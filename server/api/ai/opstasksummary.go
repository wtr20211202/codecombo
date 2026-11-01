package ai

// task.progress 终态通知摘要（P-20261005-221）：agent 经 ops-notify 上报
// done/failed 时，发布口顺带把该会话 claude transcript 的结论尾部附进载荷
// （payload.summary，可选字段——旧前端忽略零兼容负担）。值守一屏知结果：
// 前端终态通知链（agentTaskNotify）把摘要拼进 body，通知中心条目 / 桌面通知 /
// P-31 webhook 外发三消费面同 body 一致受益，手机端免开工作台即知 agent 干出
// 了什么；failed 附排障第一现场（最后一条 error 结果）。
//
// 结论提取链复用既有件，不另起炉灶（与 relay.go P-207 / postmortem.go P-60
// 同族，各段出处见函数注记）：
//   - 会话定位：terminalId → 在册终端会话（Path/CreatedAt）→ 其目录内 mtime
//     落窗的最新 transcript（postmortem.transcriptTail 同范式的时间窗匹配，
//     防错挂同目录并行会话）。发现走 ReadDir+stat 级（非 List/Index 全文扫）
//     ——发布口是上报热路径，仅取「最新者」无须内容级元数据
//   - 尾窗读条：claudesessions.Timeline 两跳（relay.go 同式）——解析层已做
//     thinking 跳过 / tool+result 分流 / 单条 200 rune 截断，前端零二次取数
//   - 挑选：done 取最后一条 assistant 文本（relay.pickRelaySummary 同语义）；
//     failed 优先最后一条 error 结果（第一现场），无则回落 assistant 文本
//   - 出域纪律：压平单行 → mask.MaskText（P-108）→ rune 截断（先遮蔽后截断，
//     截断边界不劈开模式命中，webhook.go 同序）；前端 agentTaskNotify 另过
//     sensitiveMask 兜底（P-197 展示面双保护同纪律）
//
// 尽力而为语义：任一步不可得（远程键/已关闭会话/无目录/非 claude 会话/
// transcript 缺失/空结论）即不写字段——空结论保持纯状态体，通知文案不硬凑；
// 摘要绝不影响上报主链（不 400 不 500）。载荷已携 summary 键（agent 自带）
// 以原样为准，服务端不覆写——agent 可自报精准摘要，手册已登记该契约。

import (
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"codecombo/server/claudesessions"
	"codecombo/server/mask"
	"codecombo/server/terminal"
)

const (
	// taskNotifyTailEntries 尾窗条数：relay.go relayTailEntries 同口径（结论
	// 价值集中在会话收尾，60 条覆盖收尾一段）
	taskNotifyTailEntries = 60
	// taskNotifyWindowSkew transcript 时间窗匹配的时钟容差（postmortem
	// pmWindowSkew 同值）：窗 = [会话创建−skew, now+skew]
	taskNotifyWindowSkew = 2 * time.Minute
	// taskNotifySummaryRunes 服务端摘要 rune 封顶：解析层单条已截 200，此处
	// 兜底再截（值不小于解析层上限——二次截断只在拼装意外增长时生效），
	// 前端展示另有 100 rune 截断留足余量
	taskNotifySummaryRunes = 200
)

// attachTaskProgressSummary 终态载荷顺带结论摘要（OpsNotify 发布口调用，限流
// 放行之后——被丢弃的上报不花摘要提取的 IO）。就地写 payload["summary"]；
// 非终态/非对象载荷/已携 summary 的原样返回
func attachTaskProgressSummary(payload interface{}) {
	m, ok := payload.(map[string]interface{})
	if !ok {
		return
	}
	status, _ := m["status"].(string)
	if status != "done" && status != "failed" {
		return
	}
	if _, present := m["summary"]; present {
		return // agent 自带上报以原样为准（手册登记的逃逸口）
	}
	terminalID, _ := m["terminalId"].(string)
	summary := buildTaskNotifySummary(strings.TrimSpace(terminalID), status == "failed", time.Now())
	if summary == "" {
		return // 空结论不硬凑（纯状态体），空串字段也不写
	}
	m["summary"] = summary
}

// buildTaskNotifySummary terminalId → 单行已遮蔽摘要（尽力而为，空串=不附）。
// 三段独立成纯函数（pick/transcriptID/压平装箱）供单测夹具直驱，不经
// DefaultManager 依赖
func buildTaskNotifySummary(terminalID string, failed bool, now time.Time) string {
	if terminalID == "" {
		return ""
	}
	sess := terminal.DefaultManager.GetSession(terminalID)
	if sess == nil || strings.TrimSpace(sess.Path) == "" {
		return "" // 远程回流键/已关闭会话/无目录归属：无结论面，如实不附
	}
	sid := taskNotifyTranscriptID(claudesessions.Root(), sess.Path, sess.CreatedAt.Add(-taskNotifyWindowSkew), now.Add(taskNotifyWindowSkew))
	if sid == "" {
		return ""
	}
	tail := pickTaskNotifyTail(claudesessionsTimelineTail(sid), failed)
	if tail == "" {
		return ""
	}
	return truncateRunesSummary(mask.MaskText(taskNotifySingleLine(tail)), taskNotifySummaryRunes)
}

// taskNotifyTranscriptID 目录内时间窗匹配最新 transcript：mtime 落窗的最新
// .jsonl（ReadDir+stat 级，理由见文件头注）。找不到/不可读 = 空串（非 claude
// 会话是常态而非故障）
func taskNotifyTranscriptID(root, dir string, windowStart, windowEnd time.Time) string {
	if root == "" || strings.TrimSpace(dir) == "" {
		return ""
	}
	entries, err := os.ReadDir(filepath.Join(root, claudesessions.EncodePath(dir)))
	if err != nil {
		return ""
	}
	var bestID string
	var bestAt time.Time
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		st, err := e.Info()
		if err != nil {
			continue
		}
		if st.ModTime().Before(windowStart) || st.ModTime().After(windowEnd) {
			continue
		}
		if bestID == "" || st.ModTime().After(bestAt) {
			bestID, bestAt = strings.TrimSuffix(e.Name(), ".jsonl"), st.ModTime()
		}
	}
	return bestID
}

// claudesessionsTimelineTail 尾窗条目两跳取回（relay.go 同式：先 limit=1 探
// total 再取 [total-N, total)；stat 指纹缓存下第二跳零重复解析）。读失败返回
// nil——调用方按空结论降级
func claudesessionsTimelineTail(sessionID string) []claudesessions.TimelineEntry {
	root := claudesessions.Root()
	head, err := claudesessions.Timeline(root, sessionID, 1, 0)
	if err != nil {
		return nil
	}
	offset := head.Total - taskNotifyTailEntries
	if offset < 0 {
		offset = 0
	}
	res, err := claudesessions.Timeline(root, sessionID, taskNotifyTailEntries, offset)
	if err != nil {
		return nil
	}
	return res.Entries
}

// pickTaskNotifyTail 尾窗倒序挑结论：failed 优先最后一条非空 error 结果
// （排障第一现场——命令/测试的报错原文），无则回落最后一条 assistant 文本
// （agent 对失败的自述）；done 只认 assistant 文本（relay.pickRelaySummary
// 同语义）。窗口内两者皆无（纯工具会话/空会话）= 空串不硬凑
func pickTaskNotifyTail(entries []claudesessions.TimelineEntry, failed bool) string {
	assistant := ""
	errResult := ""
	for i := len(entries) - 1; i >= 0; i-- {
		e := entries[i]
		text := strings.TrimSpace(e.Text)
		if text == "" {
			continue
		}
		if assistant == "" && e.Kind == "assistant" {
			assistant = text
		}
		if errResult == "" && failed && e.Kind == "result" && e.Status == "error" {
			errResult = text
		}
		if assistant != "" && (!failed || errResult != "") {
			break
		}
	}
	if failed && errResult != "" {
		return errResult
	}
	return assistant
}

// taskNotifySingleLine 多行结论压平单行（通知体单行语义，postmortem singleLine
// 同式——换行折叠空格，连续空白归一）
func taskNotifySingleLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// truncateRunesSummary rune 截断加省略号（claudesessions.truncateRunes 同形的
// 包内实现——包私有不可跨引，postmortem.truncateRunesLocal 同惯例）
func truncateRunesSummary(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	return string([]rune(s)[:max]) + "…"
}
