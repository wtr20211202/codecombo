package diagnostics

import (
	"runtime"
	"sync"
	"time"
)

// 进程自观测跨平台（P-20261126-3 S2）：procinfo 的 /proc 全套此前 Linux-only，
// procinfo_other.go 是空壳——用户主力 Windows 机（及远程 Windows 部署）的诊断包
// 对自身进程的 CPU/RSS/句柄/线程一无所知。本文件是**平台无关**的那一半：
// ProcessSample 形态 + CPU% 差分 tracker；平台差异在 processinfo_{windows,linux,other}.go。
//
// 口径纪律（评审 A2，manifest/README 注明、不做跨平台等值换算）：
//   - CPU% = Δ(kernel+user CPU 秒) / Δwall × 100，单核归一，多核 busy 可 >100%；
//     首点无基准 baselineWarmup=true（hosthistory 首点磁盘增量同款先例）；
//     进程/采样器重启即清零（包级变量随进程生灭，天然清零）；
//   - Windows：CPU 秒=GetProcessTimes(FILETIME 100ns 单位)，RSS=WorkingSetSize、
//     privateMB=PrivateUsage（psapi GetProcessMemoryInfo，x/sys 无包装，本地声明），
//     句柄=GetProcessHandleCount，线程=toolhelp32 快照计数；
//   - Linux：CPU 秒=/proc/self/stat utime+stime（USER_HZ=100），RSS=/proc/self/status
//     VmRSS——host.json 的 proc 段已有更全的 /proc 面，本段只补 CPU%/趋势字段；
//   - darwin best-effort：ps -p <pid>（%cpu 是衰减均值**不是**区间差分，标注 basis）。
//   - Linux /proc 主路径之外的命令兜底纪律照旧：WaitDelay=500ms + 2s 超时。

// ProcessSample host.json process 段 / hosthistory 采样点的进程观测值。
// 字段按平台可有缺席——缺席不是 0，是 omitempty + skippedFields/basis 说明。
type ProcessSample struct {
	// CPUPercent 最近一次差分窗口的单核百分比（可 >100；warmup 时缺席）
	CPUPercent float64 `json:"cpuPercent,omitempty"`
	// BaselineWarmup 无前值基准（首个采样窗），CPU% 不可算
	BaselineWarmup bool `json:"baselineWarmup,omitempty"`
	// CPUSecondsTotal kernel+user 累计 CPU 秒（差分的原始计数）
	CPUSecondsTotal float64 `json:"cpuSecondsTotal,omitempty"`
	// RSSMB 常驻内存（Windows=WorkingSetSize / Linux=VmRSS / darwin=ps rss）
	RSSMB float64 `json:"rssMb,omitempty"`
	// PrivateMB 私有提交内存（仅 Windows=PrivateUsage）
	PrivateMB float64 `json:"privateMb,omitempty"`
	// Handles OS 句柄数（仅 Windows）
	Handles int `json:"handles,omitempty"`
	// Threads OS 线程数（Windows=toolhelp 快照 / Linux=/proc status / darwin=ps nlwp）
	Threads int `json:"threads,omitempty"`
	// Basis 口径注记（哪个 API/文件、CPU% 怎么算的——防跨平台误读）
	Basis string `json:"basis,omitempty"`
	// Note 采集失败/部分缺席的如实说明
	Note string `json:"note,omitempty"`
}

// procCPUTracker CPU% 差分状态（进程内唯一；hosthistory 采样器与 host.json
// process 段共用——两处各自采样会各建基准、互相稀释窗口）
var procCPUTracker struct {
	mu        sync.Mutex
	have      bool
	lastCPU   float64
	lastAt    time.Time
	percent   float64
	warmup    bool
	nowFunc   func() time.Time // 注入点（单测）
	cpuReader func() (float64, bool)
}

// procCPUSecondsNow 平台累计 CPU 秒读取口（processinfo_{windows,linux,other}.go 实现；
// 变量形态便于单测注入差分对）
var procCPUSecondsNow = processCPUSecondsTotal

// sampleProcessCPUPercent 差分出最近窗口的 CPU%（首次调用只建基准，warmup=true）。
// 返回的 percent 在 warmup 后恒为「上次采样→本次」的窗口均值——不是瞬时值。
func sampleProcessCPUPercent() (percent float64, warmup bool) {
	procCPUTracker.mu.Lock()
	defer procCPUTracker.mu.Unlock()
	if procCPUTracker.nowFunc == nil {
		procCPUTracker.nowFunc = time.Now
	}
	cpu, ok := procCPUSecondsNow()
	now := procCPUTracker.nowFunc()
	if !ok {
		// 平台读不到累计 CPU 秒（理论只在实现损坏时）：保持上次结果并如实 warmup
		return procCPUTracker.percent, true
	}
	if !procCPUTracker.have {
		procCPUTracker.have = true
		procCPUTracker.lastCPU = cpu
		procCPUTracker.lastAt = now
		procCPUTracker.warmup = true
		return 0, true
	}
	dWall := now.Sub(procCPUTracker.lastAt).Seconds()
	dCPU := cpu - procCPUTracker.lastCPU
	procCPUTracker.lastCPU = cpu
	procCPUTracker.lastAt = now
	procCPUTracker.warmup = false
	if dWall <= 0 {
		return procCPUTracker.percent, false
	}
	if dCPU < 0 {
		// 计数回退（理论不可能；防御除负）
		dCPU = 0
	}
	procCPUTracker.percent = dCPU / dWall * 100
	return procCPUTracker.percent, false
}

// collectProcessSection host.json 的 process 段装配：平台即时样本 + tracker 的
// CPU%（样本自带 cpuSecondsTotal，但 CPU% 只信 tracker 的差分窗口）。darwin
// 不走 tracker（ps 的 %cpu 已在即时样本里，衰减均值口径，basis 注明）。
// ok=false = 平台即时样本整体失败（section 仍带 basis/note，collection-report
// 据此记 skipped——缺席如实，不装 0）。
func collectProcessSection() (ProcessSample, bool) {
	p, ok := processInstantSample()
	if !ok {
		return ProcessSample{Basis: processBasisNote(), Note: "process metrics unavailable on this platform"}, false
	}
	if runtime.GOOS != "darwin" {
		// tracker 若从未被采样器跑过（CLI 形态/服务刚启动），这里补一次基准采样：
		// host.json 如实标 baselineWarmup，而不写一个假的 0%
		pct, warmup := sampleProcessCPUPercent()
		if !warmup {
			p.CPUPercent = pct
		} else {
			p.BaselineWarmup = true
		}
	}
	p.Basis = processBasisNote()
	return p, true
}

// processBasisNote 平台口径注记（agent 判读第一现场，防跨平台等值误读）
func processBasisNote() string {
	switch runtime.GOOS {
	case "windows":
		return "windows: cpuSeconds=GetProcessTimes (FILETIME 100ns), rssMb=WorkingSetSize, privateMb=PrivateUsage (psapi GetProcessMemoryInfo), " +
			"handles=GetProcessHandleCount, threads=toolhelp32 snapshot count; cpuPercent=delta(kernel+user)/deltaWall, single-core normalized, can exceed 100"
	case "linux":
		return "linux: cpuSeconds=/proc/self/stat utime+stime (USER_HZ=100), rssMb=/proc/self/status VmRSS, threads=/proc/self/status Threads; " +
			"cpuPercent=delta/dWall single-core normalized; the fuller /proc view is in the procStatus/procIo/procLimits/cgroup sections"
	case "darwin":
		return "darwin best-effort via ps: cpuPercent is ps's DECAYING AVERAGE (not an interval delta), rssMb from ps rss (KB), threads from ps nlwp; " +
			"handle count is not available on darwin"
	default:
		return "process self-observation is not implemented on " + runtime.GOOS
	}
}

// mbOf 字节→MB（一位小数；诊断趋势量级足够，不装精度）
func mbOf(bytes float64) float64 {
	return float64(int64(bytes/1024/1024*10+0.5)) / 10
}

// joinNotes 逐条 joinNote（共享 joinNote 分隔符；空串条目跳过）
func joinNotes(notes []string) string {
	out := ""
	for _, n := range notes {
		out = joinNote(out, n)
	}
	return out
}

// sampleProcessFields host-history 采样点的进程字段填充（三平台）：CPU% 走共享
// tracker 差分（windows/linux）；darwin 无累计 CPU 秒原生口，ps 的 %cpu 直接
// 透传（衰减均值口径，Note 已注明）。RSS 三平台都取。
func sampleProcessFields(pt *HostHistoryPoint) {
	if runtimeGOOS() == "darwin" {
		if p, ok := processInstantSample(); ok {
			pt.ProcessCPUPercent = p.CPUPercent
			pt.ProcessRSSMB = p.RSSMB
		}
		return
	}
	if pct, warmup := sampleProcessCPUPercent(); !warmup {
		pt.ProcessCPUPercent = pct
	} else {
		pt.ProcessCPUWarmup = true
	}
	if p, ok := processInstantSample(); ok {
		pt.ProcessRSSMB = p.RSSMB
	}
}
