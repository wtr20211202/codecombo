package git

// merge 预演（P-20261005-174）：git merge-tree --write-tree 现代三向模式
// 在对象库内合成虚拟合并结果——不动工作区、不动引用、不产生提交，「先看
// 再合」的只读预演原语。并行 agent 工作流的合并前自检点：预演干净→放心合、
// 冲突→先解决再合，替代「盲合撞冲突再 abort」的回退成本（P-324 给 rebase
// 落 abort 保底恰证该成本真实存在）。

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"codecombo/server/filepolicy"
)

// MergePreviewConflictFile 预演冲突清单条目：状态分类（词汇对齐 GetConflictFiles）
// + 冲突段摘要（首段 ours/theirs 预览，导航用不承担解决写回职责）。
// 删除-修改类冲突无冲突标记（合成树保留存活侧原文），只回状态不回段
type MergePreviewConflictFile struct {
	Path      string `json:"path"`
	Status    string `json:"status"` // both-modified / both-added / deleted-by-us / deleted-by-them
	HunkCount int    `json:"hunkCount,omitempty"`
	Ours      string `json:"ours,omitempty"`
	Theirs    string `json:"theirs,omitempty"`
}

// MergePreviewStat 合成面统计：HEAD → 合成树的差异聚合（本次合并将带入的变更量；
// 冲突文件以带标记的合成形态计入）
type MergePreviewStat struct {
	Files      int `json:"files"`
	Insertions int `json:"insertions"`
	Deletions  int `json:"deletions"`
}

// MergePreviewResult 预演结果：Clean=true 绿态（Stat 为合成面统计）；
// false 红态（Conflicts 携冲突清单）。Conflicts 恒为数组（nil 归一空数组，
// 前端免 null 分支，GetConflictParsed 同款）
type MergePreviewResult struct {
	Clean      bool                       `json:"clean"`
	TreeOID    string                     `json:"treeOid,omitempty"`
	Conflicts  []MergePreviewConflictFile `json:"conflicts"`
	CleanCount int                        `json:"cleanCount"`
	Stat       *MergePreviewStat          `json:"stat,omitempty"`
}

const (
	// MergeTreeMinMinor merge-tree 现代三向模式（--write-tree）最低 git 次要
	// 版本（2.38，2022-10 引入；gitVersionAtLeast 按 major.minor 比较）。
	// 导出：端点 501 文案与守卫共用同一事实源
	MergeTreeMinMinor = 38
	// mergePreviewMaxSummaryBytes 单冲突文件摘要读取上限：超过按「摘要不可得」
	// 跳过内容解析（状态分类仍准确来自 stage 集），防巨型文件把只读预演拖成
	// 无界内存面
	mergePreviewMaxSummaryBytes = 1 << 20
	// mergePreviewMaxRunes 首段 ours/theirs 预览截断（rune）：弹层是导航不是全文
	mergePreviewMaxRunes = 400
)

var (
	mergeTreeOnce   sync.Once
	mergeTreeCached bool
	// mergeTreeSupportedFn 探测注入缝：单测在不装旧版 git 的机器上验证 501
	// 降级路径（stashStagedSupportedFn 同款）
	mergeTreeSupportedFn = SupportsMergeTree
)

// SupportsMergeTree 报告本机 git 是否支持 merge-tree --write-tree 现代三向
// 合并（≥2.38）。进程级缓存一次：git 版本在服务运行期内视为不变（升级 git
// 需重启服务，SupportsStashStaged 同款边界）；探测失败按不支持处理——安全
// 降级只隐藏预演入口并让端点 501，不影响真合并现状
func SupportsMergeTree() bool {
	mergeTreeOnce.Do(func() {
		out, err := GitVersionOutput()
		mergeTreeCached = err == nil && gitVersionAtLeast(out, 2, MergeTreeMinMinor)
	})
	return mergeTreeCached
}

// MergeTreeSupported 当前生效的版本护栏判定（handler 与 MergePreview 共用
// 同一出口；测试经 SetMergeTreeProbeForTest 整体替换）
func MergeTreeSupported() bool { return mergeTreeSupportedFn() }

// SetMergeTreeProbeForTest 替换版本护栏探测函数（传 nil 恢复真实探测）。
// 仅供测试使用：旧版 git 环境难以在 CI 固定，注入 false 验证 501 降级路径
// （config.SetOAuthClientForTest 同款测试辅助注记）
func SetMergeTreeProbeForTest(fn func() bool) {
	if fn == nil {
		mergeTreeSupportedFn = SupportsMergeTree
		return
	}
	mergeTreeSupportedFn = fn
}

// MergePreview 预演「把 source 合入当前 HEAD」：返回合成树 OID、冲突清单
// （逐文件状态 + 冲突段摘要）与干净合成统计。纯读原语：零审计零写队列
// （端点侧注记，MergeBranch 真合并才入硬锁与冲突链）。函数级重查版本护栏：
// git <2.38 下旧式 merge-tree 是完全不同的参数形态，误入即错解析——端点
// 501 之外这里的拒绝是防直接调用方踩老模式的第二道闸
func MergePreview(repoPath string, source string) (*MergePreviewResult, error) {
	if !MergeTreeSupported() {
		return nil, fmt.Errorf("merge-tree --write-tree requires git >= 2.%d", MergeTreeMinMinor)
	}
	if err := validateRef(source); err != nil {
		return nil, err
	}
	out, conflicted, err := runMergeTree(repoPath, "--write-tree", "-z", "HEAD", source)
	if err != nil {
		return nil, err
	}

	treeOid, entries := parseMergeTreeEntries(out)
	if treeOid == "" {
		return nil, fmt.Errorf("merge-tree produced no tree oid")
	}

	res := &MergePreviewResult{TreeOID: treeOid, Clean: !conflicted, Conflicts: []MergePreviewConflictFile{}}
	res.Stat = mergePreviewStat(repoPath, treeOid)
	if !conflicted {
		res.CleanCount = res.Stat.Files
		return res, nil
	}

	// 红态：stage 集按路径分组定状态；干净计数 = 合成面变更文件中不在冲突
	// 清单里的个数（删除-修改类若两侧内容恰一致则不入 numstat 面，不计入
	// 干净数也符合语义——它没有「干净并入」的变更量）
	staged := groupConflictStages(entries)
	paths := make([]string, 0, len(staged))
	for path := range staged {
		paths = append(paths, path)
	}
	sort.Strings(paths) // 清单按路径字典序稳定呈现（map 迭代序不确定）
	conflictSet := make(map[string]bool, len(paths))
	for _, path := range paths {
		conflictSet[path] = true
		cf := MergePreviewConflictFile{Path: path, Status: conflictStatusFromStages(staged[path])}
		if cf.Status == "both-modified" || cf.Status == "both-added" {
			cf.HunkCount, cf.Ours, cf.Theirs = conflictSectionSummary(repoPath, treeOid, path)
		}
		res.Conflicts = append(res.Conflicts, cf)
	}
	clean := 0
	for _, f := range parseNumstatFiles(mergePreviewNumstat(repoPath, treeOid)) {
		if !conflictSet[f.Path] {
			clean++
		}
	}
	res.CleanCount = clean
	return res, nil
}

// runMergeTree 执行 merge-tree 并保留退出码语义：exit 0 = 干净合成、exit 1 =
// 有冲突（stdout 恰是合成树 OID 与冲突清单，即载荷本体）——execGit 把非零
// 退出当失败丢弃 stdout（execGitDiffNoIndex 同款困境），故单独保留输出、仅吞
// 退出码 1；其余失败（真错误/超时）照常上抛。merge-tree 是纯对象库读原语：
// 不触工作区不持 index，读类直通不进写队列（execGit 读路径同语义）
func runMergeTree(repoPath string, args ...string) (string, bool, error) {
	full := append([]string{"merge-tree"}, args...)
	cmd := exec.Command("git", append(gitLongPathsArgs(), full...)...)
	cmd.Dir = repoPath
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	setProcessGroup(cmd)

	// 全局并发门（P-20261004-125）：取得槽位才起进程。门错误必须在此原样
	// 上抛——下方失败组装用 stderr 文本构造错误、会吞掉 runWithTimeout 的
	// err（含稳定标记）
	releaseGate, gerr := acquireGlobalGate(full)
	if gerr != nil {
		return "", false, gerr
	}
	defer releaseGate()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	start := time.Now()
	err := runWithTimeout(cmd, classifyGitTimeout(full))
	out := stdout.String()
	errStr := RedactCredentials(stderr.String())

	if err != nil && strings.Contains(err.Error(), "exit status 1") {
		// 冲突是预演的合法结论而非命令失败：按成功语义记日志（exit 1 不当
		// 失败广播命令台，execGitDiffNoIndex 同款）
		logGitCmdQuiet(full, repoPath, time.Since(start), nil, "", out)
		return out, true, nil
	}
	logGitCmdQuiet(full, repoPath, time.Since(start), err, errStr, out)
	if err != nil {
		return "", false, fmt.Errorf("git %s: %s", redactArgs(full), errStr)
	}
	return out, false, nil
}

// mergeTreeEntry merge-tree 冲突条目段的一行（unmerged index 形态）
type mergeTreeEntry struct {
	mode  string
	blob  string
	stage int
	path  string
}

// parseMergeTreeEntries 解析 merge-tree --write-tree -z 输出：段 1 = 合成树
// OID；段 2 = 冲突条目 `<mode> <blob> <stage>\t<path>`（NUL 分隔，文件名逐字
// 保真不转义——quotePath 只作用于非 -z 展示形态，路径内含 \n/\t 也安全）；
// 空字段是段间分隔，其后为 informational 文本（人类可读消息，本预演面不
// 消费——冲突定位以 stage 集为准，且该段格式随 git 版本演进，解析刻意止步
// 于分隔符）
func parseMergeTreeEntries(out string) (string, []mergeTreeEntry) {
	fields := strings.Split(out, "\x00")
	if len(fields) == 0 {
		return "", nil
	}
	treeOid := strings.TrimSpace(fields[0])
	var entries []mergeTreeEntry
	for _, f := range fields[1:] {
		if f == "" {
			break // 段间分隔：条目段结束
		}
		head, path, ok := strings.Cut(f, "\t")
		if !ok {
			continue // 异常行不进清单（格式漂移时宁可少列不误报）
		}
		parts := strings.Fields(head)
		if len(parts) != 3 {
			continue
		}
		stage, err := strconv.Atoi(parts[2])
		if err != nil {
			continue
		}
		entries = append(entries, mergeTreeEntry{mode: parts[0], blob: parts[1], stage: stage, path: path})
	}
	return treeOid, entries
}

// groupConflictStages 按路径聚合 stage 集（stage 1=base 2=ours(HEAD) 3=theirs(source)）
func groupConflictStages(entries []mergeTreeEntry) map[string]map[int]bool {
	out := make(map[string]map[int]bool, len(entries))
	for _, e := range entries {
		if out[e.path] == nil {
			out[e.path] = map[int]bool{}
		}
		out[e.path][e.stage] = true
	}
	return out
}

// conflictStatusFromStages stage 集 → 状态分类（词汇对齐 GetConflictFiles）；
// 未知组合保守按 both-modified 呈现（真合并会落标记文本）
func conflictStatusFromStages(stages map[int]bool) string {
	switch {
	case stages[1] && stages[2] && stages[3]:
		return "both-modified"
	case stages[2] && stages[3]:
		return "both-added"
	case stages[1] && stages[2]:
		return "deleted-by-them"
	case stages[1] && stages[3]:
		return "deleted-by-us"
	default:
		return "both-modified"
	}
}

// conflictSectionSummary 读合成树中冲突文件的标记文本并解析首段摘要：内容
// 冲突（both-modified/both-added）的合成 blob 自带 <<<<<<< 标记（merge-tree
// 把冲突标记写进虚拟树，与真合并落在工作区的形态一致）；解析不可信形态
// （嵌套/未闭合标记）诚实返回零段。超 mergePreviewMaxSummaryBytes 或读取
// 失败按「摘要不可得」跳过（hunkCount=0，状态仍准确）
func conflictSectionSummary(repoPath, treeOid, path string) (hunkCount int, ours, theirs string) {
	rev := treeOid + ":" + path
	sizeOut, err := execGit(repoPath, "cat-file", "-s", rev)
	if err != nil {
		return 0, "", ""
	}
	if size, serr := strconv.Atoi(strings.TrimSpace(sizeOut)); serr != nil || size > mergePreviewMaxSummaryBytes {
		return 0, "", ""
	}
	raw, err := execGit(repoPath, "cat-file", "-p", rev)
	if err != nil {
		return 0, "", ""
	}
	content, _ := filepolicy.DecodeText([]byte(raw))
	hunks, ok := ParseConflictHunks(content)
	if !ok || len(hunks) == 0 {
		return 0, "", ""
	}
	return len(hunks), truncateRunes(hunks[0].Ours), truncateRunes(hunks[0].Theirs)
}

// truncateRunes 按 rune 截断并附省略号（预览截断不产生半个多字节字符）
func truncateRunes(s string) string {
	runes := []rune(s)
	if len(runes) <= mergePreviewMaxRunes {
		return s
	}
	return string(runes[:mergePreviewMaxRunes]) + "…"
}

// mergePreviewStat HEAD → 合成树的 numstat 聚合（合并将带入的变更量）。
// 恒返回非 nil：零值 stat = 合成面与 HEAD 一致（source 已被包含，绿态
// 「无变更」的依据面）；读取失败同样落零值——stat 是辅助面不阻塞预演主体
func mergePreviewStat(repoPath, treeOid string) *MergePreviewStat {
	stat := &MergePreviewStat{}
	for _, f := range parseNumstatFiles(mergePreviewNumstat(repoPath, treeOid)) {
		stat.Files++
		stat.Insertions += int(f.Additions)
		stat.Deletions += int(f.Deletions)
	}
	return stat
}

func mergePreviewNumstat(repoPath, treeOid string) string {
	out, err := execGit(repoPath, "diff", "--numstat", "HEAD", treeOid)
	if err != nil {
		return ""
	}
	return out
}
