//go:build windows

package diagnostics

import (
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Windows 进程自观测（P-20261126-3 S2，评审 A2 双轨口径）：
//   - GetProcessTimes：x/sys/windows 既有包装（syscall_windows.go:229），走
//     GetCurrentProcess 伪句柄，免 CloseHandle；
//   - 内存/句柄：x/sys v0.47.0 **无** GetProcessMemoryInfo/GetProcessHandleCount
//     （psapi 仅 EnumProcesses/EnumProcessModules/GetModuleInformation/QueryWorkingSetEx）
//     ——经 NewLazySystemDLL + 本地声明 PROCESS_MEMORY_COUNTERS_EX，仓内先例
//     server/update/do_update_windows.go:13（syscall.NewLazyDLL 同款）；
//   - 线程数：CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD) 计数本进程线程——
//     一次性系统级快照（数百线程量级），仅导出/采样时调用。
//
// LazyProc.Call 惯例：err 恒为 errno（成功=ERROR_SUCCESS），成败只看返回值 r1；
// 全部无特权、零子进程；任一 API 失败只丢该字段（Note 如实），不整段失败。

var winProcOnce sync.Once
var (
	kernel32DLL              *windows.LazyDLL
	psapiDLL                 *windows.LazyDLL
	procGetProcessMemoryInfo *windows.LazyProc
	procGetProcessHandleCnt  *windows.LazyProc
	procCreateToolhelp32Snap *windows.LazyProc
	procThread32First        *windows.LazyProc
	procThread32Next         *windows.LazyProc
	procCloseHandleLazy      *windows.LazyProc
)

func loadWinProcProcs() {
	kernel32DLL = windows.NewLazySystemDLL("kernel32.dll")
	psapiDLL = windows.NewLazySystemDLL("psapi.dll")
	procGetProcessMemoryInfo = psapiDLL.NewProc("GetProcessMemoryInfo")
	procGetProcessHandleCnt = kernel32DLL.NewProc("GetProcessHandleCount")
	procCreateToolhelp32Snap = kernel32DLL.NewProc("CreateToolhelp32Snapshot")
	procThread32First = kernel32DLL.NewProc("Thread32First")
	procThread32Next = kernel32DLL.NewProc("Thread32Next")
	procCloseHandleLazy = kernel32DLL.NewProc("CloseHandle")
}

// processMemoryCountersEx psapi 的 PROCESS_MEMORY_COUNTERS_EX（x/sys 未声明；
// SIZE_T 字段全部 uintptr，CB 必须是本结构真实大小）
type processMemoryCountersEx struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
	PrivateUsage               uintptr
}

// threadEntry32 kernel32 的 THREADENTRY32（toolhelp 枚举用；只关心 OwnerProcessID）
type threadEntry32 struct {
	Size           uint32
	Usage          uint32
	ThreadID       uint32
	OwnerProcessID uint32
	BasePriority   int32
	DeltaPriority  int32
	Flags          uint32
}

// th32csSnapThread CreateToolhelp32Snapshot 的 TH32CS_SNAPTHREAD 标志
const th32csSnapThread = 0x4

// processCPUSecondsTotal 进程累计 CPU 秒（kernel+user；FILETIME 100ns 单位）
func processCPUSecondsTotal() (float64, bool) {
	h, err := windows.GetCurrentProcess()
	if err != nil {
		return 0, false
	}
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &creation, &exit, &kernel, &user); err != nil {
		return 0, false
	}
	toSeconds := func(ft windows.Filetime) float64 {
		n := int64(ft.HighDateTime)<<32 | int64(ft.LowDateTime)
		return float64(n) / 1e7 // 100ns → s
	}
	return toSeconds(kernel) + toSeconds(user), true
}

// processInstantSample Windows 即时样本（RSS/Private/Handles/Threads + 累计 CPU 秒）
func processInstantSample() (ProcessSample, bool) {
	winProcOnce.Do(loadWinProcProcs)
	p := ProcessSample{}
	var notes []string

	if secs, ok := processCPUSecondsTotal(); ok {
		p.CPUSecondsTotal = secs
	} else {
		notes = append(notes, "GetProcessTimes failed")
	}

	if h, err := windows.GetCurrentProcess(); err == nil {
		var pmc processMemoryCountersEx
		pmc.CB = uint32(unsafe.Sizeof(pmc))
		if r1, _, _ := procGetProcessMemoryInfo.Call(uintptr(h), uintptr(unsafe.Pointer(&pmc)), uintptr(pmc.CB)); r1 != 0 {
			p.RSSMB = mbOf(float64(pmc.WorkingSetSize))
			p.PrivateMB = mbOf(float64(pmc.PrivateUsage))
		} else {
			notes = append(notes, "GetProcessMemoryInfo failed")
		}
		var handles uint32
		if r1, _, _ := procGetProcessHandleCnt.Call(uintptr(h), uintptr(unsafe.Pointer(&handles))); r1 != 0 {
			p.Handles = int(handles)
		} else {
			notes = append(notes, "GetProcessHandleCount failed")
		}
	} else {
		notes = append(notes, "GetCurrentProcess failed")
	}

	if n, ok := winThreadCount(); ok {
		p.Threads = n
	} else {
		notes = append(notes, "toolhelp thread snapshot failed")
	}
	p.Note = joinNotes(notes)
	return p, true
}

// winThreadCount toolhelp32 快照计数本进程线程（失败 ok=false，不猜 0）
func winThreadCount() (int, bool) {
	pid := windows.GetCurrentProcessId()
	hSnap, _, _ := procCreateToolhelp32Snap.Call(th32csSnapThread, 0)
	if hSnap == uintptr(windows.InvalidHandle) {
		return 0, false
	}
	defer func() { _, _, _ = procCloseHandleLazy.Call(hSnap) }()
	ent := threadEntry32{Size: uint32(unsafe.Sizeof(threadEntry32{}))}
	if r, _, _ := procThread32First.Call(hSnap, uintptr(unsafe.Pointer(&ent))); r == 0 {
		return 0, false
	}
	n := 0
	for {
		if ent.OwnerProcessID == pid {
			n++
		}
		ent = threadEntry32{Size: uint32(unsafe.Sizeof(threadEntry32{}))}
		if r, _, _ := procThread32Next.Call(hSnap, uintptr(unsafe.Pointer(&ent))); r == 0 {
			break
		}
	}
	return n, true
}
