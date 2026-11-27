//go:build !linux

package diagnostics

import "time"

// 非 Linux 无 /proc/pressure、/proc/diskstats：宿主字段缺席（P-20261126-3 S2
// 起进程 CPU%/RSS 照采——Windows 主力机不再对自身进程退化一无所知）。缺哪些
// /proc-only 字段由 hostHistorySkippedFields 如实列出。

func sampleHostPoint(now time.Time) (HostHistoryPoint, bool) {
	return HostHistoryPoint{At: now.Format(time.RFC3339)}, false
}

// hostHistorySkippedFields 非 Linux：/proc-only 宿主字段整组缺席（进程字段可用，
// 不在清单内——缺席语义=「这个字段这个平台没有」）
func hostHistorySkippedFields() []string {
	return []string{
		"loadAvg1", "pressureCpuAvg10", "pressureMemAvg10", "pressureIoAvg10",
		"diskReadBytesDelta", "diskWriteBytesDelta",
	}
}
