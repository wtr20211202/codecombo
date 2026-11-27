package diagnostics

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// 存储统计（P-20261122-11 S2b⑤）：state/storage.json 回答「数据目录到底多大、
// 哪个子目录在长、credential store 有多少条目」——仍然只记统计，**绝不读
// 文件内容**（与 inventory 同一条红线：data/ 是凭据库，元数据可出机、内容不可）。
//
// 为什么单列结构化文件而不是塞进 platform.txt：这是可以跨版本对比的数值面
// （升级后 catalog 膨胀、日志没轮转、tmp 残留），JSON 便于 agent/工单脚本
// 直接消费；人读摘要仍在 platform.txt（data disk 行）与 inventory。
//
// 成本：一次 WalkDir（条目上限沿用 inventoryWalkCap），只 stat 不 open。
// 数据目录正常规模是万级条目，与 inventory 的 data/ 子树 walk 同量级；两次
// walk 都在 20s 整包预算内，且不改变既有 inventory 行为。

// StorageDirSample 单个顶层条目的递归统计（目录=子树，文件=自身）
type StorageDirSample struct {
	Name    string `json:"name"`
	Entries int    `json:"entries"`
	Bytes   int64  `json:"bytes"`
}

// StorageStats state/storage.json 的结构
type StorageStats struct {
	GeneratedAt string             `json:"generatedAt"`
	DataDir     string             `json:"dataDir"`
	Total       StorageDirSample   `json:"total"`
	Dirs        []StorageDirSample `json:"dirs"`
	// Capped bool walk 触顶=数值是下界
	Capped bool `json:"capped,omitempty"`
	// TimedOut walk 因采集 deadline 提前停止（stat 可能挂死，残余风险见 README）
	TimedOut bool        `json:"timedOut,omitempty"`
	Disk     *DiskSample `json:"disk,omitempty"`
	Notes    []string    `json:"notes,omitempty"`
}

// collectStorage 递归统计数据目录并按顶层条目分解（一次 walk 同时算总量
// 与各顶层子树的量，顺带收集 Top20 大文件——P-20261124-1 S2⑤ 要求复用同一
// 次 WalkDir，绝不新增第三次 walk）。
//
// deadline 非零时每 4096 条检查一次，超时停止并标 timedOut（walk 的 stat 在
// 挂死的网络盘上不可取消，只能放弃——残余风险写 README/runbook）。
func collectStorage(dataDir string, disk *DiskSample, red *Redactor, now time.Time, deadline time.Time) (StorageStats, LargeFilesReport) {
	st := StorageStats{
		GeneratedAt: now.Format(time.RFC3339),
		DataDir:     red.Path(dataDir),
		Disk:        disk,
		Total:       StorageDirSample{Name: "."},
	}
	var files LargeFilesReport
	files.GeneratedAt = st.GeneratedAt
	dirs := map[string]*StorageDirSample{}
	var sinceCheck int
	_ = filepath.WalkDir(dataDir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // 单条不可读不中断（权限差异是常态，不是故障）
		}
		if p == dataDir {
			return nil
		}
		if st.Total.Entries >= inventoryWalkCap {
			st.Capped = true
			return filepath.SkipAll
		}
		sinceCheck++
		if !deadline.IsZero() && sinceCheck >= 4096 {
			sinceCheck = 0
			if time.Now().After(deadline) {
				st.TimedOut = true
				return filepath.SkipAll
			}
		}
		st.Total.Entries++
		var size int64
		regular := false
		if info, ierr := d.Info(); ierr == nil && info.Mode().IsRegular() {
			size = info.Size()
			regular = true
			st.Total.Bytes += size
		}
		rel, rerr := filepath.Rel(dataDir, p)
		if rerr != nil || rel == "." || strings.HasPrefix(rel, "..") {
			return nil
		}
		slash := filepath.ToSlash(rel)
		seg := slash
		if i := strings.IndexByte(slash, '/'); i >= 0 {
			seg = slash[:i]
		}
		if regular {
			if strings.EqualFold(seg, "data") {
				// data/ 是凭据库：只计数，不列文件名（P-20261124-1 红线）
				files.DataFiles++
				files.DataBytes += size
			} else {
				files.add(p, rel, size, red)
			}
		}
		ds := dirs[seg]
		if ds == nil {
			ds = &StorageDirSample{Name: seg}
			dirs[seg] = ds
		}
		if slash == seg {
			// 顶层条目本身不计入自己的 entries（它已由 Name 体现）；
			// 顶层普通文件则算 1 条。
			if !d.IsDir() {
				ds.Entries++
				ds.Bytes += size
			}
			return nil
		}
		ds.Entries++
		ds.Bytes += size
		return nil
	})
	if st.Capped {
		st.Notes = append(st.Notes,
			"walk capped at "+itoa(inventoryWalkCap)+" entries — figures are a lower bound")
	}
	if st.TimedOut {
		st.Notes = append(st.Notes,
			"walk stopped at the collection deadline — figures are a lower bound (stat on a hung mount cannot be cancelled)")
	}
	for _, ds := range dirs {
		st.Dirs = append(st.Dirs, *ds)
	}
	sort.Slice(st.Dirs, func(i, j int) bool { return st.Dirs[i].Name < st.Dirs[j].Name })
	// 顶层条目上限沿 inventoryListCap：病态扁平目录（数万文件全在根）不该
	// 让 JSON 派生文件无界膨胀——总量仍由 Total 如实给出
	if len(st.Dirs) > inventoryListCap {
		st.Notes = append(st.Notes,
			"top-level breakdown capped at "+itoa(inventoryListCap)+" entries (total still counts all)")
		st.Dirs = st.Dirs[:inventoryListCap]
	}
	for _, ds := range st.Dirs {
		if strings.EqualFold(ds.Name, "data") {
			st.Notes = append(st.Notes,
				"data/ is the credential store: size/entry counts only, file content is never packed")
			break
		}
	}
	return st, files
}

// renderStorageJSON state/storage.json 渲染（格式化失败不可能：纯值结构；
// 仍按防御式返回空对象，避免整包因一个派生文件失败）
func renderStorageJSON(st StorageStats) string {
	buf, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return "{}\n"
	}
	return string(buf) + "\n"
}
