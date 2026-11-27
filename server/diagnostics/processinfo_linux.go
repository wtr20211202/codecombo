//go:build linux

package diagnostics

import (
	"strconv"
	"strings"
)

// Linux 进程自观测（P-20261126-3 S2）：/proc 主路径零子进程零特权。
// host.json 的 procStatus/procIo/procLimits/cgroup 段（procinfo_linux.go）已覆盖
// 大部分 /proc 面——本文件只提供 CPU 秒/RSS/线程三个数的读取口，供 CPU% 差分
// tracker 与 host-history 采样点使用（趋势口径三平台统一）。

// linuxClockTicks USER_HZ（几乎恒为 100；/proc/stat 的 utime/stime 单位）
const linuxClockTicks = 100

// processCPUSecondsTotal /proc/self/stat 的 utime+stime（字段 14/15，clock ticks）
func processCPUSecondsTotal() (float64, bool) {
	text, err := readFileBounded("/proc/self/stat")
	if err != nil {
		return 0, false
	}
	// comm 可含空格/括号：从最后一个 ')' 之后切，避开进程名干扰
	idx := strings.LastIndex(text, ")")
	if idx < 0 || idx+2 >= len(text) {
		return 0, false
	}
	fields := strings.Fields(text[idx+2:])
	// 去掉 comm 后字段下标整体前移 2：utime=第 14 个字段→下标 11，stime→下标 12
	if len(fields) < 13 {
		return 0, false
	}
	utime, e1 := strconv.ParseFloat(fields[11], 64)
	stime, e2 := strconv.ParseFloat(fields[12], 64)
	if e1 != nil || e2 != nil {
		return 0, false
	}
	return (utime + stime) / linuxClockTicks, true
}

// processRSSBytes /proc/self/status 的 VmRSS（KB）
func processRSSBytes() (float64, bool) {
	text, err := readFileBounded("/proc/self/status")
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, "VmRSS:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0, false
		}
		kb, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			return 0, false
		}
		return kb * 1024, true
	}
	return 0, false
}

// linuxThreadCount /proc/self/status 的 Threads
func linuxThreadCount() (int, bool) {
	text, err := readFileBounded("/proc/self/status")
	if err != nil {
		return 0, false
	}
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, "Threads:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return 0, false
		}
		n, err := strconv.Atoi(fields[1])
		if err != nil {
			return 0, false
		}
		return n, true
	}
	return 0, false
}

// processInstantSample Linux 即时样本（RSS/Threads/CPU 秒；Private/Handles 无 /proc
// 对应面——句柄数可用 ls /proc/self/fd 计数但那是「打开的 fd」不是句柄总数，口径
// 不同不入：skippedFields/basis 说明，不造数字）
func processInstantSample() (ProcessSample, bool) {
	var notes []string
	p := ProcessSample{}
	if secs, ok := processCPUSecondsTotal(); ok {
		p.CPUSecondsTotal = secs
	} else {
		notes = append(notes, "/proc/self/stat unavailable")
	}
	if b, ok := processRSSBytes(); ok {
		p.RSSMB = mbOf(b)
	} else {
		notes = append(notes, "VmRSS unavailable")
	}
	if n, ok := linuxThreadCount(); ok {
		p.Threads = n
	} else {
		notes = append(notes, "Threads unavailable")
	}
	p.Note = joinNotes(notes)
	return p, true
}
