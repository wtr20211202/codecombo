package git

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"codecombo/server/config"
	"codecombo/server/notification"
	"codecombo/server/store"

	"github.com/google/uuid"
)

// isHTTPSURL 判断是否为 HTTP/HTTPS 协议（需走凭据注入流程）
func isHTTPSURL(raw string) bool {
	low := strings.ToLower(raw)
	return strings.HasPrefix(low, "https://") || strings.HasPrefix(low, "http://")
}

// isSSHURL 判断是否为 SSH 协议（需走 SSH key 注入流程）
func isSSHURL(raw string) bool {
	low := strings.ToLower(raw)
	return strings.HasPrefix(low, "git@") || strings.HasPrefix(low, "ssh://")
}

// 克隆任务状态
type CloneTaskStatus string

const (
	StatusRunning  CloneTaskStatus = "running"
	StatusSuccess  CloneTaskStatus = "success"
	StatusFailed   CloneTaskStatus = "failed"
	StatusCanceled CloneTaskStatus = "canceled"
)

// 任务完成结果保留时长（供客户端 WS 重连取结果）
const cloneTaskTTL = 5 * time.Minute

// CloneRequest 克隆请求参数
type CloneRequest struct {
	URL    string
	Dir    string
	Branch string
	Depth  int
	Name   string
	// SshKeyID 用户在克隆对话框显式选定的 SSH 密钥 id；非空时 SSH 地址按 id
	// 精确取钥匙（优先于 host 自动匹配）
	SshKeyID string
}

// CloneResult 克隆结果
type CloneResult struct {
	ProjectID   string `json:"projectId,omitempty"`
	ProjectName string `json:"projectName,omitempty"`
	Path        string `json:"path,omitempty"`
	Error       string `json:"error,omitempty"`
}

// CloneTask 克隆任务
type CloneTask struct {
	ID         string          `json:"id"`
	URL        string          `json:"url"`
	Dir        string          `json:"dir"`
	Status     CloneTaskStatus `json:"status"`
	Lines      []string        `json:"lines"`
	Result     *CloneResult    `json:"result,omitempty"`
	CreatedAt  time.Time       `json:"createdAt"`
	FinishedAt time.Time       `json:"finishedAt,omitempty"`
	cancel     context.CancelFunc
	mu         sync.Mutex
	// subs 实时进度订阅者（广播语义：每个 WS 客户端独立 channel，互不竞争消费；
	// 满时丢行——进度行是信息性输出，宁丢不阻塞克隆。markFinished 统一 close）
	subs []chan string
}

// appendLine 线程安全地追加进度行 + 非阻塞广播给全部订阅者
func (t *CloneTask) appendLine(line string) {
	t.mu.Lock()
	// 仅保留最近 200 行进度（避免内存膨胀）
	if len(t.Lines) >= 200 {
		t.Lines = t.Lines[1:]
	}
	t.Lines = append(t.Lines, line)
	// 非阻塞广播：慢/死消费者只丢行，不阻塞克隆流程
	for _, sub := range t.subs {
		select {
		case sub <- line:
		default:
		}
	}
	t.mu.Unlock()
}

// Subscribe 订阅实时进度行（先在锁内原子补发已缓冲的历史行，消除
// "先 Snapshot 再订阅" 的丢失窗口；任务已结束则直接返回已关闭的 channel）。
// 返回只读 channel 与取消订阅函数。
func (t *CloneTask) Subscribe() (<-chan string, func()) {
	ch := make(chan string, 256)
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, line := range t.Lines {
		select {
		case ch <- line:
		default:
		}
	}
	if t.Status != StatusRunning {
		close(ch)
		return ch, func() {}
	}
	t.subs = append(t.subs, ch)
	return ch, func() { t.unsubscribe(ch) }
}

func (t *CloneTask) unsubscribe(ch chan string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for i, c := range t.subs {
		if c == ch {
			t.subs = append(t.subs[:i], t.subs[i+1:]...)
			return
		}
	}
}

// SnapshotStatus 线程安全地读取状态和结果
func (t *CloneTask) SnapshotStatus() (CloneTaskStatus, *CloneResult) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.Status, t.Result
}

// snapshotFinishedAt 线程安全地读取结束时间（CleanupExpired 判 TTL 用）
func (t *CloneTask) snapshotFinishedAt() time.Time {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.FinishedAt
}

// markFinished 标记任务结束：先置状态再关闭全部订阅 channel，
// 保证订阅者在 channel 关闭后 SnapshotStatus 必然读到最终状态
func (t *CloneTask) markFinished(status CloneTaskStatus, result *CloneResult) {
	t.mu.Lock()
	t.Status = status
	t.Result = result
	t.FinishedAt = time.Now()
	subs := t.subs
	t.subs = nil
	t.mu.Unlock()
	for _, ch := range subs {
		close(ch)
	}
}

// TaskManager 管理所有克隆任务
type TaskManager struct {
	mu    sync.Mutex
	tasks map[string]*CloneTask
	// cloneSlots 并发准入（4）：每个任务一个 git 子进程 + 网络流，
	// 历史实现每请求一 goroutine 无上限，批量克隆会打满带宽与进程数
	cloneSlots chan struct{}
}

// maxConcurrentClones 同时执行的克隆任务上限（其余排队依次执行）
const maxConcurrentClones = 4

// DefaultTaskManager 全局任务管理器单例
var DefaultTaskManager = &TaskManager{
	tasks:      make(map[string]*CloneTask),
	cloneSlots: make(chan struct{}, maxConcurrentClones),
}

// Start 启动一个克隆任务，返回 taskID
func (m *TaskManager) Start(req CloneRequest) string {
	ctx, cancel := context.WithCancel(context.Background())
	task := &CloneTask{
		ID:        uuid.New().String(),
		URL:       req.URL,
		Dir:       req.Dir,
		Status:    StatusRunning,
		Lines:     []string{},
		CreatedAt: time.Now(),
		cancel:    cancel,
	}

	m.mu.Lock()
	m.tasks[task.ID] = task
	m.mu.Unlock()

	go func() {
		m.cloneSlots <- struct{}{}
		defer func() { <-m.cloneSlots }()
		m.runClone(ctx, task, req)
	}()
	return task.ID
}

// runClone 执行克隆，完成后更新状态、注册项目、推通知
func (m *TaskManager) runClone(ctx context.Context, task *CloneTask, req CloneRequest) {
	slog.Info("clone task started", "taskId", task.ID, "url", req.URL, "dir", req.Dir)

	// 按协议构造 env：HTTPS 走 GIT_CONFIG_GLOBAL（指本程序 credential-helper），SSH 走 GIT_SSH_COMMAND（LRU tmp key）
	// cleanups 在 clone 完成后调用（删 tmp key 文件等，仅 SSH 路径有非空 cleanup）
	env, cleanups, err := buildAuthEnvForURLWithKey(req.URL, req.SshKeyID)
	if err != nil {
		slog.Error("clone: buildAuthEnv failed", "taskId", task.ID, "url", req.URL, "err", err)
		task.markFinished(StatusFailed, &CloneResult{Error: "build auth env failed: " + err.Error()})
		m.notifyCloneDone(task)
		return
	}
	defer func() {
		for _, c := range cleanups {
			c()
		}
	}()

	destDir, err := CloneRepoStreaming(ctx, req.URL, req.Dir, req.Branch, req.Depth, env, task.appendLine)
	slog.Info("clone: streaming done", "taskId", task.ID, "dir", destDir, "err", err, "ctxErr", ctx.Err())
	if err != nil {
		// git 的真实报错（认证失败/仓库不存在等）在 stderr 尾部，仅记 exit code
		// 无法定位问题（如 sshkey 克隆 128），把最后几行提到服务端日志
		lastErrLines := make([]string, 0, 3)
		for i := len(task.Lines) - 1; i >= 0 && len(lastErrLines) < 3; i-- {
			if line := strings.TrimSpace(task.Lines[i]); line != "" {
				lastErrLines = append(lastErrLines, line)
			}
		}
		if len(lastErrLines) > 0 {
			slog.Error("clone: git stderr tail", "taskId", task.ID, "lines", strings.Join(lastErrLines, " | "))
		}
	}

	if err != nil {
		// 区分取消和失败
		if ctx.Err() != nil {
			task.markFinished(StatusCanceled, &CloneResult{Error: "canceled by user"})
			// 清理半成品目录（git clone 中断会留 .git 残留）
			if rmErr := os.RemoveAll(req.Dir); rmErr != nil && !os.IsNotExist(rmErr) {
				slog.Warn("clone: cleanup failed", "dir", req.Dir, "err", rmErr)
			}
		} else {
			task.markFinished(StatusFailed, &CloneResult{Error: err.Error()})
		}
		m.notifyCloneDone(task)
		return
	}

	// 克隆成功：显式设置当前分支跟踪远程上游，确保 pull/push 安全
	if trackErr := setBranchUpstream(destDir, req.Branch); trackErr != nil {
		slog.Warn("clone: set upstream failed", "taskId", task.ID, "err", trackErr)
	}

	// 注册项目
	name := req.Name
	if name == "" {
		name = strings.TrimSuffix(filepath.Base(destDir), ".git")
	}
	pc := config.ProjectConfig{ID: uuid.New().String(), Name: name, Path: destDir}
	addErr := store.Get().Project.Create(pc)
	slog.Info("clone: registered as project", "taskId", task.ID, "projectId", pc.ID, "name", pc.Name, "err", addErr)
	if addErr != nil {
		task.markFinished(StatusFailed, &CloneResult{
			Path:  destDir,
			Error: "clone ok but failed to register project: " + addErr.Error(),
		})
	} else {
		task.markFinished(StatusSuccess, &CloneResult{
			ProjectID:   pc.ID,
			ProjectName: pc.Name,
			Path:        pc.Path,
		})
	}
	m.notifyCloneDone(task)
}

// Cancel 取消任务，返回是否成功（任务存在且仍在运行）
func (m *TaskManager) Cancel(id string) bool {
	m.mu.Lock()
	task, ok := m.tasks[id]
	m.mu.Unlock()
	if !ok {
		return false
	}
	status, _ := task.SnapshotStatus()
	if status != StatusRunning {
		return false
	}
	task.cancel()
	return true
}

// Get 获取任务
func (m *TaskManager) Get(id string) (*CloneTask, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	task, ok := m.tasks[id]
	return task, ok
}

// CleanupExpired 清理已结束且超过 TTL 的任务（由外部定时调用）
func (m *TaskManager) CleanupExpired() {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	for id, task := range m.tasks {
		status, _ := task.SnapshotStatus()
		if status == StatusRunning {
			continue
		}
		finished := task.snapshotFinishedAt()
		if finished.IsZero() {
			continue
		}
		if now.Sub(finished) > cloneTaskTTL {
			delete(m.tasks, id)
		}
	}
}

// notifyCloneDone 推送克隆完成/失败/取消通知到通知中心。
// Action 跳转闭环（P-20261001-31）：成功携带 ProjectID/ProjectName（前端
// pendingAction 先切项目）+ panel:changes 打开变更面板；失败仅带 panel 跳转；
// 取消为用户主动行为，不附跳转
func (m *TaskManager) notifyCloneDone(task *CloneTask) {
	status, result := task.SnapshotStatus()

	var nType, title, body string
	var projectID, projectName string
	withAction := false
	switch status {
	case StatusSuccess:
		nType = "success"
		title = "克隆成功"
		if result != nil {
			body = result.ProjectName + " 已添加到项目列表"
			projectID = result.ProjectID
			projectName = result.ProjectName
		}
		withAction = true
	case StatusFailed:
		nType = "error"
		title = "克隆失败"
		if result != nil {
			body = result.Error
		}
		withAction = true
	case StatusCanceled:
		nType = "info"
		title = "克隆已取消"
		body = task.URL
	default:
		return
	}

	n := notification.Notification{
		Type:     nType,
		Category: notification.CategoryClone,
		Title:    title,
		Body:     body,
	}
	if withAction {
		n.ProjectID = projectID
		n.ProjectName = projectName
		n.Action = "panel"
		// 面板跳转 payload 为注册表面板 id（前端 togglePanel 消费），changes = 变更面板
		n.ActionPayload = "changes"
	}
	store.Get().Notification.Add(n)
}
