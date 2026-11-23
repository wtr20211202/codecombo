package diagnostics

import (
	"encoding/json"
	"os"
	"time"

	"codecombo/server/update"
)

// 基础运行态渲染（P-20261122-10 必改B）：runtime.json 是「这台机器上它是怎么
// 跑起来的」的答案——服务形态决定读日志的第一站，argv/env 决定它到底加载了
// 哪套配置，ingress/egress 是既有的安全投影（复用不新造）。
//
// 独立成文件（不混进采集主链 collector.go）：运行态是「注入 + 渲染」，
// 与文件枚举/预算/zip 写出是两件事。

// renderRuntime runtime.json：服务形态/argv/CC_* env 白名单 + 注入的既有投影
func renderRuntime(opts Options, red *Redactor) string {
	form, formDetail := update.SuperviseForm()
	doc := map[string]any{
		"generatedAt":       opts.Now.Format(time.RFC3339),
		"source":            opts.Source,
		"serviceForm":       form,
		"serviceFormDetail": red.Line(formDetail),
		"pid":               os.Getpid(),
		"ppid":              os.Getppid(),
		"argv":              redArgv(red),
		"env":               runtimeEnv(red),
		"dataDir":           red.Path(opts.DataDir),
	}
	if opts.EffectiveLogLevel != "" {
		doc["effectiveLogLevel"] = opts.EffectiveLogLevel
	}
	var notes []string
	if opts.Runtime != nil {
		if opts.Runtime.Ingress != nil {
			doc["ingress"] = opts.Runtime.Ingress
		}
		if opts.Runtime.Egress != nil {
			doc["egress"] = opts.Runtime.Egress
		}
		notes = append(notes, opts.Runtime.Notes...)
	} else {
		notes = append(notes, "store-derived runtime sections skipped: collecting from CLI while the service store is not initialized (see ingress/egress projections via GET /api/system/ingress-overview|egress-overview once the service is up)")
	}
	// 终端会话摘要（S2b⑥）：数量/状态，绝不含 id/名称/路径/输出。CLI 形态
	// 没有会话管理器——显式 skipped 比静默缺席好读（读者不用猜是 0 个会话
	// 还是没采）
	if opts.Runtime != nil && opts.Runtime.TerminalSessions != nil {
		doc["terminalSessions"] = opts.Runtime.TerminalSessions
	} else {
		doc["terminalSessions"] = map[string]any{
			"status": "skipped",
			"reason": "offline CLI collection has no terminal manager; start the service and export via GET /api/system/diagnostics/export",
		}
	}
	if len(notes) > 0 {
		doc["notes"] = notes
	}
	buf, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "{}\n"
	}
	return string(buf) + "\n"
}

// runtimeEnv CC_* env 白名单（必改B/D：只白名单，值过 mask + 路径归一）。
// 不在白名单的 env 一律不收集——env 是最容易混进凭据的面（*_TOKEN/*_KEY）。
var envWhitelist = []string{"CC_DATA_DIR", "CC_TLS", "CC_LOG_LEVEL", "CC_PORT", "HOME", "PATH"}

func runtimeEnv(red *Redactor) map[string]string {
	out := map[string]string{}
	for _, k := range envWhitelist {
		if v, ok := os.LookupEnv(k); ok {
			out[k] = red.Line(v)
		}
	}
	return out
}

func redArgv(red *Redactor) []string {
	argv := make([]string, 0, len(os.Args))
	for _, a := range os.Args {
		argv = append(argv, red.Line(a))
	}
	return argv
}
