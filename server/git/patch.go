package git

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ============== untracked 文件追补（P-20261004-56） ==============

var (
	// untrackedPatchMaxFiles 单次导出追补的 untracked 文件数上限：补丁是搬运
	// 载体，漏文件即现场残缺；但漏 ignore 的产物海不该把一次导出拖成全盘
	// 逐文件 diff——超限逐个附注记（确定性输出），与 numstatUntrackedMaxFiles
	// 同哲学。500 足够脚手架级新产物。var 而非 const：单测收缩上限免跑
	// 数百个 git 子进程（下限语义不变）
	untrackedPatchMaxFiles = 500
	// untrackedPatchMaxBytes 单文件追补的字节上限：--no-index 对文本逐行 diff、
	// 对二进制产全量 literal 段（比原文件还大），误入的大产物会把补丁与内存
	// 同时撑爆。跳过并注记不静默（git status 照常可见该文件，用户可自行
	// ignore 或手动搬运）
	untrackedPatchMaxBytes = int64(2) << 20
)

// untrackedPatchSegments 把未跟踪新文件产成可 apply 的 new-file 补丁段：
// git diff 不含 untracked（git 既有语义），而 agent 高频产出恰是新文件——
// 导出补丁漏新文件 = 搬运到收件侧现场残缺（P-20261004-56）。
// 逐文件 `git diff --no-index --binary <os.DevNull> <relpath>` 原生生成：
// 路径与编码零手写合成；二进制自动出 GIT binary patch literal 段（收件侧可
// 完整还原——手写合成的 "Binary files differ" 占位 apply 不了，compareexp
// untracked.go 那套只服务展示面）；空文件/无尾换行/可执行位边界全由 git
// 语义兜住。ls-files -z 取原始路径（core.quotePath 会把非 ASCII 路径八进制
// 转义，转义形态喂回 --no-index 会打不开文件）；--exclude-standard 即
// .gitignore 单一事实源（与变更树所见一致，不另叠 QuickOpen SKIP_DIRS
// 硬编码），未 ignore 的超大产物由大小/数量上限兜底。
// 拼接次序由调用方保证：tracked diff 在前、本段按 ls-files 的路径序在后
// （两段都是 git 原生序，确定性输出）。单文件失败（并发删除等）跳过不毁
// 整批——导出尽力而为；超大的文件以纯文本注记行入补丁（夹在 diff 段间的
// 非 diff 行 git apply 会忽略，实测不破坏可应用性）。量级注记：上限内逐
// 文件一个 git 子进程（用户点击触发的非热路径，常规 agent 现场个位数新
// 文件），数量上限的存在同时是耗时上界
func untrackedPatchSegments(repoPath string) string {
	listOut, err := execGit(repoPath, "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil || listOut == "" {
		return ""
	}
	var b strings.Builder
	counted := 0
	omittedBeyondCap := 0
	firstBeyondCap := ""
	for _, p := range strings.Split(listOut, "\x00") {
		if p == "" {
			continue
		}
		if counted >= untrackedPatchMaxFiles {
			omittedBeyondCap++ // 聚合注记（防产物海把补丁灌满注记行），首路径供定位
			if firstBeyondCap == "" {
				firstBeyondCap = p
			}
			continue
		}
		fi, err := os.Stat(filepath.Join(repoPath, filepath.FromSlash(p)))
		if err != nil || fi.IsDir() {
			continue // 并发删除/伪条目：无内容可补，尽力而为
		}
		if fi.Size() > untrackedPatchMaxBytes {
			fmt.Fprintf(&b, "...[untracked file omitted from patch: %s (oversized: %d > %d bytes)]\n", p, fi.Size(), untrackedPatchMaxBytes)
			continue
		}
		seg, err := execGitDiffNoIndex(repoPath, "diff", "--no-index", "--binary", os.DevNull, p)
		if err != nil || strings.TrimSpace(seg) == "" {
			continue
		}
		counted++
		b.WriteString(seg)
		if !strings.HasSuffix(seg, "\n") {
			b.WriteByte('\n') // 段间拼接恒保行首（git 正常输出自带尾换行，防御性补齐）
		}
	}
	if omittedBeyondCap > 0 {
		fmt.Fprintf(&b, "...[%d untracked files omitted from patch (exceeds %d-file export cap), starting at %s]\n", omittedBeyondCap, untrackedPatchMaxFiles, firstBeyondCap)
	}
	return b.String()
}

// FormatPatch 导出指定提交为 patch 文件内容
func FormatPatch(repoPath string, commits []string) (string, error) {
	args := []string{"format-patch", "--stdout"}
	if len(commits) == 1 {
		args = append(args, "-1", commits[0])
	} else if len(commits) >= 2 {
		args = append(args, fmt.Sprintf("%s..%s", commits[0], commits[1]))
	}

	output, err := execGit(repoPath, args...)
	if err != nil {
		return "", err
	}
	return output, nil
}

// ApplyPatch 应用 patch
func ApplyPatch(repoPath string, patchContent string, check bool) error {
	args := []string{"apply"}
	if check {
		args = append(args, "--check")
	}
	args = append(args, "--allow-empty")

	_, err := execGitWithStdin(repoPath, patchContent, args...)
	return err
}

// ApplyMailboxPatch 使用 git am 应用 mailbox 格式的 patch
func ApplyMailboxPatch(repoPath string, patchContent string) error {
	_, err := execGitWithStdin(repoPath, patchContent, "am")
	return err
}

// ExportDiffAsPatch 将工作区/暂存区变更导出为 patch。
// --binary：二进制变更以 GIT binary patch 形式入补丁（git apply 可完整还原）；
// 裸 diff 对二进制文件只写 "Binary files differ" 占位，作为交换格式缺半边。
// 工作区形态追补 untracked 新文件段（P-20261004-56：GET /patch?scope=worktree
// 与 POST /patch/export staged=false 的替换备份链共用此口径）；staged 语义
// 不变——暂存区本就无 untracked 概念
func ExportDiffAsPatch(repoPath string, staged bool) (string, error) {
	if staged {
		return execGit(repoPath, "diff", "--cached", "--binary")
	}
	out, err := execGit(repoPath, "diff", "--binary")
	if err != nil {
		return "", err
	}
	return out + untrackedPatchSegments(repoPath), nil
}

// DiffHeadPatch 导出相对 HEAD 的全部未提交变更（暂存+未暂存，P-20261003-72）。
// P-20261004-56 起追补 untracked 新文件段：tracked diff 在前、untracked 段按
// 路径序在后（确定性输出）——agent 产出以新文件居多，漏新文件的补丁搬到
// 收件侧即现场残缺
func DiffHeadPatch(repoPath string) (string, error) {
	out, err := execGit(repoPath, "diff", "HEAD", "--binary")
	if err != nil {
		return "", err
	}
	return out + untrackedPatchSegments(repoPath), nil
}

// 生成两个版本之间的 patch
func FormatPatchRange(repoPath string, from, to string) (string, error) {
	if from == "" || to == "" {
		return "", fmt.Errorf("from and to commits are required")
	}
	args := []string{"format-patch", "--stdout", from + ".." + to}
	return execGit(repoPath, args...)
}

// 从 patch 内容中提取文件名列表
func ParsePatchFiles(patchContent string) []string {
	var files []string
	seen := make(map[string]bool)

	for _, line := range strings.Split(patchContent, "\n") {
		if strings.HasPrefix(line, "diff --git a/") {
			// diff --git a/file.txt b/file.txt
			parts := strings.SplitN(line, " ", 4)
			if len(parts) >= 4 {
				file := strings.TrimPrefix(parts[3], "b/")
				if !seen[file] {
					seen[file] = true
					files = append(files, file)
				}
			}
		}
	}
	return files
}

// PatchHeaderPaths 从补丁内容提取全部涉及路径（diff --git 头 old/new 两侧，
// 剥 a/ b/ 前缀；引用形态解析复用 FilterPatchToPaths 的 splitHeaderTokens——
// 含空格/非 ASCII 路径走 quote_c_style 引用形态，裸 Fields 会拆碎）。与
// ParsePatchFiles 的展示面用途不同：出域扫描要 rename/copy 两侧与引用形态
// 路径都覆盖（宁多勿漏——解析不出的 token 原样保留，basename 兜底匹配）。
// 消费方：gitops 导出族出域前敏感文件名匹配（P-20261004-97）
func PatchHeaderPaths(patchContent string) []string {
	seen := make(map[string]bool)
	var out []string
	add := func(tok string) {
		if len(tok) > 2 && (tok[0] == 'a' || tok[0] == 'b') && tok[1] == '/' {
			tok = tok[2:]
		}
		if tok != "" && !seen[tok] {
			seen[tok] = true
			out = append(out, tok)
		}
	}
	for _, line := range strings.Split(patchContent, "\n") {
		if !strings.HasPrefix(line, "diff --git ") {
			continue
		}
		rest := strings.TrimRight(strings.TrimPrefix(line, "diff --git "), "\r")
		for _, tok := range splitHeaderTokens(rest) {
			add(tok)
		}
	}
	return out
}

// FilterPatchToPaths 把补丁裁剪到指定路径集合（P-20261004-66 还原边界修复）：
// 备份补丁自 P-20261004-56 起 含 untracked new-file 段（ExportDiffAsPatch
// worktree 形态），而替换还原的 checkout 圈定只覆盖 tracked 子集——整补丁
// 直接 apply 会撞上仍在工作区的已替换 untracked 文件，git 报
// "already exists in working directory" 整体失败（409），还原对「替换涉
// untracked 文件」的现场恒不可用。逐段解析 diff --git 头：路径命中 keep 集
// 的段保留、其余整段丢弃（段内含 ---/+++/hunks/BINARY literal 自成一体）；
// 段间注记行（untracked 超限提示等非 diff 行，git apply 本就忽略）随裁剪
// 消失。路径解析兼容 git 引用形态——含空格/非 ASCII 的路径在头行走 C 风格
// 引号+转义（quote_c_style），unquote 后再剥 a/ b/ 前缀；rename/copy 段
// old/new 任一命中即保留。消费方：files 包替换历史还原（圈定 tracked）。
func FilterPatchToPaths(patchContent string, keep []string) string {
	if patchContent == "" || len(keep) == 0 {
		return ""
	}
	keepSet := make(map[string]bool, len(keep))
	for _, p := range keep {
		keepSet[p] = true
	}
	var b strings.Builder
	kept := false
	// segment 存当前段已积累的行（自 diff --git 头起）；段界=下一 diff --git 行
	var segment []string
	flush := func() {
		if kept {
			for _, l := range segment {
				b.WriteString(l)
				b.WriteByte('\n')
			}
		}
		segment = segment[:0]
		kept = false
	}
	for _, line := range strings.Split(patchContent, "\n") {
		if strings.HasPrefix(line, "diff --git ") {
			flush()
			segment = append(segment, line)
			kept = diffGitHeaderHits(line, keepSet)
			continue
		}
		// 尾部空行：Split 产物（补丁尾换行），不在任何段内，不入输出——
		// 末段 flush 时已按行补尾换行
		if len(segment) == 0 {
			continue
		}
		segment = append(segment, line)
	}
	flush()
	return b.String()
}

// diffGitHeaderHits 解析 diff --git 头行的两侧路径（剥 a/ b/ 前缀并解引号），
// 任一侧命中 keep 集即 true（rename/copy 段两侧不同，old 或 new 命中都算）
func diffGitHeaderHits(line string, keepSet map[string]bool) bool {
	rest := strings.TrimPrefix(line, "diff --git ")
	rest = strings.TrimRight(rest, "\r")
	tokens := splitDiffGitHeader(rest)
	for _, tok := range tokens {
		if keepSet[tok] {
			return true
		}
	}
	return len(tokens) == 0 // 头行解析失败时保守保留该段（宁多勿漏，行为同修复前）
}

// splitDiffGitHeader 把 "a/x b/x"（裸形态）或 `"a/x" "b/x"`（引用形态）拆成
// 两个剥前缀路径；解析不出两侧时返回空（调用方保守保留）
func splitDiffGitHeader(rest string) []string {
	var out []string
	for _, tok := range splitHeaderTokens(rest) {
		if len(tok) > 2 && (tok[0] == 'a' || tok[0] == 'b') && tok[1] == '/' {
			tok = tok[2:]
		}
		out = append(out, tok)
	}
	if len(out) != 2 {
		return nil
	}
	return out
}

// splitHeaderTokens 拆头行两侧 token：引用形态按配对引号切分并解 C 转义；
// 裸形态按空格切分（git 对含空格/特殊字符路径恒走引用形态，裸形态无空格）
func splitHeaderTokens(rest string) []string {
	if !strings.HasPrefix(rest, `"`) {
		return strings.Fields(rest)
	}
	var out []string
	for {
		rest = strings.TrimLeft(rest, " ")
		if !strings.HasPrefix(rest, `"`) {
			return out
		}
		tok, remaining, ok := unquoteCString(rest)
		if !ok {
			return out
		}
		out = append(out, tok)
		rest = strings.TrimLeft(remaining, " ")
		if !strings.HasPrefix(rest, `"`) || len(out) == 2 {
			return out
		}
	}
}

// unquoteCString 解 git quote_c_style 引用串（首尾引号已含在 s 中）：支持
// \" \\ \a \b \f \n \r \t \v 与 \ooo 八进制（非 UTF-8 字节按原值保留）；
// 返回 (内容, 余串, 是否合法闭合)
func unquoteCString(s string) (string, string, bool) {
	if !strings.HasPrefix(s, `"`) {
		return "", s, false
	}
	buf := make([]byte, 0, len(s))
	i := 1
	for ; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			return string(buf), s[i+1:], true
		case c != '\\':
			buf = append(buf, c)
		case i+1 >= len(s):
			return "", s, false
		default:
			i++
			e := s[i]
			switch e {
			case 'a':
				buf = append(buf, '\a')
			case 'b':
				buf = append(buf, '\b')
			case 'f':
				buf = append(buf, '\f')
			case 'n':
				buf = append(buf, '\n')
			case 'r':
				buf = append(buf, '\r')
			case 't':
				buf = append(buf, '\t')
			case 'v':
				buf = append(buf, '\v')
			case '\\', '"':
				buf = append(buf, e)
			default:
				// \ooo 八进制（1~3 位）：非 UTF-8 字节路径的原值通道
				if e < '0' || e > '7' {
					return "", s, false
				}
				v := int(e - '0')
				for k := 0; k < 2 && i+1 < len(s) && s[i+1] >= '0' && s[i+1] <= '7'; k++ {
					i++
					v = v*8 + int(s[i]-'0')
				}
				buf = append(buf, byte(v))
			}
		}
	}
	return "", s, false
}

// ListTrackedFiles 候选路径中的 tracked 子集（P-20261004-66 替换历史还原链）：
// git ls-files -z -- <paths...>，-z NUL 分隔与路径内换行/空格解耦（全平台路径
// 语义一致）。顺序不限、结果按输入去重；git 返回的相对路径与输入同口径。
// 替换历史还原用它在 checkout 前滤掉 untracked 命中文件——`git checkout --
// <untracked>` 会整体报 pathspec 错误，一个 untracked 文件不能拖死整批还原
func ListTrackedFiles(repoPath string, paths []string) ([]string, error) {
	if len(paths) == 0 {
		return nil, nil
	}
	args := append([]string{"ls-files", "-z", "--"}, paths...)
	out, err := execGit(repoPath, args...)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool, len(paths))
	out2 := make([]string, 0, len(paths))
	for _, p := range strings.Split(out, "\x00") {
		p = strings.TrimSpace(p)
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		out2 = append(out2, p)
	}
	return out2, nil
}

// DiscardWorktreeChanges 丢弃指定路径的全部未提交工作区改动（回到暂存区态；
// 只动工作区不动索引，P-20261004-66 替换历史还原链——checkout 前置：备份补丁
// 的 a 侧是暂存区内容，先归零再正向 apply 即精确重建「替换前工作区」，与
// P-114 e2e 验证过的 checkout+apply 回滚组合同一语义）。checkout 在写队列
// 白名单内（writequeue.go gitWriteQueueVerbs），与并发写族按仓库互斥
func DiscardWorktreeChanges(repoPath string, paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	args := append([]string{"checkout", "--"}, paths...)
	_, err := execGit(repoPath, args...)
	return err
}
