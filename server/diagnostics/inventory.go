package diagnostics

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// 数据目录清点（P-20261122-10 必改B「增/钉死」）：master-key 与 data/ 整目录
// **只记存在性 + 权限位 + 大小 + 条目计数，绝不入包**。
//
// 为什么单列一份 inventory 而不是让用户自己看目录：排障最常见的两类形态是
// 「服务起不来但看不出为什么」和「升级后数据目录疑似漂移」——两者都需要
// 「数据目录里有什么、多大、权限对不对」这一张表；而 config.json 与
// data/master-key 又恰恰是最不能外发的两个文件。清单把这两件事拆开：
// 名字/元数据入包，内容永不出机。
const (
	// inventoryWalkCap data/ 递归统计的条目上限（防病态大目录拖死收集）
	inventoryWalkCap = 200_000
	// inventoryListCap 根目录逐条列示上限（正常数据目录条目 <50）
	inventoryListCap = 200
)

// dirStat 目录递归统计（只 stat 不读内容）
type dirStat struct {
	entries int
	bytes   int64
	capped  bool
}

func walkDirStat(root string) dirStat {
	var st dirStat
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // 单条不可读不中断（权限差异是常态，不是故障）
		}
		if p == root {
			return nil
		}
		if st.entries >= inventoryWalkCap {
			st.capped = true
			return filepath.SkipAll
		}
		st.entries++
		if info, ierr := d.Info(); ierr == nil && info.Mode().IsRegular() {
			st.bytes += info.Size()
		}
		return nil
	})
	return st
}

// renderInventory data-dir-inventory.txt：根目录逐条（类型/权限/大小/条目数）
// + data/ 递归规模 + master-key 单条元数据 + 凭据 denylist 命中标注
func renderInventory(dataDir string, red *Redactor) string {
	var b strings.Builder
	b.WriteString("# data dir inventory — existence / mode / size / entry counts ONLY.\n")
	b.WriteString("# Credential paths are never packed: master-key, data/ (whole tree), config.json, *.pem, *.key, id_*, *cookie*, *authorization*.\n")
	b.WriteString("# mode bits are POSIX-meaningful; on Windows Go synthesizes them (read-only flag only).\n")
	b.WriteString("dir: " + red.Path(dataDir) + "\n\n")

	entries, err := os.ReadDir(dataDir)
	if err != nil {
		b.WriteString("(root unreadable: " + red.Line(err.Error()) + ")\n")
		return b.String()
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	for i, e := range entries {
		if i >= inventoryListCap {
			b.WriteString("… (list capped at " + itoa(inventoryListCap) + " entries)\n")
			break
		}
		name := e.Name()
		p := filepath.Join(dataDir, name)
		info, ierr := e.Info()
		if ierr != nil {
			b.WriteString(name + "  (stat failed: " + red.Line(ierr.Error()) + ")\n")
			continue
		}
		mode := info.Mode().String()
		if e.IsDir() {
			line := name + "/  dir  mode=" + mode
			if strings.EqualFold(name, "data") {
				st := walkDirStat(p)
				line += "  recursiveEntries=" + itoa(st.entries) + " recursiveSize=" + humanBytes(uint64(st.bytes))
				if st.capped {
					line += " (walk capped)"
				}
				line += "  # credential store — content NEVER packed (metadata only)"
			} else {
				if subs, rerr := os.ReadDir(p); rerr == nil {
					line += "  entries=" + itoa(len(subs))
				}
			}
			b.WriteString(line + "\n")
			continue
		}
		line := name + "  file  mode=" + mode + " size=" + itoa(int(info.Size()))
		if why := deniedReason(p, red.dataDir); why != "" {
			line += "  # DENIED: " + why + " — content not packed"
		}
		b.WriteString(line + "\n")
	}

	// master-key 单条（在 data/ 里，根清点看不见它；两行元数据是升级链
	// 「凭据还能不能解」的第一判据）
	masterKey := filepath.Join(dataDir, "data", "master-key")
	if info, err := os.Stat(masterKey); err == nil {
		b.WriteString("\ndata/master-key  file  mode=" + info.Mode().String() +
			" size=" + itoa(int(info.Size())) +
			"  # machine master key — metadata ONLY, content never packed\n")
		b.WriteString("# note: if credentials stopped decrypting after a data-dir move/reinstall, compare this file's presence/mtime here first\n")
	} else {
		b.WriteString("\ndata/master-key  ABSENT  # no machine key on disk (fresh install, or data/ unreadable: " + red.Line(err.Error()) + ")\n")
	}
	return b.String()
}
