package diagnostics

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"

	"codecombo/server/sysinfo"
)

// 通用平台信息采集（P-20261122-10 必改C）：诊断包的「跨平台基线」。
// P-20261122-11（S2b）在同一张命令表上扩「平台深度采样」：服务监管细节 /
// OS 监听表 / 进程树 / 机器内存（深度侧的纯函数在 platform_deep.go）。
//
// 纪律（评审定稿）：
//   - 单命令 3s 超时、整包 20s（ctx 由收集器注入，这里只做单命令钳制）；
//   - 无特权：全部是只读查询命令，不调 sudo/管理员链；
//   - 缺失/无权限 → 该条 status=skipped + note 原文，**不标红**——排障包
//     不该因为机器上没装某个工具就变成一堆错误；
//   - 命令表纯数据化 + GOOS 注入（platformCommands(platformEnv)），单测三分支对拍；
//   - Windows 基线只用系统内置命令（`cmd /c ver` + `sc query` + `netstat`；
//     `wmic` 仅作可选内存采样——新 Windows 11 已移除 WMIC，缺席记 skipped）。
//     **刻意不 chcp 65001**：chcp 改的是子进程码页且对内置命令的
//     输出编码无帮助（cmd 内置命令按控制台输出码页走，改 chcp 只会在
//     `cmd /c` 单次派生的进程里生效，拿回来还是非 UTF-8 字节）；解码失败
//     统一走「剥非 ASCII + manifest 记 note」。
//   - PowerShell Get-CimInstance 是可选增强：3s 内拿到就收，拿不到记 skipped
//     （PowerShell 冷启动在低配机可超 3s，属常态不是故障）。
//   - 输出有界：launchctl print / journalctl / ps / 监听表都可能很长，表项
//     用 MaxLines/MaxBytes 裁剪并把截断事实写进 note；命令输出统一逐行
//     脱敏+路径归一（journalctl 是日志原文，launchctl print 含 env）。

// platformCommandTimeout 单命令超时上限（整包 20s 由收集器 ctx 兜底）
const platformCommandTimeout = 3 * time.Second

// runtimeGOOS/runtimeGOARCH 取值口：间接调用便于单测注入（平台命令表本身
// 走 platformCommands(goos) 纯函数对拍，不依赖这里；本口只影响 manifest 头部）
var (
	runtimeGOOS   = func() string { return runtime.GOOS }
	runtimeGOARCH = func() string { return runtime.GOARCH }
)

// platformCommand 命令表条目（纯数据：GOOS 注入单测直接对拍本表）
type platformCommand struct {
	// ID manifest/输出里的稳定键
	ID string
	// GOOS 该条只在该平台执行（跨平台不派发，不依赖 shell 语义）
	GOOS string
	// Args argv 列式（不经 shell）：无引号/转义/时序注入面
	Args []string
	// Optional true = 增强项，拿不到记 skipped；false = 基线项，同样不标红
	// 但 note 前缀区分 basis 便于人读
	Optional bool
	// Note 人类可读说明（写进 platform.txt 的命令行注释）
	Note string
	// MaxLines/MaxBytes 输出上限（0 = 不限）；截断事实由 runPlatformCommand
	// 写进 sample.Note，读者不会把裁剪当成「命令只输出这么多」
	MaxLines int
	MaxBytes int
	// Filter 输出过滤（进程树：ps 全表按本二进制 + tmux 收窄）
	Filter commandFilter
}

// platformCommands 平台命令表（纯函数：单测按 GOOS 注入三分支断言）。
// Windows 只列系统内置命令；Linux/macOS 只列 coreutils/系统自带。
//
// 深度采样落点（P-20261122-11）：
//   - macOS：launchctl print gui/<uid>/com.codecombo 是 #26 组杀类第一手
//     证据（state/runs/last exit code）；`log show` 刻意**不自动跑**（秒级
//     到分钟级 + <private> 遮挡），命令只写包内 README。
//   - Linux：systemctl show -p Restart,KillMode,Type,User 正是 #26 判别式；
//     journalctl 200 行 best-effort（无权限 → skipped）。**不采** cgroup
//     memory.stat（S2b 评审：它会读整段层级且信息被 /proc/meminfo 完全覆盖）。
//   - Windows：只 sc query 状态 + netstat 监听表，**不做进程树**（扫描贵、
//     价值低——#26 类判别证据只存在于 unix 监管形态）。
//   - 监听表按平台分支：ss(linux) / lsof(darwin) / netstat(windows)。
func platformCommands(env platformEnv) []platformCommand {
	switch env.GOOS {
	case "windows":
		return []platformCommand{
			{
				ID: "windows-ver", GOOS: "windows",
				Args: []string{"cmd", "/c", "ver"},
				Note: "Windows version banner (cmd builtin, ASCII)",
			},
			{
				ID: "windows-service", GOOS: "windows",
				Args: []string{"sc", "query", "Codecombo"},
				Note: "SCM service state for the Codecombo service (exit 1060 = not installed)",
			},
			{
				ID: "windows-listeners", GOOS: "windows", Optional: true,
				Args:     []string{"netstat", "-ano", "-p", "tcp"},
				MaxLines: 200, MaxBytes: 32 << 10, Filter: filterListenerRows,
				Note: "TCP listeners + owning PIDs (netstat builtin; filtered to LISTENING rows)",
			},
			{
				ID: "windows-memory", GOOS: "windows", Optional: true,
				Args:     []string{"wmic", "OS", "get", "TotalVisibleMemorySize,FreePhysicalMemory", "/format:list"},
				MaxLines: 10, MaxBytes: 4 << 10,
				Note: "machine memory via wmic (optional: WMIC is absent on newer Windows 11 — skipped, not an error)",
			},
			{
				ID: "windows-os-cim", GOOS: "windows", Optional: true,
				Args: []string{"powershell", "-NoProfile", "-NonInteractive", "-Command",
					"Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,LastBootUpTime | ConvertTo-Json -Compress"},
				Note: "OS caption/build/uptime via CIM (optional: skipped when PowerShell is slow or unavailable)",
			},
		}
	case "linux":
		return []platformCommand{
			{
				ID: "uname", GOOS: "linux",
				Args: []string{"uname", "-a"},
				Note: "kernel name / release / machine (full uname)",
			},
			{
				ID: "systemd-unit", GOOS: "linux", Optional: true,
				Args:     []string{"systemctl", "show", "-p", "Restart,KillMode,Type,User", env.unit()},
				MaxLines: 20, MaxBytes: 4 << 10,
				Note: "unit supervisor properties — #26 discriminator: KillMode=process is what protects the update subprocess",
			},
			{
				ID: "systemd-journal", GOOS: "linux", Optional: true,
				Args:     []string{"journalctl", "-u", env.unit(), "-n", "200", "--no-pager"},
				MaxLines: 200, MaxBytes: 64 << 10,
				Note: "system journal tail for the unit (best-effort; permission denied -> skipped)",
			},
			{
				ID: "listeners", GOOS: "linux", Optional: true,
				Args:     []string{"ss", "-ltnp"},
				MaxLines: 200, MaxBytes: 32 << 10,
				Note: "OS listening TCP sockets (unprivileged view: processes owned by other users may be blank)",
			},
			{
				ID: "process-tree", GOOS: "linux", Optional: true,
				Args:     []string{"ps", "-axo", "pid,ppid,etime,command"},
				MaxLines: 120, MaxBytes: 32 << 10, Filter: filterProcessTree,
				Note: "process tree filtered to this binary + up to 3 tmux lines",
			},
		}
	case "darwin":
		cmds := []platformCommand{
			{
				ID: "uname", GOOS: "darwin",
				Args: []string{"uname", "-a"},
				Note: "kernel name / release / machine (full uname)",
			},
			{
				ID: "sw-vers", GOOS: "darwin",
				Args: []string{"sw_vers"},
				Note: "macOS product version / build",
			},
		}
		// gui/<uid> 域需要有效 uid（os.Getuid 在 darwin 恒 >=0；-1 只出现
		// 在 Windows 语义下，不会走到本分支）
		if env.UID >= 0 {
			cmds = append(cmds, platformCommand{
				ID: "launchd-job", GOOS: "darwin", Optional: true,
				Args:     []string{"launchctl", "print", fmt.Sprintf("gui/%d/%s", env.UID, env.launchd())},
				MaxLines: 200, MaxBytes: 32 << 10,
				Note: "launchd job state/runs/last exit code — #26 group-kill first-hand evidence (never runs `log show` here: slow + <private>)",
			})
		}
		return append(cmds,
			platformCommand{
				ID: "listeners", GOOS: "darwin", Optional: true,
				Args:     []string{"lsof", "-nP", "-iTCP", "-sTCP:LISTEN"},
				MaxLines: 200, MaxBytes: 32 << 10,
				Note: "OS listening TCP sockets (lsof; can be slow on busy machines — 3s cap then skipped)",
			},
			platformCommand{
				ID: "process-tree", GOOS: "darwin", Optional: true,
				Args:     []string{"ps", "-axo", "pid,ppid,etime,command"},
				MaxLines: 120, MaxBytes: 32 << 10, Filter: filterProcessTree,
				Note: "process tree filtered to this binary + up to 3 tmux lines",
			},
			platformCommand{
				ID: "memory-sysctl", GOOS: "darwin", Optional: true,
				Args:     []string{"sysctl", "-n", "hw.memsize"},
				MaxLines: 2, MaxBytes: 256,
				Note: "machine physical memory (bytes)",
			},
		)
	default:
		// 未列平台：零命令（如实 skipped，不猜平台语义）
		return nil
	}
}

// unit Linux 单元名归一（env 由 currentPlatformEnv 填；空值兜底默认单元）
func (e platformEnv) unit() string {
	if strings.TrimSpace(e.Unit) == "" {
		return defaultSystemdUnit
	}
	return strings.TrimSpace(e.Unit)
}

// launchd launchd Label 归一（空值兜底产品固定 Label）
func (e platformEnv) launchd() string {
	if strings.TrimSpace(e.LaunchdLabel) == "" {
		return launchdLabel
	}
	return strings.TrimSpace(e.LaunchdLabel)
}

// CommandSample 单条命令的采集结果（platform.txt 与 manifest note 共用）
type CommandSample struct {
	ID      string `json:"id"`
	Command string `json:"command"`
	// Status ok | skipped（失败/超时/缺失统一 skipped：排障包不标红）
	Status string `json:"status"`
	Output string `json:"output,omitempty"`
	Note   string `json:"note,omitempty"`
}

// DiskSample 数据盘水位（sysinfo.Usage 既有双平台实现，不新造平台分支）
type DiskSample struct {
	Path        string  `json:"path"`
	TotalMB     uint64  `json:"totalMB"`
	UsedMB      uint64  `json:"usedMB"`
	FreeMB      uint64  `json:"freeMB"`
	UsedPercent float64 `json:"usedPercent"`
}

// PlatformInfo 平台基线（platform.txt 的结构化来源）
type PlatformInfo struct {
	GeneratedAt   string      `json:"generatedAt"`
	GOOS          string      `json:"goos"`
	GOARCH        string      `json:"goarch"`
	GoVersion     string      `json:"goVersion"`
	NumCPU        int         `json:"numCPU"`
	Goroutines    int         `json:"goroutines"`
	MemAllocBytes uint64      `json:"memAllocBytes"`
	MemSysBytes   uint64      `json:"memSysBytes"`
	HeapAlloc     uint64      `json:"heapAllocBytes"`
	NumGC         uint32      `json:"numGC"`
	TimeLocal     string      `json:"timeLocal"`
	DataDir       string      `json:"dataDir"`
	Disk          *DiskSample `json:"disk,omitempty"`
	OSRelease     string      `json:"osRelease,omitempty"`
	// MachineMemory 整机内存（S2b best-effort；与上面的 Go runtime 口径分开）
	MachineMemory *MemorySample `json:"machineMemory,omitempty"`
	// ProcessTree unix 进程树（Windows 显式 skipped + 替代命令提示）
	ProcessTree *ProcessTreeSample `json:"processTree,omitempty"`
	Commands    []CommandSample    `json:"commands,omitempty"`
	Notes       []string           `json:"notes,omitempty"`
}

// collectPlatform 采集平台基线与深度采样（ctx 由收集器统一 20s 预算钳制）
func collectPlatform(ctx context.Context, goos, dataDir string, red *Redactor, now time.Time) PlatformInfo {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	info := PlatformInfo{
		GeneratedAt:   now.Format(time.RFC3339),
		GOOS:          goos,
		GOARCH:        runtime.GOARCH,
		GoVersion:     runtime.Version(),
		NumCPU:        runtime.NumCPU(),
		Goroutines:    runtime.NumGoroutine(),
		MemAllocBytes: ms.Alloc,
		MemSysBytes:   ms.Sys,
		HeapAlloc:     ms.HeapAlloc,
		NumGC:         ms.NumGC,
		// tzdata 纪律（P-20261005-217 内嵌 time/tzdata）：排障常被「跨时区
		// 错点」误导，这里直接给出进程解析到的本地时区名
		TimeLocal: time.Local.String(),
		DataDir:   red.Path(dataDir),
	}
	if du, err := sysinfo.Usage(dataDir); err == nil {
		info.Disk = &DiskSample{
			Path:        red.Path(dataDir),
			TotalMB:     du.Total / 1024 / 1024,
			UsedMB:      du.Used() / 1024 / 1024,
			FreeMB:      du.Free / 1024 / 1024,
			UsedPercent: du.UsedPercent(),
		}
	} else {
		info.Notes = append(info.Notes, "disk usage unavailable: "+red.Line(err.Error()))
	}
	// Linux 发行版基线走文件读（非命令）：/etc/os-release 是标准位置，
	// 容器/精简镜像缺失时如实缺席
	if goos == "linux" {
		if b, err := os.ReadFile("/etc/os-release"); err == nil {
			info.OSRelease = red.Line(firstLines(string(b), 6))
		}
	}

	env := currentPlatformEnv(goos)
	for _, cmd := range platformCommands(env) {
		if cmd.GOOS != goos {
			continue // 表项与宿主平台不符：不派发（纯数据表也可跨平台复用）
		}
		sample := runPlatformCommand(ctx, cmd, env.ExeBase, red)
		info.Commands = append(info.Commands, sample)
		if sample.Status != "ok" && sample.Note != "" {
			info.Notes = append(info.Notes, cmd.ID+": "+sample.Note)
		}
	}
	info.MachineMemory = collectMachineMemory(goos, info.Commands, red)
	info.ProcessTree = processTreeFrom(goos, info.Commands)
	if goos == "darwin" {
		// log show 永不自动跑（秒级到分钟级 + <private> 遮挡）：命令只写
		// 包内 README；平台面只声明「为什么这里没有」
		info.Notes = append(info.Notes,
			"macOS system logs are not collected automatically (`log show` is slow and redacts <private>) — manual command and DiagnosticReports path hint are in README.txt")
	}
	return info
}

// processTreeFrom 从命令表结果提取进程树；Windows 不做进程树（评审裁定：
// 扫描贵、值低——#26 类判别证据只存在于 unix 监管形态），给替代命令提示。
func processTreeFrom(goos string, samples []CommandSample) *ProcessTreeSample {
	if goos == "windows" {
		return &ProcessTreeSample{
			Status: "skipped",
			Note: "process tree is not collected on Windows (scan cost vs diagnostic value) — " +
				"use `tasklist /FI \"PID eq <pid>\"` with the pid from state/runtime.json",
		}
	}
	for _, s := range samples {
		if s.ID != "process-tree" {
			continue
		}
		return &ProcessTreeSample{Command: s.Command, Status: s.Status, Note: s.Note, Output: s.Output}
	}
	return nil
}

// runPlatformCommand 执行单条平台命令（3s 钳制，失败=skipped 不标红）。
// 输出处理顺序固定：解码 → 过滤 → 上限 → 逐行脱敏/路径归一——先裁剪再
// 脱敏会让 note 里的「截断」与包内字节对得上，且脱敏只处理真正入包的行。
func runPlatformCommand(ctx context.Context, cmd platformCommand, exeBase string, red *Redactor) CommandSample {
	sample := CommandSample{
		ID:      cmd.ID,
		Command: red.Line(strings.Join(cmd.Args, " ")),
	}
	cctx, cancel := context.WithTimeout(ctx, platformCommandTimeout)
	defer cancel()
	// #nosec G204 —— 命令表是编译期常量（platformCommands），无用户输入拼接
	out, err := exec.CommandContext(cctx, cmd.Args[0], cmd.Args[1:]...).Output()
	text, note := decodeCommandOutput(out)
	switch cmd.Filter {
	case filterProcessTree:
		filtered, filterNote := filterProcessTreeOutput(text, exeBase)
		text = filtered
		note = joinNote(note, filterNote)
	case filterListenerRows:
		filtered, filterNote := filterListenerRowOutput(text)
		text = filtered
		note = joinNote(note, filterNote)
	}
	if cmd.MaxLines > 0 || cmd.MaxBytes > 0 {
		capped, capNote := capCommandOutput(text, cmd.MaxLines, cmd.MaxBytes)
		text = capped
		note = joinNote(note, capNote)
	}
	text = redactCommandText(red, text)
	if err != nil {
		sample.Status = "skipped"
		if cctx.Err() == context.DeadlineExceeded {
			note = joinNote(note, fmt.Sprintf("timed out after %s", platformCommandTimeout))
		} else {
			note = joinNote(note, commandErrorText(err, red))
		}
		sample.Note = note
		if text != "" {
			sample.Output = text
		}
		return sample
	}
	sample.Status = "ok"
	sample.Note = note
	sample.Output = text
	return sample
}

// decodeCommandOutput 输出解码：合法 UTF-8 原样；非法（Windows 控制台码页
// 等）剥非 ASCII 并给出 note（manifest 与 platform.txt 同步可见）
func decodeCommandOutput(raw []byte) (string, string) {
	if utf8.Valid(raw) {
		return strings.TrimRight(string(raw), "\r\n"), ""
	}
	var b strings.Builder
	for _, r := range string(raw) {
		// 只留可打印 ASCII + 换行/制表：Windows 控制台码页（CP936/CP437…）
		// 的多字节序列在这里被整体剥掉，ASCII 骨架（版本号/服务状态）保留
		if r == '\n' || r == '\t' || (r >= 0x20 && r < 0x7f) {
			b.WriteRune(r)
		}
	}
	return strings.TrimRight(b.String(), "\r\n"),
		"non-UTF-8 output (console code page) — non-ASCII bytes stripped"
}

// commandErrorText 命令失败的如实说明：exit status + stderr 前几行
// （journalctl「No journal files were found」/「Access denied」这类原因是
// skipped 是否有意义的唯一线索——只给 exit status 读者无从判断）。
// exec.Cmd.Output 在 Stderr 未显式设置时把管道收进 ExitError.Stderr。
func commandErrorText(err error, red *Redactor) string {
	msg := err.Error()
	var ee *exec.ExitError
	if errors.As(err, &ee) && len(ee.Stderr) > 0 {
		if text, _ := decodeCommandOutput(ee.Stderr); text != "" {
			msg = joinNote(msg, firstLines(text, 3))
		}
	}
	return red.Line(msg)
}

func joinNote(a, b string) string {
	if b == "" {
		return a
	}
	if a == "" {
		return b
	}
	return a + "; " + b
}

func firstLines(s string, n int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, "\n")
}

// formatPlatformText platform.txt 的文本渲染（人读；结构化副本在 manifest
// 与 runtime.json 的相邻字段里）
func formatPlatformText(info PlatformInfo) string {
	var b strings.Builder
	b.WriteString("# platform baseline — codecombo diagnostics (P-20261122-10, deep sampling P-20261122-11)\n")
	fmt.Fprintf(&b, "generatedAt: %s\n", info.GeneratedAt)
	fmt.Fprintf(&b, "os/arch:     %s/%s\n", info.GOOS, info.GOARCH)
	fmt.Fprintf(&b, "go version:  %s\n", info.GoVersion)
	fmt.Fprintf(&b, "cpu:         %d\n", info.NumCPU)
	fmt.Fprintf(&b, "goroutines:  %d\n", info.Goroutines)
	fmt.Fprintf(&b, "mem:         alloc=%s sys=%s heap=%s gc=%d\n",
		humanBytes(info.MemAllocBytes), humanBytes(info.MemSysBytes), humanBytes(info.HeapAlloc), info.NumGC)
	if m := info.MachineMemory; m != nil {
		if m.TotalMB > 0 {
			line := fmt.Sprintf("machine mem: %d MB total", m.TotalMB)
			if m.AvailableMB > 0 {
				line += fmt.Sprintf(", %d MB available", m.AvailableMB)
			}
			fmt.Fprintf(&b, "%s (source: %s)\n", line, m.Source)
			if m.Note != "" {
				fmt.Fprintf(&b, "machine mem note: %s\n", m.Note)
			}
		} else {
			fmt.Fprintf(&b, "machine mem: unavailable (source: %s) — %s\n", m.Source, m.Note)
		}
	}
	fmt.Fprintf(&b, "time local:  %s\n", info.TimeLocal)
	fmt.Fprintf(&b, "data dir:    %s\n", info.DataDir)
	if info.Disk != nil {
		fmt.Fprintf(&b, "data disk:   %d MB used / %d MB total (%.1f%% used, %d MB free)\n",
			info.Disk.UsedMB, info.Disk.TotalMB, info.Disk.UsedPercent, info.Disk.FreeMB)
	}
	if info.OSRelease != "" {
		b.WriteString("\n## os-release\n")
		b.WriteString(info.OSRelease)
		b.WriteString("\n")
	}
	if len(info.Commands) > 0 {
		b.WriteString("\n## commands\n")
	}
	for _, c := range info.Commands {
		// 进程树在下方独立成节（含裁剪说明）；这里跳过避免整段重复
		if c.ID == "process-tree" {
			continue
		}
		fmt.Fprintf(&b, "$ %s\n  status: %s\n", c.Command, c.Status)
		if c.Note != "" {
			fmt.Fprintf(&b, "  note: %s\n", c.Note)
		}
		if c.Output != "" {
			for _, line := range strings.Split(c.Output, "\n") {
				fmt.Fprintf(&b, "  | %s\n", line)
			}
		}
	}
	if pt := info.ProcessTree; pt != nil {
		b.WriteString("\n## process tree\n")
		if pt.Command != "" {
			fmt.Fprintf(&b, "$ %s\n", pt.Command)
		}
		fmt.Fprintf(&b, "  status: %s\n", pt.Status)
		if pt.Note != "" {
			fmt.Fprintf(&b, "  note: %s\n", pt.Note)
		}
		if pt.Output != "" {
			for _, line := range strings.Split(pt.Output, "\n") {
				fmt.Fprintf(&b, "  | %s\n", line)
			}
		}
	}
	if len(info.Notes) > 0 {
		b.WriteString("\n## notes\n")
		for _, n := range info.Notes {
			fmt.Fprintf(&b, "- %s\n", n)
		}
	}
	return b.String()
}

// humanBytes 人类可读字节数（日志与 platform.txt 共用，1024 进制）
func humanBytes(n uint64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := uint64(unit), 0
	for v := n / unit; v >= unit && exp < 5; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
