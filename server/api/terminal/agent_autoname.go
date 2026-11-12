package terminal

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"codecombo/server/claudesessions"
	"codecombo/server/mask"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// agent 会话自动命名（P-20261111-6 S1）：会话开始任务时按转写内容总结会话名。
//
// 动机：带 prompt 创建的会话名已是 prompt 首行摘要（P-12），但「开个 claude
// 会话再在 TUI 里说任务」的多数派会话名停在序号缺省名（终端 N/槽位继承），
// 要手动改名才可辨识。本观察器周期检测：claude 运行时 agent 会话的首个用户
// 消息落盘（transcript JSONL 首条 user 条目，claudesessions 同源解析链）→
// 取首行文本去噪截断作标题 → 仅当会话名仍为系统派生形态（Derived 且未 Named）
// 时经 rename 写入。
//
// 边界（逐条对应提案口径）：
//   - 手动重命名过（meta.Named，rename 端点置位）永不覆盖——用户意志优先；
//     手动改名后 Derived 保持创建时点事实，故 Named 是唯一的「用户已介入」判据
//   - 命中敏感模式的首句不自动命名（mask.ScanContent 一行抑制，静默跳过）；
//     用户已标敏感（meta.Sensitive）的会话同样跳过——不扩大敏感会话的暴露面
//   - 解析失败/首条消息尚未落盘/归属不明：静默跳过，下轮重试（不命名好过错名）
//   - dsh/codex 等运行时无对等首条消息数据面，显式豁免（Runtime=claude 门控，
//     不硬凑）
//   - 带 prompt 创建的会话跳过：名字已是 prompt 首行摘要，转写首条用户消息即
//     同一 prompt，再改名零增益纯抖动
//
// S2（P-20261111-6-S2）：变更透出沿用 S1 既有 terminals.changed 复用（前端
// 侧栏/标签对既有快照消费链即时跟随，零新增事件），本步补设置总开关
// agentAutoNameEnabled（默认开，下方 autoNameEnabled 每 tick 现读内存缓存）
// 与 ops 手册命名语义登记。

const (
	// autoNameTickInterval 观察周期：首条用户消息落盘到改名上屏的延迟上界
	// 取向（秒级体感）与轮询成本（每轮对在册 claude 会话一次目录列举 + 头部
	// 有界读，量级个位数会话）的平衡点
	autoNameTickInterval = 5 * time.Second

	// autoNameTitleMaxRunes 自动命名标题截断宽度（rune）：提案口径 ~40 字符。
	// 比 prompt 摘要名（promptSessionNameMax=24）宽——转写首句是纯任务语境，
	// 无装箱前言挤占；单行识别位（侧栏/标签）可读性上限与提案对齐
	autoNameTitleMaxRunes = 40
)

// autoNameResolved 自动命名已决会话表（内存态，进程生命周期）：id → 已改名 /
// 派生名与现名相等（幂等无操作）/ 首句命中敏感抑制。已决会话不再重复读盘
// 派生——改名后的派生名与现名恒等，重派生是纯 IO 重复；重启丢失最多重派生
// 一轮（派生确定性，结果不变）。条目随会话消亡在每轮 tick 修剪
var autoNameResolved = struct {
	sync.Mutex
	ids map[string]bool
}{ids: make(map[string]bool)}

// autoNameTakenNames 现存 agent 会话名集合取数口（变量化供测试注入，
// terminalSessionsLister 先例）：生产绑定 liveAgentSessionNames（同名消歧
// 对照面）；测试 stub 免起真实 PTY 注册会话
var autoNameTakenNames = liveAgentSessionNames

// autoNameEnabled 自动命名总开关（P-20261111-6 S2，默认开——提案目的即行为
// 变化，升级注记已知情告知）。读端走 settings 内存缓存（PUT /settings 保存即
// 改写同一指针，下一 tick 生效，无需重启/落盘读），与 GET /settings、迁移
// 投影同源 OrDefault。store 未装配（单测装配窗）返回 false——观察器无 meta
// 面无以为继，与 autoNameTick 既有 store nil 静默跳过同语义
func autoNameEnabled() bool {
	if store.Get() == nil {
		return false
	}
	if cfg := store.Get().Settings.Get(); cfg != nil {
		return cfg.Server.AgentAutoNameEnabledOrDefault()
	}
	return false
}

// autoNameTick 观察器主循环（kernel Scheduler 周期驱动；单测直调）。
// 逐轮：总开关 → 在册会话 → 资格过滤 → transcript 定位与首条消息提取 →
// 敏感抑制 → 同名消歧 → 幂等改名。全程静默跳过不阻断（任何一轮的失败都留给
// 下轮重试，派生确定性保证幂等）
func autoNameTick() {
	if !autoNameEnabled() {
		return // 用户显式关闭：观察器整体旁路（已决表不清——重开后免重派生一轮）
	}
	sessions := terminalSessionsLister()
	agentSessions := make([]*terminal.Session, 0, len(sessions))
	liveIDs := make(map[string]bool, len(sessions))
	for _, s := range sessions {
		liveIDs[s.ID] = true
		if s.Kind == terminal.KindAgent {
			agentSessions = append(agentSessions, s)
		}
	}
	if len(agentSessions) == 0 {
		autoNamePruneResolved(liveIDs)
		return
	}
	if store.Get() == nil {
		return // store 未装配（单测装配窗）：静默跳过，auditBroadcast 同款旁路惯例
	}
	metas := map[string]*store.AgentSessionMeta{}
	if list, err := store.Get().AgentSession.List(); err == nil {
		for i := range list {
			metas[list[i].ID] = &list[i]
		}
	}
	root := claudesessions.Root()
	if root == "" {
		return
	}
	// 持久关联表（claudeassoc，恢复链拉起时落库）：候选归属的「已被其他活
	// 终端认领」排除面。读失败降级为无认领（归属计数兜底，宁漏勿错）
	assocs := loadClaudeAssocs(root)
	for _, s := range agentSessions {
		autoNameResolved.Lock()
		done := autoNameResolved.ids[s.ID]
		autoNameResolved.Unlock()
		if done {
			continue
		}
		meta := metas[s.ID]
		if !autoNameEligible(meta) {
			continue
		}
		_, headTitle := autoNameResolveTranscript(s, meta, root, liveIDs, assocs)
		title := autoNameTitleFromMessage(headTitle)
		if title == "" {
			continue // 首条用户消息尚未落盘/不可作标题：下轮重试（不标记已决）
		}
		if len(mask.ScanContent(title)) > 0 {
			// 敏感抑制（提案口径：命中敏感模式的首句不自动命名）：静默跳过并
			// 标记已决——transcript 头部不可变，抑制结论是稳定事实，不重试
			autoNameMarkResolved(s.ID)
			continue
		}
		autoNameApply(s, title)
	}
	autoNamePruneResolved(liveIDs)
}

// autoNameEligible 自动命名资格（纯函数便于单测）：meta 在册 + Runtime=claude
// （数据面豁免见文件头）+ 名字仍为系统派生形态（Derived 且未 Named）+ 非敏感
// 标记 + 初始注入非 prompt 形态。资格在会话生命周期内只增不减（Named/Sensitive
// 由用户动作翻转，翻转后即永久退出资格），每轮重查成本可忽略
func autoNameEligible(meta *store.AgentSessionMeta) bool {
	if meta == nil {
		return false
	}
	if meta.Runtime != "claude" {
		return false
	}
	if !meta.Derived || meta.Named {
		return false
	}
	if meta.Sensitive {
		return false
	}
	// prompt 形态跳过（见文件头）：InitialPrompt 是注入原文（注记拼装前，
	// saveAgentSessionMeta 契约），非旗标即 prompt 派生名
	if meta.InitialPrompt != "" && !flagFormLaunchArgs(meta.InitialPrompt) {
		return false
	}
	return true
}

// autoNameResolveTranscript 定位待命名会话的 transcript 文件并带回其首条可作
// 标题的用户消息文本（一次头部读同时完成候选过滤与标题提取）：
//   - 恢复链（InitialPrompt 带 --resume <id>）：精确归属 <编码目录>/<id>.jsonl
//     （关联语义见 claude_sessions_active.go；文件缺失=transcript 已删，跳过）
//   - 新会话：扫描会话 cwd 的编码目录顶层 *.jsonl（与 claudesessions.List 同
//     口径），候选 = 头部首个时间戳 ≥ 本会话 CreatedAt（claude 进程先于终端
//     存在的首条消息启动，会话 transcript 不可能早于终端创建——早于即别的
//     会话的旧 transcript）且未被其他活终端认领（claudeassoc 对账）。候选恰
//     一个 → 归属；0 个 = 首条消息还没写；≥2 个 = 并发同目录（第二个 claude
//     终端/原生 claude）不可分辨，保守放弃——不命名好过错名
//
// 归属是每轮启发式、不做持久认领（成功后派生名==现名幂等跳过，无需记住归属；
// claudeassoc 保持恢复链既有写入点不扩）
func autoNameResolveTranscript(s *terminal.Session, meta *store.AgentSessionMeta, root string, liveIDs map[string]bool, assocs map[string]store.ClaudeSessionAssoc) (string, string) {
	dir := strings.TrimSpace(s.Path)
	if dir == "" {
		return "", ""
	}
	dirPath := filepath.Join(root, claudesessions.EncodePath(dir))
	// 本会话之外的活终端认领集：认领键=transcript UUID 小写（loadClaudeAssocs
	// 键形态）。自身认领不算占用（恢复链场景自己的关联恰是要读的文件）
	claimed := make(map[string]bool, len(assocs))
	for lower, a := range assocs {
		if a.TerminalID != s.ID && liveIDs[a.TerminalID] {
			claimed[lower] = true
		}
	}
	if rid := parseResumeSessionID(meta.InitialPrompt); rid != "" {
		p := filepath.Join(dirPath, rid+".jsonl")
		if _, err := os.Stat(p); err != nil {
			return "", ""
		}
		_, title := claudesessions.TranscriptHead(p)
		return p, title
	}
	entries, err := os.ReadDir(dirPath)
	if err != nil {
		return "", "" // 目录不存在（claude 未写过任何 transcript）：下轮重试
	}
	found, foundTitle := "", ""
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		if claimed[strings.ToLower(strings.TrimSuffix(e.Name(), ".jsonl"))] {
			continue
		}
		p := filepath.Join(dirPath, e.Name())
		firstAt, title := claudesessions.TranscriptHead(p)
		if firstAt.IsZero() || firstAt.Before(s.CreatedAt) {
			continue // 无时间戳可考 / 早于终端创建 = 别的会话的旧 transcript
		}
		if found != "" {
			return "", "" // 第二个候选出现：归属不明，整轮放弃（宁可不命名）
		}
		found, foundTitle = p, title
	}
	return found, foundTitle
}

// autoNameTitleFromMessage 转写首条用户消息 → 会话标题（纯函数便于单测）：
// 取首个非空行（去换行——首条消息可携多行/注记拼装尾）、控制字符折叠为空格
// （promptSessionName 同款单行展示位口径）、超宽 rune 截断加省略号。
// 消息文本来自 claudesessions 同源解析链（meta 块/sidechain/纯噪声已滤）
func autoNameTitleFromMessage(msg string) string {
	for _, line := range strings.Split(msg, "\n") {
		line = strings.TrimSpace(strings.Map(func(r rune) rune {
			if unicode.IsControl(r) {
				return ' '
			}
			return r
		}, line))
		if line == "" {
			continue
		}
		if utf8.RuneCountInString(line) > autoNameTitleMaxRunes {
			return string([]rune(line)[:autoNameTitleMaxRunes]) + "…"
		}
		return line
	}
	return ""
}

// autoNameApply 同名消歧后落地改名（rename 既有单点：session.Rename + meta
// 落库 + terminals.changed 广播）。与 rename 端点的语义差：meta 不置 Named/
// NamedAt——Named 是「用户手动命名」的槽位继承判据（inheritDisplayName 只认
// 它），自动名不是用户意志，置位会让后续会话槽位继承到自动名、扩散非用户
// 意图。改名后派生名与现名恒等（派生确定性），下轮起幂等跳过无需重派生
func autoNameApply(s *terminal.Session, title string) {
	taken := autoNameTakenNames()
	delete(taken, s.Name) // 自身现名不算占用：派生名==现名时防「步进→下轮回步」振荡
	final := dedupeAgentSessionName(title, taken)
	if final == s.Name {
		autoNameMarkResolved(s.ID)
		return
	}
	// 用户改名竞态守卫：写前重读，间隙内用户手动改名（Named 置位）即放弃
	//（资格面下轮也会排除，双保险）；meta 已删 = 会话已关，同样放弃（改名
	// 一个死会话只会留下孤儿 meta）
	fresh, err := store.Get().AgentSession.Get(s.ID)
	if err != nil || fresh == nil || fresh.Named {
		return
	}
	s.Rename(final)
	fresh.Name = final
	if err := store.Get().AgentSession.Save(*fresh); err != nil {
		// 落库失败不阻断：内存名已改且已标记已决（派生==现名）；tmux 恢复
		// 场景名回退创建缺省链后仍可再被本观察器补名，自愈面保留
		slog.Warn("agent auto-name meta save failed", "id", s.ID, "err", err)
	}
	autoNameMarkResolved(s.ID)
	broadcastTerminalsChanged()
	slog.Info("agent session auto-named", "id", s.ID, "name", final)
}

// autoNameMarkResolved 标记会话自动命名已决（并发安全：观察器单 goroutine
// 驱动，锁是防御性口径）
func autoNameMarkResolved(id string) {
	autoNameResolved.Lock()
	autoNameResolved.ids[id] = true
	autoNameResolved.Unlock()
}

// autoNamePruneResolved 修剪已决表中消亡会话的条目（会话关闭后 id 不复用，
// 条目即死数据；每轮一次 O(n) 遍历，n=历史已决会话数，量级个位数~几十）
func autoNamePruneResolved(live map[string]bool) {
	autoNameResolved.Lock()
	defer autoNameResolved.Unlock()
	for id := range autoNameResolved.ids {
		if !live[id] {
			delete(autoNameResolved.ids, id)
		}
	}
}
