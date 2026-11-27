package diagnostics

import (
	"encoding/json"
	"fmt"
	"strings"
)

// 诊断包内的 README（P-20261122-10 必改D⑥/必改G）：脱敏边界、怎么读、
// 怎么开 Debug——包会离开这台机器，说明必须随包走，不能只活在 runbook 里。
//
// 双语（zh + en）是刻意选择：用户多半中文、维护者/issue 读者可能英文；
// 同一份文本两段并置，避免「包里没说明 → 外发未脱敏数据」的隐性代价。

// renderReadme 生成包内 README.txt
func renderReadme(opts Options) string {
	var b strings.Builder
	b.WriteString("codecombo diagnostics bundle\n")
	b.WriteString("===========================\n\n")
	b.WriteString("generatedAt : " + opts.Now.Format("2006-01-02T15:04:05Z07:00") + "\n")
	b.WriteString("version     : " + opts.Version + "\n")
	b.WriteString("source      : " + opts.Source + " (" + collectionSourceNote(opts.Source) + ")\n")
	b.WriteString("log days    : " + itoa(opts.LogDays) + "\n")
	b.WriteString("masked      : " + boolStr(opts.Mask) + "\n\n")

	b.WriteString("## what is inside / 包内内容\n\n")
	b.WriteString("  manifest.json                  every entry: original size / included bytes / omitted / status\n")
	b.WriteString("                                 (present | truncated | absent | derived | omitted | denied)\n")
	b.WriteString("  logs-summary.txt               per file: total lines, level counts, top module prefixes, first/last timestamps\n")
	b.WriteString("  errors.txt                     WARN+ERROR lines verbatim (capped), grouped per file, newest first\n")
	b.WriteString("  platform.txt                   OS/arch/Go, CPU, memory, timezone, data disk, kernel/OS probes\n")
	b.WriteString("                                 + deep sampling: launchd job / systemd unit props / journal tail /\n")
	b.WriteString("                                 listening sockets / process tree / machine memory\n")
	b.WriteString("  state/runtime.json             service form / argv / whitelisted env + ingress & egress projections\n")
	b.WriteString("                                 + terminal session summary (counts/status only)\n")
	b.WriteString("  state/selfcheck.json           GET /api/selfcheck report (from the running service)\n")
	b.WriteString("  state/update-status.json       update state machine + last persisted update-result\n")
	b.WriteString("  state/update-result.json       raw update-result.json if it existed on disk\n")
	b.WriteString("  state/pid.txt                  PID file verbatim (pid/port/loopback/scheme/version lines)\n")
	b.WriteString("  state/data-dir-inventory.txt   data dir metadata ONLY (mode/size/entry counts; no content)\n")
	b.WriteString("  state/storage.json             data dir storage stats ONLY (top-level dirs: entries + bytes)\n")
	b.WriteString("  state/large-files.json         top 20 files from the SAME storage walk (data/ file names never listed)\n")
	b.WriteString("  logs/                          full raw logs: daily codecombo-YYYY-MM-DD.log, update chain\n")
	b.WriteString("                                 (update.log / update-subprocess.log / update-restart.log / crash.log),\n")
	b.WriteString("                                 dsh-web.log, and any other logs/*.log\n\n")

	b.WriteString("## v2 forensics / v2 取证面（P-20261124-1）\n\n")
	b.WriteString("Read state/collection-report.json FIRST: it lists every probe with ok|skipped|timeout|budget|denied,\n")
	b.WriteString("its duration and the skip reason — so \"this machine does not have it\" is distinguishable from\n")
	b.WriteString("\"the collector gave up\". 先读 collection-report：每个探针的结局/耗时/跳过原因都在那里。\n\n")
	b.WriteString("  slow-requests.txt              [GIN] access-log requests >=1s (top 500). startedAt = completedAt - latency.\n")
	b.WriteString("                                 Query strings are DROPPED at parse time; routes are templated (:id).\n")
	b.WriteString("  stalls.txt                     primary source = in-process watchdog (1s ticks, wall vs monotonic clock:\n")
	b.WriteString("                                 wall >> mono = suspend/host pause, both together = in-process stall).\n")
	b.WriteString("                                 Log gaps are context only; a gap without a request spanning it is likely-idle.\n")
	b.WriteString("  dsh-summary.txt                dsh-web.log sampled windows (head 8MiB + tail 16MiB + middle samples);\n")
	b.WriteString("                                 line counts are ESTIMATED (estimated=true) — magnitude, not accounting.\n")
	b.WriteString("  tls-summary.txt                TLS handshake errors inside the packed logs (+ journal sample).\n")
	b.WriteString("  state/requests.json            slow/5xx/panic request ring (200). Never query/body/header.\n")
	b.WriteString("  state/stalls.json              watchdog stalls >=2s (32) — offline CLI collection writes skipped.\n")
	b.WriteString("  state/goroutine-stalls-NN.txt  pprof aggregated goroutine profiles (only for stalls >=10s, <=1MiB,\n")
	b.WriteString("                                 at most 3 in memory / one capture per 10 min; generated at export time).\n")
	b.WriteString("  state/host.json                Linux /proc: mountinfo/diskstats/PSI/status/wchan/io/limits/cgroup.\n")
	b.WriteString("                                 Mount rows are filtered to the data dir + project roots (<=20), never stat'ed.\n")
	b.WriteString("                                 + process section (ALL platforms, P-20261126-3): CPU%/RSS/handles/threads —\n")
	b.WriteString("                                 Windows=GetProcessTimes/psapi/toolhelp, Linux=/proc, macOS=ps best-effort.\n")
	b.WriteString("                                 The basis field states each platform's exact semantics (no cross-platform normalization).\n")
	b.WriteString("  state/host-history.json        10s x 360 points (1h): loadavg, PSI avg10, disk deltas, in-flight, log-write ms\n")
	b.WriteString("                                 (Linux) + processCpuPercent/processRssMb on ALL platforms. /proc-only fields that\n")
	b.WriteString("                                 a platform lacks are listed in skippedFields. Guest side only — host/hypervisor\n")
	b.WriteString("                                 pauses still need host logs.\n")
	b.WriteString("  state/goruntime.json           Go runtime snapshot (MemStats / GC pause quantiles / goroutines / OS threads)\n")
	b.WriteString("                                 + trend ring 60s x 120 points (2h): heap/goroutine/pause-INCREMENTS — locate\n")
	b.WriteString("                                 leaks, GC storms, goroutine pile-ups; cross-check stalls.json timestamps.\n")
	b.WriteString("                                 pauseTotalMsDelta is an increment (the absolute counter only ever grows).\n")
	b.WriteString("                                 CLI form: scope=collector-process — figures are the COLLECTOR, not the service.\n")
	b.WriteString("  state/routes.json              route-level hot-spot ranking, 24h window in fixed hourly buckets:\n")
	b.WriteString("                                 count/totalMs/maxMs/avgMs/4xx/5xx per route template (c.FullPath, same as\n")
	b.WriteString("                                 requests.json), <=64 rows by totalMs desc. WS connections count toward\n")
	b.WriteString("                                 count/status but NOT totalMs/maxMs (a WS duration is the connection lifetime).\n")
	b.WriteString("                                 *api-other*/*static* = the unmatched-route tracks (requests.json writes the\n")
	b.WriteString("                                 single sentinel \"unmatched\" for the same requests). No path/query ever.\n")
	b.WriteString("  profiles/{heap,goroutine,block,mutex}  deep-only pprof profiles (standard gzip protobuf; offline:\n")
	b.WriteString("                                 `go tool pprof <binary> profiles/heap`). Binary profiles are written WHOLE\n")
	b.WriteString("                                 or dropped WHOLE (marked skipped(oversized)) — never truncated, truncation\n")
	b.WriteString("                                 would be dead bytes. goroutine is text (debug=1 aggregation) and may be\n")
	b.WriteString("                                 linearly truncated <=512KB. block/mutex sampling is enabled at service\n")
	b.WriteString("                                 startup (low rates); CC_DIAG_PROFILE_RATE=0 disables both — an empty\n")
	b.WriteString("                                 profile means \"sampling off or no contention\", check goruntime.json\n")
	b.WriteString("                                 profileRates + the CC_DIAG_PROFILE_RATE line in state/runtime.json.\n")
	b.WriteString("                                 Binary faces skip the text redactor; -trimpath builds embed no\n")
	b.WriteString("                                 build-machine absolute paths (manifest notes this when profiles are packed).\n")
	b.WriteString("  profiles/cpu                   deep + explicit &cpu=1 only: 5s CPU profile taken INSIDE the export window\n")
	b.WriteString("                                 (it overlaps the collection work — it INCLUDES the export's own CPU; the\n")
	b.WriteString("                                 deep budget is not extended by it). Conflicts with a loopback\n")
	b.WriteString("                                 /debug/pprof/profile session are reported as skipped(already in use).\n")
	b.WriteString("  state/tls.json                 certificate PUBLIC metadata (fingerprint/validity/DNS+IP SAN/self-signed)\n")
	b.WriteString("                                 and SAN IPs missing from this host. The private key is NEVER read.\n")
	b.WriteString("  state/net.json                 addresses/MTU/default route/DNS/TCP states+retransmits/proxy env hosts\n")
	b.WriteString("                                 (only scheme://host:port — userinfo never packed).\n")
	b.WriteString("  state/self-probe.json          deep mode only: 1s TCP connect to the addresses this instance is bound to.\n")
	b.WriteString("                                 Label tcpReachabilityOnly — it does NOT validate certificates or routing.\n")
	b.WriteString("  state/share-health.json        stage timings for GET /api/share (recent 20 + slowest 20); no token/path.\n")
	b.WriteString("  state/runtime.json watcher     fs-watcher event/overflow counters and error class (no paths, no raw errors).\n")
	b.WriteString("  state/browser.json             CONDITIONAL: browser-side diagnostic report (failing XHR/WS close codes)\n")
	b.WriteString("                                 only when the export URL carried ?clientReport=1 (the web UI POSTs a\n")
	b.WriteString("                                 fresh snapshot automatically when you click Export diagnostics) AND a\n")
	b.WriteString("                                 report was POSTed by the same browser within the 5-minute session window.\n")
	b.WriteString("                                 Entries capped at\n")
	b.WriteString("                                 the latest 50; paths/UA/host are not accepted from the client (page.host is\n")
	b.WriteString("                                 filled by THIS server from the request Host). Stored in memory only,\n")
	b.WriteString("                                 cleared on restart. status=absent here means the window had no report —\n")
	b.WriteString("                                 it does not imply the browser ring was empty.\n\n")
	b.WriteString("HSTS: only sent when TLS is enabled; browsers IGNORE HSTS for IP-literal hosts (RFC 6797 2.3).\n")
	b.WriteString("If clients reject the certificate: delete cert.pem + key.pem and restart (the service re-issues a\n")
	b.WriteString("self-signed cert; clients re-trust the new fingerprint), or install a CA-issued certificate.\n")
	b.WriteString("HSTS 对 IP 字面量主机不生效；自签被拒时删 cert.pem+key.pem 重启重签，或换 CA 证书。\n\n")
	b.WriteString("Residual risk (stated, not hidden): stat/statfs/WalkDir kernel calls cannot be cancelled. Every blocking\n")
	b.WriteString("probe runs behind the collection deadline and reports status=timeout, but the goroutine itself may stay\n")
	b.WriteString("blocked until the hung mount recovers. The bundle keeps being produced; full isolation is NOT claimed.\n")
	b.WriteString("残余风险：stat/statfs/WalkDir 的内核调用不可取消——超时后出包继续，但 goroutine 可能阻塞到挂载恢复。\n\n")

	b.WriteString("## platform deep sampling / 平台深度采样\n\n")
	b.WriteString("Every probe is read-only, unprivileged, capped at 3s per command; a missing tool or a\n")
	b.WriteString("permission denial is recorded as \"skipped\" (not an error). Outputs are masked and the\n")
	b.WriteString("data directory is normalized to $DATA_DIR like every other line in this bundle.\n")
	b.WriteString("所有探测只读、不提权、单命令 3s 上限；缺工具/无权限记 skipped（不是错误）。\n\n")
	b.WriteString("- macOS: `launchctl print gui/<uid>/com.codecombo` (capped at 200 lines / 32KiB) carries\n")
	b.WriteString("  the job state, run count and last exit code — the first-hand evidence for the launchd\n")
	b.WriteString("  group-kill failure class (#26 in docs/release-runbook.md).\n")
	b.WriteString("  `log show` is NEVER run automatically: it takes seconds to minutes and redacts payloads\n")
	b.WriteString("  as `<private>`. Run it yourself when needed:\n")
	b.WriteString("    log show --last 30m --predicate 'process == \"codecombo\"' --style compact\n")
	b.WriteString("  Crash reports (path hint only, not collected): ~/Library/Logs/DiagnosticReports/\n")
	b.WriteString("- Linux: `systemctl show -p Restart,KillMode,Type,User <unit>` (KillMode=process is what\n")
	b.WriteString("  protects the update subprocess — same #26 discriminator) + `journalctl -u <unit> -n 200\n")
	b.WriteString("  --no-pager` best-effort (permission denied -> skipped) + `ss -ltnp` listening sockets.\n")
	b.WriteString("- Windows: `sc query Codecombo` state + `netstat -ano -p tcp` listeners. The process tree\n")
	b.WriteString("  is NOT collected on Windows (scan cost vs diagnostic value): use\n")
	b.WriteString("  `tasklist /FI \"PID eq <pid>\"` with the pid from state/runtime.json.\n")
	b.WriteString("- unix process tree: `ps -axo pid,ppid,etime,command` filtered to this binary plus up to\n")
	b.WriteString("  three tmux lines (the full ps table is neither needed nor safe to ship).\n")
	b.WriteString("- machine memory: /proc/meminfo (Linux), `sysctl -n hw.memsize` (macOS), `wmic` (Windows,\n")
	b.WriteString("  absent on newer Windows 11 -> skipped). The Go heap figures are process-scoped instead.\n\n")

	b.WriteString("## how to read / 怎么读\n\n")
	b.WriteString("1. Start with manifest.json: entries marked \"absent\" are evidence too — e.g. a missing\n")
	b.WriteString("   update.log or update-subprocess.log tells you the update chain never got that far.\n")
	b.WriteString("2. logs-summary.txt gives you the shape (which days, which levels, which modules) without\n")
	b.WriteString("   opening the big files. modules: <name>=<count> is the first word of each slog msg.\n")
	b.WriteString("3. errors.txt is the shortest path to the failure: WARN/ERROR first occurrence per signature,\n")
	b.WriteString("   with a count/first/last table at the end (repeated TLS storms collapse into one row).\n")
	b.WriteString("4. For \"it hung / it was slow\": slow-requests.txt (which request, how long) -> stalls.txt\n")
	b.WriteString("   (suspend vs in-process stall) -> state/host.json (mount/IO/PSI) -> logs/ for raw context.\n")
	b.WriteString("5. Then open logs/ for the surrounding context of the exact timestamp you care about.\n")
	b.WriteString("   排障顺序同理：manifest → summary → errors → slow-requests/stalls/host → 原文对应时刻。\n\n")

	b.WriteString("## masking boundary / 脱敏边界\n\n")
	b.WriteString("- Credentials are NOT in this bundle by construction: master-key, data/, config.json,\n")
	b.WriteString("  *.pem / *.key / id_* / *cookie* / *authorization* are excluded (see manifest status \"denied\").\n")
	b.WriteString("- Log lines were passed through the product's sensitive-value masker (tokens, password/token\n")
	b.WriteString("  assignments, cloud keys -> ***) unless mask was explicitly disabled (masked: false above).\n")
	b.WriteString("- Paths: the data directory appears as $DATA_DIR and the home directory as ~.\n")
	b.WriteString("- NOT redacted on purpose (needed for troubleshooting): host names, LAN IPs, project paths,\n")
	b.WriteString("  ports, versions. This bundle is \"credentials, not topology\".\n")
	b.WriteString("- 边界=凭据不是拓扑：主机名/内网 IP/项目路径/端口刻意保留（排障必需）。\n")
	b.WriteString("- The bundle stays on your machine; YOU decide whether and what to share. Review before\n")
	b.WriteString("  posting publicly. / 包留在你的机器上，外发责任在用户：公开前请自行再过一遍。\n\n")

	b.WriteString("## limits / 体积与流式\n\n")
	b.WriteString(fmt.Sprintf("- Per log file: <= %s packed whole; larger files keep the first %s and the last %s\n",
		humanBytes(fullLogMaxBytes), humanBytes(logHeadBytes), humanBytes(logTailBytes)))
	b.WriteString("  with an explicit `[TRUNCATED n bytes omitted]` line at the seam (failure evidence is at the tail).\n")
	b.WriteString(fmt.Sprintf("- Raw budget: %s total; when it is hit, OLDER files are dropped first (today's file is never trimmed).\n",
		humanBytes(rawBudgetBytes)))
	b.WriteString(fmt.Sprintf("- Zip cap: %s. If it is ever hit, TRUNCATED.txt lists the planned-but-unwritten entries;\n",
		humanBytes(zipCapBytes)))
	b.WriteString("  manifest.json was written first and remains complete.\n")
	b.WriteString("- The archive is streamed: an interrupted download yields a partial zip (entries written so far),\n")
	b.WriteString("  so re-export if the browser reported a failed download. / 流式输出：下载中断只会得到半截包，请重导。\n")
	b.WriteString("- Deep mode (`?deep=1` / `--deep`, manifest \"deep\": true) raises the collection budget from 20s to\n")
	b.WriteString("  30s and adds self-probe / wider TLS window / dmesg / pprof profiles. Deep does not remove any\n")
	b.WriteString("  core section. `&cpu=1` adds a 5s CPU profile INSIDE that 30s budget (overlapping, not additive).\n")
	b.WriteString("  Offline CLI (`source: cli`) skips pprof profiles entirely: they would describe the collector\n")
	b.WriteString("  process, not the service.\n\n")

	b.WriteString("## turning on debug logs / 怎么开 Debug\n\n")
	b.WriteString("CC_LOG_LEVEL=debug|info|warn|error (env only, no settings toggle). Service forms: change the\n")
	b.WriteString("unit/plist/SCM environment then restart; foreground: `CC_LOG_LEVEL=debug codecombo --serve -p 9999`.\n")
	b.WriteString("The effective level is echoed in this bundle (state/selfcheck.json version item suffix `log=<level>`).\n")
	b.WriteString("Debug amplifies log volume (per-file events, 10s drop stats) — enable it in a bounded window.\n")
	b.WriteString("中文：CC_LOG_LEVEL=debug 后重启服务；生效级别见 selfcheck 的 version 条目尾缀 log=<level>。\n\n")

	b.WriteString("## where the full picture is documented / 完整排查手册\n\n")
	b.WriteString("docs/release-runbook.md §11 (\"排查手册\") in the codecombo repository: symptom -> first file to read,\n")
	b.WriteString("the five-line update discriminator, and the log-role table.\n")
	return b.String()
}

func collectionSourceNote(source string) string {
	if source == "cli" {
		return "collected offline by `codecombo diagnostics`: store-derived sections are skipped"
	}
	return "collected by the running service via GET /api/system/diagnostics/export"
}

// renderRuntimeSections state/selfcheck.json 与 state/update-status.json：
// 直接透传注入的既有投影（api 层复用 GET /api/selfcheck 与 /api/updates/status
// 的同一份数据构造函数，零新造）。CLI 形态如实写 skipped 占位。
func renderRuntimeSections(opts Options, _ *Redactor) (selfCheck, updateStatus string, notes []string) {
	selfCheck = skippedSection("selfcheck",
		"only available from the running service (GET /api/selfcheck) — offline CLI collection cannot read the store-backed settings")
	updateStatus = skippedSection("update-status",
		"only available from the running service (GET /api/updates/status) — see state/update-result.json for the last persisted result")
	if opts.Runtime == nil {
		notes = append(notes, "selfcheck/update-status skipped: offline CLI collection")
		return selfCheck, updateStatus, notes
	}
	if opts.Runtime.SelfCheck != nil {
		if b, err := json.MarshalIndent(opts.Runtime.SelfCheck, "", "  "); err == nil {
			selfCheck = string(b) + "\n"
		}
	} else {
		notes = append(notes, "selfcheck section unavailable in this collection source")
	}
	if opts.Runtime.UpdateStatus != nil {
		if b, err := json.MarshalIndent(opts.Runtime.UpdateStatus, "", "  "); err == nil {
			updateStatus = string(b) + "\n"
		}
	} else {
		notes = append(notes, "update-status section unavailable in this collection source")
	}
	return selfCheck, updateStatus, notes
}

func skippedSection(kind, reason string) string {
	b, _ := json.MarshalIndent(map[string]string{"status": "skipped", "section": kind, "reason": reason}, "", "  ")
	return string(b) + "\n"
}
