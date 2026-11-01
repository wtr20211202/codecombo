package claims

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"codecombo/server/config"
	"codecombo/server/kernel"
	"codecombo/server/notification"
	"codecombo/server/store"
)

// 通知中心模板键（system.dualOpen.*，前端按 titleKey/bodyKey 渲染；
// Title/Body 原文为无模板消费方——webhook 外发、API 直读——的回退）
const (
	ConflictTitleKey = "system.dualOpen.conflict.title"
	ConflictBodyKey  = "system.dualOpen.conflict.body"
)

// Module 跨实例同目录双开检测模块：启动对项目列表全量 claim（提案原文：
// 实例启动者配对本实例项目列表全量 claim），此后心跳续期 + 周期扫描 +
// 项目增删事件即时补扫；发现他实例存活 claim 入账通知中心（warning/system，
// 经 store 出站口单点——WS 广播与 webhook 外发共用，无第二重复面）。退出
// （含优雅停机与自更新重启）清理本实例全部 claim；崩溃残留靠 staleness 回收
type Module struct {
	k          kernel.Kernel
	port       int
	instanceID string

	// notifyFn 通知出站口：默认 store 出站口；单测替换以捕获入账
	//（扫描/去重逻辑与投递解耦验证，同 report.emitFn 模式）
	notifyFn func(notification.Notification)
	// dataDirFn 实例身份数据目录：默认 config.DataDir；单测指向临时目录
	dataDirFn func() string

	mu      sync.Mutex
	claimed map[string]string // projectID → gitDir：本进程写过 claim 的登记，退出清理以它为准
	seen    map[string]bool   // "projectID|peerInstanceID" 已入账，同冲突不重复打扰
	unsub   []func()
}

// NewModule port 为本实例对外端口（claim 内容，供通知文案定位对方实例）
func NewModule(port int) *Module {
	return &Module{
		port:      port,
		notifyFn:  storeNotify,
		dataDirFn: config.DataDir,
		claimed:   map[string]string{},
		seen:      map[string]bool{},
	}
}

func (m *Module) Name() string        { return "claims" }
func (m *Module) DependsOn() []string { return nil }

// Init 记录内核引用（数据面取自全局 store 与项目 .git，无装配期工作）
func (m *Module) Init(_ context.Context, k kernel.Kernel) error {
	m.k = k
	return nil
}

// Start 装配检测循环：全量 claim → 订阅项目增删（新增项目即时 claim+补扫，
// 移除项目即时清理）→ 心跳 ticker（续期 + 全量扫描）。启动扫描在 Start 内
// 同步完成（每项目一次目录读 + 一次小文件写，项目数十量级耗时毫秒级）
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	m.k = k
	id, err := InstanceID(m.dataDirFn())
	if err != nil {
		// 身份不可得 = claim 读写无从谈起：模块降级停用（日志留痕），不阻断启动
		slog.Warn("claims module disabled — instance id unavailable", "err", err)
		return nil
	}
	m.instanceID = id

	// 启动即全量 claim + 首轮扫描（提案①②：启动者配对全量 claim，启动检测
	// 他实例冲突）——此后周期扫描让先启动方对后启动的对端同样知情
	m.claimAll()
	m.scanAll()

	unsubAdded := k.Events().Subscribe("project.added", func(env kernel.Envelope) {
		if id, path, ok := projectPayload(env); ok {
			m.onProjectAdded(id, path)
		}
	})
	unsubRemoved := k.Events().Subscribe("project.removed", func(env kernel.Envelope) {
		if id, path, ok := projectPayload(env); ok {
			m.onProjectRemoved(id, path)
		}
	})
	m.unsub = append(m.unsub, unsubAdded, unsubRemoved)

	if !k.Scheduler().AddTicker("claims-heartbeat", HeartbeatEvery, func(context.Context) {
		m.tick()
	}) {
		return fmt.Errorf("claims: claims-heartbeat ticker already registered")
	}
	return nil
}

// Stop 退出清理：移除本实例全部 claim 文件（提案③退出清理）+ 退订事件 +
// 清空内存态。ticker 由内核 StopAll 统一取消，无需在此处理
func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	for _, u := range m.unsub {
		u()
	}
	m.unsub = nil

	m.mu.Lock()
	defer m.mu.Unlock()
	for _, gitDir := range m.claimed {
		if err := RemoveClaim(gitDir, m.instanceID); err != nil {
			slog.Warn("claims cleanup failed", "gitDir", gitDir, "err", err)
		}
	}
	m.claimed = map[string]string{}
	m.seen = map[string]bool{}
	return nil
}

// tick 心跳节拍：已 claim 项目续期（updatedAt 推进），随后全量扫描——
// 他实例后启动的 claim 只能被扫描侧发现，持续扫描让先启动方同样知情
func (m *Module) tick() {
	m.mu.Lock()
	targets := make(map[string]string, len(m.claimed))
	for id, gitDir := range m.claimed {
		targets[id] = gitDir
	}
	m.mu.Unlock()

	for id, gitDir := range targets {
		if err := WriteClaim(gitDir, m.claimFor()); err != nil {
			slog.Debug("claims heartbeat rewrite failed", "gitDir", gitDir, "err", err)
			continue
		}
		// 心跳与移除事件并发的兜底：登记项已消失说明本项目刚被移除，
		// 撤掉刚重写的文件，避免给已移除的项目永久续命残留 claim
		m.mu.Lock()
		still := m.claimed[id] == gitDir
		m.mu.Unlock()
		if !still {
			_ = RemoveClaim(gitDir, m.instanceID)
		}
	}
	m.scanAll()
}

// onProjectAdded 新项目即时 claim + 单项目补扫（运行期添加的项目无需等
// 重启才纳入双开检测；事件由 api/project 生命周期发布，载荷 {id, path}）
func (m *Module) onProjectAdded(id, path string) {
	m.mu.Lock()
	if m.instanceID == "" {
		m.mu.Unlock()
		return
	}
	m.mu.Unlock()

	if gitDir := m.claimProject(id, path); gitDir != "" {
		m.scanProject(id, projectName(id), gitDir)
	}
}

// onProjectRemoved 项目移除即清理其 claim（含 relocate 旧路径——relocate
// 以 removed+added 事件对发布）
func (m *Module) onProjectRemoved(id, _ string) {
	m.mu.Lock()
	gitDir, ok := m.claimed[id]
	delete(m.claimed, id)
	m.mu.Unlock()
	if ok {
		if err := RemoveClaim(gitDir, m.instanceID); err != nil {
			slog.Warn("claims unclaim failed", "gitDir", gitDir, "err", err)
		}
	}
}

// claimAll 启动全量 claim（提案①）：对项目列表逐个落 claim；单个失败只
// 留日志（claim 是知情增强，不阻断服务）
func (m *Module) claimAll() {
	s := store.Get()
	if s == nil {
		return
	}
	projects, err := s.Project.List()
	if err != nil {
		slog.Warn("claims project list failed", "err", err)
		return
	}
	for _, p := range projects {
		m.claimProject(p.ID, p.Path)
	}
}

// claimProject 对单项目落 claim 并登记（claim 文件随目录走，登记表供
// 心跳续期与退出清理；非 git 目录无锚点跳过）
func (m *Module) claimProject(id, path string) string {
	gitDir := ResolveGitDir(path)
	if gitDir == "" {
		return ""
	}
	if err := WriteClaim(gitDir, m.claimFor()); err != nil {
		slog.Warn("claims write failed", "path", path, "err", err)
		return ""
	}
	m.mu.Lock()
	m.claimed[id] = gitDir
	m.mu.Unlock()
	return gitDir
}

// claimFor 构造本实例当前时刻的 claim（startedAt 取模块启动时刻语义不强求，
// 统一以写入时刻为准——续期即刷新，内容除 updatedAt 外不变）
func (m *Module) claimFor() Claim {
	now := time.Now()
	return Claim{InstanceID: m.instanceID, Port: m.port, StartedAt: now, UpdatedAt: now}
}

// scanAll 全量扫描：逐项目解析锚点并查他实例存活 claim（解析实时做而非
// 复用登记表——项目路径可被 relocate，登记表只服务清理）
func (m *Module) scanAll() {
	s := store.Get()
	if s == nil {
		return
	}
	projects, err := s.Project.List()
	if err != nil {
		return
	}
	for _, p := range projects {
		if gitDir := ResolveGitDir(p.Path); gitDir != "" {
			m.scanProject(p.ID, p.Name, gitDir)
		}
	}
}

// scanProject 单项目冲突判定与入账：他实例存活 claim 命中即通知，同
// （项目，对端实例）只入账一次——扫描周期性重跑，去重防刷屏；对端实例
// 重启（换号）视为新冲突重新告知
func (m *Module) scanProject(projectID, name, gitDir string) {
	peers, err := ScanGitDir(gitDir, m.instanceID, time.Now())
	if err != nil {
		slog.Debug("claims scan failed", "gitDir", gitDir, "err", err)
		return
	}
	for _, peer := range peers {
		key := projectID + "|" + peer.InstanceID
		m.mu.Lock()
		seen := m.seen[key]
		m.seen[key] = true
		m.mu.Unlock()
		if seen || m.instanceID == "" {
			continue
		}
		slog.Warn("dual-open detected", "project", name, "peerPort", peer.Port, "peerInstance", peer.InstanceID)
		m.notifyFn(m.conflictNotification(projectID, name, peer))
	}
}

// conflictNotification 双开冲突通知（warning/system：真实并发风险，进入
// webhook important 默认外发集合；ProjectID/ProjectName 关联项目供中心
// 过滤与跳转）
func (m *Module) conflictNotification(projectID, name string, peer Peer) notification.Notification {
	return notification.Notification{
		Type:        "warning",
		Category:    notification.CategorySystem,
		ProjectID:   projectID,
		ProjectName: name,
		TitleKey:    ConflictTitleKey,
		BodyKey:     ConflictBodyKey,
		Title:       "检测到项目被其他实例同时打开",
		// 语言中立明细（webhook 外发/API 直读回退，同日报惯例）
		Body: fmt.Sprintf("%s — port %d, instance %s", name, peer.Port, shortID(peer.InstanceID)),
		MsgParams: map[string]any{
			"project": name,
			"port":    peer.Port,
		},
	}
}

// projectPayload 解析项目生命周期事件载荷 {id, path}
func projectPayload(env kernel.Envelope) (id, path string, ok bool) {
	payload, ok := env.Payload.(map[string]string)
	if !ok {
		return "", "", false
	}
	return payload["id"], payload["path"], payload["id"] != ""
}

// projectName 项目列表反查名称（scanProject 补扫场景兜底，查不到用 id）
func projectName(id string) string {
	if s := store.Get(); s != nil {
		if p, err := s.Project.GetByID(id); err == nil && p != nil {
			return p.Name
		}
	}
	return id
}

// storeNotify 默认出站口：store 未装配时静默跳过（裸模块单测环境）
func storeNotify(n notification.Notification) {
	if s := store.Get(); s != nil {
		s.Notification.Add(n)
	}
}

// shortID 实例号截短展示（uuid 前 8 位足以区分对端）
func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return strings.TrimSpace(id)
}
