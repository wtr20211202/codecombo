// Package fsattr 文件改动来源归因（P-20261005-170）：watcher 命中事件
// （file.changed 总线事件）× OSC133 命令窗（terminal 会话 C/D 时刻）的
// 时间账，回答「这个文件刚才被哪条命令/哪个会话改的」。
//
// 三系统组合的归因语义：
//   - 命令：事件时刻落在某会话运行中命令的 [C,D] 窗内（含 D 后短尾宽容，
//     见 tailTolerance）即归因该 (会话, 命令)；多会话并行同项目重叠窗全列
//     并标 Overlap——歧义如实呈现，不武断裁决；
//   - 编辑器：本产品文件 API 的写入链（保存/恢复/替换/上传/改名/删除）在
//     落盘前打 API 写标记（NoteAPIWrite，外部改动审计 P-20261005-15 同款
//     自环过滤语义），命中即归因「编辑器」——编辑器保存恰逢他会长命令在跑
//     时不被错挂到命令窗；
//   - 未归因：无窗无标记（shellint 缺失/窗间隙/git API 写/编辑器外的进程
//     写）照实入账——诚实账要求无差别记账，只留归上了的会假装世界安静。
//
// 范围注记（如实声明）：skipDirs 目录（node_modules/target 等依赖与构建
// 产物）不入账——codegen/源文件侧改动是主场景，装依赖类副作用不在界内；
// 原子写临时件（.sc-tmp-）不入账。
package fsattr

import (
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"codecombo/server/store"
	"codecombo/server/terminal"
	"codecombo/server/watch"
)

const (
	// tailTolerance D 时刻后的归属宽容度：watcher 广播前有 fsnotify 批量
	// 交付与 500ms 防抖，命令刚结束的写事件可能晚于 D 帧到达——落在
	// End+tolerance 内仍归因该命令（任务书「以 D 时刻前 N ms 宽容度校准」，
	// 1.5s 覆盖防抖窗 + 交付延迟；C 侧无宽容：写发生在 C 之前不属于该命令）
	tailTolerance = 1500 * time.Millisecond

	// apiWriteTTL API 写标记的有效期：从落盘前打标到 watcher 事件入账
	// 的全链路时延（fsnotify 毫秒级 + 防抖旁路首事件即发）远小于此；过期
	// 后同路径的外部写不再被误认编辑器写。宁短勿长——错挂「编辑器」比
	// 落「未归因」更有害
	apiWriteTTL = 5 * time.Second

	// apiWriteMarksCap 标记表容量上限：编辑器保存是低频事件，4096 远超
	// TTL 窗口内的实际存量；触顶整表清过期再重置（sensitiveread 去重表同款）
	apiWriteMarksCap = 4096

	// atomicTmpMark api 层原子写的临时件标记（api/files uniqueTmp 命名约定）：
	// tmp 落在项目目录内会产生 create/remove 事件，对账无价值
	atomicTmpMark = ".sc-tmp-"
)

// ── API 写标记（编辑器保存自环过滤）──

var (
	apiWriteMu     sync.Mutex
	apiWriteMarks  = map[string]time.Time{} // absPath → 最近一次 API 写打标时刻
	apiWritePruned time.Time
)

// NoteAPIWrite 在文件 API 落盘【之前】打标：watcher 事件（tmp rename 即触发）
// 可能早于写完成返回，落盘后补标会输给事件到达的竞态——预打标保证事件
// 入账时标记必在。打标后写失败（磁盘满等）只余一条过期即散的标记，无实害
func NoteAPIWrite(absPath string) {
	if absPath == "" {
		return
	}
	now := time.Now()
	apiWriteMu.Lock()
	defer apiWriteMu.Unlock()
	// 触顶或上次清扫超 TTL：先清过期再收新（低频路径，清扫代价可忽略）
	if len(apiWriteMarks) >= apiWriteMarksCap || now.Sub(apiWritePruned) > apiWriteTTL {
		for p, t := range apiWriteMarks {
			if now.Sub(t) > apiWriteTTL {
				delete(apiWriteMarks, p)
			}
		}
		apiWritePruned = now
	}
	apiWriteMarks[absPath] = now
}

// recentAPIWrite 报告 absPath 是否在 TTL 内有过 API 写打标（命中即消费掉——
// 一次打标至多归因一轮事件，防长 TTL 内重复命中掩盖后续外部写）
func recentAPIWrite(absPath string) bool {
	now := time.Now()
	apiWriteMu.Lock()
	defer apiWriteMu.Unlock()
	t, ok := apiWriteMarks[absPath]
	if !ok {
		return false
	}
	if now.Sub(t) > apiWriteTTL {
		delete(apiWriteMarks, absPath)
		return false
	}
	delete(apiWriteMarks, absPath)
	return true
}

// ── 归因引擎 ──

// windowCovers 报告时刻 at 是否落在命令窗的归属范围内：[Start, D 后宽容尾]。
// Open 窗（C 已见 D 未至）当无上界区间——命令还在跑，写入随时可能发生
func windowCovers(w terminal.CmdWindow, at time.Time) bool {
	if at.Before(w.Start) {
		return false
	}
	if w.Open {
		return true
	}
	return !at.After(w.End.Add(tailTolerance))
}

// sessionInProject 报告会话是否归属该项目：ProjectID 精确匹配为主；
// 无主会话（外部接管等 ProjectID 空的形态）按创建目录落在项目根下兜底
// （projectLockedSession 的 dir 归属判定同思路，防接管会话漏归因）
func sessionInProject(sessionPath, sessionProjectID, projectID, root string) bool {
	if sessionProjectID == projectID {
		return true
	}
	if sessionProjectID != "" {
		return false
	}
	if root == "" || sessionPath == "" {
		return false
	}
	s := filepath.ToSlash(filepath.Clean(sessionPath))
	r := filepath.ToSlash(filepath.Clean(root))
	return s == r || strings.HasPrefix(s, r+"/")
}

// BuildEvent 为一次 watcher 命中事件组装账面条目：来源判定（编辑器标记 →
// 命令窗 → 未归因）+ 会话窗关联。root 为项目根绝对路径（相对路径换算用）。
// 事件时刻用总线信封的 TS（watcher 发布时点，与 OSC133 时刻同源服务器时钟）
func BuildEvent(projectID, root, absPath, op string, at time.Time) store.FSAttributionEvent {
	ev := store.FSAttributionEvent{
		At:     at,
		Path:   relPath(root, absPath),
		Op:     op,
		Source: store.FSAttributionUnattributed,
	}
	if ev.Path == "" {
		// 根自身事件（权限/元数据变更等）无路径语义，不入账
		return ev
	}
	if recentAPIWrite(absPath) {
		ev.Source = store.FSAttributionEditor
		return ev
	}
	refs := commandAttributions(projectID, root, at)
	if len(refs) > 0 {
		ev.Source = store.FSAttributionCommand
		ev.Attributions = refs
		ev.Overlap = len(refs) > 1
	}
	return ev
}

// sessionRef 归因扫描读取的会话最小面（值拷贝 + 窗查询闭包）：引擎不持有
// terminal.Session 指针——测试可注入裸窗数据（无 PTY 测试路径），生产装配
// 恒从 terminal.DefaultManager.ListSessions 投影
type sessionRef struct {
	ID        string
	Name      string
	ProjectID string
	Path      string
	windows   func() []terminal.CmdWindow
}

// sessionsProvider 归因扫描的会话清单来源（注入缝：生产恒为
// terminal.DefaultManager.ListSessions 投影，测试替换为裸构造清单）
var sessionsProvider = func() []sessionRef {
	list := terminal.DefaultManager.ListSessions()
	out := make([]sessionRef, 0, len(list))
	for _, s := range list {
		s := s
		out = append(out, sessionRef{ID: s.ID, Name: s.Name, ProjectID: s.ProjectID, Path: s.Path, windows: s.CommandWindows})
	}
	return out
}

// commandAttributions 收集事件时刻命中的全部 (会话, 命令) 窗。会话量级
// ≤ MaxSessions、每会话窗 ≤ cmdWindowCap，全量扫描是常数小集合遍历
func commandAttributions(projectID, root string, at time.Time) []store.FSAttributionRef {
	var refs []store.FSAttributionRef
	for _, s := range sessionsProvider() {
		if !sessionInProject(s.Path, s.ProjectID, projectID, root) {
			continue
		}
		for _, w := range s.windows() {
			if !windowCovers(w, at) {
				continue
			}
			refs = append(refs, store.FSAttributionRef{
				TerminalID:  s.ID,
				SessionName: s.Name,
				Command:     w.Command,
				ExitCode:    w.ExitCode,
				Running:     w.Open,
				StartedAt:   w.Start,
				EndedAt:     w.End,
			})
		}
	}
	return refs
}

// relPath 绝对路径 → 项目相对 slash 路径；越出根（含根自身）返回空串。
// watcher 事件与项目根同在宿主文件系统，前缀剥离即相对化，不解析符号链接
// （watcher 层从未解析，保持同一口径）
func relPath(root, absPath string) string {
	if root == "" || absPath == "" {
		return ""
	}
	a := filepath.ToSlash(filepath.Clean(absPath))
	r := filepath.ToSlash(filepath.Clean(root))
	if a == r {
		return ""
	}
	if !strings.HasPrefix(a, r+"/") {
		return ""
	}
	rel := strings.TrimPrefix(a, r+"/")
	if rel == "" || rel == "." || strings.HasPrefix(rel, "../") {
		return ""
	}
	return rel
}

// recordable 报告事件是否在记账范围内：skipDirs 目录（依赖/构建产物副作用
// 不入账，与 watcher 同清单）与原子写临时件（.sc-tmp-）除外。watcher 不监听
// skipDirs 子树，事件天然到不了；此处防御性同判——降级轮询/目录竞态窗口
// （项目接入前已存在的 skipDirs 目录，watch 递归注册后新建）仍可能漏进事件
func recordable(absPath string) bool {
	if strings.Contains(absPath, atomicTmpMark) {
		return false
	}
	return !watch.SkipPath(absPath)
}

// Record 一条 watcher 事件的入账口：范围过滤 → 归因 → 落盘。尽力而为，
// 失败只记 Debug（事件风暴场景同步落盘失败不该刷爆日志，watcher 广播链
// 同款口径），账面缺一条不影响归因语义成立
func Record(projectID, root, absPath, op string, at time.Time) {
	if store.Get() == nil || store.Get().FSAttribution == nil {
		return // 测试环境未装配 Store 时静默跳过
	}
	if !recordable(absPath) {
		return
	}
	ev := BuildEvent(projectID, root, absPath, op, at)
	if ev.Path == "" {
		return
	}
	if err := store.Get().FSAttribution.Append(projectID, ev); err != nil {
		slog.Debug("fsattribution append failed", "project", projectID, "path", ev.Path, "err", err)
	}
}
