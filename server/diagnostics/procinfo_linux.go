//go:build linux

package diagnostics

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Linux /proc 主路径（P-20261124-1 S3①）：全部零子进程、零特权读取。
// 每个文件独立容错——容器/精简内核可能缺 PSI（/proc/pressure）或 cgroup。

// collectProcHost 填充 Linux 宿主态
func collectProcHost(info *HostInfo, dataDir string, roots []string, red *Redactor) {
	if s, err := readFileBounded("/proc/uptime"); err == nil {
		info.UptimeSec = parseUptime(s)
	} else {
		info.Notes = append(info.Notes, "uptime unavailable: "+red.Line(err.Error()))
	}
	if s, err := readFileBounded("/proc/loadavg"); err == nil {
		info.LoadAvg = parseLoadAvg(s)
	} else {
		info.Notes = append(info.Notes, "loadavg unavailable: "+red.Line(err.Error()))
	}
	info.Pressure = readPressure(red)
	info.DiskStats = readDiskStats()
	info.Mounts = readMounts(dataDir, roots, red)
	info.Proc = readProcStatus(red)
	info.ProcIO = readProcIO()
	info.ProcLimits = readProcLimits()
	info.Cgroup = readCgroup()
}

// readPressure /proc/pressure/{cpu,memory,io}（CONFIG_PSI 未开时如实缺席）
func readPressure(red *Redactor) map[string]PressureSample {
	out := map[string]PressureSample{}
	for _, res := range []string{"cpu", "memory", "io"} {
		text, err := readFileBounded("/proc/pressure/" + res)
		if err != nil {
			out[res] = PressureSample{Note: "unavailable (kernel without CONFIG_PSI, or not Linux)"}
			continue
		}
		out[res] = parsePressure(text)
	}
	return out
}

// parsePressure 解析 some/full 两行（avg10/avg60/avg300/total 微秒）
func parsePressure(text string) PressureSample {
	var ps PressureSample
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		full := fields[0] == "full"
		vals := map[string]float64{}
		for _, kv := range fields[1:] {
			k, v, ok := strings.Cut(kv, "=")
			if !ok {
				continue
			}
			if f, err := strconv.ParseFloat(v, 64); err == nil {
				vals[k] = f
			}
		}
		if full {
			ps.FullAvg10 = vals["avg10"]
			ps.FullTotal = int64(vals["total"])
			continue
		}
		ps.SomeAvg10 = vals["avg10"]
		ps.SomeAvg60 = vals["avg60"]
		ps.SomeAvg300 = vals["avg300"]
		ps.SomeTotal = int64(vals["total"])
	}
	return ps
}

// readDiskStats /proc/diskstats（字段 4..14：读完成/读扇区/写完成/写扇区/
// 在途 IO/IO 毫秒/加权 IO 毫秒；只保留有实际 IO 的设备，最多 40 条）
func readDiskStats() []DiskStatSample {
	text, err := readFileBounded("/proc/diskstats")
	if err != nil {
		return nil
	}
	var out []DiskStatSample
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		f := strings.Fields(line)
		if len(f) < 14 {
			continue
		}
		vals := make([]int64, 0, 14)
		ok := true
		for i := 3; i < 14; i++ {
			v, err := strconv.ParseInt(f[i], 10, 64)
			if err != nil {
				ok = false
				break
			}
			vals = append(vals, v)
		}
		if !ok {
			continue
		}
		// vals 下标：0 reads, 1 readSectors, 2 readMs, 3 writes, 4 writeSectors,
		// 5 writeMs, 6 inFlight, 7 ioMs, 8 weightedIoMs
		if vals[0] == 0 && vals[3] == 0 {
			continue
		}
		out = append(out, DiskStatSample{
			Device: f[2], Reads: vals[0], ReadSectors: vals[1],
			Writes: vals[3], WriteSectors: vals[4],
			InFlight: vals[6], IOTicksMS: vals[7], IOTimeMS: vals[8],
		})
		if len(out) >= 40 {
			break
		}
	}
	return out
}

// readMounts 只取与数据目录/项目根前缀相关的挂载点（去重，≤20），不递归不 stat
func readMounts(dataDir string, roots []string, red *Redactor) []MountSample {
	text, err := readFileBounded("/proc/self/mountinfo")
	if err != nil {
		return nil
	}
	wanted := processRoots(dataDir, roots)
	seen := map[string]bool{}
	var out []MountSample
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 7 {
			continue
		}
		mountPoint := unescapeMountInfo(fields[4])
		mountOpts := fields[5]
		fsType, source := "", ""
		for i := 6; i < len(fields); i++ {
			if fields[i] == "-" && i+2 < len(fields) {
				fsType = fields[i+1]
				source = fields[i+2]
				break
			}
		}
		matched := ""
		for _, w := range wanted {
			// 双向匹配：挂载点落在项目根之内（子挂载），或项目根落在挂载点之内
			// （最常见的一类——数据目录在 NFS/共享盘挂载上，挂载点是它的父路径；
			// 只做单向匹配会正好漏掉本案要诊断的慢共享目录）
			if pathHasPrefix(mountPoint, w) || pathHasPrefix(w, mountPoint) {
				matched = redactedRoot(red, w)
				break
			}
		}
		if matched == "" && mountPoint != "/" {
			continue
		}
		if seen[mountPoint] {
			continue
		}
		seen[mountPoint] = true
		out = append(out, MountSample{
			MountPoint:  red.Line(mountPoint),
			FSType:      fsType,
			Source:      red.Line(truncate(source, 200)),
			Options:     truncate(mountOpts, 200),
			MatchedRoot: matched,
		})
		if len(out) >= hostMountCap {
			break
		}
	}
	return out
}

// pathHasPrefix 路径前缀判定（带分隔符边界；filepath.Clean 已在外层做过）
func pathHasPrefix(path, prefix string) bool {
	if prefix == "" || prefix == "/" {
		return true // 根挂载总是相关（空间/挂死都会波及）
	}
	if path == prefix {
		return true
	}
	return strings.HasPrefix(path, prefix+string(filepath.Separator))
}

// unescapeMountInfo mountinfo 的八进制转义（\040 空格 /\011 tab /\134 反斜杠）
func unescapeMountInfo(s string) string {
	if !strings.Contains(s, "\\") {
		return s
	}
	r := strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)
	return r.Replace(s)
}

// readProcStatus /proc/self/status 关键字段
func readProcStatus(red *Redactor) *ProcStatusSample {
	text, err := readFileBounded("/proc/self/status")
	if err != nil {
		return nil
	}
	ps := &ProcStatusSample{PID: pidOfSelf()}
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		v = strings.TrimSpace(v)
		switch k {
		case "State":
			ps.State = v
		case "Threads":
			ps.Threads = atoiSafe(v)
		case "VmRSS":
			ps.VmRSSKB = kbValue(v)
		case "VmPeak":
			ps.VmPeakKB = kbValue(v)
		case "VmSwap":
			ps.VmSwapKB = kbValue(v)
		case "voluntary_ctxt_switches":
			ps.VoluntaryCtx = int64(atoiSafe(v))
		case "nonvoluntary_ctxt_switches":
			ps.NonvoluntaryCtx = int64(atoiSafe(v))
		}
	}
	// wchan：进程此刻阻塞在哪个内核函数（D 状态/NFS 挂死的直接证据）
	if w, err := readFileBounded("/proc/self/wchan"); err == nil {
		ps.Wchan = red.Line(truncate(strings.TrimSpace(w), 120))
	}
	return ps
}

// readProcIO /proc/self/io（内核 CONFIG_TASK_IO_ACCOUNTING 未开时缺席）
func readProcIO() *ProcIOSample {
	text, err := readFileBounded("/proc/self/io")
	if err != nil {
		return nil
	}
	io := &ProcIOSample{}
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		n, _ := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		switch k {
		case "rchar":
			io.RChar = n
		case "wchar":
			io.WChar = n
		case "read_bytes":
			io.ReadBytes = n
		case "write_bytes":
			io.WriteBytes = n
		case "cancelled_write_bytes":
			io.CancelledWriteBytes = n
		}
	}
	return io
}

// readProcLimits /proc/self/limits（shell builtin ulimit 不可 exec，改读内核
// 自报值）——只取诊断最常看的三项，值原样保留（soft/hard）
func readProcLimits() map[string]string {
	text, err := readFileBounded("/proc/self/limits")
	if err != nil {
		return nil
	}
	out := map[string]string{}
	for _, line := range strings.Split(text, "\n") {
		for _, key := range []string{"Max open files", "Max processes", "Max locked memory", "Max address space"} {
			if !strings.HasPrefix(line, key) {
				continue
			}
			rest := strings.TrimSpace(strings.TrimPrefix(line, key))
			fields := strings.Fields(rest)
			if len(fields) >= 2 {
				out[key] = "soft=" + fields[0] + " hard=" + fields[1] + " units=" + strings.Join(fields[2:], " ")
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// readCgroup cgroup v1/v2（/proc/self/cgroup 首行形态判定；只读三项限值）
func readCgroup() *CgroupSample {
	text, err := readFileBounded("/proc/self/cgroup")
	if err != nil {
		return nil
	}
	cg := &CgroupSample{}
	lines := strings.Split(strings.TrimSpace(text), "\n")
	if len(lines) == 0 || lines[0] == "" {
		return nil
	}
	// v2：0::/path；v1：N:controller[,controller]:/path
	first := lines[0]
	parts := strings.SplitN(first, ":", 3)
	if len(parts) != 3 {
		cg.Note = "unparsable /proc/self/cgroup"
		return cg
	}
	if parts[0] == "0" && parts[1] == "" {
		cg.Version = 2
		cg.Path = parts[2]
		base := "/sys/fs/cgroup" + parts[2]
		cg.MemoryMax, _ = readFileBounded(filepath.Join(base, "memory.max"))
		cg.MemoryCur, _ = readFileBounded(filepath.Join(base, "memory.current"))
		cg.CPUStat, _ = readFileBounded(filepath.Join(base, "cpu.stat"))
		cg.PidsCurrent, _ = readFileBounded(filepath.Join(base, "pids.current"))
		cg.MemoryMax = strings.TrimSpace(cg.MemoryMax)
		cg.MemoryCur = strings.TrimSpace(cg.MemoryCur)
		cg.PidsCurrent = strings.TrimSpace(cg.PidsCurrent)
		cg.CPUStat = truncate(strings.TrimSpace(cg.CPUStat), 400)
		return cg
	}
	cg.Version = 1
	cg.Path = parts[2]
	cg.Note = "cgroup v1: controller=" + parts[1] + " (v1 limit files vary per distro; not enumerated)"
	return cg
}

func pidOfSelf() int { return os.Getpid() }

func atoiSafe(s string) int {
	n, _ := strconv.Atoi(strings.TrimSpace(s))
	return n
}

// kbValue 解析 `1234 kB` 形态
func kbValue(v string) int64 {
	fields := strings.Fields(v)
	if len(fields) == 0 {
		return 0
	}
	n, _ := strconv.ParseInt(fields[0], 10, 64)
	return n
}
