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
	SchemaVersion int      `json:"schemaVersion"`
	GeneratedAt   string   `json:"generatedAt"`
	Version       string   `json:"version"`
	Source        string   `json:"source"`
	GOOS          string   `json:"goos"`
	GOARCH        string   `json:"goarch"`
	Mask          bool     `json:"mask"`
	LogDays       int      `json:"logDays"`
	Totals        Totals   `json:"totals"`
	Entries       []Entry  `json:"entries"`
	Notes         []string `json:"notes,omitempty"`
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
	entries  []bundleEntry
	now      time.Time
}

// Plan 执行采集（探针 + 分析 + 派生文件生成），不写任何字节到输出流。
// ctx 只用于平台探针命令（整包 20s）；文件 IO 用 Options.Deadline 兜底。
func Plan(ctx context.Context, opts Options) (*Bundle, error) {
	if err := normalizeOptions(&opts); err != nil {
		return nil, err
	}
	red := NewRedactor(opts.DataDir, opts.Mask)
	logDir := filepath.Join(opts.DataDir, "logs")

	raw, notes := planRawFiles(opts, red, logDir)

	// 分析入选文件（logs-summary/errors 的数据源；Omitted/Denied 不分析）
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
			notes = append(notes, "analysis stopped: 20s bundle budget exhausted — logs-summary/errors cover only the files listed above")
			break
		}
		stats = append(stats, an.analyze(rf.meta.Name, rf.abs, rf.size))
	}
	errorsText := renderErrors(an)
	summaryText := renderLogSummary(stats)

	// 平台基线（含 3s/命令 超时；整包预算靠 ctx）
	platform := collectPlatform(ctx, runtimeGOOS(), opts.DataDir, red, opts.Now)
	notes = append(notes, platform.Notes...)
	if opts.DeadlineReached() {
		notes = append(notes, "platform probe cut short: 20s bundle budget exhausted")
	}

	inventoryText := renderInventory(opts.DataDir, red)
	// 存储统计（S2b⑤）：data/ 只记大小/条目数——与 inventory 同红线
	storage := collectStorage(opts.DataDir, platform.Disk, red, opts.Now)
	runtimeText := renderRuntime(opts, red)
	selfCheckText, statusText, rtNotes := renderRuntimeSections(opts, red)
	notes = append(notes, rtNotes...)
	// includedBytes 口径如实标注：脱敏/路径归一只会让写入文本变短，manifest
	// 计的是「计划覆盖的源字节」——排障时不至于拿它跟 zip 实际体积对不上而
	// 怀疑包被截了
	notes = append(notes, "manifest includedBytes counts SOURCE bytes covered by the pack plan; masking/path normalization can only shrink the written text")

	b := &Bundle{now: opts.Now}
	entries := make([]bundleEntry, 0, len(raw)+10)
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
	add("errors.txt", "", StatusDerived, 0, []byte(errorsText),
		fmt.Sprintf("WARN+ERROR verbatim lines (masked=%t), capped at %d lines / %d bytes", opts.Mask, errorsMaxLines, errorsMaxBytes))
	add("platform.txt", "", StatusDerived, 0, []byte(formatPlatformText(platform)), "")
	add("state/runtime.json", "", StatusDerived, 0, []byte(runtimeText), "")
	add("state/selfcheck.json", "", StatusDerived, 0, []byte(selfCheckText), "")
	add("state/update-status.json", "", StatusDerived, 0, []byte(statusText), "")
	add("state/data-dir-inventory.txt", "", StatusDerived, 0, []byte(inventoryText),
		"metadata only (existence/mode/size/entry counts); credential paths never packed")
	add("state/storage.json", "", StatusDerived, 0, []byte(renderStorageJSON(storage)),
		"storage statistics only (size/entry counts; file content never read)")
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

// rawFilePlan 原文文件的装箱决策
type rawFilePlan struct {
	abs  string
	size int64
	inc  inclusion
	meta Entry
}

// planRawFiles 枚举并决策全部原文文件（新→旧顺序 + raw 预算裁剪）。
//
// 顺序（重要性递减）：按日主日志（新→旧）→ 更新链固定清单 → DataDir 根
// 期望文件（dsh-web.log / update-result.json / PID 文件）→ 轮转历史（.1）→
// logs/ 通配余项。预算裁剪只砍队尾（= 更旧的文件），当天文件在队首已装完
// ——「绝不砍当天尾部」（必改E）。
func planRawFiles(opts Options, red *Redactor, logDir string) ([]rawFilePlan, []string) {
	var notes []string
	var out []rawFilePlan
	seen := map[string]bool{}

	addExpected := func(zipName, path string) {
		seen[strings.ToLower(filepath.Base(path))] = true
		if plan, ok := expectedEntry(zipName, path, red); ok {
			out = append(out, plan)
			return
		}
		out = append(out, newRawPlanFromPath(path, zipName, red))
	}

	daily, absentDays := selectDailyLogs(logDir, opts.LogDays, opts.Now)
	for _, f := range daily {
		out = append(out, newRawPlan(f, red))
		seen[strings.ToLower(f.base)] = true
	}
	// 更新链固定清单：缺席 = ABSENT 证据（不造空文件）
	for _, name := range fixedChainLogs {
		addExpected("logs/"+name, filepath.Join(logDir, name))
	}
	// dsh-web.log 在 DataDir 根（config.go:390），显式列举——通配 logs/ 漏它
	addExpected("logs/"+dshWebLogName, filepath.Join(opts.DataDir, dshWebLogName))
	// update-result.json（manager.go:750 落点）：更新结局文件，与更新链日志同族证据
	addExpected("state/update-result.json", filepath.Join(opts.DataDir, "update-result.json"))
	// PID 文件全文（含第五行版本，P-20261122-6）：换包后「谁在跑哪版」的直接证据
	addExpected("state/pid.txt", filepath.Join(opts.DataDir, "codecombo.pid"))
	// 轮转历史（S1 按次轮转留 2 文件；`.1` 后缀不被 *.log 通配命中）
	for _, name := range legacyTailFiles {
		addExpected("logs/"+name, filepath.Join(logDir, name))
	}
	// logs/ 通配余项（排除半成品/zip、跳过符号链接、重名去重取最新）
	for _, f := range wildcardLogs(logDir, seen) {
		out = append(out, newRawPlan(f, red))
	}
	// 按日缺席证据（窗口内某天没有文件）
	for _, name := range absentDays {
		out = append(out, rawFilePlan{meta: Entry{
			Name: "logs/" + name, Status: StatusAbsent,
			Reason: "expected daily log missing (service not running that day, or past retention)",
		}})
	}

	// raw 预算：新→旧扫描，超预算的原文条目降级为 omitted
	used := int64(0)
	for i := range out {
		e := &out[i]
		if e.meta.Status != StatusPresent && e.meta.Status != StatusTruncated {
			continue
		}
		if used+e.meta.IncludedBytes > rawBudgetBytes {
			e.meta.Status = StatusOmitted
			e.meta.Reason = fmt.Sprintf("raw budget %s reached — older files dropped first; today's file is always packed first", humanBytes(rawBudgetBytes))
			e.meta.OmittedBytes = e.meta.IncludedBytes
			e.meta.IncludedBytes = 0
			notes = append(notes, "raw budget reached: older logs omitted (see manifest)")
			continue
		}
		used += e.meta.IncludedBytes
	}
	return out, notes
}

// newRawPlan 单个已 stat 文件的装箱决策（zip 名默认 logs/<base>）
func newRawPlan(f sourceFile, red *Redactor) rawFilePlan {
	return newRawPlanFromPath(f.abs, "logs/"+f.base, red)
}

// newRawPlanFromPath 按路径 stat 并决策（zipName 显式给：state/ 族的落点不同）
func newRawPlanFromPath(p, zipName string, red *Redactor) rawFilePlan {
	st, err := os.Stat(p)
	if err != nil {
		// 竞态删除（正常：轮转清理正好发生）——如实缺席
		return rawFilePlan{meta: Entry{
			Name: zipName, Source: red.Path(p), Status: StatusAbsent,
			Reason: "file disappeared during collection: " + red.Line(err.Error()),
		}}
	}
	size := st.Size()
	inc := planInclusion(p, size)
	status := StatusPresent
	var omitted int64
	if !inc.full {
		status = StatusTruncated
		omitted = inc.omittedBytes(size)
	}
	return rawFilePlan{
		abs:  p,
		size: size,
		inc:  inc,
		meta: Entry{
			Name:          zipName,
			Source:        red.Path(p),
			Status:        status,
			OriginalBytes: size,
			IncludedBytes: inc.includedBytes(size),
			OmittedBytes:  omitted,
			Reason:        truncationReason(inc, size),
		},
	}
}

// expectedEntry 期望文件缺席 / 凭据 denylist 命中时的 manifest 条目
// （ok=true 表示"已决定，不需要再 stat"）
func expectedEntry(zipName, path string, red *Redactor) (rawFilePlan, bool) {
	if why := deniedReason(path, red.dataDir); why != "" {
		return rawFilePlan{meta: Entry{
			Name: zipName, Source: red.Path(path), Status: StatusDenied, Reason: why,
		}}, true
	}
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return rawFilePlan{meta: Entry{
				Name: zipName, Source: red.Path(path), Status: StatusAbsent,
				Reason: "expected file absent (the absence itself is evidence — see runbook §11)",
			}}, true
		}
		return rawFilePlan{meta: Entry{
			Name: zipName, Source: red.Path(path), Status: StatusAbsent,
			Reason: "stat failed: " + red.Line(err.Error()),
		}}, true
	}
	return rawFilePlan{}, false
}

func truncationReason(inc inclusion, size int64) string {
	if inc.full {
		return ""
	}
	return fmt.Sprintf(">8MiB: head %s + tail %s kept (tail-biased — failure evidence lives at the end)",
		humanBytes(uint64(inc.head)), humanBytes(uint64(size-inc.tailAt)))
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

// renderErrors errors.txt 收尾（封顶说明如实附在末尾）
func renderErrors(a *analyzer) string {
	var b strings.Builder
	b.WriteString("# WARN/ERROR verbatim lines (masked=" + boolStr(a.red.maskOn) +
		", cap=" + itoa(errorsMaxLines) + " lines / " + humanBytes(errorsMaxBytes) + ")\n")
	b.WriteString("# grouped per file, newest file first; full context is in the raw log files under logs/\n\n")
	b.WriteString(a.errBuf.String())
	if a.errCapped {
		b.WriteString("\n# NOTE: capture capped — remaining WARN/ERROR lines were NOT written (raise raw logs in logs/ for the rest)\n")
	}
	if a.errLines == 0 {
		b.WriteString("(no WARN/ERROR lines in the collected window)\n")
	}
	return b.String()
}

func boolStr(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

func itoa(n int) string { return fmt.Sprintf("%d", n) }
