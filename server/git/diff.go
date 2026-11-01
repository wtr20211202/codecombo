package git

import (
	"bytes"
	"codecombo/server/errmarkers"
	"codecombo/server/model"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MaxDiffOutput 单次 diff 输出上限（字节）。
// 大 diff（格式化扫描/生成文件变更/依赖升级）可能产生数十 MB 的补丁文本，
// 全量缓冲 + 序列化会造成内存尖刺与前端冻结；超限截断并附标记（决策门 M5.4①）
var MaxDiffOutput = 5 * 1024 * 1024

// truncateDiff 超限截断并附标记（len<=上限时原样返回）
func truncateDiff(s string) string {
	if len(s) <= MaxDiffOutput {
		return s
	}
	return s[:MaxDiffOutput] + "\n...[diff truncated: output exceeds 5MB limit]"
}

// 获取两个分支之间的文件差异列表
func GetBranchDiff(repoPath string, from, to string) ([]model.FileDiff, error) {
	if err := validateRef(from, to); err != nil {
		return nil, err
	}
	return GetDiffStat(repoPath, from, to)
}

// 获取两个分支之间某个文件的详细 diff
func GetBranchFileDiff(repoPath string, from, to, file string) (string, error) {
	if err := validateRef(from, to); err != nil {
		return "", err
	}
	output, err := execGit(repoPath, "diff", from, to, "--", file)
	if err != nil {
		return "", err
	}
	return truncateDiff(output), nil
}

// 获取工作区和暂存区的差异
func GetDiff(repoPath string, staged bool) (string, error) {
	var out string
	var err error
	if staged {
		out, err = mustDiff(repoPath, "diff", "--cached")
	} else {
		out, err = mustDiff(repoPath, "diff")
	}
	if err != nil {
		return "", err
	}
	return truncateDiff(out), nil
}

// mustDiff execGit 的 err 恒定为 nil 的包装（git diff 无匹配时 exit 1 是常态语义）
func mustDiff(repoPath string, args ...string) (string, error) {
	out, err := execGit(repoPath, args...)
	if err != nil {
		if strings.Contains(err.Error(), "exit status 1") || out == "" {
			return out, nil
		}
	}
	return out, err
}

// 获取指定文件的差异
func GetFileDiff(repoPath string, file string, staged bool) (string, error) {
	var out string
	var err error
	if staged {
		out, err = mustDiff(repoPath, "diff", "--cached", "--", file)
	} else {
		out, err = mustDiff(repoPath, "diff", "--", file)
	}
	if err != nil {
		return "", err
	}
	return truncateDiff(out), nil
}

// 获取某次提交的差异。merge 提交与第一父对比（mergeDiffBase，log.go）
func GetCommitDiff(repoPath string, commit string) (string, error) {
	args := []string{"diff-tree", "--root", "-p"}
	if base := mergeDiffBase(repoPath, commit); base != commit {
		args = append(args, base)
	}
	args = append(args, commit)
	output, err := execGit(repoPath, args...)
	if err != nil {
		return "", err
	}
	return truncateDiff(output), nil
}

// GetCommitFileDiff 获取某次提交中指定文件的差异。merge 提交与第一父对比
func GetCommitFileDiff(repoPath string, commit string, file string) (string, error) {
	args := []string{"diff-tree", "--root", "-p"}
	if base := mergeDiffBase(repoPath, commit); base != commit {
		args = append(args, base)
	}
	args = append(args, commit, "--", file)
	output, err := execGit(repoPath, args...)
	if err != nil {
		return "", err
	}
	return truncateDiff(output), nil
}

// GetBaseFileDiff 取工作区相对指定基线（commit/分支引用）的单文件 diff
// （P-20261003-46 对比实验：base = 会话 startHead 快照面，「基线 vs 侧会话产出」）。
// 与 GetBranchFileDiff 的 ref↔ref 不同，to 缺省即工作区。ref 校验同款
// （防选项注入），无匹配时 exit 1 是常态语义（mustDiff 吸收）
func GetBaseFileDiff(repoPath string, ref string, file string) (string, error) {
	if err := validateRef(ref); err != nil {
		return "", err
	}
	out, err := mustDiff(repoPath, "diff", ref, "--", file)
	if err != nil {
		return "", err
	}
	return truncateDiff(out), nil
}

// GetRestoreFileDiff 取「基线 → 工作区」单文件还原补丁（P-20261004-72 对比实验
// 采用落盘：apply -R 逆向即可把文件还原到基线态）。与 GetBaseFileDiff 的差异
// 两点：--binary（二进制文件产出全量补丁，双向可 apply——普通 diff 对二进制
// 只出 differ 说明行，逆向还原不可能）；不截断（截断补丁 apply 必败，还原性
// 优先、字节上限由调用方累计把关）。ref 校验同款防选项注入；无差异 exit 1
// 吸收为空串（空补丁调用方跳过）
func GetRestoreFileDiff(repoPath string, ref string, file string) (string, error) {
	if err := validateRef(ref); err != nil {
		return "", err
	}
	return mustDiff(repoPath, "diff", "--binary", ref, "--", file)
}

// ApplyPatchReverse 把补丁逆向应用到工作区（只动工作区不动索引，P-20261004-72
// 对比实验采用落盘的多文件回滚通道；单 hunk discard 走 applyHunkReverse 私有
// 路径带专属冲突语义，勿混用）。git apply 默认全有或全无（无 --reject 不落
// 部分结果）——多文件合并补丁一次调用即原子回滚。上下文失配等失败原样返回
// （调用方按稳定标记归类），stdin 注入与写队列互斥走 execGitWithStdin 同源
func ApplyPatchReverse(repoPath string, patch string) error {
	_, err := execGitWithStdin(repoPath, patch, "apply", "-R", "--allow-empty")
	return err
}

// 获取两次提交之间的文件差异列表
func GetDiffStat(repoPath string, from, to string) ([]model.FileDiff, error) {
	args := []string{"diff", "--name-status"}
	if from != "" && to != "" {
		args = append(args, from, to)
	} else if from != "" {
		args = append(args, from)
	}

	output, err := execGit(repoPath, args...)
	if err != nil {
		return nil, err
	}

	return parseDiffStat(output), nil
}

func parseDiffStat(output string) []model.FileDiff {
	var diffs []model.FileDiff
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		parts := strings.SplitN(line, "\t", 3)
		if len(parts) < 2 {
			continue
		}

		status := "Modified"
		switch parts[0] {
		case "A":
			status = "Added"
		case "D":
			status = "Deleted"
		case "R":
			status = "Renamed"
		case "C":
			status = "Copied"
		}

		diff := model.FileDiff{
			Status: status,
		}

		if len(parts) == 3 {
			diff.OldPath = parts[1]
			diff.Path = parts[2]
		} else {
			diff.Path = parts[1]
		}

		diffs = append(diffs, diff)
	}

	return diffs
}

// 获取文件Blame信息（结构化）。ref 非空时按该提交/引用 blame（X^ 上一版考古），
// 缺省保持工作树形态不变；ref 走 validateRef 防选项注入（A6，同分支对比口径）
func GetBlame(repoPath string, file string, ref string) ([]model.BlameLine, error) {
	args := []string{"blame", "--porcelain"}
	if ref != "" {
		if err := validateRef(ref); err != nil {
			return nil, err
		}
		args = append(args, ref)
	}
	args = append(args, "--", file)
	output, err := execGit(repoPath, args...)
	if err != nil {
		return nil, err
	}
	return parseBlame(output), nil
}

// 获取文件diff的hunk列表
func GetFileHunks(repoPath string, file string, staged bool) ([]model.DiffHunk, error) {
	diff, err := GetFileDiff(repoPath, file, staged)
	if err != nil {
		return nil, err
	}
	return parseHunks(diff), nil
}

// 暂存单个hunk
func StageHunk(repoPath string, file string, hunkIndex int) error {
	// 获取文件diff
	diff, err := GetFileDiff(repoPath, file, false)
	if err != nil {
		return err
	}
	hunks := parseHunks(diff)
	if hunkIndex < 0 || hunkIndex >= len(hunks) {
		return fmt.Errorf("invalid hunk index: %d", hunkIndex)
	}

	// 构造只包含该hunk的patch（尾换行缺失补齐，见 buildSingleHunkPatch）
	patch := buildSingleHunkPatch(file, hunks[hunkIndex].Content)

	// 使用git apply --cached应用patch
	_, err = execGitWithStdin(repoPath, patch, "apply", "--cached", "--allow-empty")
	return err
}

// 取消暂存单个hunk
func UnstageHunk(repoPath string, file string, hunkIndex int) error {
	// 获取暂存区diff
	diff, err := GetFileDiff(repoPath, file, true)
	if err != nil {
		return err
	}
	hunks := parseHunks(diff)
	if hunkIndex < 0 || hunkIndex >= len(hunks) {
		return fmt.Errorf("invalid hunk index: %d", hunkIndex)
	}

	// 反向应用patch（用-R标志）
	patch := buildSingleHunkPatch(file, hunks[hunkIndex].Content)

	_, err = execGitWithStdin(repoPath, patch, "apply", "-R", "--cached", "--allow-empty")
	return err
}

// buildSingleHunkPatch 组装单 hunk 补丁（--- a/ / +++ b/ 头 + hunk 内容），
// Stage/Unstage/applyHunkReverse（discard）三处共用。parseHunks 以「下一行前
// 补 \n」拼接内容，非末位 hunk 结尾无换行——直接交 git apply 报 corrupt patch
// （P-20261004-24：discard 链此前已局部补齐，本 helper 收口三处共用；末位块
// 天然带换行则零改写，discard 语义不变）
func buildSingleHunkPatch(file string, hunkContent string) string {
	if !strings.HasSuffix(hunkContent, "\n") {
		hunkContent += "\n"
	}
	return fmt.Sprintf("--- a/%s\n+++ b/%s\n%s", file, file, hunkContent)
}

// hunkWriteLocks hunk 写入按仓库串行（P-20261003-49 写队列域）：DiscardHunk 是
// 「派生工作区 diff → 逆向 apply 回工作区」的读改写过程，窗口被并发打破时后到者
// 会基于同一张旧 hunk 表再次 -R（误回滚相邻块）。按仓库路径惰性建锁（status_cache
// pathLock 同款 sync.Map 惯例），只串行 discard 自身——stage/unstage 既有链不动
var hunkWriteLocks sync.Map // repoPath -> *sync.Mutex

// ErrHunkDiscardConflict 逆向补丁与工作区现状失配：该变更块在 diff 快照派生后
// 又被改动（agent/用户并发编辑）。安全失败——git apply 整体拒绝，工作区一个
// 字节不动。errors.Is 判别；错误文本含稳定英文标记（HunkDiscardConflictMarker），
// 前端 KNOWN_ERROR_I18N 按子串映射「此变更块已变化，无法直接回滚」
// （子串匹配机制与 IndexLockStaleMarker 同款）
var ErrHunkDiscardConflict = errors.New(errmarkers.HunkDiscardConflict)

// HunkDiscardConflictMarker 稳定英文标记：前端 http.ts KNOWN_ERROR_I18N 正则
// 匹配锚点，改文案必须同步前端正则。文本唯一事实源在 errmarkers 注册表
// （P-20261004-29），此处保名别名
const HunkDiscardConflictMarker = errmarkers.HunkDiscardConflict

// DiscardHunk 回滚工作区单个 hunk（VS Code「撤销此更改」，P-20261003-49）：
// 取文件当前未暂存 diff（工作区 vs 暂存区）的第 hunkIndex 块，git apply -R
// 逆向写回工作区——只动工作区，暂存区不受影响。仅处置「看见的这一版」：
// 块内容已再变时 apply 上下文失配，按 ErrHunkDiscardConflict 拒绝
func DiscardHunk(repoPath string, file string, hunkIndex int) error {
	l, _ := hunkWriteLocks.LoadOrStore(repoPath, &sync.Mutex{})
	l.(*sync.Mutex).Lock()
	defer l.(*sync.Mutex).Unlock()

	diff, err := GetFileDiff(repoPath, file, false)
	if err != nil {
		return err
	}
	hunks := parseHunks(diff)
	if hunkIndex < 0 || hunkIndex >= len(hunks) {
		return fmt.Errorf("invalid hunk index: %d", hunkIndex)
	}
	return applyHunkReverse(repoPath, file, hunks[hunkIndex].Content)
}

// applyHunkReverse 把单 hunk 补丁逆向应用到工作区（不带 --cached）。
// 独立成函数除复用外也为单测可注入：拿旧快照 hunk 打已再改的工作区，
// 确定性构造冲突路径（DiscardHunk 内部的快照-应用窗口无法从外部插入）。
// 补丁组装（含非末位 hunk 尾换行补齐）走 buildSingleHunkPatch 共用——
// P-20261004-24 起 Stage/Unstage 同构暗伤一并修复，此处不再单独补
func applyHunkReverse(repoPath string, file string, hunkContent string) error {
	patch := buildSingleHunkPatch(file, hunkContent)
	_, err := execGitWithStdin(repoPath, patch, "apply", "-R", "--allow-empty")
	if err != nil && strings.Contains(err.Error(), "patch does not apply") {
		return fmt.Errorf("%w (change block was modified after the diff snapshot): %v", ErrHunkDiscardConflict, err)
	}
	return err
}

func parseHunks(diff string) []model.DiffHunk {
	var hunks []model.DiffHunk
	lines := strings.Split(diff, "\n")
	var currentHunk *model.DiffHunk
	// 使用 strings.Builder 代替 []string + strings.Join，减少内存分配
	var hunkBuilder strings.Builder
	hunkBuilder.Grow(256)

	flushHunk := func() {
		if currentHunk != nil {
			currentHunk.Content = hunkBuilder.String()
			hunks = append(hunks, *currentHunk)
		}
	}

	for _, line := range lines {
		if strings.HasPrefix(line, "@@") {
			// 保存上一个hunk
			flushHunk()
			// 解析 @@ -oldStart,oldLines +newStart,newLines @@
			currentHunk = &model.DiffHunk{}
			hunkBuilder.Reset()
			hunkBuilder.WriteString(line)
			parseHunkHeader(line, currentHunk)
		} else if currentHunk != nil {
			if strings.HasPrefix(line, "diff --git") || strings.HasPrefix(line, "---") || strings.HasPrefix(line, "+++") {
				// 新文件diff开始，保存当前hunk
				flushHunk()
				currentHunk = nil
			} else {
				hunkBuilder.WriteByte('\n')
				hunkBuilder.WriteString(line)
			}
		}
	}
	// 最后一个hunk
	flushHunk()

	return hunks
}

func parseHunkHeader(line string, hunk *model.DiffHunk) {
	// @@ -oldStart,oldLines +newStart,newLines @@
	// 提取 -start,count +start,count 部分
	parts := strings.Split(line, " ")
	if len(parts) >= 3 {
		parseRange(parts[1], &hunk.OldStart, &hunk.OldLines)
		parseRange(parts[2], &hunk.NewStart, &hunk.NewLines)
	}
}

func parseRange(s string, start *int, count *int) {
	// 去掉前缀 - 或 +
	if len(s) > 0 && (s[0] == '-' || s[0] == '+') {
		s = s[1:]
	}
	parts := strings.SplitN(s, ",", 2)
	*start = atoi(parts[0])
	if len(parts) > 1 {
		*count = atoi(parts[1])
	} else {
		*count = 1
	}
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		if c >= '0' && c <= '9' {
			n = n*10 + int(c-'0')
		} else {
			break
		}
	}
	return n
}

func parseBlame(output string) []model.BlameLine {
	var lines []model.BlameLine
	currentHash := ""
	currentAuthor := ""
	currentSummary := ""
	currentTime := time.Time{}
	lineNo := 0

	for _, raw := range strings.Split(output, "\n") {
		if raw == "" {
			continue
		}
		// 以 tab 开头的是文件内容行
		if raw[0] == '\t' {
			lineNo++
			content := raw[1:]
			lines = append(lines, model.BlameLine{
				LineNo:  lineNo,
				Hash:    currentHash,
				Author:  currentAuthor,
				Date:    currentTime,
				Summary: currentSummary,
				Content: content,
			})
			continue
		}

		// 根据首字符快速分支，减少字符串比较次数
		if len(raw) == 0 {
			continue
		}
		isMeta := true
		switch raw[0] {
		case 'a':
			if strings.HasPrefix(raw, "author ") {
				currentAuthor = raw[7:]
			} else if strings.HasPrefix(raw, "author-time ") {
				// author-time 为 Unix 秒；解析失败保留零值（前端隐藏日期）
				if sec, err := strconv.ParseInt(strings.TrimSpace(raw[12:]), 10, 64); err == nil {
					currentTime = time.Unix(sec, 0)
				}
			} else if !strings.HasPrefix(raw, "author-") {
				isMeta = false
			}
		case 's':
			if strings.HasPrefix(raw, "summary ") {
				currentSummary = raw[8:]
			}
		case 'c', 'f', 'p', 'b':
			// committer/filename/previous/boundary 字段，忽略。
			// hash 自身可能以 c/f/p/b 开头（与这些元数据首字符同域）——
			// 前缀不匹配时回落为 hash header（否则该提交段 hash 被吞、
			// 注解显示为空且点击定位失效，~4/16 的提交命中）
			if strings.HasPrefix(raw, "committer") ||
				strings.HasPrefix(raw, "filename ") ||
				strings.HasPrefix(raw, "previous ") ||
				raw == "boundary" {
				// 元数据，忽略
			} else {
				isMeta = false
			}
		default:
			isMeta = false
		}

		// hash header 行: hash origLine finalLine [numLines]
		if !isMeta {
			parts := strings.Fields(raw)
			if len(parts) >= 1 && len(parts[0]) >= 8 {
				currentHash = parts[0]
				if len(currentHash) > 8 {
					currentHash = currentHash[:8]
				}
			}
		}
	}

	return lines
}

// ============== 工作区 numstat（P-20261003-219 变更树「复制变更摘要」数据面） ==============

// NumstatFile 工作区未提交变更的单文件行数统计
type NumstatFile struct {
	Path      string `json:"path"`
	Additions int64  `json:"additions"`
	Deletions int64  `json:"deletions"`
	Binary    bool   `json:"binary,omitempty"`
}

const (
	// numstatUntrackedMaxFiles 未跟踪文件行数补计的数量上限：行数是「改动规模」
	// 示意口径（AgentMarksStat 同哲学），依赖目录漏 ignore 等病态场景下的海量
	// 未跟踪文件不该把一次点击取数拖成全盘扫描——超出的文件仍会出现在前端文件
	// 清单里（清单来自 status），只是不计行数
	numstatUntrackedMaxFiles = 200
	// numstatUntrackedMaxBytes 单个未跟踪文件行数补计的读取上限：只数前 1MB 内
	// 的整行，防把生成物大文件整读进内存
	numstatUntrackedMaxBytes = 1 << 20
	// numstatBinaryProbeBytes 二进制探测窗：首 8KB 含 NUL 即按二进制处理（git
	// 判二进制同类启发——diff 输出对二进制也以 - 代替行数）
	numstatBinaryProbeBytes = 8192
)

// GetWorktreeNumstat 工作区相对 HEAD 的逐文件增删行数（含已暂存）：
// git diff --numstat HEAD，外加未跟踪新文件行数补计——untracked 不在 diff
// 输出里，而 agent 产出以新建文件居多，漏计会让「N 个文件 M 行」严重失真
// （未跟踪文件按内容行数计入 additions）。尽力而为不返回错误：git diff 失败
// （空仓库无 HEAD 等）时 tracked 部分为空、untracked 照常补计——调用方（前端
// 变更摘要）本就持有文件清单，这里只供行数，宁缺毋失败
func GetWorktreeNumstat(repoPath string) []NumstatFile {
	files := make([]NumstatFile, 0, 16)
	if out, err := execGit(repoPath, "diff", "--numstat", "HEAD"); err == nil {
		files = parseNumstatFiles(out)
	}
	outU, errU := execGit(repoPath, "ls-files", "--others", "--exclude-standard")
	if errU != nil {
		return files
	}
	counted := 0
	for _, line := range strings.Split(outU, "\n") {
		p := strings.TrimSpace(line)
		if p == "" {
			continue
		}
		if counted >= numstatUntrackedMaxFiles {
			break
		}
		add, binary := countNewFileLines(repoPath, p)
		if binary {
			files = append(files, NumstatFile{Path: p, Binary: true})
		} else {
			files = append(files, NumstatFile{Path: p, Additions: add})
		}
		counted++
	}
	return files
}

// parseNumstatFiles 解析 git diff --numstat 输出为逐文件行数（terminalapi
// parseNumstat 的聚合口径即本函数按文件求和）。二进制行（-	-）记 Binary 不数
// 行；重命名条目的路径取 => 右侧新路径（与 status 侧 FileStatus.Path 的归属
// 一致，前端按 path 合并）
func parseNumstatFiles(out string) []NumstatFile {
	files := make([]NumstatFile, 0, 16)
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		parts := strings.SplitN(line, "\t", 3)
		if len(parts) < 3 {
			continue
		}
		f := NumstatFile{Path: numstatNewPath(parts[2])}
		if parts[0] == "-" || parts[1] == "-" {
			f.Binary = true
		} else {
			f.Additions, _ = strconv.ParseInt(parts[0], 10, 64)
			f.Deletions, _ = strconv.ParseInt(parts[1], 10, 64)
		}
		files = append(files, f)
	}
	return files
}

// numstatNewPath numstat 路径字段取新路径：重命名条目为 `old => new` 或
// `pre/{old => new}post` 展开形态，统一解析出 new（无 => 原样返回）
func numstatNewPath(p string) string {
	i := strings.Index(p, " => ")
	if i < 0 {
		return p
	}
	head, tail := p[:i], p[i+4:]
	if ob := strings.LastIndexByte(head, '{'); ob >= 0 {
		pre := head[:ob]
		if cb := strings.IndexByte(tail, '}'); cb >= 0 {
			return pre + tail[:cb] + tail[cb+1:]
		}
		return pre + tail
	}
	return tail
}

// countNewFileLines 数未跟踪新文件的行数（整行口径，末尾无换行的残行也计 1）。
// 只读前 numstatUntrackedMaxBytes；首 8KB 含 NUL 按二进制返回 binary=true（与
// diff 侧二进制同样不数行）。文件读不了（并发删除等）返回 0 非二进制
func countNewFileLines(repoPath, slashPath string) (additions int64, binary bool) {
	f, err := os.Open(filepath.Join(repoPath, filepath.FromSlash(slashPath)))
	if err != nil {
		return 0, false
	}
	defer f.Close()
	buf := make([]byte, numstatUntrackedMaxBytes)
	n, _ := io.ReadFull(f, buf)
	if n == 0 {
		return 0, false
	}
	data := buf[:n]
	probe := data
	if len(probe) > numstatBinaryProbeBytes {
		probe = probe[:numstatBinaryProbeBytes]
	}
	if bytes.IndexByte(probe, 0) >= 0 {
		return 0, true
	}
	var count int64
	for _, b := range data {
		if b == '\n' {
			count++
		}
	}
	if data[len(data)-1] != '\n' {
		count++ // 末尾无换行的残行也是一行
	}
	return count, false
}
