//go:build linux

package diagnostics

import (
	"strconv"
	"strings"
	"sync"
	"time"
)

// Linux 宿主时序采样（只读 /proc；不 spawn 任何命令）

var hostHistPrev struct {
	mu    sync.Mutex
	have  bool
	read  int64
	write int64
}

// sampleHostPoint 采一个点（先算 disk 增量再回填；首点 baselineWarmup）
func sampleHostPoint(now time.Time) (HostHistoryPoint, bool) {
	pt := HostHistoryPoint{At: now.Format(time.RFC3339)}
	if s, err := readFileBounded("/proc/loadavg"); err == nil {
		if v := parseLoadAvg(s); len(v) > 0 {
			pt.LoadAvg1 = v[0]
		}
	}
	if s, err := readFileBounded("/proc/pressure/cpu"); err == nil {
		pt.PressureCPU10 = parsePressure(s).SomeAvg10
	}
	if s, err := readFileBounded("/proc/pressure/memory"); err == nil {
		pt.PressureMem10 = parsePressure(s).SomeAvg10
	}
	if s, err := readFileBounded("/proc/pressure/io"); err == nil {
		pt.PressureIO10 = parsePressure(s).SomeAvg10
	}
	read, write, ok := diskSectorTotals()
	if ok {
		hostHistPrev.mu.Lock()
		if hostHistPrev.have {
			pt.DiskReadBytes = (read - hostHistPrev.read) * 512
			pt.DiskWriteBytes = (write - hostHistPrev.write) * 512
			if pt.DiskReadBytes < 0 {
				pt.DiskReadBytes = 0
			}
			if pt.DiskWriteBytes < 0 {
				pt.DiskWriteBytes = 0
			}
		} else {
			pt.BaselineWarmup = true
		}
		hostHistPrev.read, hostHistPrev.write = read, write
		hostHistPrev.have = true
		hostHistPrev.mu.Unlock()
	}
	return pt, true
}

// diskSectorTotals /proc/diskstats 全设备读写扇区累计（扇区=512B）
func diskSectorTotals() (read, write int64, ok bool) {
	text, err := readFileBounded("/proc/diskstats")
	if err != nil {
		return 0, 0, false
	}
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		f := strings.Fields(line)
		if len(f) < 10 {
			continue
		}
		r, e1 := strconv.ParseInt(f[5], 10, 64)
		w, e2 := strconv.ParseInt(f[9], 10, 64)
		if e1 != nil || e2 != nil {
			continue
		}
		read += r
		write += w
		ok = true
	}
	return read, write, ok
}

// hostHistorySkippedFields 字段级缺席清单（缺 PSI/diskstats 时单项跳过，
// 不整段 skipped——补充评审⑪）
func hostHistorySkippedFields() []string {
	var out []string
	if _, err := readFileBounded("/proc/pressure/cpu"); err != nil {
		out = append(out, "pressureCpuAvg10", "pressureMemAvg10", "pressureIoAvg10")
	}
	if _, _, ok := diskSectorTotals(); !ok {
		out = append(out, "diskReadBytesDelta", "diskWriteBytesDelta")
	}
	if _, err := readFileBounded("/proc/loadavg"); err != nil {
		out = append(out, "loadAvg1")
	}
	return out
}
