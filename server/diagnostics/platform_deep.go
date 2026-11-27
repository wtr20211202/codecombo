package diagnostics

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"codecombo/server/update"
)

// 平台深度采样（P-20261122-11 S2b）：在 S2a 的「跨平台基线」之上补
// 「这台机器上它到底被谁管、有没有在听端口、进程树长什么样、内存多大」。
//
// 纪律与 S2a 逐字一致：单命令 3s、无特权、缺失/失败 → skipped 不标红、
// 命令表纯数据化 + GOOS 注入单测三分支。本文件只放深度采样的纯函数与
// 数据形态（身份上下文/输出裁剪/进程树过滤/机器内存解析），命令表与渲染
// 仍在 platform.go——表是单一事实源，别把命令散到两个文件里。
//
// 为什么进程树只做 unix（评审裁定）：Windows 上枚举进程要 wmic/tasklist
// 全表 + 父子关系还原，扫描成本高而 #26 类判别证据（launchd 组杀、systemd
// KillMode、换包子进程死活）只存在于 unix 监管形态；Windows 侧给
// tasklist 提示即可，不为了「三平台对称」付这个成本。

const (
	// launchdLabel 产品 launchd 代理 Label（docs/deploy-linux.md §6.1 /
	// scripts/install.sh 固定值：一机一个脚本托管服务）
	launchdLabel = "com.codecombo"
	// defaultSystemdUnit 产品 systemd 单元名（旧名 simple-coding.service 由
	// update.SuperviseForm 的 cgroup 自检覆盖；这里只是「自检没命中」时的
	// 兜底查询目标——查不到即 skipped，不猜）
	defaultSystemdUnit = "codecombo.service"
	// processTreeTmuxLines 进程树里 tmux 行的保留上限：tmux server 与其下
	// 会话/子进程都含 "tmux"，全留会把 ps 表重新铺满；三行足够回答「是不是
	// tmux 托管、会话还在不在」
	processTreeTmuxLines = 3
)

// commandFilter 命令输出过滤器（进程树收窄 / Windows 监听表去非监听行；
// 表里以数据声明，派发逻辑集中在 runPlatformCommand，别在表项里塞函数）
type commandFilter int

const (
	filterNone commandFilter = iota
	filterProcessTree
	// filterListenerRows 监听表只留 LISTENING 行（Windows netstat 不带
	// -l 语义，全表含 ESTABLISHED/TIME_WAIT 会把监听表淹掉）
	filterListenerRows
	// filterTail 保留末 N 行（dmesg：最新证据在尾；capCommandOutput 只从
	// 头部剪，方向相反）
	filterTail
)

// platformEnv 深度采样的身份上下文（纯数据：GOOS 注入单测直接构造对拍）。
// 命令参数里的单元名/UID/二进制名都从这里来——表保持纯函数，测试不依赖
// 宿主真实环境（runner/容器/裸机各不相同）。
type platformEnv struct {
	GOOS         string
	Unit         string // Linux systemd 单元（自检命中优先，兜底 defaultSystemdUnit）
	LaunchdLabel string
	UID          int    // macOS gui/<uid> 域
	ExeBase      string // 本进程二进制基名（ps 过滤）
}

// currentPlatformEnv 组装宿主身份：Linux 优先用 update.SuperviseForm 自检
// 命中的 systemd 单元（#26 关心的 KillMode 属于「实际托管我们的那个单元」，
// 不是产品名猜测——宿主自身是 systemd 服务时同样命中，如实采该单元）。
func currentPlatformEnv(goos string) platformEnv {
	env := platformEnv{
		GOOS:         goos,
		Unit:         defaultSystemdUnit,
		LaunchdLabel: launchdLabel,
		UID:          os.Getuid(), // Windows 恒 -1（os 包契约）；只在 darwin 用
	}
	if exe, err := os.Executable(); err == nil {
		env.ExeBase = filepath.Base(exe)
	}
	if goos == "linux" {
		if form, detail := update.SuperviseForm(); form == "systemd" && detail != "" {
			env.Unit = detail
		}
	}
	return env
}

// MemorySample 机器内存（best-effort：拿不到只记 source+note，不标红）。
// 与 PlatformInfo 里的 Go runtime MemStats 刻意分开——后者是进程堆口径，
// 前者回答「整机还剩多少内存」（换包/大目录迁移被 OOM 击杀时先看这个）。
type MemorySample struct {
	// Source /proc/meminfo | sysctl hw.memsize | wmic | …
	Source string `json:"source"`
	// TotalMB 物理内存总量（MiB）
	TotalMB uint64 `json:"totalMB,omitempty"`
	// AvailableMB 可用内存（MiB；macOS sysctl 口径只有总量，此字段缺席）
	AvailableMB uint64 `json:"availableMB,omitempty"`
	// Note 取不到/降级口径的原文（不标红）
	Note string `json:"note,omitempty"`
}

// ProcessTreeSample 进程树（unix only；Windows 显式 skipped 并给替代命令）。
// Output 已过滤到本二进制 + 至多 3 行 tmux 并逐行脱敏——ps 全表既不必要
// 也会把无关进程的命令行（可能含凭据）带进包。
type ProcessTreeSample struct {
	Command string `json:"command"`
	Status  string `json:"status"`
	Note    string `json:"note,omitempty"`
	Output  string `json:"output,omitempty"`
}

// capCommandOutput 输出上限：先按行、再按字节（0=不限）。返回截断事实说明，
// 由调用方并入 sample.Note——「capped」必须在包里可见，否则读者会把截断
// 当成命令只输出这么多。
// filterTailOutput 保留末 n 行（n<=0 原样）
func filterTailOutput(text string, n int) (string, string) {
	if n <= 0 {
		return text, ""
	}
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	if len(lines) <= n {
		return text, ""
	}
	return strings.Join(lines[len(lines)-n:], "\n"), fmt.Sprintf("kept the last %d lines", n)
}

func capCommandOutput(text string, maxLines, maxBytes int) (string, string) {
	var notes []string
	if maxLines > 0 {
		lines := strings.Split(text, "\n")
		if len(lines) > maxLines {
			text = strings.Join(lines[:maxLines], "\n")
			notes = append(notes, fmt.Sprintf("output capped at %d lines", maxLines))
		}
	}
	if maxBytes > 0 && len(text) > maxBytes {
		cut := text[:maxBytes]
		if i := strings.LastIndexByte(cut, '\n'); i > 0 {
			cut = cut[:i]
		}
		text = cut
		notes = append(notes, fmt.Sprintf("output capped at %s", humanBytes(uint64(maxBytes))))
	}
	if len(notes) == 0 {
		return text, ""
	}
	return text, strings.Join(notes, "; ") + " — rerun the command manually for the full output"
}

// filterProcessTree 把 ps 全表过滤成「本二进制 + 至多 N 行 tmux」：
//   - 表头保留（读者要知道列含义）；
//   - 含二进制基名的行全留（主进程、换包子进程、残留旧版都能看见）；
//   - tmux 行单独限量（见 processTreeTmuxLines）。
//
// 零命中不是错误：改名部署/容器里 ps 视图可能不同——note 如实说明。
func filterProcessTreeOutput(text, exeBase string) (string, string) {
	lines := strings.Split(text, "\n")
	out := make([]string, 0, 16)
	kept, tmux := 0, 0
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if i == 0 && strings.Contains(strings.ToUpper(trimmed), "COMMAND") {
			out = append(out, line) // ps 表头
			continue
		}
		if exeBase != "" && strings.Contains(line, exeBase) {
			out = append(out, line)
			kept++
			continue
		}
		if tmux < processTreeTmuxLines && strings.Contains(line, "tmux") {
			out = append(out, line)
			tmux++
		}
	}
	note := fmt.Sprintf("filtered to lines mentioning %q (all) + up to %d tmux lines (%d+%d kept)",
		exeBase, processTreeTmuxLines, kept, tmux)
	if kept == 0 && tmux == 0 {
		note += "; no matching process found — the service may run under a renamed binary"
	}
	return strings.Join(out, "\n"), note
}

// filterListenerRows 只留监听行 + 表头（netstat 全表含已建立/等待态连接，
// 监听表语义要求 LISTENING/Proto 头）。空表也如实给 note。
func filterListenerRowOutput(text string) (string, string) {
	out := make([]string, 0, 64)
	kept := 0
	for _, line := range strings.Split(text, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if strings.Contains(trimmed, "Proto") { // netstat 表头
			out = append(out, line)
			continue
		}
		if strings.Contains(trimmed, "LISTENING") {
			out = append(out, line)
			kept++
		}
	}
	note := fmt.Sprintf("filtered to LISTENING rows (%d kept)", kept)
	if kept == 0 {
		note += "; no listening TCP socket found"
	}
	return strings.Join(out, "\n"), note
}

// redactCommandText 命令输出逐行过归一器（mask + 路径归一）。
// 为什么统一在这里做：S2b 的输出面扩大后（journalctl 是日志原文、launchctl
// print 含 EnvironmentVariables、ps 含完整命令行），「命令输出默认安全」
// 的假设不再成立；逐行处理与 raw 日志同一口径，也顺带把 DataDir 归一成
// $DATA_DIR。
func redactCommandText(red *Redactor, text string) string {
	if text == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	for i := range lines {
		lines[i] = red.Line(lines[i])
	}
	return strings.Join(lines, "\n")
}

// collectMachineMemory 机器内存 best-effort：Linux 读 /proc/meminfo（文件，
// 零子进程）；darwin/windows 取命令表里已执行的 sample 解析（同一次执行，
// 不重复 spawn）。
func collectMachineMemory(goos string, samples []CommandSample, red *Redactor) *MemorySample {
	switch goos {
	case "linux":
		return linuxMachineMemory(red)
	case "darwin":
		return memoryFromSample(samples, "memory-sysctl", parseSysctlBytes)
	case "windows":
		return memoryFromSample(samples, "windows-memory", parseWmicMemory)
	}
	return nil
}

// linuxMachineMemory /proc/meminfo 解析（MemAvailable 缺失的老内核回落
// MemFree 并在 note 里说明口径）
func linuxMachineMemory(red *Redactor) *MemorySample {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return &MemorySample{Source: "/proc/meminfo", Note: red.Line(err.Error())}
	}
	mem, _ := parseMeminfo(string(b))
	mem.Source = "/proc/meminfo"
	return &mem
}

// parseMeminfo MemTotal/MemAvailable（/proc/meminfo 的 kB 单位）
func parseMeminfo(text string) (MemorySample, string) {
	var mem MemorySample
	var kBAvail, kBFree uint64
	for _, line := range strings.Split(text, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		kb, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "MemTotal:":
			mem.TotalMB = kb / 1024
		case "MemAvailable:":
			kBAvail = kb
		case "MemFree:":
			kBFree = kb
		}
	}
	// MemAvailable 缺失（老内核 <3.14）才回落 MemFree，并显式标注口径
	if kBAvail == 0 {
		kBAvail = kBFree
		if kBFree > 0 {
			mem.Note = "MemAvailable missing (kernel < 3.14) — available falls back to MemFree"
		}
	}
	mem.AvailableMB = kBAvail / 1024
	if mem.TotalMB == 0 {
		mem.Note = joinNote(mem.Note, "MemTotal not found in /proc/meminfo")
	}
	return mem, mem.Note
}

// memoryFromSample 取命令表里的内存命令结果（同一次执行，不重复 spawn）
func memoryFromSample(samples []CommandSample, id string, parse func(string) (MemorySample, bool)) *MemorySample {
	for _, s := range samples {
		if s.ID != id {
			continue
		}
		source := s.Command
		if s.Status != "ok" {
			note := s.Note
			if note == "" {
				note = "command unavailable or failed"
			}
			return &MemorySample{Source: source, Note: note}
		}
		mem, ok := parse(s.Output)
		if !ok {
			return &MemorySample{Source: source, Note: "output did not parse as a byte/kB figure"}
		}
		mem.Source = source
		return &mem
	}
	return nil
}

// parseSysctlBytes `sysctl -n hw.memsize` 单行字节数
func parseSysctlBytes(out string) (MemorySample, bool) {
	v := strings.TrimSpace(firstLines(out, 1))
	n, err := strconv.ParseUint(v, 10, 64)
	if err != nil || n == 0 {
		return MemorySample{}, false
	}
	return MemorySample{TotalMB: n / 1024 / 1024}, true
}

// parseWmicMemory `wmic OS get TotalVisibleMemorySize,FreePhysicalMemory
// /format:list` 的 KEY=VALUE 行（单位 kB）
func parseWmicMemory(out string) (MemorySample, bool) {
	var mem MemorySample
	var availKB uint64
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "TotalVisibleMemorySize="):
			if kb, err := strconv.ParseUint(strings.TrimPrefix(line, "TotalVisibleMemorySize="), 10, 64); err == nil {
				mem.TotalMB = kb / 1024
			}
		case strings.HasPrefix(line, "FreePhysicalMemory="):
			if kb, err := strconv.ParseUint(strings.TrimPrefix(line, "FreePhysicalMemory="), 10, 64); err == nil {
				availKB = kb
			}
		}
	}
	mem.AvailableMB = availKB / 1024
	if mem.TotalMB == 0 {
		return MemorySample{}, false
	}
	return mem, true
}
