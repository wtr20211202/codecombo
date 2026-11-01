package sync

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"codecombo/server/git"
)

// 单元枚举与聚合指纹（方案①）。
//
// 指纹跨平台稳定口径：条目 = 规范化正斜杠相对路径 + size，排序后 sha256——
// 不取 mtime（跨平台/跨文件系统漂移正是风险节点名的坑）。git 仓库默认感知
// .gitignore（二审增强②）：git ls-files --cached --others --exclude-standard
// 单进程取「tracked + 未忽略 untracked」全集，排除面单一事实源是 .gitignore
// 本身；非 git 工作区走内置默认排除清单（可编辑 glob，纯工作区档）。

// maxUnitEntries 单元枚举条目上限（dir-archive 打包护栏同值）：触顶置
// Truncated 如实回告，指纹/传输都按截断态保守处置
const maxUnitEntries = 20000

// defaultExcludes 非 git 工作区的默认排除清单（二审增强②：大项目不排除则
// 传输慢且无价值；git 仓库以 .gitignore 为单一事实源不叠加本清单）。条目
// 与提案原文一致，另补高频构建产物（.next/__pycache__ 等——「等」的落地）
var defaultExcludes = []string{
	"node_modules", "target", "dist", "build", "vendor", ".venv", "venv",
	"__pycache__", ".next", ".cache", ".gradle", "bin", "obj",
}

// fileEntry 单元内一个文件的枚举条目
type fileEntry struct {
	rel  string // 规范化正斜杠项目相对路径
	size int64
}

// excludedCount 排除条目计数（manifest 展示「已排除 N 项」）；truncated 触顶
type unitScan struct {
	files     []fileEntry
	excluded  int
	truncated bool
}

// matchExclude 排除判定：裸名命中任一路径段（node_modules 目录树整枝），
// 含 / 或 * 的条目按 glob 对整相对路径匹配（可编辑排除 glob 的语义）。
//
// 跨平台口径（全平台纪律）：单元内相对路径恒为正斜杠归一形态，glob 匹配必须
// 用 path.Match（固定 / 语义）而非 filepath.Match——后者的 * 不跨宿主分隔符，
// Windows（\\）上 `*.log` 会跨 / 命中子目录文件而 Linux（/）不会，同一排除
// 规则两端枚举集分裂（指纹失真 → 账本假冲突）。无 / 的 glob 追加一次「/ 折叠
// 占位符」匹配，使 `*.log` 在三平台一致地命中任意层级（gitignore 同意图）；
// 显式含 / 的 glob（build/*）保持单段语义不跨层
func matchExclude(rel string, patterns []string) bool {
	for _, p := range patterns {
		if p == "" {
			continue
		}
		if !strings.ContainsAny(p, "/*") {
			for _, seg := range strings.Split(rel, "/") {
				if seg == p {
					return true
				}
			}
			continue
		}
		if globMatch(p, rel) {
			return true
		}
	}
	return false
}

// globMatch 可移植 glob：path.Match 固定 / 语义（* 不跨段）；无 / 的 pattern
// 追加「/ 折叠占位符」再试一次（\x00 不会出现在真实路径与 pattern 中，path
// 包对 * 的「匹配非分隔符任意串」语义因 / 已消失而变为跨段）
func globMatch(pattern, rel string) bool {
	if ok, _ := path.Match(pattern, rel); ok {
		return true
	}
	if !strings.Contains(pattern, "/") {
		ok, _ := path.Match(pattern, strings.ReplaceAll(rel, "/", "\x00"))
		return ok
	}
	return false
}

// enumerateUnitDir 枚举目录树。git 仓库（且不要求含 .git 全量）走 git
// ls-files 感知 .gitignore；其余（纯工作区/含 .git 档）走本地走树 +
// 排除清单。includeGit 时 .git 目录整树入列（本体两档之一）
func enumerateUnitDir(root string, includeGit, includeIgnored bool) (unitScan, error) {
	var scan unitScan
	excludes := defaultExcludes
	if includeIgnored {
		excludes = nil // 显式含被忽略文件：默认清单一并放开（用户显式扩面）
	}
	if !includeGit && git.IsRepo(root) {
		return enumerateGitAware(root, includeIgnored)
	}
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // 单条目不可读不阻断枚举（stat.go statTarget 下界口径）
		}
		rel, rerr := filepath.Rel(root, p)
		if rerr != nil {
			return nil
		}
		rel = normalizeSlashes(rel)
		if rel == "." {
			return nil
		}
		if d.IsDir() {
			if !includeGit && rel == ".git" {
				return filepath.SkipDir
			}
			if matchExclude(rel, excludes) {
				scan.excluded++
				return filepath.SkipDir
			}
			return nil
		}
		if scan.truncated {
			return filepath.SkipAll
		}
		if matchExclude(rel, excludes) {
			scan.excluded++
			return nil
		}
		info, ierr := d.Info()
		if ierr != nil {
			return nil
		}
		if len(scan.files) >= maxUnitEntries {
			scan.truncated = true
			return filepath.SkipAll
		}
		scan.files = append(scan.files, fileEntry{rel: rel, size: info.Size()})
		return nil
	})
	if err != nil {
		return scan, err
	}
	sortFiles(scan.files)
	return scan, nil
}

// enumerateGitAware git 感知枚举：LsFilesForSync 单进程取全集；排除计数 =
// 被忽略顶层条目数（忽略目录整枝计 1，展示语义「已排除 N 项」够用且免深树
// 遍历）。git 不可用/命令失败回落本地走树（枚举永不因工具缺失而失败——
// 降级可用优于拒绝服务）
func enumerateGitAware(root string, includeIgnored bool) (unitScan, error) {
	var scan unitScan
	mode := git.SyncListTracked
	if includeIgnored {
		mode = git.SyncListAll
	}
	out, err := git.LsFilesForSync(root, mode)
	if err != nil {
		return enumerateUnitDir(root, false, includeIgnored)
	}
	for _, rel := range splitNul(out) {
		if rel == "" {
			continue
		}
		rel = normalizeSlashes(rel)
		if scan.truncated {
			break
		}
		info, ierr := os.Lstat(filepath.Join(root, filepath.FromSlash(rel)))
		if ierr != nil {
			continue // index 内已删除的工作区条目：不入枚举（对齐打包面）
		}
		if len(scan.files) >= maxUnitEntries {
			scan.truncated = true
			break
		}
		scan.files = append(scan.files, fileEntry{rel: rel, size: info.Size()})
	}
	if !includeIgnored {
		// 排除计数（尽力而为：失败不计入，不阻断）
		if igOut, igErr := git.LsFilesForSync(root, git.SyncListIgnoredTop); igErr == nil {
			scan.excluded = len(splitNul(igOut))
		}
	}
	sortFiles(scan.files)
	return scan, nil
}

func splitNul(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(s, "\x00")
}

func sortFiles(files []fileEntry) {
	sort.Slice(files, func(i, j int) bool { return files[i].rel < files[j].rel })
}

// fingerprintFiles 聚合指纹：排序条目的 "rel\x00size\n" 流 sha256。
// 同输入同输出、跨平台稳定——分隔符在指纹层再归一一次（枚举层已归一，这里
// 是防御性双保险：任何直喂本函数的调用方都不必记得先归一）
func fingerprintFiles(files []fileEntry) string {
	h := sha256.New()
	for _, f := range files {
		h.Write([]byte(normalizeSlashes(f.rel)))
		h.Write([]byte{0})
		h.Write([]byte(strconv.FormatInt(f.size, 10)))
		h.Write([]byte{'\n'})
	}
	return hex.EncodeToString(h.Sum(nil))
}
