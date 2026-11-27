//go:build !windows && !linux

package diagnostics

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// darwin/其它 unix 进程自观测 best-effort（P-20261126-3 S2）：mac 没有 /proc，
// 纯 Go 也拿不到自身 RSS/CPU（task_info 需 mach 端口且要 cgo）——按提案走 `ps`
// 等价口径并如实标注（%cpu 是衰减均值不是区间差分；句柄数 darwin 无此概念）。
// 命令纪律与 hostinfo.go 兜底族一致：exec.CommandContext + WaitDelay=500ms +
// 2s 超时；失败整段 Note 如实、不猜 0。

const (
	procCmdWaitDelay = 500 * time.Millisecond
	procCmdTimeout   = 2 * time.Second
)

// processCPUSecondsTotal darwin 无原生口：ps -o time= 的 MM:SS.ss 口径（导出时
// collectProcessSection 走 processInstantSample；tracker 差分对 darwin 不可用，
// CPU% 直接用 ps 的 %cpu，basis 注明）。本口恒 false——tracker 会如实标 warmup。
func processCPUSecondsTotal() (float64, bool) {
	return 0, false
}

// psSelfFields 一次 ps 拿 %cpu/rss(KB)/nlwp（等价口径；失败零值+ok=false）
func psSelfFields() (cpuPercent float64, rssBytes float64, threads int, ok bool) {
	ctx, cancel := context.WithTimeout(context.Background(), procCmdTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ps", "-p", strconv.Itoa(os.Getpid()), "-o", "%cpu=,rss=,nlwp=")
	cmd.WaitDelay = procCmdWaitDelay
	out, err := cmd.Output()
	if err != nil {
		return 0, 0, 0, false
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) < 3 {
		return 0, 0, 0, false
	}
	cpu, e1 := strconv.ParseFloat(fields[0], 64)
	rssKB, e2 := strconv.ParseFloat(fields[1], 64)
	nlwp, e3 := strconv.Atoi(fields[2])
	if e1 != nil || e2 != nil || e3 != nil {
		return 0, 0, 0, false
	}
	return cpu, rssKB * 1024, nlwp, true
}

// processInstantSample darwin 即时样本（ps best-effort）
func processInstantSample() (ProcessSample, bool) {
	cpu, rss, threads, ok := psSelfFields()
	if !ok {
		return ProcessSample{Note: "ps probe failed (darwin best-effort)"}, false
	}
	return ProcessSample{
		// ps 的 %cpu 是衰减指数均值（口径与差分 tracker 不同）——直接透传并靠
		// basis 注明，不做换算；共享 collectProcessSection 对 darwin 不走 tracker
		CPUPercent: cpu,
		RSSMB:      mbOf(rss),
		Threads:    threads,
	}, true
}
