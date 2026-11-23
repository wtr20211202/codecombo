package system

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"codecombo/server/agentops"
	"codecombo/server/config"
	"codecombo/server/diagnostics"
	"codecombo/server/middleware"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 诊断包导出（P-20261122-10 S2a「全量日志 + 基础运行态」）：一站式排障入口。
//
//	GET /api/system/diagnostics/export?days=&mask=&probe=
//	  - 缺省：流式回一个 zip（application/zip），内容见 server/diagnostics 包
//	    的 README（随包携带）
//	  - probe=1：只回 manifest 级体量预览 JSON（不打包/不分析/不起命令），
//	    agent 先看体量再决定要不要拉几十 MB 的流式响应
//
// 鉴权：继承 /api/system/* 四件套（router.go 全局 api 组的 LockCSRF +
// LockMiddleware + TokenAuth + AgentGuard）——诊断包含日志原文与运行态，
// 与 servicelogs 同级管理面；**不入 guardedRoutes**（不是高危写面，但外发
// 动作必须留痕）：每次导出成功/失败都 AuditAppend 一条 diagnostics.export。
//
// 为什么不塞进 servicelogs.go：那是 336 行的只读查看器，导出是另一个职责
// （体量预算/流式/单飞/审计）；采集逻辑全在 server/diagnostics（CLI
// `codecombo diagnostics` 复用同一套 collector——服务起不来时端点不可达，
// 离线采集是本案的一半价值）。
//
// 单飞 + 冷却：导出是 20s 级、几十 MB 的流式响应，双击/多标签并发会把磁盘
// IO 与内存复制放大数倍。单飞互斥（409）+ 30s 冷却（429 + Retry-After）——
// 与既有导出族「一次动作一次审计」姿态一致。

const (
	// diagDefaultDays 按日日志默认天数（必改A：默认 3，上限 settings.logRetentionDays）
	diagDefaultDays = 3
	// diagMaxDays 请求侧天数硬上限（再大也只在 retention 内，这里防病态入参）
	diagMaxDays = 31
	// diagCooldown 两次导出的最小间隔
	diagCooldown = 30 * time.Second
	// diagExportBudget 整包采集预算（必改C：整包 20s）
	diagExportBudget = 20 * time.Second
)

// diagExportState 导出闸门（进程级：单飞 + 冷却）。用 mutex 而非 atomic，
// 因为「判定 + 落 lastRun」必须原子
var diagExportState struct {
	mu      sync.Mutex
	running bool
	lastRun time.Time
}

// acquireDiagExport 申请一次导出（ok=false 时 retryAfter>0 表示冷却剩余）
func acquireDiagExport(now time.Time) (ok bool, retryAfter time.Duration) {
	diagExportState.mu.Lock()
	defer diagExportState.mu.Unlock()
	if diagExportState.running {
		return false, 0
	}
	if !diagExportState.lastRun.IsZero() {
		if wait := diagCooldown - now.Sub(diagExportState.lastRun); wait > 0 {
			return false, wait
		}
	}
	diagExportState.running = true
	diagExportState.lastRun = now
	return true, 0
}

func releaseDiagExport() {
	diagExportState.mu.Lock()
	diagExportState.running = false
	diagExportState.mu.Unlock()
}

// diagMaskEnabled mask 参数语义与 servicelogs 逐字一致：缺省开，0/false 显式关
func diagMaskEnabled(raw string) bool {
	v := strings.ToLower(strings.TrimSpace(raw))
	return v != "0" && v != "false"
}

// diagDays 解析天数：非正/非法回落默认，超硬上限钳制（真上限是 retention）
func diagDays(raw string) int {
	n := diagDefaultDays
	if v, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && v > 0 {
		n = v
	}
	if n > diagMaxDays {
		n = diagMaxDays
	}
	return n
}

// diagLogRetentionDays settings.logRetentionDays（同 app.go dailyHandler 的动态
// 读取口：留存 1 天的实例不该被导成 3 天——那 2 天本来就不该存在）
func diagLogRetentionDays() int {
	if s := store.Get(); s != nil {
		if sc := s.Settings.Get(); sc != nil {
			return sc.Server.LogRetentionDaysOrDefault()
		}
	}
	return config.DefaultLogRetentionDays
}

// diagRuntimeInputs 运行态注入面：全部复用既有只读投影（ingress/egress/
// selfcheck/update-status），本函数只做装配，不新造读取路径
func diagRuntimeInputs() *diagnostics.RuntimeInputs {
	rt := &diagnostics.RuntimeInputs{}
	if p, err := IngressProjection(); err == nil {
		rt.Ingress = p
	} else {
		rt.Notes = append(rt.Notes, "ingress projection unavailable: "+err.Error())
	}
	if p, err := EgressProjection(); err == nil {
		rt.Egress = p
	} else {
		rt.Notes = append(rt.Notes, "egress projection unavailable: "+err.Error())
	}
	rt.SelfCheck = SelfCheckReport()
	rt.UpdateStatus = updateStatusData()
	rt.TerminalSessions = diagTerminalSessions()
	return rt
}

// diagTerminalSessions 终端会话摘要（S2b⑥）：数量/状态，**绝不含**会话 id /
// 名称 / 项目路径 / 输出——排障要的是「有没有会话、几个在跑、什么形态」，不是
// 用户终端里的内容。
//
// 口径与 GET /api/terminals/running-count、whoami 配额块同源（OscRunningState /
// RunningState / MaxSessions），不新造状态判定。单次 ListSessions 快照内聚合
// （列表有界 ≤ MaxSessions，读路径零额外分配）。
func diagTerminalSessions() map[string]any {
	sessions := terminal.DefaultManager.ListSessions()
	byKind := map[string]int{}
	byOrigin := map[string]int{}
	byBackend := map[string]int{}
	oscRunning := 0
	probeRunning := 0
	probeKnown := 0
	probeUnknown := 0
	for _, s := range sessions {
		byKind[s.Kind]++
		byOrigin[s.Origin]++
		byBackend[s.Backend]++
		if running, _ := s.OscRunningState(); running {
			oscRunning++
		}
		if running, known := s.RunningState(); known {
			probeKnown++
			if running {
				probeRunning++
			}
		} else {
			probeUnknown++
		}
	}
	return map[string]any{
		"total":  len(sessions),
		"max":    terminal.MaxSessions(),
		"byKind": byKind, "byOrigin": byOrigin, "byBackend": byBackend,
		// oscRunning / probe* 是同快照内的两种运行态来源：OSC 133 帧（三平台
		// 一致）与前台进程探测（平台受限，Windows 恒 unknown）——分开报，
		// 避免把「探测不了」写成「空闲」
		"oscRunning":   oscRunning,
		"oscIdle":      len(sessions) - oscRunning,
		"probeRunning": probeRunning,
		"probeIdle":    probeKnown - probeRunning,
		"probeUnknown": probeUnknown,
		"note":         "counts/status only — no session ids, names, paths or output",
	}
}

// DiagnosticsExport GET /api/system/diagnostics/export —— 诊断包导出/体量探针
func DiagnosticsExport(c *gin.Context) {
	opts := diagnostics.Options{
		DataDir:           config.DataDir(),
		Version:           buildVersion,
		LogDays:           diagDays(c.Query("days")),
		MaxLogDays:        diagLogRetentionDays(),
		Mask:              diagMaskEnabled(c.Query("mask")),
		Source:            "api",
		EffectiveLogLevel: EffectiveLogLevel(),
	}

	// 体量探针：不占单飞/冷却（无 IO 放大），只 stat + 截断决策
	if v := strings.ToLower(strings.TrimSpace(c.Query("probe"))); v == "1" || v == "true" {
		report, err := diagnostics.Probe(opts)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"err": "internal", "msg": err.Error()})
			return
		}
		c.Header("Cache-Control", "no-store")
		c.JSON(http.StatusOK, gin.H{"data": report})
		return
	}

	maskOn := opts.Mask
	now := time.Now()
	ok, retryAfter := acquireDiagExport(now)
	if !ok {
		if retryAfter > 0 {
			c.Header("Retry-After", strconv.Itoa(int(retryAfter.Seconds()+0.5)))
			c.JSON(http.StatusTooManyRequests, gin.H{
				"err": "cooldown",
				"msg": fmt.Sprintf("diagnostics export cooling down, retry in %ds (one export per %ds)", int(retryAfter.Seconds()+0.5), int(diagCooldown.Seconds())),
			})
			return
		}
		c.JSON(http.StatusConflict, gin.H{
			"err": "busy",
			"msg": "diagnostics export already in progress (single-flight — one export at a time)",
		})
		return
	}
	defer releaseDiagExport()

	opts.Now = now
	opts.Deadline = now.Add(diagExportBudget)
	opts.Runtime = diagRuntimeInputs()
	ctx, cancel := context.WithTimeout(c.Request.Context(), diagExportBudget)
	defer cancel()

	bundle, err := diagnostics.Plan(ctx, opts)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"err": "internal", "msg": err.Error()})
		return
	}

	name := "codecombo-diagnostics-" + now.Format("20060102-150405") + ".zip"
	c.Header("Content-Type", "application/zip")
	// 下载名是服务端常量（时间戳），unquoted-token 形式即安全
	c.Header("Content-Disposition", "attachment; filename="+name)
	c.Header("Cache-Control", "no-store")

	cw := &diagCountWriter{w: c.Writer}
	writeErr := bundle.WriteZip(cw)
	detail := fmt.Sprintf("bytes=%d entries=%d days=%d mask=%t", cw.n, len(bundle.Manifest.Entries), opts.LogDays, maskOn)
	if writeErr != nil {
		// 流式输出中途失败（客户端断开/磁盘读错）：已写字节无法撤回，只能断连；
		// 审计按 failure 入账——「导出动作发生过」比结果更重要
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditDiagnosticsExport,
			Result: store.AuditResultFailure,
			IP:     c.ClientIP(),
			Detail: detail + " err=" + writeErr.Error(),
		})
		// 响应头已发出，不能再回 JSON；连接由 gin/net-http 收尾
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditDiagnosticsExport,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: detail,
	})
}

// diagCountWriter 已写字节计数（审计 Detail 与流式体量如实记账）
type diagCountWriter struct {
	w http.ResponseWriter
	n int64
}

func (d *diagCountWriter) Write(p []byte) (int, error) {
	n, err := d.w.Write(p)
	d.n += int64(n)
	return n, err
}

func init() {
	// 智能体手册登记：诊断包导出是 agent 排障的「打包一切」原语（比逐个
	// curl 更省往返，且离线 CLI 形态覆盖服务起不来）。Order 23 紧随 server-logs
	// （22）——同属本机观测/排障面
	agentops.RegisterSection(agentops.Section{
		ID: "diagnostics", Title: "诊断包（一站式排障）", Order: 23,
		Summary: "GET /api/system/diagnostics/export 导出诊断 zip（全模块按日日志+更新链日志+dsh-web.log+crash.log+平台基线+**平台深度采样**〔macOS launchctl print/linux systemctl show+journalctl/unix 进程树/OS 监听表/机器内存〕+存储统计+终端会话摘要，逐行脱敏、凭据路径硬拒）；probe=1 先看体量；服务起不来时用 `codecombo diagnostics --out x.zip` 同一收集器",
		Body: `用户报「服务不对/升级失败/没日志」时，先拉一个诊断包再问细节——比逐个
端点拼证据少一半往返，且包内 README 说明脱敏边界与阅读顺序。

- GET /api/system/diagnostics/export?probe=1        体量预览（不打包）：
                                                    {data:{files:[{name,status,originalBytes,includedBytes}],totals,limits}}
- GET /api/system/diagnostics/export?days=3&mask=1  导出 zip（流式，application/zip）
  - days   按日主日志天数（默认 3，上限 settings.logRetentionDays 与 31）
  - mask   敏感值遮蔽，缺省开；mask=0 关（取证对账档）
  - 单飞互斥（并发 409）+ 30s 冷却（429 + Retry-After）
  - 每次导出成功/失败都入审计（action=diagnostics.export，Detail 只记字节/条目/天数/遮蔽）

包内容：manifest.json（每条目 present/truncated/absent/derived/omitted/denied
+ 原大小/含入字节/省略原因）、logs-summary.txt（每文件总行/级别计数/模块前缀
top15/首末时间戳）、errors.txt（WARN+ERROR 原文，2 万行封顶）、platform.txt
（OS/arch/CPU/内存/时区/磁盘/内核探针 + 平台深度采样：macOS「launchctl print」
〔state/runs/last exit code，#26 组杀第一手证据〕、Linux「systemctl show
-p Restart,KillMode,Type,User」+「journalctl -n 200」best-effort、unix「ps」
进程树〔过滤本二进制+tmux〕、OS 监听表〔ss/lsof/netstat〕、机器内存）、
state/runtime.json（服务形态/argv/CC_* env 白名单 + ingress/egress 既有投影
+ 终端会话摘要〔数量/状态，不含 id/名称/路径/输出〕）、state/selfcheck.json、
state/update-status.json、state/update-result.json、state/pid.txt（含版本行）、
state/data-dir-inventory.txt（只元数据）、state/storage.json（data/ 大小/条目数，
只统计不入内容）、logs/（原文：按日全模块日志 + update.log/update-subprocess.log/
update-restart.log/crash.log/dsh-web.log + logs/*.log）。

平台深度采样纪律：单命令 3s、无特权、失败/无权限 → skipped 不标红；Windows
只「sc query」+「netstat」（不做进程树——扫描贵、值低）；macOS「log show」
**不自动跑**（慢 + 「<private>」遮挡），命令与 DiagnosticReports 路径见包内 README。

缺席即证据：manifest 里 status=absent 的条目（如四个更新链日志）说明那条链
根本没走到——不要把它当"没收集到"忽略。
凭据永不入包：master-key / data/ / config.json / *.pem / *.key / id_* /
*cookie* / *authorization* 硬拒（status=denied）；日志行过 mask.MaskText，
DataDir→$DATA_DIR、家目录→~。主机名/内网 IP/项目路径/端口刻意保留（排障必需）。

## 推荐用法（示例）

` + "```bash" + `
# 先看体量
curl "{{BASE}}/api/system/diagnostics/export?probe=1" -H "X-Lock-Token: $CC_LOCK_TOKEN"
# 再拉包
curl -o diag.zip "{{BASE}}/api/system/diagnostics/export?days=3" -H "X-Lock-Token: $CC_LOCK_TOKEN"
` + "```" + `
服务起不来时端点不可达：` + "`codecombo diagnostics --out diag.zip`" + ` 用同一收集器离线采集
（store 派生的 selfcheck/update-status 会如实标注 skipped）。`,
	})
}
