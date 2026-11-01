package agentcron

// relay.go（P-20261005-207 定时任务自动接力）：触发时解析接力源会话、取尾部
// 结论、遮蔽装箱成 launchArgs 前言——前端接力链（P-20261003-114 useClaudeRelay
// /useRelayLaunch）三段语义的服务端复刻，各段复用既有实现不另起炉灶：
//
//	结论挑选  web utils/sessionRelay pickRelaySummary   → pickRelaySummary（同款尾部倒序）
//	兜底遮蔽  P-108 server/mask MaskText                 → mask.MaskText（前端 sensitiveMask 同模式集）
//	保尾装箱  web utils/promptFit fitByBytes(tailKeep)   → fitTailKeep（同式字节预算收敛）
//
// 与人工接力的语义差异（有意为之，提案拍板）：人工接力无结论=放弃不开会话；
// 定时任务接力源失效=如实无前言照常启动 + task.relaySkipped 事件回告——自动化
// 容错优先，定时任务不因接力失败而停摆。

import (
	"fmt"
	"log/slog"
	"strings"
	"time"
	"unicode/utf8"

	"codecombo/server/api/opschannel"
	"codecombo/server/claudesessions"
	"codecombo/server/mask"
	"codecombo/server/store"
)

const (
	// relayTailEntries 尾部窗口条数：与 web utils/sessionRelay RELAY_TAIL_ENTRIES
	// 同口径（结论价值集中在会话收尾，越近越相关）
	relayTailEntries = 60
	// relayLatestScan 动态解析扫描页大小：按 LastAt 倒序首页里取第一个非活跃
	// 会话（活跃 = 正被活终端写入，结论未定型不接力）。10 页足量跳过活跃头部
	relayLatestScan = 10
	// cronRelayFromMax relayFrom 存储字节上限（显式会话 ID 为 UUID 形态，宽裕即可）
	cronRelayFromMax = 128
	// launchArgsQuota 前言装箱总配额：agent 会话 launchArgs 服务端上限同口径
	//（terminal.go HTTP 面 len>500 拒绝；agentchain prompt.go launchArgsMax
	// 同值——调度链内部调用方自证长度合规）
	launchArgsQuota = 500

	// relayNoteOK / relayNoteSkippedPrefix LastRelayNote 词汇（前端按前缀映射
	// i18n 文案）；skip 原因人读面，写入 store 时 rune 截断兜底
	relayNoteOK            = "relayed"
	relayNoteSkippedPrefix = "skipped: "
)

// relayPrefaceFmt 前言模板（服务端触发链无 UI 语言上下文——与 cron.go promptVar
// 星期取英文全名同一决策口径：英文对 agent 消费方通用）；句式与前端
// claudeSessions.relay.prompt 英文形态一致，人工/自动接力注入同形
const relayPrefaceFmt = "Conclusions from the previous session: %s. Please continue."

// resolveRelaySession 接力源解析：返回 (会话 ID, 台账, 降级原因)。
//   - RelayFrom 空 = 未配置接力，("", nil, "")——调用方按未配置跳过整段
//   - latest = 项目最近已结束会话动态解析（Dir 为项目锚点，经 claudesessions
//     索引列表按 LastAt 倒序取首个非活跃；列表注入策展数据——用户隐藏的会话
//     不作接力源，与管理视图口径一致）。选中行的台账（P-208）顺带带回——索引
//     条目本就持有，零额外 IO
//   - 其余 = 显式会话 ID 原样返回，存在性在时间线读取时判定（保存时不校验：
//     源会话可晚于任务创建，竞态由降级语义兜住）；台账经索引按 id 只读查取
//     （LookupLedger，查不到=nil 前言如实省略台账行）
func resolveRelaySession(t store.AgentCron) (string, *claudesessions.Ledger, string) {
	from := strings.TrimSpace(t.RelayFrom)
	if from == "" {
		return "", nil, ""
	}
	ix := claudesessions.NewIndex(store.Get().ClaudeIndex, claudesessions.Root())
	if from != store.CronRelayLatest {
		return from, ix.LookupLedger(from), ""
	}
	if strings.TrimSpace(t.Dir) == "" {
		return "", nil, "no project dir for latest-session lookup"
	}
	root := claudesessions.Root()
	res, err := ix.List(
		t.Dir, relayLatestScan, 0, claudesessions.FetchCuration(store.Get().ClaudeCur, root))
	if err != nil {
		return "", nil, "session list unavailable"
	}
	for i := range res.Sessions {
		if !res.Sessions[i].Active {
			return res.Sessions[i].ID, res.Sessions[i].Ledger, ""
		}
	}
	return "", nil, "no ended session in project"
}

// pickRelaySummary 尾部窗口内最后一条有正文的 assistant 条目文本（trim 后）；
// 无 assistant 文本（纯工具会话/空会话）返回空串——调用方走降级不注空前言
// （web utils/sessionRelay.pickRelaySummary 同语义：服务端 timeline 解析已把
// thinking 跳过、tool/result 分流，只认 assistant 文本条目）
func pickRelaySummary(entries []claudesessions.TimelineEntry) string {
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		if e.Kind == "assistant" && strings.TrimSpace(e.Text) != "" {
			return strings.TrimSpace(e.Text)
		}
	}
	return ""
}

// fitTailKeep 保尾装箱：build(content) 全量超预算时裁头保尾（结论越近越相关，
// … 前缀标注省略）——web utils/promptFit fitByBytes tailKeep 语义同式：先按
// 「每 rune 至多 4 字节」估去头量批量裁，再逐 rune 微调到恰好塞下。模板固定段
// 本身超预算时内容裁空后原样返回（调用方预算判定兜底，仅理论边界）
func fitTailKeep(build func(string) string, content string, budget int) string {
	full := build(content)
	if len(full) <= budget {
		return full
	}
	const ellipsis = "…"
	over := len(full) - budget
	runes := []rune(content)
	cut := over / 4
	if cut > len(runes) {
		cut = len(runes)
	}
	c := string(runes[cut:])
	for len(c) > 0 && len(build(ellipsis+c)) > budget {
		c = string([]rune(c)[1:])
	}
	return build(ellipsis + c)
}

// relayLedgerLine 台账附行（P-20261005-208）：源会话结构化台账渲染成一行英文
// 量化锚（服务端触发链无 UI 语言上下文，relayPrefaceFmt 同款决策口径）——比
// 自由文本结论多「干了多少」的锚点。分段零值省略（只跑命令不写文件的会话不
// 出 files 段），无台账数据（nil / 全零）返回空串=前言如实省略（可选增强，
// 结论仍是主体）
func relayLedgerLine(l *claudesessions.Ledger) string {
	if l == nil {
		return ""
	}
	parts := make([]string, 0, 3)
	if l.FilesWritten > 0 {
		parts = append(parts, fmt.Sprintf("%d files written", l.FilesWritten))
	}
	if l.CommandsRun > 0 {
		parts = append(parts, fmt.Sprintf("%d shell commands", l.CommandsRun))
	}
	if l.DurationMs > 0 {
		parts = append(parts, relayLedgerDuration(l.DurationMs)+" elapsed")
	}
	if len(parts) == 0 {
		return ""
	}
	return "Session ledger: " + strings.Join(parts, ", ") + "."
}

// relayLedgerDuration 跨时短格式（分钟内整分钟 / 上小时一位小数；与前端
// utils/sessionLedger 短格式同语义，<1 分钟如实标 <1m）
func relayLedgerDuration(ms int64) string {
	const minuteMs = 60_000
	if ms < minuteMs {
		return "<1m"
	}
	minutes := float64(ms) / minuteMs
	if minutes < 60 {
		return fmt.Sprintf("%dm", int64(minutes))
	}
	return fmt.Sprintf("%.1fh", minutes/60)
}

// relayPreface 接力前言装配主链（trigger 前置一步调用）：
//   - 未配置接力 → ("", "")，调用方零动作
//   - 解析/读时间线/挑结论任一步失效 → ("", "skipped: <原因>")，任务照常无前言
//     发起（降级语义，事件回告见 emitRelaySkipped）
//   - 成功 → (前言, "relayed")；前言 = 遮蔽后结论装箱进模板，预算 =
//     launchArgs 500 字节上限 − 任务 prompt 组装（含 [scheduled] 后缀）− 连接
//     空格——总注入面不超配额（内部调用方自证长度合规契约，terminal.go
//     LaunchAgentSession 注记）；预算装不下固定模板时如实降级。
//     台账附行（P-20261005-208）可选拼在结论行前（原子整行，单独预留预算）：
//     塞不下整行放弃、绝不挤占结论配额——自由文本结论仍是主体
func relayPreface(t store.AgentCron, slot time.Time) (string, string) {
	sid, ledger, reason := resolveRelaySession(t)
	if sid == "" && reason == "" {
		return "", "" // 未配置接力
	}
	if sid == "" {
		return "", relayNoteSkippedPrefix + reason
	}
	root := claudesessions.Root()
	// 两跳取尾窗（useClaudeRelay 同式）：先 limit=1 探 total 再取 [total-N,
	// total)；mtime+size 指纹缓存下第二跳零重复解析。源会话不存在/已删除
	// 在此归降级（显式指向被删会话的竞态兜底）
	total, err := claudesessions.Timeline(root, sid, 1, 0)
	if err != nil {
		return "", relayNoteSkippedPrefix + "relay source unavailable"
	}
	if total.Total == 0 {
		return "", relayNoteSkippedPrefix + "relay source has no entries"
	}
	offset := total.Total - relayTailEntries
	if offset < 0 {
		offset = 0
	}
	res, err := claudesessions.Timeline(root, sid, relayTailEntries, offset)
	if err != nil {
		return "", relayNoteSkippedPrefix + "relay source unavailable"
	}
	summary := pickRelaySummary(res.Entries)
	if summary == "" {
		return "", relayNoteSkippedPrefix + "no assistant conclusion in relay source"
	}
	// 遮蔽在装箱前（P-108 同序：结论可能复述密钥）；预算按遮蔽后字节计
	masked := mask.MaskText(summary)
	budget := launchArgsQuota - len(ComposeLaunchArgs(t.Prompt, slot)) - 1 // 1 = 前言与任务间的连接空格
	minPreface := len(fmt.Sprintf(relayPrefaceFmt, "…"))
	if budget < minPreface {
		return "", relayNoteSkippedPrefix + "no launchArgs budget left for relay preface"
	}
	// 台账附行预留预算（原子整行：+1 换行分隔符）；行自身塞不下整行让位，
	// 预算全额留给结论（可选增强的弃段语义，与前端 assembleLaunchPrompt 原子
	// 前言「整段塞不下整段弃」同式）
	ledLine := relayLedgerLine(ledger)
	if ledLine != "" {
		if len(ledLine)+1 < budget {
			budget -= len(ledLine) + 1
		} else {
			ledLine = ""
		}
	}
	preface := fitTailKeep(func(s string) string { return fmt.Sprintf(relayPrefaceFmt, s) }, masked, budget)
	if ledLine != "" {
		preface = ledLine + "\n" + preface
	}
	return preface, relayNoteOK
}

// emitRelaySkipped 接力降级事件广播（task.relaySkipped，直通分发型）：agent
// 监控面感知「定时任务接力没接上 + 原因」——自动化续命断链可观测，无需翻任务
// 运行历史。载荷只携元数据不携结论内容
func emitRelaySkipped(t store.AgentCron, note string) {
	opschannel.BroadcastEvent(opschannel.EventTaskRelaySkipped, map[string]any{
		"cronId": t.ID,
		"name":   t.Name,
		"reason": strings.TrimPrefix(note, relayNoteSkippedPrefix),
	})
}

// recordRelay 接力事实落库（失败仅告警：接力是增强面，记账失败不阻断触发
// 主链路——runner.record 同款容错口径）
func recordRelay(cronID, note string) {
	if err := store.Get().AgentCron.RecordRelay(cronID, time.Now(), note); err != nil {
		slog.Warn("agentcron record relay failed", "id", cronID, "err", err)
	}
}

// validRelayFrom 保存口校验（api.go 调用）：空/latest 合法；显式会话 ID 不做
// 存在性校验（见 resolveRelaySession 注记），只守字节上限与 rune 完整性
func validRelayFrom(from string) bool {
	if from == "" || from == store.CronRelayLatest {
		return true
	}
	return len(from) <= cronRelayFromMax && utf8.ValidString(from)
}
