package deploy

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/notification"
	"codecombo/server/sshclient"
	"codecombo/server/store"
)

// taskRetainTtl 任务结束后 running map 中保留多久（供 WS 重连回放历史）
const taskRetainTtl = 1 * time.Hour

type Manager struct {
	store   store.DeployTaskStore
	mu      sync.Mutex
	running map[string]*runningTask
	// hostLocks per-host 部署互斥（P-20261003-41）：hostID -> *hostDeployMutex，
	// 懒创建复用 gitops pathLocks 模式（status_cache.go）。内存态即一切：
	// 进程亡锁自消，无崩溃残留问题
	hostLocks sync.Map
}

// hostDeployMutex 同主机部署串行互斥：同一台远程主机同时只允许一个部署任务。
// SSH 双开时远端安装/服务操作会互相踩踏（临时文件名已防互踩，但安装阶段/
// 服务重启仍竞态）。holder 记持锁任务 ID——把「谁在占」报给用户，等待或取消
// 都有明确目标。release 按持锁者校验，天然幂等可多处调用。
// P-20261004-36 二阶段：被占从「拒绝」进化为「排队」——waiters 为该主机的
// FIFO 等待队列（队首在锁释放后第一个被唤醒重取），NoWait 触发保留拒绝式
type hostDeployMutex struct {
	mu      sync.Mutex
	holder  string
	waiters []*hostWaiter
}

// hostWaiter 排队任务的唤醒凭据：wake 容量 1，释放方非阻塞投递（重复唤醒合并
// 为一个 token，close 语义需要 once 反而复杂）。taskID 参与队首校验，防止被
// 摘队后的残留 waiter 拾锁
type hostWaiter struct {
	taskID string
	wake   chan struct{}
}

type runningTask struct {
	task   *config.DeployTask
	cancel context.CancelFunc
	logBuf []LogEntry
	subs   []chan LogEntry
	cfg    *config.DeployConfig
	done   bool
}

type TriggerRequest struct {
	HostID    string
	Instances []config.DeployerInstance
	// NoWait 不等候：同主机锁被占时直接拒绝（P-20261003-41 拒绝式语义的保留
	// 入口，前端表单「不等候」开关）。缺省 false = 排队模式（P-20261004-36）：
	// 登记同主机 FIFO 等待队列，持锁任务终态释放锁时唤醒队首自动接续
	NoWait bool
}

func NewManager(s store.DeployTaskStore) *Manager {
	return &Manager{
		store:   s,
		running: map[string]*runningTask{},
	}
}

// hostMutex 返回主机专属互斥锁（懒创建）
func (m *Manager) hostMutex(hostID string) *hostDeployMutex {
	l, _ := m.hostLocks.LoadOrStore(hostID, &hostDeployMutex{})
	return l.(*hostDeployMutex)
}

// tryLockHost 尝试占用 hostID 的部署互斥锁；被占返回 (持锁任务ID, false)。
// 仅锁原语（单测契约用）；Trigger 入口走感知等待队列的 acquireHost 公平版
func (m *Manager) tryLockHost(hostID, taskID string) (string, bool) {
	l := m.hostMutex(hostID)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.holder != "" {
		return l.holder, false
	}
	l.holder = taskID
	return "", true
}

// acquireHost 排队感知的公平获锁（Trigger 入口）：无持锁且无排队者才立即持有
// ——锁空闲但队首尚未拾取的窗口期不插队，保持先到先得。被占/有队时：NoWait
// 返回 (占锁者, nil, false) 由调用方拒绝；排队模式登记 FIFO 等待者并返回
// waitingFor（持锁任务优先，无持锁时报队首——那个窗口期它即将拾锁）
func (m *Manager) acquireHost(hostID, taskID string, wait bool) (holder string, w *hostWaiter, acquired bool) {
	l := m.hostMutex(hostID)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.holder == "" && len(l.waiters) == 0 {
		l.holder = taskID
		return "", nil, true
	}
	if l.holder != "" {
		holder = l.holder
	} else {
		holder = l.waiters[0].taskID
	}
	if !wait {
		return holder, nil, false
	}
	w = &hostWaiter{taskID: taskID, wake: make(chan struct{}, 1)}
	l.waiters = append(l.waiters, w)
	return holder, w, false
}

// pickUpHostLock 被唤醒的等待者公平拾锁：仅当锁空闲且自己是队首才成功
func (m *Manager) pickUpHostLock(hostID, taskID string) bool {
	l := m.hostMutex(hostID)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.holder != "" || len(l.waiters) == 0 || l.waiters[0].taskID != taskID {
		return false
	}
	l.holder = taskID
	l.waiters = l.waiters[1:]
	return true
}

// dequeueHostWaiter 排队任务退出等待（取消收尾）时摘除自己——残留队首会让
// wakeNextHost 永远空转，head-of-line 阻塞同主机所有后续排队任务
func (m *Manager) dequeueHostWaiter(hostID, taskID string) {
	l := m.hostMutex(hostID)
	l.mu.Lock()
	defer l.mu.Unlock()
	for i, w := range l.waiters {
		if w.taskID == taskID {
			l.waiters = append(l.waiters[:i], l.waiters[i+1:]...)
			return
		}
	}
}

// wakeNextHost 唤醒队首等待者重试拾锁（finishTask 收尾点 / 队首放弃的接力点）。
// 非阻塞投递：token 未消费时幂等，不会因重复唤醒阻塞释放方
func (m *Manager) wakeNextHost(hostID string) {
	l := m.hostMutex(hostID)
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.waiters) > 0 {
		select {
		case l.waiters[0].wake <- struct{}{}:
		default:
		}
	}
}

// QueuePosition 任务在同主机等待队列中的位次（1 起，1 = 下一个拿锁）；不在任何
// 队列返回 0。任务详情展示用：位次是动态内存态不入库，读时现算，量级为主机数
// （deploy 主机个位数~十位数）遍历 + 单队列扫描，无热点
func (m *Manager) QueuePosition(taskID string) int {
	pos := 0
	m.hostLocks.Range(func(_, v any) bool {
		l := v.(*hostDeployMutex)
		l.mu.Lock()
		for i, w := range l.waiters {
			if w.taskID == taskID {
				pos = i + 1
				break
			}
		}
		l.mu.Unlock()
		return pos == 0 // 已找到则停止遍历
	})
	return pos
}

// unlockHost 释放 hostID 互斥锁（仅持锁任务本人可清，重复调用无害）
func (m *Manager) unlockHost(hostID, taskID string) {
	l := m.hostMutex(hostID)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.holder == taskID {
		l.holder = ""
	}
}

func (m *Manager) Trigger(ctx context.Context, req TriggerRequest, host *config.RemoteHost, cfg *config.DeployConfig) (string, error) {
	// 并发准入：同时运行的部署任务上限 3（每个任务占一条 SSH 连接与远端进程，
	// 且任务日志常驻内存 1h）。历史实现无上限，批量触发会放大远端压力
	m.mu.Lock()
	active := 0
	for _, rt := range m.running {
		if rt.task.Status == config.TaskStatusQueued || rt.task.Status == config.TaskStatusRunning {
			active++
		}
	}
	m.mu.Unlock()
	if active >= 3 {
		return "", fmt.Errorf("too many concurrent deploy tasks (limit 3), wait or cancel running tasks")
	}

	resolved, err := ResolvePlan(req.Instances)
	if err != nil {
		return "", fmt.Errorf("resolve plan: %w", err)
	}

	// 任务序列含 claude_code 时，Anthropic 配置（token/baseUrl/model）缺一不可——
	// 在任务创建前拦截，避免远程环境装到一半才发现配置不全
	for _, inst := range resolved {
		if inst.DeployerID == "claude_code" {
			if err := validateClaudeCfg(cfg); err != nil {
				return "", err
			}
			break
		}
	}

	// per-host 串行互斥（P-20261003-41 + P-20261004-36 二阶段）：与全局上限正交
	// ——那道闸管资源水位（SSH 连接/内存日志），这道闸管主机安全（远端安装/
	// 服务操作不可双开）。默认排队式：被占登记 FIFO 等待队列留在 queued，
	// waitingFor 记「等谁」；NoWait=true 保留 P-41 拒绝式语义（表单「不等候」
	// 开关），原文是前端 KNOWN_ERROR_I18N 的匹配契约，改动需同步 web/src/api/
	// http.ts 与 errmarkers 注册表。在 ResolvePlan/校验通过后才获锁：参数不合法
	// 的触发不该短暂挡住主机
	taskID := "sc_dt_" + uuid.New().String()
	holder, waiter, acquired := m.acquireHost(req.HostID, taskID, !req.NoWait)
	if !acquired && req.NoWait {
		// 稳定原文收口 errmarkers 注册表（P-20261004-29）：此前是行内字面量，
		// 前端映射契约无单一事实源
		return "", fmt.Errorf(errmarkers.DeployHostBusyTemplate, holder)
	}

	// 部署任务生命周期独立于触发它的 HTTP 请求。
	// 即使上层传入 c.Request.Context()，这里也用 context.Background() 派生新 ctx，
	// 避免 HTTP 响应返回后 ctx 被取消导致任务立刻 cancelled。
	_ = ctx
	taskCtx, cancel := context.WithCancel(context.Background())

	now := time.Now()
	task := config.DeployTask{
		ID: taskID, HostID: req.HostID, Host: host.Host,
		Instances: resolved, Status: config.TaskStatusQueued, StartedAt: &now,
	}
	if !acquired {
		// 排队登记成功：waitingFor 指向同主机在途任务，详情/历史页如实展示「等谁」
		task.WaitingFor = holder
	}
	if err := m.store.Save(task); err != nil {
		cancel()
		m.unlockHost(req.HostID, taskID)
		m.dequeueHostWaiter(req.HostID, taskID)
		return "", fmt.Errorf("save task: %w", err)
	}

	// 在 Lock 内创建 rt 并立即赋值 cancel，避免「Trigger 返回后、run 尚未赋值 rt.cancel」
	// 的窗口内调 Cancel(taskID) 拿到 nil cancel 导致取消请求被丢弃
	rt := &runningTask{task: &task, cfg: cfg, cancel: cancel}
	m.mu.Lock()
	m.running[taskID] = rt
	m.mu.Unlock()

	if !acquired {
		// 排队日志即时入环（WS 订阅回放可见）：操作有反馈，用户知道任务没丢
		m.broadcast(taskID, LogEntry{
			Time: time.Now(), Step: "queue", Level: LevelInfo,
			Message:       fmt.Sprintf("queued behind task %s on same host", holder),
			MessageKey:    "deploy.log.queuedBehind",
			MessageParams: map[string]any{"task": holder},
		})
	}
	go m.dispatch(taskCtx, taskID, req.HostID, host, cancel, waiter)
	return taskID, nil
}

// dispatch 任务派发（P-20261004-36 排队二阶段的调度点）：持锁任务直接进 run；
// 排队任务在 waiter.wake / ctx.Done 上等待——持锁任务 finishTask 释放锁后唤醒
// 队首（wakeNextHost），此处公平拾锁后接续执行。ctx 取消（用户取消排队）以
// cancelled 收尾，并摘队 + 接力唤醒，防止残留队首阻塞同主机后续任务。
// hostID 显式传 req.HostID：与 Trigger 获锁/run 收尾解锁（rt.task.HostID）同源，
// 不经 host.ID 转手，避免调用方两参不一致时锁错主机
func (m *Manager) dispatch(ctx context.Context, taskID, hostID string, host *config.RemoteHost, cancel context.CancelFunc, waiter *hostWaiter) {
	defer cancel()
	if waiter != nil {
		for !m.pickUpHostLock(hostID, taskID) {
			select {
			case <-ctx.Done():
				m.dequeueHostWaiter(hostID, taskID)
				m.wakeNextHost(hostID)
				m.finishTask(taskID, config.TaskStatusCancelled, "cancelled", host)
				return
			case <-waiter.wake:
			}
		}
	}
	m.run(ctx, taskID, host, cancel)
}

func (m *Manager) run(ctx context.Context, taskID string, host *config.RemoteHost, cancel context.CancelFunc) {
	defer cancel()

	m.mu.Lock()
	rt, ok := m.running[taskID]
	m.mu.Unlock()
	if !ok {
		return
	}
	// per-host 互斥异常路径兜底释放（正常由 finishTask 单一收尾点释放；幂等，
	// 也兜住 Deployer panic 等未达 finishTask 的路径）
	defer m.unlockHost(rt.task.HostID, taskID)

	// rt.task 字段写入须持 m.mu：Trigger 准入（全局上限统计）与 per-host 判定
	// 在 m.mu 下读取 Status，无锁写与之构成数据竞态（-race 门禁捕获）
	m.mu.Lock()
	rt.task.Status = config.TaskStatusRunning
	// 排队结束（P-20261004-36）：取到锁即清「等谁」，详情恢复纯净 running 态
	rt.task.WaitingFor = ""
	m.persistTask(rt)
	m.mu.Unlock()
	m.broadcast(taskID, LogEntry{
		Time: time.Now(), Step: "start", Level: LevelInfo,
		Message:       fmt.Sprintf("task started, %d instances", len(rt.task.Instances)),
		MessageKey:    "deploy.log.taskStarted",
		MessageParams: map[string]any{"count": len(rt.task.Instances)},
	})

	client, err := sshclient.Dial(sshclient.ConnectOptions{
		Host: host.Host, Port: host.Port, User: host.User,
		Auth:            sshclient.AuthMethodFor(host.AuthType, host.Password, host.PemContent),
		SkipHostKeyTOFU: host.HostKeyVerifyDisabled,
	})
	if err != nil {
		m.finishTask(taskID, config.TaskStatusFailed, "ssh dial: "+err.Error(), host)
		return
	}
	defer client.Close()

	for i, inst := range rt.task.Instances {
		if ctx.Err() != nil {
			m.finishTask(taskID, config.TaskStatusCancelled, "cancelled", host)
			return
		}
		m.mu.Lock()
		rt.task.CurrentIndex = i
		m.mu.Unlock()
		m.broadcast(taskID, LogEntry{
			Time: time.Now(), Deployer: inst.DeployerID, Step: "start", Level: LevelInfo,
			Message:    fmt.Sprintf("[%d/%d] starting %s", i+1, len(rt.task.Instances), inst.DeployerID),
			MessageKey: "deploy.log.startingInstance",
			MessageParams: map[string]any{
				"index":    i + 1,
				"total":    len(rt.task.Instances),
				"deployer": inst.DeployerID,
			},
		})

		d := Get(inst.DeployerID)
		if d == nil {
			m.finishTask(taskID, config.TaskStatusFailed, "unknown deployer: "+inst.DeployerID, host)
			return
		}
		params := DeployParams{
			SSH:    client,
			Host:   host,
			Cfg:    rt.cfg,
			Params: inst.Params,
			Log:    &taskLogger{m: m, taskID: taskID, deployer: inst.DeployerID},
			Ctx:    ctx,
		}
		if err := d.Deploy(ctx, params); err != nil {
			// ctx 被取消（用户点取消）→ 标记为 cancelled，不是 failed
			if ctx.Err() != nil {
				m.finishTask(taskID, config.TaskStatusCancelled, "cancelled", host)
				return
			}
			m.finishTask(taskID, config.TaskStatusFailed, fmt.Sprintf("%s: %s", inst.DeployerID, err.Error()), host)
			return
		}
	}

	m.finishTask(taskID, config.TaskStatusCompleted, "", host)
}

func (m *Manager) finishTask(taskID, status, errMsg string, host *config.RemoteHost) {
	m.mu.Lock()
	rt := m.running[taskID]
	var task *config.DeployTask
	if rt != nil {
		now := time.Now()
		rt.task.Status = status
		rt.task.Error = errMsg
		rt.task.FinishedAt = &now
		// 终态清排队标记（P-20261004-36）：含取消排队路径，落库记录不残留「等谁」
		rt.task.WaitingFor = ""
		m.persistTask(rt)
		rt.done = true
		// per-host 互斥随任务终态释放（P-20261003-41）：任何终态（含取消/失败）
		// 都放行同主机下一个部署；run 侧另有 defer 幂等兜底
		m.unlockHost(rt.task.HostID, taskID)
		task = rt.task
		// 关闭所有 subscriber channel（用于通知 WS 收尾）
		for _, sub := range rt.subs {
			close(sub)
		}
		rt.subs = nil
	}
	m.mu.Unlock()

	// 锁已释放，唤醒同主机队首排队任务重取（P-20261004-36 排队唤醒点）。放
	// m.mu 外：唤醒只碰 hostLocks 自己的锁，别拖住订阅者广播路径
	if rt != nil {
		m.wakeNextHost(rt.task.HostID)
	}

	m.broadcast(taskID, LogEntry{
		Time: time.Now(), Step: "done", Level: levelForStatus(status),
		Message:       statusMessage(status, errMsg),
		MessageKey:    doneMessageKey(status),
		MessageParams: map[string]any{"error": errMsg},
	})

	// 任务终态推通知中心（成功/失败；取消为用户主动行为不打扰）。
	// 放锁外：Add 落库有文件 IO，不拖住订阅者广播路径
	if task != nil {
		m.notifyTaskDone(task, host, status, errMsg)
	}

	// 长期留档落盘（P-20261007-8，P-142 二阶段）：成功/失败终态把日志环快照写
	// 车道 2 artifacts（logpersist.go）——内存环 1h TTL 后即逝，留档副本寿命
	// 同任务记录（30 天清理链同批删）。终态先行、快照后补且写失败不阻塞收尾
	// （失败部署的日志恰恰最重要，但留档是尽力而为的旁路）；cancelled 是用户
	// 主动中止，快照价值低不入档（内存窗内照常可下载）
	if task != nil && (status == config.TaskStatusCompleted || status == config.TaskStatusFailed) {
		m.persistLogSnapshot(task)
	}

	// TTL 后清理内存（供 WS 短时重连回放历史）
	time.AfterFunc(taskRetainTtl, func() {
		m.mu.Lock()
		delete(m.running, taskID)
		m.mu.Unlock()
	})
}

// notifyTaskDone 部署任务终态通知（P-20261001-31）：部署此前只有 /ws/deploy
// 日志页，几分钟的任务必须守着页面才知道结束。Title 含主机名与工具名（去重
// 拼接，多工具一眼分辨部署目标）；失败附尾部错误摘要（≤200 字符，定位信息
// 集中在尾部）。动作按终态分流：成功 panel:deploy 直达 设置→远程部署（结果
// 现场）；失败（P-20261003-289）agent-fix 一键交给智能体修复——payload=任务
// id，前端动作触发时经 GET /api/deploy/:taskId 补拉完整任务配置组装修复
// prompt（任务记录保留 30 天，见 module.go deployTaskRetention，远超 1h 日志
// TTL），补拉失效降级仅通知标题/摘要。store 未装配（单测环境）静默跳过；
// 类别偏好由 Notification.Add 统一过滤
func (m *Manager) notifyTaskDone(task *config.DeployTask, host *config.RemoteHost, status, errMsg string) {
	if status != config.TaskStatusCompleted && status != config.TaskStatusFailed {
		return
	}
	s := store.Get()
	if s == nil {
		return
	}

	hostLabel := task.Host
	if host != nil && host.Name != "" {
		hostLabel = host.Name
	}
	nType, title := "success", "部署完成"
	action, actionPayload := "panel", "deploy"
	body := ""
	if status == config.TaskStatusFailed {
		nType, title = "error", "部署失败"
		body = truncateTail(errMsg, notifyErrSummaryMax)
		action, actionPayload = "agent-fix", task.ID
	}

	s.Notification.Add(notification.Notification{
		Type:     nType,
		Category: notification.CategoryTask,
		Title:    fmt.Sprintf("%s：%s · %s", title, hostLabel, deployerSummary(task.Instances)),
		Body:     body,
		// TaskID「下载日志」行内入口锚点（P-20261003-142）：日志窗内可直下，
		// 窗外前端给出过期提示。主动作仍按 P-20261003-289 分流，不回退
		TaskID:        task.ID,
		Action:        action,
		ActionPayload: actionPayload,
	})
}

// notifyErrSummaryMax 失败通知错误摘要上限（字符）
const notifyErrSummaryMax = 200

// truncateTail 保留字符串末尾 ≤max 字符（错误定位信息多在尾部），截断时以
// … 前缀标注并计入上限；按 rune 切避免劈开多字节字符
func truncateTail(s string, max int) string {
	if max < 1 {
		return ""
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return "…" + string(r[len(r)-(max-1):])
}

// deployerSummary 实例工具 id 去重拼接（allowMultiple 工具可重复出现，通知
// 标题只报工具集）
func deployerSummary(instances []config.DeployerInstance) string {
	seen := make(map[string]bool, len(instances))
	names := make([]string, 0, len(instances))
	for _, in := range instances {
		if in.DeployerID == "" || seen[in.DeployerID] {
			continue
		}
		seen[in.DeployerID] = true
		names = append(names, in.DeployerID)
	}
	return strings.Join(names, "+")
}

func (m *Manager) Cancel(taskID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	rt, ok := m.running[taskID]
	if !ok || rt.cancel == nil || rt.done {
		return false
	}
	rt.cancel()
	return true
}

func (m *Manager) Subscribe(taskID string) (<-chan LogEntry, func()) {
	ch := make(chan LogEntry, 256)
	m.mu.Lock()
	defer m.mu.Unlock()
	rt, ok := m.running[taskID]
	if !ok {
		close(ch)
		return ch, func() {}
	}
	for _, e := range rt.logBuf {
		select {
		case ch <- e:
		default:
		}
	}
	// 任务已结束：直接关闭 channel 让 WS handler 走收尾路径
	if rt.done {
		close(ch)
		return ch, func() {}
	}
	rt.subs = append(rt.subs, ch)
	return ch, func() {
		m.unsubscribe(taskID, ch)
	}
}

func (m *Manager) unsubscribe(taskID string, ch chan LogEntry) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rt, ok := m.running[taskID]
	if !ok {
		return
	}
	for i, c := range rt.subs {
		if c == ch {
			rt.subs = append(rt.subs[:i], rt.subs[i+1:]...)
			return
		}
	}
}

func (m *Manager) IsRunning(taskID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.running[taskID]
	return ok
}

func (m *Manager) SetPublicKey(taskID, keyName, pub string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rt, ok := m.running[taskID]
	if !ok {
		return
	}
	rt.task.PublicKeys = append(rt.task.PublicKeys, config.PublicKeyEntry{KeyName: keyName, PublicKey: pub})
	m.persistTask(rt)
	m.broadcastLocked(rt, LogEntry{
		Time: time.Now(), Step: "publicKey", Level: LevelOK,
		Message: fmt.Sprintf("%s: %s", keyName, pub),
	})
}

func (m *Manager) broadcast(taskID string, e LogEntry) {
	m.mu.Lock()
	defer m.mu.Unlock()
	rt, ok := m.running[taskID]
	if !ok {
		return
	}
	m.broadcastLocked(rt, e)
}

func (m *Manager) broadcastLocked(rt *runningTask, e LogEntry) {
	rt.logBuf = append(rt.logBuf, e)
	if len(rt.logBuf) > 200 {
		rt.logBuf = rt.logBuf[len(rt.logBuf)-200:]
	}
	for _, sub := range rt.subs {
		select {
		case sub <- e:
		default:
		}
	}
}

func (m *Manager) persistTask(rt *runningTask) {
	_ = m.store.Save(*rt.task)
}

func levelForStatus(s string) string {
	switch s {
	case config.TaskStatusCompleted:
		return LevelOK
	case config.TaskStatusFailed:
		return LevelFail
	case config.TaskStatusCancelled:
		return LevelWarn
	}
	return LevelInfo
}

func statusMessage(status, err string) string {
	switch status {
	case config.TaskStatusCompleted:
		return "task completed"
	case config.TaskStatusFailed:
		return "task failed: " + err
	case config.TaskStatusCancelled:
		return "task cancelled"
	}
	return status
}

// doneMessageKey 返回任务结束日志的 i18n key
func doneMessageKey(status string) string {
	switch status {
	case config.TaskStatusCompleted:
		return "deploy.log.taskCompleted"
	case config.TaskStatusFailed:
		return "deploy.log.taskFailed"
	case config.TaskStatusCancelled:
		return "deploy.log.taskCancelled"
	}
	return ""
}

type taskLogger struct {
	m        *Manager
	taskID   string
	deployer string
}

func (l *taskLogger) Log(step, level, msg string) {
	l.m.broadcast(l.taskID, LogEntry{
		Time: time.Now(), Deployer: l.deployer, Step: step, Level: level, Message: msg,
	})
}

func (l *taskLogger) LogKV(step, level, key string, params map[string]any) {
	l.m.broadcast(l.taskID, LogEntry{
		Time: time.Now(), Deployer: l.deployer, Step: step, Level: level,
		MessageKey: key, MessageParams: params,
		// Message 留空：前端优先用 messageKey，回退时显示空字符串
	})
}

func (l *taskLogger) SetPublicKey(keyName, pub string) {
	l.m.SetPublicKey(l.taskID, keyName, pub)
}
