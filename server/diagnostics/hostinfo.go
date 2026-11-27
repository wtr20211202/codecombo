package diagnostics

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// 宿主/进程/挂载态（P-20261124-1 S3①）：state/host.json 的目标是回答
// 「这次卡顿是 VM 暂停、磁盘/NFS 挂死，还是进程内锁」里的第二类。
//
// 数据源优先级（评审①⑩）：
//   - Linux 主路径读 /proc：/proc/self/mountinfo（挂载类型/源）、/proc/diskstats、
//     /proc/pressure/{cpu,memory,io}、/proc/<pid>/{status,wchan,io,limits,cgroup}。
//     零子进程、零特权、不会被 PATH/本地化影响。
//   - df/findmnt/stat/iostat/nfsstat 只作可选兜底（非 Linux），全部
//     exec.CommandContext + WaitDelay=500ms；一旦某条挂死（超时），
//     mountProbeHung=true 并跳过同类后续命令——诊断工具不能死在它要诊断的
//     故障上。
//   - /proc/<pid>/stack 不采（内核锁内栈，可能长时间阻塞且暴露内核地址）。
//
// 项目根由 RuntimeInputs.ProjectRoots 注入；挂载点按路径前缀去重、最多 20 个，
// 不递归、不 stat 目标（stat 正是本案要诊断的慢点）。

const (
	// hostMountCap 挂载点条目上限
	hostMountCap = 20
	// hostCommandWaitDelay 兜底命令 WaitDelay（stdout/stderr 管道残留时强杀）
	hostCommandWaitDelay = 500 * time.Millisecond
	// hostCommandTimeout 兜底命令总超时
	hostCommandTimeout = 2 * time.Second
)

// MountSample 一条挂载
type MountSample struct {
	MountPoint string `json:"mountPoint"`
	FSType     string `json:"fsType,omitempty"`
	Source     string `json:"source,omitempty"`
	Options    string `json:"options,omitempty"`
	// MatchedRoot 与哪个项目根/数据目录前缀命中（"$DATA_DIR" 等归一形态）
	MatchedRoot string `json:"matchedRoot,omitempty"`
}

// PressureSample /proc/pressure 单资源
type PressureSample struct {
	SomeAvg10  float64 `json:"someAvg10,omitempty"`
	SomeAvg60  float64 `json:"someAvg60,omitempty"`
	SomeAvg300 float64 `json:"someAvg300,omitempty"`
	SomeTotal  int64   `json:"someTotalUs,omitempty"`
	FullAvg10  float64 `json:"fullAvg10,omitempty"`
	FullTotal  int64   `json:"fullTotalUs,omitempty"`
	Note       string  `json:"note,omitempty"`
}

// DiskStatSample /proc/diskstats 单设备（字段口径见 kernel doc）
type DiskStatSample struct {
	Device       string `json:"device"`
	Reads        int64  `json:"reads"`
	ReadSectors  int64  `json:"readSectors"`
	Writes       int64  `json:"writes"`
	WriteSectors int64  `json:"writeSectors"`
	IOTicksMS    int64  `json:"ioTicksMs"`
	IOTimeMS     int64  `json:"ioTimeMs"`
	InFlight     int64  `json:"inFlight"`
}

// ProcStatusSample /proc/<pid>/status 关键字段
type ProcStatusSample struct {
	PID             int    `json:"pid"`
	State           string `json:"state,omitempty"`
	Threads         int    `json:"threads,omitempty"`
	VmRSSKB         int64  `json:"vmRssKb,omitempty"`
	VmPeakKB        int64  `json:"vmPeakKb,omitempty"`
	VmSwapKB        int64  `json:"vmSwapKb,omitempty"`
	VoluntaryCtx    int64  `json:"voluntaryCtxSwitches,omitempty"`
	NonvoluntaryCtx int64  `json:"nonvoluntaryCtxSwitches,omitempty"`
	Wchan           string `json:"wchan,omitempty"`
}

// ProcIOSample /proc/<pid>/io
type ProcIOSample struct {
	RChar               int64 `json:"rchar"`
	WChar               int64 `json:"wchar"`
	ReadBytes           int64 `json:"readBytes"`
	WriteBytes          int64 `json:"writeBytes"`
	CancelledWriteBytes int64 `json:"cancelledWriteBytes"`
}

// CgroupSample cgroup v1/v2 关键限值/用量
type CgroupSample struct {
	Version     int    `json:"version"`
	Path        string `json:"path,omitempty"`
	MemoryMax   string `json:"memoryMax,omitempty"`
	MemoryCur   string `json:"memoryCurrent,omitempty"`
	CPUStat     string `json:"cpuStat,omitempty"`
	PidsCurrent string `json:"pidsCurrent,omitempty"`
	Note        string `json:"note,omitempty"`
}

// HostInfo state/host.json 的结构
type HostInfo struct {
	GeneratedAt string                    `json:"generatedAt"`
	GOOS        string                    `json:"goos"`
	Status      string                    `json:"status"` // ok | skipped
	Reason      string                    `json:"reason,omitempty"`
	UptimeSec   float64                   `json:"uptimeSec,omitempty"`
	LoadAvg     []float64                 `json:"loadAvg,omitempty"`
	Pressure    map[string]PressureSample `json:"pressure,omitempty"`
	DiskStats   []DiskStatSample          `json:"diskStats,omitempty"`
	Mounts      []MountSample             `json:"mounts,omitempty"`
	Proc        *ProcStatusSample         `json:"procStatus,omitempty"`
	ProcIO      *ProcIOSample             `json:"procIo,omitempty"`
	ProcLimits  map[string]string         `json:"procLimits,omitempty"`
	Cgroup      *CgroupSample             `json:"cgroup,omitempty"`
	// Process 进程自观测（P-20261126-3 S2 跨平台）：Windows=GetProcessTimes/
	// psapi/toolhelp，Linux=/proc（procStatus 之外补 CPU% 差分），darwin=ps
	// best-effort——口径差异在 basis 字段注明，不做跨平台等值换算
	Process *ProcessSample `json:"process,omitempty"`
	Notes   []string       `json:"notes,omitempty"`
	// MountProbeHung 兜底命令挂死（true = 走命令族的同类探针全部跳过）
	MountProbeHung bool `json:"mountProbeHung,omitempty"`
}

// collectHostInfo 采集宿主态（Linux 读 /proc；其它平台显式 skipped + 可选 df 兜底）
func collectHostInfo(ctx context.Context, goos, dataDir string, roots []string, red *Redactor, now time.Time) HostInfo {
	info := HostInfo{GeneratedAt: now.Format(time.RFC3339), GOOS: goos, Mounts: []MountSample{}}
	if goos != "linux" {
		info.Status = "skipped"
		info.Reason = "host.json is collected from /proc on Linux; " + goos + " has no /proc (see platform.txt for the command-table baseline)"
		if goos == "darwin" {
			// 唯一保留的兜底：df 只回答「数据目录所在盘还剩多少」，不追问挂载类型
			if mount, hung, err := dfFallback(ctx, dataDir, red); err != nil {
				info.MountProbeHung = hung
				info.Notes = append(info.Notes, "df fallback failed: "+red.Line(err.Error()))
			} else {
				info.Mounts = append(info.Mounts, mount)
			}
		}
		return info
	}
	info.Status = "ok"
	collectProcHost(&info, dataDir, roots, red)
	return info
}

// dfFallback 非 Linux 的唯一命令兜底（WaitDelay + 2s 超时；超时标 hung）
func dfFallback(ctx context.Context, dataDir string, red *Redactor) (MountSample, bool, error) {
	cctx, cancel := context.WithTimeout(ctx, hostCommandTimeout)
	defer cancel()
	cmd := exec.CommandContext(cctx, "df", "-kP", dataDir)
	cmd.WaitDelay = hostCommandWaitDelay
	out, err := cmd.Output()
	if err != nil {
		hung := cctx.Err() == context.DeadlineExceeded
		return MountSample{}, hung, err
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) < 2 {
		return MountSample{}, false, fmt.Errorf("df produced no data rows")
	}
	fields := strings.Fields(lines[len(lines)-1])
	if len(fields) < 6 {
		return MountSample{}, false, fmt.Errorf("df row unparsable")
	}
	return MountSample{
		Source:     red.Line(fields[0]),
		MountPoint: red.Line(strings.Join(fields[5:], " ")),
		Options:    "df fallback (no /proc): size/used/avail only",
	}, false, nil
}

// renderHostJSON state/host.json 渲染
func renderHostJSON(h HostInfo) string {
	buf, err := json.MarshalIndent(h, "", "  ")
	if err != nil {
		return "{}\n"
	}
	return string(buf) + "\n"
}

// processRoots 归一项目根列表：数据目录 + 注入的项目根，去重、清空无效项
func processRoots(dataDir string, roots []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(roots)+1)
	add := func(p string) {
		p = strings.TrimSpace(p)
		if p == "" {
			return
		}
		p = filepath.Clean(p)
		if seen[p] {
			return
		}
		seen[p] = true
		out = append(out, p)
	}
	add(dataDir)
	for _, r := range roots {
		add(r)
	}
	return out
}

// redactedRoot 根路径的归一显示（$DATA_DIR/~/原样）
func redactedRoot(red *Redactor, p string) string {
	if red == nil {
		return p
	}
	return red.Path(p)
}

// parseUptime /proc/uptime 首值（秒）
func parseUptime(s string) float64 {
	f := strings.Fields(strings.TrimSpace(s))
	if len(f) == 0 {
		return 0
	}
	v, _ := strconv.ParseFloat(f[0], 64)
	return v
}

// parseLoadAvg /proc/loadavg 前三值
func parseLoadAvg(s string) []float64 {
	f := strings.Fields(strings.TrimSpace(s))
	if len(f) < 3 {
		return nil
	}
	out := make([]float64, 0, 3)
	for _, x := range f[:3] {
		v, err := strconv.ParseFloat(x, 64)
		if err != nil {
			return nil
		}
		out = append(out, v)
	}
	return out
}

// readFileBounded 读小文件（/proc 单文件都有界；上限 256KiB 防御异常）
func readFileBounded(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	buf := make([]byte, 256<<10)
	n, rerr := f.Read(buf)
	if rerr != nil && n == 0 {
		return "", rerr
	}
	return string(buf[:n]), nil
}

// hostStatus/tlsStatus 探针账本状态（host.json 自身也可能是 skipped）
func hostStatus(h HostInfo) string {
	if h.Status == "skipped" {
		return string(ProbeSkipped)
	}
	return string(ProbeOK)
}

func hostNote(h HostInfo) string {
	if h.Reason != "" {
		return h.Reason
	}
	return fmt.Sprintf("mounts=%d pressure=%d diskStats=%d", len(h.Mounts), len(h.Pressure), len(h.DiskStats))
}

func tlsStatus(d TLSDoc) string {
	if d.Status == "skipped" {
		return string(ProbeSkipped)
	}
	return string(ProbeOK)
}

// journalSample 从既有 systemd-journal 探针输出取样本（只保留一个 journal
// 探针——S3① 评审要求；TLS 摘要复用它，不再起第二个）
func journalSample(p PlatformInfo) string {
	for _, c := range p.Commands {
		if c.ID == "systemd-journal" && c.Status == "ok" {
			return c.Output
		}
	}
	return ""
}
