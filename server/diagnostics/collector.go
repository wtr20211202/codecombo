package diagnostics

import (
	"archive/zip"
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 诊断包收集器（P-20261122-10 S2a「全量日志 + 基础运行态」）：
// 一站式排障入口——把「服务为什么不对」需要的全部证据装成一个 zip。
//
// 为什么独立成包（不塞进 server/api/system/servicelogs.go）：
//   - 端点只是薄壳（鉴权/单飞/审计），采集逻辑必须能被 CLI 复用——服务起不来
//     时端点本身就是不可达的，`codecombo diagnostics --out x.zip` 是同一套
//     收集器（用户定向：不能只有控制台入口）；
//   - api/system 已被体量守卫盯着（settings.go 1119 行）；导出模块单开文件
//     是评审硬要求（别把 336 行 servicelogs.go 长成导出模块）。
//
// 分层：本包只依赖 stdlib + sysinfo/update/mask（叶子方向），不 import
// api/*，store 派生面由调用方以 RuntimeInputs 注入（api 层复用 ingress/egress
// 既有投影，零新造暴露面）。
//
// 预算与流式（必改E）：
//   - 单文件 ≤8MiB 全带；>8MiB 头 2MiB + 尾 14MiB（尾部偏置——失败证据在尾），
//     seam 写 `[TRUNCATED n bytes omitted]` 显式行；
//   - raw 总预算 96MiB：新→旧顺序装包，超预算只砍更旧的文件（当天文件已在
//     头部装完，尾部证据绝不因预算被砍）；
//   - zip 上限 64MiB：文本 5-10x 压缩后正常远低于此，触顶时停止装后续条目
//     并在末尾补 TRUNCATED.txt 列明被丢弃的条目（manifest 恒完整——它在前
//     面已写定，TRUNCATED.txt 是运行期预算的补充说明）；
//   - archive/zip 直写调用方 io.Writer（API 侧是 c.Writer）：头先出、流式，
//     中途失败只能断连（无法回滚已写字节）——写进 README 与 runbook。
const (
	// rawBudgetBytes 原文入包总预算
	rawBudgetBytes = 96 << 20
	// zipCapBytes zip 输出上限（防病态不可压缩内容撑爆响应）
	zipCapBytes = 64 << 20
	// defaultLogDays 按日日志默认天数（上限 settings.logRetentionDays）
	defaultLogDays = 3
	// totalBudget 整包采集预算（必改C 纪律：整包 20s）
	totalBudget = 20 * time.Second
)

// 条目状态（manifest.status 的稳定取值；前端/agent 可编程分支）
const (
	// StatusPresent 全量入包
	StatusPresent = "present"
	// StatusTruncated 头+尾截断入包（omittedBytes 记省略字节）
	StatusTruncated = "truncated"
	// StatusAbsent 预期存在却缺席——四个更新链日志的缺席本身就是判别证据
	StatusAbsent = "absent"
	// StatusDerived 包内生成的派生文件（summary/errors/manifest/…）
	StatusDerived = "derived"
	// StatusOmitted 预算裁掉（更旧的文件；绝不砍当天文件）
	StatusOmitted = "omitted"
	// StatusDenied 凭据 denylist 硬拒（整条不入包）
	StatusDenied = "denied"
)

// Options 采集参数
type Options struct {
	// DataDir 数据目录（config.DataDir()）
	DataDir string
	// Version 构建版本（manifest/README 头部）
	Version string
	// LogDays 按日主日志天数（默认 3）
	LogDays int
	// MaxLogDays 上限（settings.logRetentionDays；0 = 不设上限）
	MaxLogDays int
	// Mask 敏感值遮蔽（默认 true；mask=0 显式关）
	Mask bool
	// Now 采集时刻（测试注入）
	Now time.Time
	// Deadline 整包预算终点（零值 = Now+20s）
	Deadline time.Time
	// Runtime store 派生面（api 层注入既有投影；CLI 形态 nil）
	Runtime *RuntimeInputs
	// EffectiveLogLevel 当前生效日志级别（api 层注入；CLI 空）
	EffectiveLogLevel string
	// Source 采集来源：api | cli
	Source string
	// Deep 深度诊断（?deep=1 / --deep）：追加 TLS 全窗扫描、self-probe 等
	// 20s 预算之外的取证面（服务端预算随之上调到 diagDeepBudget=30s）
	Deep bool
	// CPUProfile deep+显式 &cpu=1 时串行采 CPU 档案（P-20261126-3 S3；shallow
	// 绝不采）。采样窗与采集工作并发、在 diagDeepBudget 内（预算不因 cpu=1
	// 延长——显式扣减口径：剩余探针可用窗 = 预算 − 采样窗，重叠执行）
	CPUProfile bool
	// CPUProfileDuration CPU 采样时长（0/负 → CPUProfileDurationDefault=5s；
	// 注入点：集成测试用短时长）
	CPUProfileDuration time.Duration
	// ProjectRoots 项目根路径（host.json 挂载点去重；api 层从 store 注入，
	// CLI 形态为空——不猜项目位置）
	ProjectRoots []string
	// TLSCertFile 当前证书路径（tls.json 公钥元数据；空 = 未启用/未知）
	TLSCertFile string
	// TLSEnabled 监听是否 TLS（决定 HSTS 是否下发 / tls.json 的 enabled）
	TLSEnabled bool
	// ClientReport 浏览器侧诊断报告关联（P-20261126-2 S2，state/browser.json）。
	// nil = ?clientReport=1 参数不在场（**不产生 manifest 条目**——缺席即证据：
	// 恒注 absent 会稀释「absent=该链未走到」的判别语义，diagnostics.go 手册口径）；
	// 非 nil = 参数在场：Report 非空为 derived 条目（api 层已完成 typed 白名单 +
	// 截断 + 逐值脱敏，本包只按字节装箱），Report 空为 absent 条目（Reason 注明
	// cookie 过期/缺失或 /proxy 远程形态 fail-closed）。CLI 形态恒 nil。
	ClientReport *ClientReportSection
}

// ClientReportSection 浏览器侧报告的注入面（Options.ClientReport 的载荷）。
// 内容已在 api 层收口（客户端捕获点脱敏 → 服务端 typed 白名单重 marshal →
// 导出时逐值过 Redactor），collector 不再二次处理——与 share-health/self-probe
// 同族的「注入面 any/预渲染」口径，这里用字节而非 any：脱敏时序（先截断后
// 逐值脱敏，不对整段 JSON 文本跑 mask）由 api 层独占，避免两处实现漂移。
type ClientReportSection struct {
	// Report 服务端重 marshal 后的 JSON 字节（非空 = derived 条目入 zip）
	Report []byte
	// Reason derived/absent 条目的可读缘由（manifest reason 字段）
	Reason string
}

// RuntimeInputs store/更新管理器派生的运行态投影（全部复用既有只读口，
// 零新增暴露面）。
//
// 字段类型用 any 而不是 gin.H：本包不 import gin（CLI 也要用），调用方把
// 既有投影（gin.H 就是 map[string]any）原样塞进来即可。
type RuntimeInputs struct {
	// Ingress 入口面总览（IngressProjection：锁/失败计数/agentToken.Meta/
	// TLS/分享计数/远程主机计数）
	Ingress any
	// Egress 出域面总览（EgressProjection：webhook 脱敏 URL/活跃分享 items/
	// agentToken.Meta/远程主机计数/审计总数）
	Egress any
	// SelfCheck 环境体检单（SelfCheckReport）
	SelfCheck any
	// UpdateStatus 更新状态全字段（updateStatusData）
	UpdateStatus any
	// TerminalSessions 终端会话摘要（数量/状态；绝不含 id/名称/路径/输出）。
	// 由 api 层从 terminal.DefaultManager 组装——本包不 import terminal（CLI
	// 形态没有会话管理器，保持叶子方向）
	TerminalSessions any
	// ShareHealth GET /api/share 阶段耗时投影（P-20261124-1 S1⑥）：由
	// api/share 统计环导出（无 token/path/query）；nil = 未装配写 skipped
	ShareHealth any
	// Watcher 文件监听统计（P-20261124-1 S1⑥b）：api 层经 watchapi 桥注入
	// （计数/类别，无路径/无 error 原文）；nil = 未装配
	Watcher any
	// SelfProbe 自连接探测（P-20261124-1 S3③）：api 层实现（复用
	// /api/system/network 地址清单），nil = 非 deep 或 CLI 形态
	SelfProbe any
	// Notes 注入侧已知的缺席说明（如 store 未初始化）
	Notes []string
}

// Entry manifest 条目：原大小/含入字节/省略字节/原因
type Entry struct {
	// Name zip 内条目名（logs/… / state/… / 顶层派生文件）
	Name string `json:"name"`
	// Source 源路径（已过路径归一 $DATA_DIR / ~）
	Source string `json:"source,omitempty"`
	// Status present | truncated | absent | derived | omitted | denied
	Status string `json:"status"`
	// OriginalBytes 源文件原大小（absent=0）
	OriginalBytes int64 `json:"originalBytes"`
	// IncludedBytes 实际入包字节（derived=生成内容字节）
	IncludedBytes int64 `json:"includedBytes"`
	// OmittedBytes 被省略字节（truncated/omitted 才有意义）
	OmittedBytes int64 `json:"omittedBytes,omitempty"`
	// Reason 缺席/裁掉/拒绝的缘由（判据可读化）
	Reason string `json:"reason,omitempty"`
}

// Totals manifest 汇总
type Totals struct {
	Entries       int   `json:"entries"`
	IncludedBytes int64 `json:"includedBytes"`
	OmittedBytes  int64 `json:"omittedBytes"`
	Absent        int   `json:"absent"`
	Denied        int   `json:"denied"`
	Truncated     int   `json:"truncated"`
	Omitted       int   `json:"omitted"`
}

// Manifest 包清单（恒完整：先于原文写入，含全部预期条目的状态）
type Manifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	GeneratedAt   string `json:"generatedAt"`
	Version       string `json:"version"`
	Source        string `json:"source"`
	GOOS          string `json:"goos"`
	GOARCH        string `json:"goarch"`
	Mask          bool   `json:"mask"`
	LogDays       int    `json:"logDays"`
	// Deep 深度采集（?deep=1 / --deep）：schemaVersion 仍为 1——新增字段是
	// 增量契约（旧读者忽略未知字段，新读者能分辨「没采」与「采了没有」）
	Deep    bool     `json:"deep,omitempty"`
	Totals  Totals   `json:"totals"`
	Entries []Entry  `json:"entries"`
	Notes   []string `json:"notes,omitempty"`
}

// bundleEntry 待写条目（content 与 open 二选一）
type bundleEntry struct {
	meta    Entry
	content []byte
	open    func() (io.ReadCloser, error)
}

// Bundle 采集结果：manifest + 有序条目
type Bundle struct {
	Manifest Manifest
	// Report 逐探针账本（与 state/collection-report.json 同源；测试/调用方可读）
	Report  *CollectionReport
	entries []bundleEntry
	now     time.Time
}

// Plan 执行采集（探针 + 分析 + 派生文件生成），不写任何字节到输出流。
// ctx 只用于平台探针命令（整包 20s）；文件 IO 用 Options.Deadline 兜底。
func Plan(ctx context.Context, opts Options) (*Bundle, error) {
	if err := normalizeOptions(&opts); err != nil {
		return nil, err
	}
	red := NewRedactor(opts.DataDir, opts.Mask)
	logDir := filepath.Join(opts.DataDir, "logs")
	budget := time.Until(opts.Deadline)
	if budget < 0 {
		budget = 0
	}
	report := NewCollectionReport(opts.Now, budget, opts.Deep)

	// CPU 档案先行开表（S3/B1）：采样窗与 ①-⑦ 的采集工作并发运行——采到的
	// 窗口含导出自身 CPU（README 注明口径）；stop 在 ⑦ 之后补足剩余时长并记账
	// （启动失败也经 stop 的 skipped 浮出——report 只在包内出现，先行的「开表」
	// 条目对挂死的导出毫无可见性，不重复记）。
	// diagDeepBudget 不因 cpu=1 延长（30s ≥ 5s 采样 + 其余探针的 ~25s）。
	cpuProf := startCPUProfile(opts)

	// ① 原文装箱计划：stat 在挂死挂载上不可取消，只能放进带截止时间的
	// goroutine（S3⑦）；超时后仍产出包（raw 列表为空 + 如实 note）
	rawStart := time.Now()
	type rawPlanOut struct {
		raw   []rawFilePlan
		notes []string
	}
	planOut, planTimedOut := runDeadline(opts.Deadline, func() rawPlanOut {
		r, n := planRawFiles(opts, red, logDir)
		return rawPlanOut{raw: r, notes: n}
	})
	raw, notes := planOut.raw, planOut.notes
	planStatus := ProbeOK
	planNote := ""
	if planTimedOut {
		planStatus = ProbeTimeout
		planNote = "file planning hit the collection deadline — raw log list may be incomplete (stat on a hung mount cannot be cancelled)"
		notes = append(notes, planNote)
	}
	var plannedBytes int64
	for _, rf := range raw {
		plannedBytes += rf.meta.IncludedBytes
	}
	report.Add(ProbeResult{
		ID: "files:plan", Kind: "file", Status: string(planStatus),
		DurationMS: time.Since(rawStart).Milliseconds(), Bytes: plannedBytes, Note: planNote,
	})

	// ② 单遍日志分析（S2）：窗口读 + 慢请求/错误签名/每小时计数/gap 同一次扫描
	an := newAnalyzer(red)
	stats := make([]logStats, 0, len(raw))
	for _, rf := range raw {
		if rf.meta.Status != StatusPresent && rf.meta.Status != StatusTruncated {
			continue
		}
		// 只分析 logs/ 下的真日志：state/*.json 与 pid.txt 不是日志，按文本扫
		// 只会把 JSON 行算进 other 级别，污染摘要口径
		if !strings.HasPrefix(rf.meta.Name, "logs/") {
			continue
		}
		if opts.DeadlineReached() {
			notes = append(notes, "analysis stopped: bundle budget exhausted — logs-summary/errors cover only the files listed above")
			report.Add(ProbeResult{ID: "analysis:" + rf.meta.Name, Kind: "analysis", Status: string(ProbeBudget), Note: "bundle budget exhausted"})
			break
		}
		var st logStats
		report.Timed("analysis:"+rf.meta.Name, "analysis", false, 0, func() (int64, string, ProbeStatus) {
			st = an.analyze(rf.meta.Name, rf.abs, rf.size)
			var note string
			if st.windowed {
				note = ">8MiB: analysed head 2MiB + tail 14MiB window only"
			}
			if st.partial {
				note = joinNote(note, "analysis budget/pathological line — statistics incomplete")
			}
			return st.analyzed, note, ProbeOK
		})
		stats = append(stats, st)
	}
	errorsText := renderErrors(an)
	summaryText := renderLogSummary(stats)

	// ③ 平台基线（含 3s/命令 超时；整包预算靠 ctx）
	platform := collectPlatform(ctx, runtimeGOOS(), opts.DataDir, red, opts.Now, opts.Deadline, report)
	notes = append(notes, platform.Notes...)
	if opts.DeadlineReached() {
		notes = append(notes, "platform probe cut short: bundle budget exhausted")
	}

	// ④ 宿主/网络/TLS（S3①③②）+ 进程自观测跨平台（P-20261126-3 S2）：
	// host.json process 段三平台装配（Windows=GetProcessTimes/psapi/toolhelp、
	// Linux=/proc、darwin=ps best-effort；口径差异在 basis 字段）
	host := collectHostInfo(ctx, runtimeGOOS(), opts.DataDir, opts.ProjectRoots, red, opts.Now)
	proc, procOK := collectProcessSection()
	host.Process = &proc
	report.Add(ProbeResult{ID: "proc:host", Kind: "proc", Status: hostStatus(host), Note: hostNote(host)})
	procStatus := ProbeOK
	if !procOK {
		procStatus = ProbeSkipped
	}
	report.Add(ProbeResult{ID: "proc:process", Kind: "proc", Status: string(procStatus),
		Note: "process self-observation (" + runtimeGOOS() + "): " + host.Process.Note})
	netInfo := collectNetInfo(runtimeGOOS(), opts.DataDir, red, opts.Now)
	report.Add(ProbeResult{ID: "proc:net", Kind: "proc", Status: "ok", Note: netInfo.Reason})
	tlsDoc := collectTLS(opts, red)
	report.Add(ProbeResult{ID: "tls:cert", Kind: "file", Status: tlsStatus(tlsDoc), Note: tlsDoc.Reason})
	tlsSummary, tlsCount, tlsFiles := collectTLSSummary(opts, raw, journalSample(platform), red)
	report.Add(ProbeResult{
		ID: "analysis:tls-summary", Kind: "analysis", Status: "ok", Deep: opts.Deep,
		Bytes: int64(len(tlsSummary)),
		Note:  fmt.Sprintf("scanned=%d files, handshakeErrorLines=%d", tlsFiles, tlsCount),
	})

	// ⑤ 存储/大文件：同一次 WalkDir（S2⑤），带 deadline（S3⑦）。轮转结论的
	// ≤20 次 stat 也在同一个带截止时间的 goroutine 内完成——它是新加的 stat
	// 面，不能绕过「所有文件探针都有 deadline」的纪律。
	type storageOut struct {
		st      StorageStats
		files   LargeFilesReport
		jsonOut string
	}
	storageStart := time.Now()
	so, storageTimedOut := runDeadline(opts.Deadline, func() storageOut {
		st, files := collectStorage(opts.DataDir, platform.Disk, red, opts.Now, opts.Deadline)
		return storageOut{st: st, files: files, jsonOut: renderLargeFilesJSON(files, opts.DataDir, red)}
	})
	storage, largeFiles := so.st, so.files
	storageStatus := ProbeOK
	storageNote := ""
	if storageTimedOut {
		storageStatus = ProbeTimeout
		storageNote = "storage walk hit the collection deadline (figures are a lower bound)"
		notes = append(notes, storageNote)
	} else if storage.Capped {
		storageNote = "walk capped at entry limit"
	}
	largeFilesJSON := so.jsonOut
	if largeFilesJSON == "" {
		largeFilesJSON = skippedSection("large-files", "collection deadline reached during the storage walk")
	}
	report.Add(ProbeResult{ID: "walk:storage", Kind: "walk", Status: string(storageStatus),
		DurationMS: time.Since(storageStart).Milliseconds(), Bytes: storage.Total.Bytes, Note: storageNote})
	if !storageTimedOut {
		report.Add(ProbeResult{ID: "walk:large-files", Kind: "walk", Status: "ok",
			Note: fmt.Sprintf("reuses the storage walk; top=%d dataDirFiles=%d", len(largeFiles.Top), largeFiles.DataFiles)})
	}

	// ⑥ 目录清点（同样带 deadline；data/ 子树统计是另一次 walk）
	inventoryStart := time.Now()
	inventoryText, inventoryTimedOut := runDeadline(opts.Deadline, func() string { return renderInventory(opts.DataDir, red) })
	inventoryStatus := ProbeOK
	if inventoryTimedOut {
		inventoryStatus = ProbeTimeout
		inventoryText = "# inventory skipped: collection deadline reached while walking the data dir (stat on a hung mount cannot be cancelled)\n"
		notes = append(notes, "inventory skipped at the collection deadline")
	}
	report.Add(ProbeResult{ID: "walk:inventory", Kind: "walk", Status: string(inventoryStatus),
		DurationMS: time.Since(inventoryStart).Milliseconds(), Bytes: int64(len(inventoryText))})

	// ⑦ dsh-web.log 摘要（头8MiB+尾16MiB+中段采样；绝不整读）。Stat/读窗口
	// 同样可能撞挂死共享盘 → 带 deadline（S3⑦）
	dshStart := time.Now()
	dsh, dshTimedOut := runDeadline(opts.Deadline, func() dshCollected { return collectDshSummary(opts.DataDir, red) })
	if dshTimedOut {
		dsh = dshCollected{
			status: ProbeTimeout,
			note:   "dsh-web.log sampling hit the collection deadline (hung mount?)",
			text:   "# dsh-web.log summary skipped: collection deadline reached while reading sampled windows\n",
		}
	}
	report.Add(ProbeResult{ID: "analysis:dsh-web.log", Kind: "analysis", Status: string(dsh.status),
		DurationMS: time.Since(dshStart).Milliseconds(), Bytes: dsh.bytes, Note: dsh.note})

	// ⑧ deep pprof 档案（P-20261126-3 S3）：CPU 采样无条件收尾（补足时长窗；
	// 即使后续门槛不收也必须 stop——采样器常开会持续吃开销），再装
	// heap/block/mutex（有界预写→超限整份丢弃）与 goroutine 文本（可截断）。
	// 只在 deep+api 档入包；CLI 形态（Runtime==nil）的 profiles 描述的是采集器
	// 自身进程——与 goruntime 同理不采，如实 skipped。
	var profileEntries []bundleEntry
	profileNotes := []string{}
	var cpuData []byte
	var cpuBytes int64
	var cpuSkipped string
	var cpuWindow time.Duration
	if cpuProf != nil {
		cpuData, cpuBytes, cpuSkipped, cpuWindow = cpuProf.stop(opts.CPUProfileDuration)
	}
	if opts.Deep && opts.Runtime != nil {
		if cpuProf != nil {
			if cpuSkipped != "" {
				report.Add(ProbeResult{ID: "profile:cpu", Kind: "profile", Status: string(ProbeSkipped),
					Deep: true, Bytes: cpuBytes, Note: red.Line(cpuSkipped)})
			} else {
				report.Add(ProbeResult{ID: "profile:cpu", Kind: "profile", Status: string(ProbeOK),
					Deep: true, Bytes: cpuBytes, Note: "cpu profile captured in the export window (includes the export's own CPU)"})
				profileEntries = append(profileEntries, bundleEntry{
					meta: Entry{
						Name: "profiles/cpu", Status: StatusDerived, IncludedBytes: cpuBytes,
						Reason: "deep+cpu=1 CPU profile (" + cpuWindow.Round(time.Millisecond).String() + " window, default 5s, injectable); written WHOLE or not at all; binary payload skips the text redactor — -trimpath builds embed no build-machine paths",
					},
					content: cpuData,
				})
			}
		}
		bin, texts := collectDeepProfiles(opts, red, report)
		profileEntries = append(profileEntries, bin...)
		profileEntries = append(profileEntries, texts...)
		for _, p := range report.Probes() {
			if p.Kind == "profile" && strings.HasPrefix(p.Note, "oversized") {
				profileNotes = append(profileNotes, "profile "+p.ID+" skipped: "+p.Note)
			}
		}
	} else if opts.Deep {
		report.Add(ProbeResult{ID: "profile:*", Kind: "profile", Status: string(ProbeSkipped),
			Deep: true, Note: "offline CLI collection: profiles would describe the collector process, not the service"})
	}

	runtimeText := renderRuntime(opts, red)
	selfCheckText, statusText, rtNotes := renderRuntimeSections(opts, red)
	notes = append(notes, rtNotes...)
	// includedBytes 口径如实标注：脱敏/路径归一只会让写入文本变短，manifest
	// 计的是「计划覆盖的源字节」——排障时不至于拿它跟 zip 实际体积对不上而
	// 怀疑包被截了
	notes = append(notes, "manifest includedBytes counts SOURCE bytes covered by the pack plan; masking/path normalization can only shrink the written text")

	b := &Bundle{now: opts.Now, Report: report}
	entries := make([]bundleEntry, 0, len(raw)+30)
	add := func(name, source, status string, original int64, content []byte, reason string) {
		entries = append(entries, bundleEntry{
			meta: Entry{
				Name: name, Source: source, Status: status,
				OriginalBytes: original, IncludedBytes: int64(len(content)),
				Reason: reason,
			},
			content: content,
		})
	}
	add("README.txt", "", StatusDerived, 0, []byte(renderReadme(opts)), "")
	add("logs-summary.txt", "", StatusDerived, 0, []byte(summaryText), "")
	add("slow-requests.txt", "", StatusDerived, 0, []byte(an.renderSlowRequests()),
		"slow [GIN] lines (>=1s), Top500, query strings dropped at parse time")
	add("stalls.txt", "", StatusDerived, 0, []byte(an.renderStallsFile(opts.Now, red)),
		"watchdog primary + log gaps as historical context (gaps without a spanning request are marked likely-idle)")
	add("errors.txt", "", StatusDerived, 0, []byte(errorsText),
		fmt.Sprintf("WARN+ERROR first occurrence per signature (masked=%t), capped at %d lines / %d bytes; repeated signatures counted with first/last", opts.Mask, errorsMaxLines, errorsMaxBytes))
	add("dsh-summary.txt", "", StatusDerived, 0, []byte(dsh.text),
		"dsh-web.log sampled windows only: head 8MiB + tail 16MiB + middle samples; line counts are estimated")
	add("platform.txt", "", StatusDerived, 0, []byte(formatPlatformText(platform)), "")
	add("tls-summary.txt", "", StatusDerived, 0, []byte(tlsSummary),
		"TLS handshake errors found in packed logs (+journal sample); count scope is the bundle, not the whole host history")
	add("state/host.json", "", StatusDerived, 0, []byte(renderHostJSON(host)),
		"Linux /proc primary (mounts/diskstats/PSI/status/wchan/io/limits/cgroup); command fallbacks use WaitDelay=500ms")
	add("state/host-history.json", "", StatusDerived, 0, []byte(renderHostHistoryJSON()),
		"10s sampling ring (360 points = 1h), started by the service lifecycle; host CPU%/RSS sampled on ALL platforms (P-20261126-3 S2), /proc host fields on Linux only — offline CLI writes skipped")
	add("state/goruntime.json", "", StatusDerived, 0, []byte(renderGoRuntimeJSON(opts.Source)),
		"Go runtime snapshot (MemStats/GC stats/goroutines/OS threads) + 60s trend ring (120 points = 2h): heap/goroutine/GC-pause deltas — CLI form describes the collector process and says so (scope)")
	add("state/routes.json", "", StatusDerived, 0, []byte(renderRoutesJSON(opts.Now, opts.Source)),
		"route-level hot-spot aggregation, 24h window in fixed hourly buckets: count/totalMs/maxMs/4xx/5xx per route template; WS connections count only (their duration is the connection lifetime); *api-other*/*static* are the unmatched tracks")
	add("state/net.json", "", StatusDerived, 0, []byte(renderNetJSON(netInfo)),
		"addresses/MTU/default route/DNS/TCP states+retransmits/per-interface counters; proxy env hosts only (userinfo never packed)")
	add("state/tls.json", "", StatusDerived, 0, []byte(renderTLSJSON(tlsDoc)),
		"certificate PUBLIC metadata only (fingerprint/validity/SAN/self-signed); private key is never read")
	// 注入面派生文件（进程内时间线 + share-health + self-probe）
	for _, d := range inProcessDerivedSections(opts, red) {
		add(d.Name, "", StatusDerived, 0, []byte(d.Content), d.Reason)
	}
	for _, d := range runtimeDerivedSections(opts) {
		add(d.Name, "", StatusDerived, 0, []byte(d.Content), d.Reason)
	}
	// 浏览器侧报告（P-20261126-2 S2）：条件性条目——?clientReport=1 在场才出现；
	// 在场而无关联报告注 absent（absent 在 WriteZip 里只进 manifest 不进 zip，
	// 与更新链日志缺席同一证据语义）
	if cr := opts.ClientReport; cr != nil {
		if len(cr.Report) > 0 {
			add("state/browser.json", "", StatusDerived, 0, cr.Report, cr.Reason)
		} else {
			add("state/browser.json", "", StatusAbsent, 0, nil, cr.Reason)
		}
	}
	add("state/runtime.json", "", StatusDerived, 0, []byte(runtimeText), "")
	add("state/selfcheck.json", "", StatusDerived, 0, []byte(selfCheckText), "")
	add("state/update-status.json", "", StatusDerived, 0, []byte(statusText), "")
	add("state/data-dir-inventory.txt", "", StatusDerived, 0, []byte(inventoryText),
		"metadata only (existence/mode/size/entry counts); credential paths never packed")
	add("state/storage.json", "", StatusDerived, 0, []byte(renderStorageJSON(storage)),
		"storage statistics only (size/entry counts; file content never read)")
	add("state/large-files.json", "", StatusDerived, 0, []byte(largeFilesJSON),
		"top 20 files from the SAME storage walk (no extra walk); data/ counts only, no file names")
	add("state/collection-report.json", "", StatusDerived, 0, []byte(report.render()),
		"per-probe status/duration/skip reason (ok|skipped|timeout|budget|denied) + logWrite probe")
	// deep 档案条目（二进制面：content 原字节直写 zip，status=derived）
	entries = append(entries, profileEntries...)
	if len(profileNotes) > 0 {
		notes = append(notes, profileNotes...)
	}
	if opts.Deep && opts.Runtime != nil {
		notes = append(notes, "profiles/* are standard pprof gzip protobuf, written WHOLE or dropped WHOLE (never truncated); "+
			"the binary face is not passed through the text redactor — -trimpath builds embed no build-machine absolute paths")
	}
	for _, rf := range raw {
		rf := rf
		entries = append(entries, bundleEntry{
			meta: rf.meta,
			open: func() (io.ReadCloser, error) { return openRaw(rf.abs, rf.size, rf.inc, red) },
		})
	}
	// manifest.json 落位 README 之后（下载一开始先看见包里有什么）
	manifestIdx := 1
	entries = append(entries, bundleEntry{})
	copy(entries[manifestIdx+1:], entries[manifestIdx:])
	entries[manifestIdx] = bundleEntry{}

	b.entries = entries
	// manifest 是自引用（自身大小影响自身内容）：定长迭代到不动点，
	// 3 轮内必收敛（大小数字位数变化有限）
	var manifestJSON []byte
	for i := 0; i < 4; i++ {
		meta := make([]Entry, 0, len(entries))
		for j, e := range entries {
			if j == manifestIdx {
				meta = append(meta, Entry{
					Name: "manifest.json", Status: StatusDerived,
					IncludedBytes: int64(len(manifestJSON)),
					Reason:        "self-reference — includedBytes is this file's actual size; the field is estimated to a fixed point",
				})
				continue
			}
			meta = append(meta, e.meta)
		}
		b.Manifest = Manifest{
			SchemaVersion: 1,
			GeneratedAt:   opts.Now.Format(time.RFC3339),
			Version:       opts.Version,
			Source:        opts.Source,
			GOOS:          runtimeGOOS(),
			GOARCH:        runtimeGOARCH(),
			Mask:          opts.Mask,
			LogDays:       opts.LogDays,
			Deep:          opts.Deep,
			Entries:       meta,
			Notes:         dedupeNotes(notes),
		}
		b.Manifest.Totals = sumTotals(meta)
		next, err := json.MarshalIndent(b.Manifest, "", "  ")
		if err != nil {
			return nil, fmt.Errorf("diagnostics: marshal manifest: %w", err)
		}
		converged := len(next) == len(manifestJSON)
		manifestJSON = next
		if converged {
			break
		}
	}
	b.entries[manifestIdx] = bundleEntry{
		meta: Entry{
			Name: "manifest.json", Status: StatusDerived,
			IncludedBytes: int64(len(manifestJSON)),
			Reason:        "self-reference — includedBytes is this file's actual size; the field is estimated to a fixed point",
		},
		content: manifestJSON,
	}
	return b, nil
}

// DeadlineReached 整包预算是否已耗尽（采集各阶段自行让路）
func (o Options) DeadlineReached() bool { return time.Now().After(o.Deadline) }

func normalizeOptions(opts *Options) error {
	if strings.TrimSpace(opts.DataDir) == "" {
		return errors.New("diagnostics: data dir is required")
	}
	opts.DataDir = filepath.Clean(opts.DataDir)
	if opts.Now.IsZero() {
		opts.Now = time.Now()
	}
	if opts.Deadline.IsZero() {
		// 20s 是**墙钟**预算（不是 Now+20s：Now 可被单测注入为固定历史时刻，
		// 那会让预算在测试里恒已耗尽——预算的语义是「本次采集最多花 20s」）
		opts.Deadline = time.Now().Add(totalBudget)
	}
	if opts.LogDays <= 0 {
		opts.LogDays = defaultLogDays
	}
	// 上限 = settings.logRetentionDays（留存 1 天的实例只装 1 天，不装作有 3 天）
	if opts.MaxLogDays > 0 && opts.LogDays > opts.MaxLogDays {
		opts.LogDays = opts.MaxLogDays
	}
	if opts.Source == "" {
		opts.Source = "api"
	}
	return nil
}

// openRaw 打开原文条目：full 直读；截断形态 = 头段 + seam 行 + 尾段。
// 全量再过 redactReader（逐行 mask.MaskText + 路径归一）——「原文全带」指的是
// 行内容不做摘要/采样，不是「凭据原样出包」；mask=0 时仍做路径归一（必改D②
// 无开关：用户名/数据目录在任何出口都不该裸奔）。
func openRaw(path string, size int64, inc inclusion, red *Redactor) (io.ReadCloser, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	var src io.Reader = f
	if !inc.full {
		first := inc.head
		tailLen := size - inc.tailAt
		omitted := size - first - tailLen
		seam := fmt.Sprintf("\n[TRUNCATED %d bytes omitted]\n", omitted)
		src = io.MultiReader(
			io.NewSectionReader(f, 0, first),
			strings.NewReader(seam),
			io.NewSectionReader(f, inc.tailAt, tailLen),
		)
	}
	return &redactReadCloser{
		r: &redactReader{br: bufio.NewReaderSize(src, 256<<10), red: red},
		c: f,
	}, nil
}

// redactReader 逐行脱敏/归一的流式 Reader：一次一行（ReadString 只持一行），
// 无整文件缓冲。行长上界由装箱预算兜住（单条目 ≤16MiB），最坏瞬态内存是
// 「一行」而非「一份文件」。
type redactReader struct {
	br  *bufio.Reader
	red *Redactor
	buf []byte
	eof bool
}

func (r *redactReader) Read(p []byte) (int, error) {
	for len(r.buf) == 0 {
		if r.eof {
			return 0, io.EOF
		}
		line, err := r.br.ReadString('\n')
		if line != "" {
			r.buf = append(r.buf, r.red.Line(line)...)
		}
		if err != nil {
			r.eof = true
			if len(r.buf) == 0 {
				return 0, io.EOF
			}
			break
		}
	}
	n := copy(p, r.buf)
	r.buf = r.buf[n:]
	return n, nil
}

type redactReadCloser struct {
	r io.Reader
	c io.Closer
}

func (m *redactReadCloser) Read(p []byte) (int, error) { return m.r.Read(p) }
func (m *redactReadCloser) Close() error               { return m.c.Close() }

// WriteZip 流式写 zip（archive/zip 直写调用方 io.Writer）。
// 头先出：README + manifest 是前两个条目——下载一开始就能看清包里有什么；
// 中途失败只能断连（已写字节无法撤回），调用方按错误入账。
func (b *Bundle) WriteZip(w io.Writer) error {
	cw := &countingWriter{w: w}
	zw := zip.NewWriter(cw)
	var dropped []string
	for _, e := range b.entries {
		switch e.meta.Status {
		case StatusAbsent, StatusOmitted, StatusDenied:
			continue
		}
		if cw.n >= zipCapBytes {
			dropped = append(dropped, e.meta.Name)
			continue
		}
		hdr := &zip.FileHeader{Name: e.meta.Name, Method: zip.Deflate, Modified: b.now}
		hdr.SetMode(0o644)
		fw, err := zw.CreateHeader(hdr)
		if err != nil {
			return fmt.Errorf("diagnostics: create %s: %w", e.meta.Name, err)
		}
		if e.open != nil {
			rc, err := e.open()
			if err != nil {
				return fmt.Errorf("diagnostics: open %s: %w", e.meta.Name, err)
			}
			_, copyErr := io.Copy(fw, rc)
			_ = rc.Close()
			if copyErr != nil {
				return fmt.Errorf("diagnostics: write %s: %w", e.meta.Name, copyErr)
			}
			continue
		}
		if _, err := fw.Write(e.content); err != nil {
			return fmt.Errorf("diagnostics: write %s: %w", e.meta.Name, err)
		}
	}
	if len(dropped) > 0 {
		fw, err := zw.Create("TRUNCATED.txt")
		if err != nil {
			return err
		}
		fmt.Fprintf(fw, "# zip cap %s reached — the entries below were planned but NOT written.\n"+
			"# Every planned entry still appears in manifest.json (which was written before them).\n", humanBytes(zipCapBytes))
		for _, n := range dropped {
			fmt.Fprintln(fw, n)
		}
	}
	if err := zw.Close(); err != nil {
		return fmt.Errorf("diagnostics: close zip: %w", err)
	}
	return nil
}

// countingWriter 已写字节计数（zip 上限判定用）
type countingWriter struct {
	w io.Writer
	n int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n += int64(n)
	return n, err
}

func sumTotals(entries []Entry) Totals {
	t := Totals{Entries: len(entries)}
	for _, e := range entries {
		t.IncludedBytes += e.IncludedBytes
		t.OmittedBytes += e.OmittedBytes
		switch e.Status {
		case StatusAbsent:
			t.Absent++
		case StatusDenied:
			t.Denied++
		case StatusTruncated:
			t.Truncated++
		case StatusOmitted:
			t.Omitted++
		}
	}
	return t
}

func dedupeNotes(notes []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(notes))
	for _, n := range notes {
		n = strings.TrimSpace(n)
		if n == "" || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	return out
}

// renderErrors errors.txt 收尾（封顶说明如实附在末尾；签名去重统计见 S2）
func renderErrors(a *analyzer) string {
	var b strings.Builder
	b.WriteString("# WARN/ERROR first occurrences (deduplicated by signature; masked=" + boolStr(a.red.maskOn) +
		", cap=" + itoa(errorsMaxLines) + " lines / " + humanBytes(errorsMaxBytes) + ")\n")
	b.WriteString("# grouped per file, newest file first; repeated identical errors are counted in the signature table below.\n")
	b.WriteString("# full context is in the raw log files under logs/\n\n")
	b.WriteString(a.errBuf.String())
	if a.errCapped {
		b.WriteString("\n# NOTE: capture capped — remaining unique WARN/ERROR lines were NOT written (raise raw logs in logs/ for the rest)\n")
	}
	if a.errLines == 0 {
		b.WriteString("(no WARN/ERROR lines in the collected window)\n")
	}
	b.WriteString(a.renderSignatures())
	return b.String()
}

func boolStr(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

func itoa(n int) string { return fmt.Sprintf("%d", n) }
