package diagnostics

import (
	"encoding/json"
	"fmt"
)

// 进程内时间线派生文件装配（P-20261124-1 S1②③④）：requests.json / stalls.json /
// goroutine 栈 / share-health —— 全部来自进程内存环，导出时才落盘。
//
// 与 collector.go 分开的理由：collector 的职责是「文件枚举 + 预算 + manifest +
// zip」，进程内观测是另一套数据源（无文件、无 stat、无读盘），混写会让两边的
// 预算/失败模型互相污染。collector.go 也守着 800 行体量纪律。

// derivedSection 一个派生文件（名字/内容/缘由）
type derivedSection struct {
	Name    string
	Content string
	Reason  string
}

// inProcessDerivedSections 进程内时间线派生文件
func inProcessDerivedSections(opts Options, red *Redactor) []derivedSection {
	out := []derivedSection{
		{
			Name:    "state/requests.json",
			Content: renderRequestsJSON(opts.Now, red),
			Reason:  "in-process ring: only duration>=1s / status>=500 / panic requests (200 entries); never query/body/header",
		},
		{
			Name:    "state/stalls.json",
			Content: renderStallsJSON(opts.Now, red),
			Reason:  "in-process watchdog: wall vs monotonic clock deltas, 1s sampling, stalls>=2s (32 entries); goroutine profiles are separate entries",
		},
	}
	snap := WatchdogSnapshot()
	for i, d := range snap.Dumps {
		header := fmt.Sprintf("# goroutine profile captured after a %dms stall at %s (pprof debug=1: identical stacks aggregated)\n"+
			"# truncated=%t bytes=%d — build paths normalized; tokens are not claimed to be absent, they are never read from goroutines\n\n",
			d.TriggerMS, d.CapturedAt, d.Truncated, d.Bytes)
		out = append(out, derivedSection{
			Name:    fmt.Sprintf("state/goroutine-stalls-%02d.txt", i+1),
			Content: header + d.Text,
			Reason:  "derived at export time only (never written while stalled); ring keeps at most 3, at most one capture per 10 minutes",
		})
	}
	return out
}

// runtimeDerivedSections 注入面派生文件（share-health / self-probe）
func runtimeDerivedSections(opts Options) []derivedSection {
	var shareHealth, selfProbe any
	if opts.Runtime != nil {
		shareHealth = opts.Runtime.ShareHealth
		selfProbe = opts.Runtime.SelfProbe
	}
	return []derivedSection{
		{
			Name:    "state/share-health.json",
			Content: renderShareHealthJSON(shareHealth),
			Reason:  "GET /api/share stage timings + slow share items (recent 20 + slowest 20); no token/path/query",
		},
		{
			Name:    "state/self-probe.json",
			Content: renderSelfProbeJSON(selfProbe),
			Reason:  "TCP reachability only (1s dial to addresses the instance is bound to) — does NOT validate certificates or external routing",
		},
	}
}

// renderSelfProbeJSON 自连接探测结果（nil = 未做/不可用，写 skipped）
func renderSelfProbeJSON(v any) string {
	if v == nil {
		return `{"status":"skipped","reason":"self-probe not run (offline CLI collection, or diagnostics request not in deep mode)"}` + "\n"
	}
	return marshalAnyJSON(v)
}

// marshalAnyJSON 通用 JSON 渲染（注入面是 any：api 层投影/本地结构都可）
func marshalAnyJSON(v any) string {
	buf, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return "{}\n"
	}
	return string(buf) + "\n"
}

// renderShareHealthJSON 分享管理接口的阶段耗时（nil = 未装配写 skipped，
// 不写空对象——reader 不用猜「0 次慢调用」还是「没采」）
func renderShareHealthJSON(v any) string {
	if v == nil {
		return `{"status":"skipped","reason":"GET /api/share not assembled in this process (share module not started, or offline collection)"}` + "\n"
	}
	return marshalAnyJSON(v)
}
