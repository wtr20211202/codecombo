package watch

import (
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"codecombo/server/notification"
	"codecombo/server/share"
	"codecombo/server/store"
)

// 敏感文件工作台外写入观测（P-20261005-15）：fsnotify watcher 此前对磁盘变更
// 只做编辑器缓冲重载 + Quick Open 缓存失效，工作台外进程（本地 IDE/共享机他户/
// 失控工具）改写 .env、密钥、凭据类文件时审计与通知双双缺席——工作台内一切敏感
// 动作都有台账，偏偏边界上的写入是盲区。本文件在 watcher 事件链上补一层观测：
//
//	路径命中敏感模式（share 包确定性模式表，单一事实源与分享/补丁导出同源勿复制）
//	且非工作台自身写入（file.selfwrite 标记过滤 API 写自环）
//	且不在同路径节流窗口内（60s，编辑器连续保存/原子写的多波事件只记一条）
//	→ 审计 project.file.external + 通知中心条目（action=file 直达编辑器）
//
// 纪律：只记项目名 + 相对路径元数据，文件内容永不如账（与 file.sensitive_read
// 同一审计红线）。边界注记：①inotify 配额耗尽退化的轮询兜底（degraded.go）只有
// 项目级指纹、无路径感知，不承载本观测——配额自愈切回实时 watcher 后恢复；
// ②git 等子进程经工作台发起的写入不经 files API，无法标记，命中敏感名时会照常
// 入账（敏感文件按约定不入库，git 触碰属罕见事件，误记方向是「多记」可接受）；
// ③终端会话里用户/agent 手敲命令改 .env 同理入账——它确实是「工作台文件面之外」
// 的写入，与本观测的边界定义一致。

const (
	// externalDedupWindow 同路径节流窗口：外部编辑器保存常产生多波事件（临时
	// 文件交换/多次 flush），窗口内同路径只记一条，台账不刷屏（任务书既定 60s）
	externalDedupWindow = 60 * time.Second

	// externalDedupCap 节流表条目上限：观测面的内存有界线。超限先清过期条目，
	// 仍超限整表重置——代价只是节流语义偶尔失效（多记一条），绝不丢事件
	//（sensitiveReadDedup 同款纪律）
	externalDedupCap = 4096

	// selfWriteTTL 自环标记有效窗：API 写入到 watcher goroutine 处理对应事件
	// 的时延是毫秒级，5s 覆盖原子写（tmp+rename 双事件）与事件风暴下的排队余量；
	// 窗口内恰好同路径的外部写入会被吞记——罕见且方向是漏报一条而非误报，可接受
	selfWriteTTL = 5 * time.Second

	// selfWriteCap 自环标记表上限（有界纪律同上；标记只在 API 写入路径产生，
	// 正常流量远达不到）
	selfWriteCap = 1024
)

// externalGuard 敏感外部写入观测的状态域。判定链全部进程内存操作，watcher
// goroutine 上的未命中成本 = 一次 basename 小写 + 十来次 glob（非敏感路径的
// 大多数事件在此短路），命中后的审计/通知是节流后的低频 IO
type externalGuard struct {
	mu    sync.Mutex
	seen  map[string]time.Time // 节流表：projectID \x00 relPath → 上次入账时刻
	marks map[string]time.Time // 自环标记表：slash 归一绝对路径 → 标记时刻

	// 注入口（测试缝）：nil 时走生产实现。now 注入时钟；enabled 读设置开关；
	// audit/notify 是台账与通知投递口（生产从 store 统一解析）
	now     func() time.Time
	enabled func() bool
	audit   func(store.AuditEvent)
	notify  func(notification.Notification)
}

// normalizeSlashes 路径分隔符显式归一为 /：反斜杠一律替换。不走 filepath.ToSlash
// ——它在 Linux 是恒等操作（\ 是合法文件名字符，非分隔符），反斜杠输入只在
// Windows 被归一，同一函数三平台结果不一致；本观测的标记/查询/相对路径裁剪
// 全走本函数，归一语义与宿主平台解耦（share.MatchSensitivePaths 同款先例；
// 全平台纪律：三平台显式一致。代价是 Linux 上字面含 \ 的病态文件名会按 /
// 参与 prefix 裁剪/标记互认——现实不存在且方向只影响元数据显示，可接受）
func normalizeSlashes(p string) string {
	return strings.ReplaceAll(p, `\`, `/`)
}

// noteSelfWrite 记录一个工作台即将写入的绝对路径（files 包经内核总线
// file.selfwrite 事件驱动，module.go 订阅；发布先于落盘，标记先于事件到达）。
// 路径经 normalizeSlashes 显式归一：fsnotify 事件名在 Windows 是反斜杠形态，
// 标记与查询两侧同口径才能命中，且命中与否不随宿主平台漂移
func (g *externalGuard) noteSelfWrite(absPath string) {
	now := g.clock()
	key := normalizeSlashes(absPath)
	g.mu.Lock()
	defer g.mu.Unlock()
	if len(g.marks) >= selfWriteCap {
		g.pruneLocked(now)
	}
	if g.marks == nil {
		g.marks = make(map[string]time.Time)
	}
	g.marks[key] = now
}

// isSelfWrite 查询路径是否处于自环标记窗口内。查询即惰性清理（过期标记顺手
// 摘除），表满时全表清过期、仍满整表重置（有界让位节流，与节流表同款取舍）
func (g *externalGuard) isSelfWrite(absPath string, now time.Time) bool {
	key := normalizeSlashes(absPath)
	g.mu.Lock()
	defer g.mu.Unlock()
	if t, ok := g.marks[key]; ok {
		if now.Sub(t) < selfWriteTTL {
			return true
		}
		delete(g.marks, key)
	}
	if len(g.marks) >= selfWriteCap {
		g.pruneLocked(now)
	}
	return false
}

// pruneLocked 清过期条目（调用方持锁）；清后仍满整表重置
func (g *externalGuard) pruneLocked(now time.Time) {
	for k, t := range g.marks {
		if now.Sub(t) >= selfWriteTTL {
			delete(g.marks, k)
		}
	}
	if len(g.marks) >= selfWriteCap {
		g.marks = make(map[string]time.Time)
	}
}

// clock 测试注入口解析：nil → 真实时钟
func (g *externalGuard) clock() time.Time {
	if g.now != nil {
		return g.now()
	}
	return time.Now()
}

// throttled 同路径节流判定：窗口内已入账返回 true；未入账则记账并放行。
// 键含项目 id——两个项目的同名 .env 互不吞记；\x00 分隔防字段拼接歧义
// （sensitiveread 同款键规）
func (g *externalGuard) throttled(now time.Time, projectID, relPath string) bool {
	key := projectID + "\x00" + relPath
	g.mu.Lock()
	defer g.mu.Unlock()
	if t, ok := g.seen[key]; ok && now.Sub(t) < externalDedupWindow {
		return true
	}
	if len(g.seen) >= externalDedupCap {
		for k, t := range g.seen {
			if now.Sub(t) >= externalDedupWindow {
				delete(g.seen, k)
			}
		}
		if len(g.seen) >= externalDedupCap {
			// 全为窗口内活跃键：重置保内存有界（频率语义让位内存纪律）
			g.seen = make(map[string]time.Time)
		}
	}
	if g.seen == nil {
		g.seen = make(map[string]time.Time)
	}
	g.seen[key] = now
	return false
}

// observe watcher 事件链的观测入口：命中敏感模式且通过自环过滤与节流的路径
// 入账审计 + 通知中心。event.Op 侧的 Write|Create 过滤在调用方（watcher.go），
// 这里只管模式命中之后的判定链。best-effort 语义：store 未装配（测试环境）或
// 任一投递口缺失时静默跳过，绝不影响广播主链路
func (rw *RepoWatcher) observe(projectID, absPath string) {
	if !share.IsSensitiveName(filepath.Base(absPath)) {
		return
	}
	g := &rw.external
	now := g.clock()
	// 开关判定（未配置默认开）：关闭即观测静默，审计/通知均不再产生
	if !g.enabledFn()() {
		return
	}
	if g.isSelfWrite(absPath, now) {
		return
	}
	root := rw.projectRootFor(projectID)
	if root == "" {
		return
	}
	relPath := externalRelPath(root, absPath)
	if relPath == "" {
		return
	}
	if g.throttled(now, projectID, relPath) {
		return
	}

	name := projectNameFor(projectID)
	detail := fmt.Sprintf("%s: %s", name, relPath)

	audit := g.audit
	if audit == nil {
		st := store.Get()
		if st == nil || st.Audit == nil {
			return // store 未装配（测试环境）：观测静默
		}
		audit = st.Audit.Append
	}
	audit(store.AuditEvent{
		Action: store.AuditProjectFileExternal,
		Result: store.AuditResultSuccess,
		Detail: detail,
	})

	notify := g.notify
	if notify == nil {
		notify = rw.notifyOutlet()
	}
	if notify != nil {
		notify(externalWriteNotification(projectID, name, relPath))
	}
	slog.Info("sensitive file changed outside workbench", "project", name, "path", relPath)
}

// enabledFn 开关判定口解析：注入口优先，否则读设置存储（未配置默认开）。
// 判定点每条命中事件现读——设置切换即时生效，无需重启（与审计保留期同惯例）
func (g *externalGuard) enabledFn() func() bool {
	if g.enabled != nil {
		return g.enabled
	}
	return func() bool {
		if st := store.Get(); st == nil || st.Settings == nil {
			return false // store 未装配：观测静默（测试环境守卫）
		}
		return store.Get().Settings.Get().Server.SensitiveExternalWatchOrDefault()
	}
}

// projectRootFor 项目根路径（slash 归一）查询：命中敏感名才走，O(项目数) 线性
// 扫描可接受（节流后的低频路径）
func (rw *RepoWatcher) projectRootFor(projectID string) string {
	rw.projMu.RLock()
	defer rw.projMu.RUnlock()
	for _, p := range rw.projIdx {
		if p.id == projectID {
			return p.path
		}
	}
	return ""
}

// externalRelPath 绝对路径 → 项目相对路径（/ 分隔）。root 是 slash 归一形态
// （projIndex 构建时 ToSlash，宿主原生路径），事件路径经 normalizeSlashes 显式
// 归一再裁前缀——Windows 反斜杠事件名与 Linux 正斜杠事件名在同一函数下得到
// 同一结果；裁不出前缀（索引与事件竞态错位）返回空串由调用方跳过
func externalRelPath(rootSlash, absPath string) string {
	p := normalizeSlashes(absPath)
	if !strings.HasPrefix(p, rootSlash+"/") {
		return ""
	}
	return p[len(rootSlash)+1:]
}

// projectNameFor 项目显示名查询（通知跨项目跳转 + 审计 Detail 用）：List 是
// 进程内配置读，节流后的低频调用不做缓存
func projectNameFor(projectID string) string {
	if st := store.Get(); st != nil && st.Project != nil {
		if projects, err := st.Project.List(); err == nil {
			for _, p := range projects {
				if p.ID == projectID {
					return p.Name
				}
			}
		}
	}
	return projectID // 兜底：项目查询失败时用 id（元数据仍可追溯）
}

// externalWriteNotification 通知中心条目：弱打扰形态（warning 级 + system 类，
// 与 inotify 配额告警同档），action=file 携项目相对路径——点击经 pendingAction
// 链直达编辑器打开该文件（用户随即看到外部改动后的内容；编辑器缓冲本就随
// file.changed 自动重载）。TitleKey/BodyKey 模板化 + Title/Body 中文/语言中立
// 原文回退，与 inotifyExhaustedNotification 同惯例
func externalWriteNotification(projectID, projectName, relPath string) notification.Notification {
	return notification.Notification{
		Type:          "warning",
		Category:      notification.CategorySystem,
		ProjectID:     projectID,
		ProjectName:   projectName,
		TitleKey:      "notify.extwrite.title",
		BodyKey:       "notify.extwrite.body",
		Title:         "敏感文件被工作台外修改",
		Body:          fmt.Sprintf("%s: %s", projectName, relPath),
		Action:        "file",
		ActionPayload: relPath,
		MsgParams: map[string]any{
			"project": projectName,
			"path":    relPath,
		},
	}
}
