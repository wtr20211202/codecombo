package remote

import (
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ============== 诊断快照提取与趋势摘要（P-20261002-18） ==============

// extractDiagSnapshot 从诊断响应提取关键数值摘要。与 DiagnoseText 同源：
// 直接解析各 item.Output 文本产物（诊断时已采集的同一份数据），不重跑命令。
// 各解析器独立容错——单项输出格式未识别只损失该指标，不影响其余。
// 至少采到一项才返回 true（全军覆没不落历史，避免空快照污染环形窗口）
func extractDiagSnapshot(resp diagnoseResp) (store.DiagSnapshot, bool) {
	var snap store.DiagSnapshot
	for _, item := range resp.Items {
		if item.Error != "" && item.Output == "" {
			continue
		}
		switch item.Key {
		case "disk":
			snap.DiskAvailMB, snap.DiskTotalMB = parseDfRoot(item.Output)
		case "memory":
			snap.MemUsedMB = parseFreeMemUsed(item.Output)
		case "uptime":
			snap.Load1, snap.Load5, snap.Load15 = parseUptimeLoad(item.Output)
		case "failedServices":
			snap.FailedServices = countNonEmptyLines(item.Output)
		case "cpu":
			snap.CPUPercent = parseTopCPUBusy(item.Output)
		}
	}
	return snap, snap != store.DiagSnapshot{}
}

// parseDfRoot 解析 df -h 输出，取根挂载点（无 / 行时取首个可解析数据行）。
// 兼容 df 不带 -P 时的两行折行形态（长设备名先把文件系统名单独打一行）
func parseDfRoot(out string) (availMB, totalMB int64) {
	var fallbackAvail, fallbackTotal int64
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) < 5 {
			continue
		}
		// 常规行：Filesystem Size Used Avail Use% Mounted(≥5 列，末列挂载点)
		sizeIdx, availIdx, mount := 1, 3, lastField(f)
		if len(f) == 5 { // 折行续行：Size Used Avail Use% Mounted
			sizeIdx, availIdx = 0, 2
		}
		// Use% 列必须形如 23%，否则不是数据行（表头/折行首行）
		if !strings.HasSuffix(f[len(f)-2], "%") {
			continue
		}
		total, avail := parseSizeMB(f[sizeIdx]), parseSizeMB(f[availIdx])
		if total == 0 {
			continue
		}
		if mount == "/" {
			return avail, total
		}
		if fallbackTotal == 0 {
			fallbackAvail, fallbackTotal = avail, total
		}
	}
	return fallbackAvail, fallbackTotal
}

func lastField(f []string) string { return f[len(f)-1] }

var sizeSuffixMB = map[byte]float64{
	'K': 1.0 / 1024, 'M': 1, 'G': 1024, 'T': 1024 * 1024, 'P': 1024 * 1024 * 1024,
}

// parseSizeMB 人类可读容量（df -h 形态：29G / 6.6G / 1024M / 0）→ MB
func parseSizeMB(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	mult := 1.0
	if last := s[len(s)-1]; last < '0' || last > '9' {
		mult = sizeSuffixMB[last]
		if mult == 0 {
			return 0
		}
		s = s[:len(s)-1]
	}
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return 0
	}
	return int64(math.Round(v * mult))
}

// parseFreeMemUsed 解析 free -m 输出的 Mem: 行 used 列（MB 口径直读）
func parseFreeMemUsed(out string) int64 {
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(strings.TrimSpace(line))
		if len(f) >= 3 && (f[0] == "Mem:" || f[0] == "内存：") {
			v, _ := strconv.ParseInt(f[2], 10, 64)
			return v
		}
	}
	return 0
}

var loadAvgRe = regexp.MustCompile(`load average[s]?:\s*([0-9.]+),?\s*([0-9.]+),?\s*([0-9.]+)`)

// parseUptimeLoad 解析 uptime 的 load average 1/5/15
func parseUptimeLoad(out string) (l1, l5, l15 float64) {
	m := loadAvgRe.FindStringSubmatch(out)
	if len(m) != 4 {
		return 0, 0, 0
	}
	l1, _ = strconv.ParseFloat(m[1], 64)
	l5, _ = strconv.ParseFloat(m[2], 64)
	l15, _ = strconv.ParseFloat(m[3], 64)
	return
}

var cpuIdleRe = regexp.MustCompile(`([0-9.]+)\s*id[,]`)

// parseTopCPUBusy 解析 top 首屏 %Cpu(s) 行的占用率（100 - idle）
func parseTopCPUBusy(out string) float64 {
	for _, line := range strings.Split(out, "\n") {
		if !strings.Contains(line, "%Cpu") && !strings.Contains(line, "% CPU") {
			continue
		}
		if m := cpuIdleRe.FindStringSubmatch(line); len(m) == 2 {
			idle, err := strconv.ParseFloat(m[1], 64)
			if err != nil {
				return 0
			}
			return math.Round((100-idle)*10) / 10
		}
	}
	return 0
}

// countNonEmptyLines systemctl --failed --no-legend 输出即失败服务清单（一行一个）
func countNonEmptyLines(out string) int {
	n := 0
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) != "" {
			n++
		}
	}
	return n
}

// ============== 列表悬停趋势摘要端点 ==============

// diagHistSummary 单主机的最近诊断趋势摘要（最近一次值 + 与再上一次的差值），
// 供远程主机列表卡片「最近诊断时间」悬停展示
type diagHistSummary struct {
	LastTime time.Time `json:"lastTime,omitempty"`
	PrevTime time.Time `json:"prevTime,omitempty"`
	Runs     int       `json:"runs"`
	// 最近一次值（未采集为零值，前端隐藏）
	DiskAvailMB int64   `json:"diskAvailMB,omitempty"`
	MemUsedMB   int64   `json:"memUsedMB,omitempty"`
	Load1       float64 `json:"load1,omitempty"`
	// 与再上一次的差值（无基线时为零值）
	DiskAvailDeltaMB int64   `json:"diskAvailDeltaMB,omitempty"`
	MemUsedDeltaMB   int64   `json:"memUsedDeltaMB,omitempty"`
	Load1Delta       float64 `json:"load1Delta,omitempty"`
}

// GetDiagHistSummary GET /api/remotehosts/diaghist —— 全部主机的最近诊断趋势摘要。
// 静态段路由（/status 同款先例）。每主机一文档全量读，量级 = 主机数，成本可忽略；
// 只以现存主机为主键（孤儿文档已由主机删除级联清理，此处不再兜底）
func GetDiagHistSummary(c *gin.Context) {
	hosts, err := store.Get().RemoteHost.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "remote host operation failed", err)
		return
	}
	out := make(map[string]diagHistSummary, len(hosts))
	for _, h := range hosts {
		// 全窗读取（上限即环形 20 条）：Runs 需要真实总次数，前两条算差值
		hist := store.Get().DiagHist.History(h.ID, 0)
		if len(hist) == 0 {
			continue
		}
		s := diagHistSummary{
			LastTime:    hist[0].Time,
			Runs:        len(hist),
			DiskAvailMB: hist[0].DiskAvailMB,
			MemUsedMB:   hist[0].MemUsedMB,
			Load1:       hist[0].Load1,
		}
		if len(hist) >= 2 {
			d := store.DiffDiagSnapshot(hist[1], hist[0])
			s.PrevTime = hist[1].Time
			s.DiskAvailDeltaMB = d.DiskAvailMB
			s.MemUsedDeltaMB = d.MemUsedMB
			s.Load1Delta = d.Load1
		}
		out[h.ID] = s
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}
