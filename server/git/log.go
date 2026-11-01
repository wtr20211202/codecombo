package git

import (
	"codecombo/server/filepolicy"
	"codecombo/server/model"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// logFieldSep 字段分隔符：使用 US（Unit Separator, \x1f）避免与 message 中的 | 冲突
// logCommitSep 提交分隔符：使用 NUL（\x00）配合 -z 选项，%B 内的换行不会破坏提交分割
const (
	logFieldSep  = "\x1f"
	logCommitSep = "\x00"
)

// logFormat git log 输出格式：%B 返回完整 message（含多行 body），后续可拆分为 subject / body
const logFormat = "%H%x1f%h%x1f%B%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%G?"

// IsNoCommitsError 判断 git log 失败是否因「仓库尚无任何提交」（git init 后
// 零提交的未出生分支）。git log 对该状态以 fatal 128 退出而非输出空结果，
// 历史上各 log 查询裸传该错误导致前端提交面板首开即红色报错——空仓是正常
// 状态而非故障，调用方（gitops handler）应返回空列表并带 emptyRepo 标志。
// 识别策略：stderr 特征匹配为主（git fatal 文案默认不本地化）——
//   - "does not have any commits yet"：未出生分支的 log/--follow/-- <path> 形态，
//     只在零提交仓库出现，命中即可定案；
//   - "ambiguous argument"：显式传 ref（分支名等）时空仓报的是这个，但该文案
//     在非空仓库传错 ref 时同样出现，须以 rev-parse --verify HEAD 失败确认
//     HEAD 确实不存在才判定（探测语义，不广播前端命令台）。
//
// 两条特征都不命中时保守返回 false（本地化 git 环境的已知边界：维持原报错）。
func IsNoCommitsError(repoPath string, err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	if strings.Contains(msg, "does not have any commits yet") {
		return true
	}
	if strings.Contains(msg, "ambiguous argument") {
		if _, verr := execGitProbe(repoPath, "rev-parse", "--verify", "HEAD"); verr != nil {
			return true
		}
	}
	return false
}

// 获取提交日志。author/since/until 为可选过滤：--author 精确/正则匹配作者，
// since/until 接受 git 日期格式（前端传 YYYY-MM-DD）
func GetLog(repoPath string, branch string, limit, skip int, author, since, until string) ([]model.Commit, error) {
	args := []string{"log", "-z", "--format=" + logFormat}
	if limit > 0 {
		args = append(args, "-n", fmt.Sprintf("%d", limit))
	}
	if skip > 0 {
		args = append(args, "--skip", fmt.Sprintf("%d", skip))
	}
	if author != "" {
		args = append(args, "--author="+author)
	}
	if since != "" {
		args = append(args, "--since="+since)
	}
	if until != "" {
		args = append(args, "--until="+until)
	}
	if branch != "" {
		args = append(args, branch)
	}

	output, err := execGit(repoPath, args...)
	if err != nil {
		return nil, err
	}

	// 提交信息/作者名可能是非 UTF-8（GBK 提交历史常见）：展示前逐行解码。
	// log -z 以 NUL/US 分隔，GBK 字节不含这两个控制符，逐行解码语义安全
	return parseLog(filepolicy.DecodeDisplay(output)), nil
}

// aheadLogDefaultLimit 推送前 ahead 预览的默认条数：预览只求「这波要推什么」
// 的体感，20 条封顶后由前端补剩余计数（真实 ahead 总数走 aheadBehind 徽标数据）
const aheadLogDefaultLimit = 20

// GetAheadLog 取当前分支领先其 upstream 的提交清单（推送前预览，P-20261003-151）：
// `git log @{upstream}..HEAD`，最新在前。
// noUpstream=true 表示上游基线不可解析——分支未 tracking / 上游跟踪指向已消失的
// 远端分支 / 未出生 HEAD（零提交仓库），属「无可预览基线」的正常状态而非故障，
// 调用方（gitops handler）返回空列表 + noUpstream 标志，前端跳过清单预览只留
// 注记；识别策略与 IsNoCommitsError 同款（git fatal 文案默认不本地化）。
// 范围恒以 HEAD 为右端：预览的语义主体是「当前分支要推什么」，不接受 branch
// 参数（要看任意区间的历史走通用 GetLog）。
func GetAheadLog(repoPath string, limit int) ([]model.Commit, bool, error) {
	if limit <= 0 {
		limit = aheadLogDefaultLimit
	}
	// 走探测语义（失败不广播前端命令台）：弹窗每次打开都拉预览，未 tracking
	// 分支的「no upstream」是预期态而非命令故障，不该点亮红标
	output, err := execGitProbe(repoPath, "log", "-z", "--format="+logFormat, "-n", strconv.Itoa(limit), "@{upstream}..HEAD")
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "no upstream configured for branch") ||
			strings.Contains(msg, "unknown revision or path not in the working tree") {
			return []model.Commit{}, true, nil
		}
		return nil, false, err
	}
	commits := parseLog(filepolicy.DecodeDisplay(output))
	if commits == nil {
		commits = []model.Commit{}
	}
	return commits, false, nil
}

// compareLogDefaultLimit 分支比较区间提交清单的默认条数：弹层区间列表求
// 「两侧差异全貌」的体感，超限由前端补截断注记
const compareLogDefaultLimit = 100

// GetCompareLog 取分支比较区间的提交清单（P-20261003-233 比较弹层「仅独有提交」
// 过滤）：from=基线（弹层合入目标侧，当前分支/HEAD），to=参照（分支/Tag/hash），
// 最新在前。
//   - uniqueOnly=true → `from..to` 单向：仅 to 独有的提交（待合入内容审阅聚焦）
//   - uniqueOnly=false → `from...to` 对称差：两侧独有提交全量（双向混列）
//
// noBase=true 表示基线缺失——from 不可解析（分支被删/写错等），任何区间语义都
// 不成立，降级返回 to 的全量历史，调用方（gitops handler）附 noBase 标志由前端
// 注记「基线缺失，已显示全量」；识别走 rev-parse --verify 探测（execGitProbe
// 探测语义不广播命令台，与 GetAheadLog 同哲学）。to 不可解析是硬错误（对比本身
// 已不可能），原样返回由前端就地提示。
func GetCompareLog(repoPath, from, to string, uniqueOnly bool, limit int) ([]model.Commit, bool, error) {
	if from == "" {
		from = "HEAD" // 弹层基线缺省即当前分支（前端拿不到分支名时退回 HEAD，同语义）
	}
	if limit <= 0 {
		limit = compareLogDefaultLimit
	}
	revset := from + "..." + to
	if uniqueOnly {
		revset = from + ".." + to
	}
	output, err := execGitProbe(repoPath, "log", "-z", "--format="+logFormat, "-n", strconv.Itoa(limit), revset)
	if err != nil {
		if _, verr := execGitProbe(repoPath, "rev-parse", "--verify", "--quiet", from); verr != nil {
			degraded, derr := execGitProbe(repoPath, "log", "-z", "--format="+logFormat, "-n", strconv.Itoa(limit), to)
			if derr != nil {
				return nil, false, derr
			}
			return parseLog(filepolicy.DecodeDisplay(degraded)), true, nil
		}
		return nil, false, err
	}
	commits := parseLog(filepolicy.DecodeDisplay(output))
	if commits == nil {
		commits = []model.Commit{}
	}
	return commits, false, nil
}

func parseLog(output string) []model.Commit {
	var commits []model.Commit
	// -z 模式下提交以 NUL 分隔，%B 内的换行不影响整体分割
	records := strings.Split(strings.TrimRight(output, logCommitSep), logCommitSep)

	for _, record := range records {
		if record == "" {
			continue
		}
		commit := parseCommitLine(record)
		if commit.Hash != "" {
			commits = append(commits, commit)
		}
	}

	return commits
}

func parseCommitLine(line string) model.Commit {
	// 格式: %H\x1f%h\x1f%B\x1f%an\x1f%ae\x1f%at\x1f%P\x1f%D\x1f%G?
	// 第二个字段是完整 message（%B），可能含换行
	parts := strings.SplitN(line, logFieldSep, 9)
	if len(parts) < 7 {
		return model.Commit{}
	}

	parents := make([]string, 0)
	for _, p := range strings.Fields(parts[6]) {
		if p != "" {
			parents = append(parents, p)
		}
	}

	refs := make([]string, 0)
	if len(parts) > 7 && parts[7] != "" {
		refStr := parts[7]
		for _, ref := range strings.Split(refStr, ",") {
			ref = strings.TrimSpace(ref)
			ref = strings.TrimPrefix(ref, "HEAD -> ")
			ref = strings.TrimPrefix(ref, "tag: ")
			if ref != "" {
				refs = append(refs, ref)
			}
		}
	}

	gpgStatus := ""
	if len(parts) > 8 {
		gpgStatus = strings.TrimSpace(parts[8])
	}

	timestamp, _ := strconv.ParseInt(parts[5], 10, 64)

	// message 拆分为 subject（首行）和完整 body
	fullMessage := strings.TrimRight(parts[2], "\n")
	subject := fullMessage
	if idx := strings.IndexByte(fullMessage, '\n'); idx >= 0 {
		subject = fullMessage[:idx]
	}

	return model.Commit{
		Hash:      parts[0],
		ShortHash: parts[1],
		Message:   subject,
		Body:      fullMessage,
		Author:    parts[3],
		Email:     parts[4],
		Date:      time.Unix(timestamp, 0),
		Parents:   parents,
		Refs:      refs,
		GpgStatus: gpgStatus,
	}
}

// hashScanLimit hash 模糊搜索的扫描上限：按 id 子串过滤无 git 原生支持，
// 全量 walk 在万级提交仓库上必须设界（约 MB 级输出，与 MaxDiffOutput 同量级）
const hashScanLimit = 5000

// 搜索提交：消息内容 + 提交 id 模糊匹配（均大小写不敏感）。
//   - 内容：--grep --fixed-strings -i（字面子串命中主题与正文，正则元字符按
//     字面处理——「模糊搜索」语义下 fix(web) 应匹配括号本身）
//   - id：git 无原生 hash 子串过滤，查询串形似 hash 片段（7-40 位纯十六进制，
//     GitHub 约定下限；4-6 位会误伤 beef/dead/2024 等常见词）时触发有界全量
//     扫描合并——扫描走 execGitProbe（失败不广播：探测性质，内容结果照常返回），
//     合并后按 author date 重排（GetLog 依赖 git log 的 commit-time 序，
//     rebase/amend 场景两序有偏差，属已知限制）
func SearchLog(repoPath string, query string, limit int) ([]model.Commit, error) {
	if limit <= 0 {
		limit = 200
	}
	args := []string{"log", "-z", "--format=" + logFormat, "--all", "-i", "--fixed-strings", "--grep", query, "-n", fmt.Sprintf("%d", limit)}

	output, err := execGit(repoPath, args...)
	if err != nil {
		return nil, err
	}
	commits := parseLog(filepolicy.DecodeDisplay(output))

	if !isHexQuery(query) {
		return commits, nil
	}
	seen := make(map[string]struct{}, len(commits))
	for _, c := range commits {
		seen[strings.ToLower(c.Hash)] = struct{}{}
	}
	// 扫描侧独立收集（上限只约束扫描侧）：内容命中饱和时 hash 命中仍参与
	// 合并竞争，而非扫描后整体丢弃
	scan, err := execGitProbe(repoPath, "log", "-z", "--format="+logFormat, "--all", "-n", fmt.Sprintf("%d", hashScanLimit))
	if err != nil {
		return commits, nil
	}
	lq := strings.ToLower(query)
	var extra []model.Commit
	for _, c := range parseLog(scan) {
		if _, dup := seen[strings.ToLower(c.Hash)]; dup {
			continue
		}
		if strings.Contains(strings.ToLower(c.Hash), lq) {
			extra = append(extra, c)
		}
	}
	if len(extra) == 0 {
		return commits, nil
	}
	commits = append(commits, extra...)
	sortCommitsByDateDesc(commits)
	if len(commits) > limit {
		commits = commits[:limit]
	}
	return commits, nil
}

// isHexQuery 查询串是否可能是 hash 片段：7-40 位纯十六进制（7 为 GitHub 的
// 缩写 hash 惯用下限，也更短会误伤 beef/dead/added/2024 等纯 hex 字符的
// 常见词；40 为完整 hash）
func isHexQuery(q string) bool {
	if len(q) < 7 || len(q) > 40 {
		return false
	}
	for _, r := range strings.ToLower(q) {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

// sortCommitsByDateDesc 合并 grep 与 hash 扫描两路结果后恢复时间线序
func sortCommitsByDateDesc(commits []model.Commit) {
	sort.SliceStable(commits, func(i, j int) bool { return commits[i].Date.After(commits[j].Date) })
}

// mergeDiffBase 返回提交 diff 的对比基准：merge 提交返回第一父提交（commit^1），
// 其余返回原值。diff-tree/show 对 merge 默认输出组合差异（干净合并为空），
// 提交面板会显示「零变更文件」——并行分支合并进仓库后首次暴露。业界惯例是
// 与第一父对比（GitHub/GitLab 的 merge diff 语义）。rev-list 失败（浅克隆等）
// 退回原值：宁可空 diff 不阻塞面板
func mergeDiffBase(repoPath, commit string) string {
	parents, err := execGit(repoPath, "rev-list", "--parents", "-n", "1", commit)
	if err != nil || len(strings.Fields(parents)) < 3 {
		return commit
	}
	return commit + "^1"
}

// 获取提交详情（变更文件列表）。merge 提交与第一父对比（mergeDiffBase）
func GetCommitFiles(repoPath string, commit string) ([]model.FileDiff, error) {
	args := []string{"diff-tree", "--root", "--no-commit-id", "--name-status", "-r"}
	if base := mergeDiffBase(repoPath, commit); base != commit {
		args = append(args, base)
	}
	args = append(args, commit)
	output, err := execGit(repoPath, args...)
	if err != nil {
		return nil, err
	}
	return parseDiffStat(output), nil
}

// GetCommitPatch 获取单个提交的完整补丁（含统计概览），供 AI 提交解释等场景使用。
// merge 提交与第一父对比（show 对干净合并输出空组合差异，AI 无从解释）。
// 输出上限 2MB：巨型提交（如 vendor 全量导入）的补丁全量缓冲没有消费方受益，
// 超限截断并附标记
func GetCommitPatch(repoPath string, commit string) (string, error) {
	var output string
	var err error
	if base := mergeDiffBase(repoPath, commit); base != commit {
		output, err = execGit(repoPath, "--no-pager", "diff", "--stat", "--patch", "--find-renames", base, commit)
	} else {
		output, err = execGit(repoPath, "--no-pager", "show", "--stat", "--patch", "--find-renames", commit)
	}
	if err != nil {
		return "", err
	}
	const maxPatch = 2 * 1024 * 1024
	if len(output) > maxPatch {
		output = output[:maxPatch] + "\n...[patch truncated]"
	}
	return output, nil
}

// 获取指定文件的提交历史（limit <= 0 时默认 500：--follow 无界历史在
// 万级提交文件上会全量解析进内存）
func GetFileLog(repoPath string, file string, limit int) ([]model.Commit, error) {
	if limit <= 0 {
		limit = 500
	}
	args := []string{"log", "-z", "--format=" + logFormat, "--follow", "-n", fmt.Sprintf("%d", limit), "--", file}
	output, err := execGit(repoPath, args...)
	if err != nil {
		return nil, err
	}
	return parseLog(filepolicy.DecodeDisplay(output)), nil
}

// GetRecentMessages 获取最近N条提交消息
func GetRecentMessages(repoPath string, limit int) ([]string, error) {
	args := []string{"log", "--format=%s"}
	if limit > 0 {
		args = append(args, "-n", fmt.Sprintf("%d", limit))
	}
	output, err := execGit(repoPath, args...)
	if err != nil {
		return nil, err
	}
	output = filepolicy.DecodeDisplay(output)

	var messages []string
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line != "" {
			messages = append(messages, line)
		}
	}
	return messages, nil
}
