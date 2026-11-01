package git

import (
	"bytes"
	"codecombo/server/model"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// 合并策略白名单（P-20261007-18）：空串 = 默认合并（历史语义零变化），
// "squash" = 压平合并（git merge --squash + 单条汇总提交）。服务端与 API
// 层共用同一枚举，非法值在两层各自拒绝
const (
	MergeStrategyDefault = ""
	MergeStrategySquash  = "squash"
)

// AutoStashMessagePrefix autoStash 条目的 stash 消息前缀（P-20261006-48）：写入端
// （CheckoutWithAutoStash）与恢复提示匹配端（FindRecoverableAutoStash）的单一事实
// 源——前缀漂移会让「切回原分支」的恢复提示失联，改措辞须同步前端注记文案
const AutoStashMessagePrefix = "auto: checkout to "

// 获取所有分支
func GetBranches(repoPath string) ([]model.Branch, error) {
	output, err := execGit(repoPath, "branch", "-a", "-vv", "--no-abbrev")
	if err != nil {
		return nil, err
	}

	branches := parseBranches(output)

	// isMerged 真源（P-20261003-50）：`branch -vv` 从不输出 "(merged)" 标记——旧解析
	// 检查的 token 实际不可达，反而会把提交主题恰好含 "(merged)" 字样的分支误判为
	// 已合并。这里补一次 `branch -a --merged`（相对当前 HEAD 的祖先分支，与前端
	// 清理向导的"已合并"语义同源）标注合并态。调用面只有一个分支列表端点（面板
	// 打开/手动刷新触发，非热路径），多一次 git 子进程可接受。
	// 拿不到合并态时按未合并展示——清理向导宁漏勿误，且不阻塞分支列表本身。
	if merged, merr := mergedBranchSet(repoPath); merr == nil {
		for i := range branches {
			if merged[branches[i].Name] {
				branches[i].IsMerged = true
			}
		}
	}

	return branches, nil
}

// mergedBranchSet 返回相对当前 HEAD 已合并的分支名集合（本地原名、远程带
// "remotes/" 前缀，与 parseBranches 的 name 约定一致）。`*` 前缀是当前分支
// （HEAD 自身祖先恒真，但"已合并"对当前分支无意义——前端徽标与清理向导都
// 排除当前分支，在数据源统一裁决）；`+` 前缀是其他工作树检出的分支，保留在
// 集合内（删除时由 git 拒绝兜底）；分离头指针行（"(HEAD …)"）跳过。
func mergedBranchSet(repoPath string) (map[string]bool, error) {
	output, err := execGit(repoPath, "branch", "-a", "--merged")
	if err != nil {
		return nil, err
	}
	set := make(map[string]bool)
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "(") || strings.HasPrefix(line, "*") {
			continue
		}
		if name := strings.TrimSpace(strings.TrimLeft(line, "+")); name != "" {
			set[name] = true
		}
	}
	return set, nil
}

func parseBranches(output string) []model.Branch {
	var branches []model.Branch
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}

		isCurrent := line[0] == '*'
		line = strings.TrimSpace(line[1:])
		if line == "" {
			continue
		}

		// 识别分离头指针（detached HEAD）行：形如 "(HEAD detached at <hash>)" 或 "(no branch)"
		if isCurrent && strings.HasPrefix(line, "(") {
			detachedCommit := ""
			// 尝试从 "at <hash>)" 提取 commit hash
			if idx := strings.Index(line, " at "); idx >= 0 {
				hash := strings.TrimSpace(line[idx+4:])
				hash = strings.TrimRight(hash, ")")
				detachedCommit = hash
				if len(detachedCommit) > 7 {
					detachedCommit = detachedCommit[:7]
				}
			}
			branches = append(branches, model.Branch{
				Name:           "(HEAD)",
				IsCurrent:      true,
				IsDetached:     true,
				DetachedCommit: detachedCommit,
			})
			continue
		}

		parts := strings.Fields(line)
		if len(parts) == 0 {
			continue
		}

		name := parts[0]
		isRemote := strings.HasPrefix(name, "remotes/")
		upstream := ""
		ahead := 0
		behind := 0

		// 解析 upstream 信息: [remote/branch]
		for _, p := range parts[1:] {
			if strings.HasPrefix(p, "[") && strings.HasSuffix(p, "]") {
				upstreamInfo := p[1 : len(p)-1]
				// 格式可能为: origin/main 或 origin/main:ahead 2, behind 1
				if colonIdx := strings.Index(upstreamInfo, ":"); colonIdx >= 0 {
					upstream = upstreamInfo[:colonIdx]
					abStr := upstreamInfo[colonIdx+1:]
					// 解析 ahead N, behind M
					abParts := strings.Fields(abStr)
					for j := 0; j < len(abParts)-1; j++ {
						if abParts[j] == "ahead" {
							ahead, _ = strconv.Atoi(abParts[j+1])
						} else if abParts[j] == "behind" {
							behind, _ = strconv.Atoi(abParts[j+1])
						}
					}
				} else {
					upstream = upstreamInfo
				}
				break
			}
		}

		branches = append(branches, model.Branch{
			Name:      name,
			IsCurrent: isCurrent,
			IsRemote:  isRemote,
			// isMerged 由 GetBranches 依 mergedBranchSet 统一标注（见上）
			Upstream: upstream,
			Ahead:    ahead,
			Behind:   behind,
		})
	}

	return branches
}

// 创建分支
func CreateBranch(repoPath string, name string, checkout bool) error {
	if err := validateRef(name); err != nil {
		return err
	}
	if checkout {
		_, err := execGit(repoPath, "checkout", "-b", name)
		return err
	}
	_, err := execGit(repoPath, "branch", name)
	return err
}

// 切换分支
func Checkout(repoPath string, branch string) error {
	if err := validateRef(branch); err != nil {
		return err
	}
	_, err := execGit(repoPath, "checkout", branch)
	return err
}

// CheckoutAutoStashResult 自动暂存切换链的结构化结果（P-20261003-203）：
// 前端按 Restored/StashKept 分支出「恢复成功 / stash 保留」两种反馈
type CheckoutAutoStashResult struct {
	Stashed   bool // 本次实际新建了 stash 条目（执行时工作区已干净则 false，尾部 pop 相应跳过）
	Restored  bool // 切换后已在目标分支成功 pop（变更回来了；stash push 会并掉暂存/未暂存之分）
	StashKept bool // pop 失败（冲突等）：stash 条目按 git pop 语义自动保留，变更不丢
}

// CheckoutWithAutoStash 脏工作区切换的自动暂存恢复链：stash → checkout → stash
// pop——P-19 脏区预警确认框「自动暂存并恢复」档的服务端实现，把「先手动 stash、
// 再切换、再切回 pop」三步收成一次调用。安全第一（宁多勿丢）：
//   - stash 阶段未新建条目（预检后有竞态清空等）→ 尾部 pop 跳过，绝不误 pop
//     存量条目；
//   - checkout 失败 → 在原分支 pop 回刚建的 stash（还原现场）；还原也失败则
//     stash 保留 + 错误文案双重点名「未丢失」；
//   - checkout 成功后 pop 冲突 → git pop 自身语义即「冲突不 drop」，stash 条目
//     保留（变更安全在 stash 里，可切回原分支恢复或经 stash 面板处置）；此为
//     切换成功后的恢复受阻，返回结构化标记而非错误，由前端分支提示。
//
// stash 消息记录检出目标分支（"auto: checkout to <target>"），原分支名由 git
// 自带的 `On <branch>:` 前缀承载——两者合看即「这条 stash 属于哪个分支、为何而
// 建」的完整语义注记（切回原分支再恢复时对得上号）。含未跟踪文件入栈
// （IncludeUntracked）：脏区预检口径 = changes store 文件列表（含 Untracked），
// 不收 untracked 会让这部分改动留在工作区、可能反过来顶撞目标分支的同名文件。
//
// 已知窄窗口：三段写命令各持写队列槽位（stash push / checkout / stash pop 均
// 在 gitWriteQueueVerbs），进程外并发新建的 stash 可能恰插入 stash@{0}——后果
// 限于 pop 到他人条目（双方条目都不丢，冲突时仍保留），不做跨进程互斥。
func CheckoutWithAutoStash(repoPath string, branch string) (CheckoutAutoStashResult, error) {
	if err := validateRef(branch); err != nil {
		return CheckoutAutoStashResult{}, err
	}

	var res CheckoutAutoStashResult

	// ① 建栈前先记 refs/stash 指纹：stash push 对「无改动」是退出 0 的 no-op
	//（"No local changes to save" 文案随 git locale 变化，不可作判定依据），
	// 指纹变化 = 确实新入了条目，尾部 pop 才有明确对象
	before := stashRefFingerprint(repoPath)
	if _, err := Stash(repoPath, model.StashRequest{
		Message:          AutoStashMessagePrefix + branch,
		IncludeUntracked: true,
	}); err != nil {
		return res, fmt.Errorf("auto-stash failed (nothing switched): %v", err)
	}
	res.Stashed = stashRefFingerprint(repoPath) != before

	// ② checkout：失败则还原现场后再报错
	if err := Checkout(repoPath, branch); err != nil {
		if res.Stashed {
			if _, popErr := StashPop(repoPath, 0); popErr != nil {
				return res, fmt.Errorf("checkout failed (%v) and auto-stash restore also failed — the stash entry is kept, no changes lost: %v", err, popErr)
			}
			return res, fmt.Errorf("checkout failed (changes restored from auto-stash): %v", err)
		}
		return res, err
	}

	// ③ 恢复：冲突等失败时 git 保留 stash 条目，结构化上报（非错误）
	if res.Stashed {
		if _, err := StashPop(repoPath, 0); err != nil {
			res.StashKept = true
			return res, nil
		}
		res.Restored = true
	}
	return res, nil
}

// stashRefFingerprint 读 refs/stash 当前指向（不存在返回空串）。仅作「stash
// push 是否真正新建了条目」的前后对比用
func stashRefFingerprint(repoPath string) string {
	out, err := execGit(repoPath, "rev-parse", "--quiet", "--verify", "refs/stash")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// RecoverableAutoStash checkout 成功响应 recoverableStash 字段的载荷（P-20261006-48）：
// 切回原分支时可一键恢复的 autoStash 条目标识。Files 只是提示文案的量词（探测
// 失败按 0），不给恢复链当判定位——恢复仍按 branch+message 重定位条目
type RecoverableAutoStash struct {
	Index   int    `json:"index"`
	Branch  string `json:"branch"`
	Message string `json:"message"`
	Files   int    `json:"files"`
}

// FindRecoverableAutoStash 查找切回 branch 分支后可恢复的 autoStash 条目
// （P-20261006-48，P-203「切回原分支恢复」提示的闭环最后一环）：双注记同匹配——
// git 自带 `On <branch>:` 前缀（stash 创建时所在分支，pop 应落回的分支）须等于
// 检出目标分支，且消息带 AutoStashMessagePrefix（写入端同源常量）。只按消息前缀
// 匹配会把 A 分支的暂存提示恢复到别的分支（pop 落错分支重演冲突），分支维度
// 缺不可少。列表序即时间序（stash@{0} 最新），多条命中取最新——旧条目留在
// stash 列表人工处置（不自动清，P-203 安全第一哲学）。GetStashes 失败按无条目
// 处理：恢复提示是增量体验面，探测降级不影响切换本身
func FindRecoverableAutoStash(repoPath string, branch string) (RecoverableAutoStash, bool) {
	stashes, err := GetStashes(repoPath)
	if err != nil {
		return RecoverableAutoStash{}, false
	}
	for _, s := range stashes {
		if s.Branch == branch && strings.HasPrefix(s.Message, AutoStashMessagePrefix) {
			return RecoverableAutoStash{
				Index:   s.Index,
				Branch:  s.Branch,
				Message: s.Message,
				Files:   stashFileCount(repoPath, s.Index),
			}, true
		}
	}
	return RecoverableAutoStash{}, false
}

// stashFileCount 统计 stash 条目的变更文件数（含 untracked，与 autoStash 入栈
// 口径一致）。git < 2.32 的 stash show 不认 --include-untracked 时探测失败按
// 0——调用方只作量词展示，0 值前端有计数缺省文案兜底
func stashFileCount(repoPath string, index int) int {
	out, err := execGit(repoPath, "stash", "show", "--name-only", "--include-untracked",
		"stash@{"+strconv.Itoa(index)+"}")
	if err != nil {
		return 0
	}
	n := 0
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) != "" {
			n++
		}
	}
	return n
}

// 删除分支
func DeleteBranch(repoPath string, name string, force bool) error {
	if err := validateRef(name); err != nil {
		return err
	}
	flag := "-d"
	if force {
		flag = "-D"
	}
	_, err := execGit(repoPath, "branch", flag, name)
	return err
}

// 合并分支。strategy 为空走默认路径（历史语义原样）；MergeStrategySquash
// 压平合并：merge --squash 把合并效果落到工作区与索引但不落提交，紧接单条
// 汇总提交（message 为空时自动生成「(<source>) N commits: 首末提交标题」）。
// 其他 strategy 值拒绝（白名单枚举，调用方 API 层同样校验给 400）
func Merge(repoPath string, source string, strategy string, message string) (string, error) {
	if err := validateRef(source); err != nil {
		return "", err
	}
	switch strategy {
	case MergeStrategyDefault:
		output, err := execGit(repoPath, "merge", source)
		if err != nil {
			return output, fmt.Errorf("merge conflict or error: %s", output)
		}
		return output, nil
	case MergeStrategySquash:
		return mergeSquash(repoPath, source, message)
	default:
		return "", fmt.Errorf("invalid merge strategy %q (must be %q or empty)", strategy, MergeStrategySquash)
	}
}

// mergeSquash 压平合并双步链：merge --squash（暂存合并效果）+ 单条 commit -F。
// 两步持同一写队列槽位裸执行——拆成两次入队会在两步之间留出窗口，并发写者
// （agent 自动提交）可能把暂存的合并结果连带自己的消息提交掉；持槽期间不得
// 再经 execGit 入队（写队列是容量 1 chan 且不记属主，再入队会自等 30s 超时）
// ——InteractiveRebase 持槽跨裸 exec 同款约束。
// 冲突语义与默认合并一致：git 保留索引冲突态供既有冲突解决域处置（--squash
// 不写 MERGE_HEAD，解决后经常规提交收尾）；源分支已无领先提交时在动索引前
// 如实拒绝——--squash 对 already-up-to-date 是退出 0 的 no-op，硬走到提交步
// 只会撞 nothing to commit 把仓库留在「全量暂存」的困惑态。
// 源分支处理保持现状：不自动删除（用户既有习惯）。
func mergeSquash(repoPath string, source string, message string) (string, error) {
	out, err := execGit(repoPath, "rev-list", "--count", "HEAD.."+source)
	if err != nil {
		return "", err
	}
	count, cerr := strconv.Atoi(strings.TrimSpace(out))
	if cerr != nil || count <= 0 {
		return "", fmt.Errorf("nothing to squash merge: %s has no commits ahead of the current branch", source)
	}
	finalMsg := strings.TrimSpace(message)
	if finalMsg == "" {
		finalMsg, cerr = defaultSquashMessage(repoPath, source, count)
		if cerr != nil {
			return "", cerr
		}
	}

	// 消息经 -F 文件落地：可含换行/引号的任意消息不走 argv，规避转义与命令行
	// 长度问题（rebase 通道 writeMsgFile 同款取舍）；路径作为直接 argv 传入，
	// 不经 shell 无需引号包裹
	msgFile, err := writeSquashMsgFile(finalMsg)
	if err != nil {
		return "", err
	}
	defer os.Remove(msgFile)

	mergeArgs := []string{"merge", "--squash", source}
	release, qerr := acquireRepoWriteSlot(repoPath, mergeArgs, logGitCmd)
	if qerr != nil {
		return "", qerr
	}
	defer release()

	mergeOut, err := runGitWriteInSlot(repoPath, classifyGitTimeout(mergeArgs), mergeArgs...)
	if err != nil {
		// 冲突等失败：索引冲突态已由 git 落盘，交既有冲突解决链；输出随 409
		// 载荷回传（调用方契约与默认合并失败路径同形）
		return mergeOut, fmt.Errorf("merge conflict or error: %s", mergeOut)
	}
	commitOut, cerr := runGitWriteInSlot(repoPath, classifyGitTimeout([]string{"commit"}), "commit", "-F", msgFile)
	if cerr != nil {
		return commitOut, fmt.Errorf("squash merge staged but commit failed: %s", commitOut)
	}
	// 裸 exec 不经 execGitWithEnvLog 的统一失效钩子，成功后显式失效仓库缓存
	//（ahead 徽章与状态缓存在 3s TTL 窗口内依然即时正确）
	invalidateRepoCaches(repoPath)
	return strings.TrimSpace(mergeOut + "\n" + commitOut), nil
}

// defaultSquashMessage 默认汇总消息「(<source>) N commits: 首末提交标题」
// （单条时只列其标题）。语言中立英文，与 rebasePlanSummary 审计摘要同取向
func defaultSquashMessage(repoPath string, source string, count int) (string, error) {
	out, err := execGit(repoPath, "log", "--format=%s", "--reverse", "HEAD.."+source)
	if err != nil {
		return "", err
	}
	var subjects []string
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			subjects = append(subjects, line)
		}
	}
	switch len(subjects) {
	case 0:
		return fmt.Sprintf("(%s) %d commits", source, count), nil
	case 1:
		return fmt.Sprintf("(%s) 1 commit: %s", source, subjects[0]), nil
	default:
		return fmt.Sprintf("(%s) %d commits: %s .. %s", source, count, subjects[0], subjects[len(subjects)-1]), nil
	}
}

// writeSquashMsgFile 汇总提交消息落临时文件（git commit -F 读取），调用方负责
// 删除。内容统一补尾换行（git 对无尾换行的消息文件照单全收，但补齐与
// writeMsgFile 产物一致，提交消息尾部整洁）
func writeSquashMsgFile(content string) (string, error) {
	f, err := os.CreateTemp("", "git-merge-squash-msg-*")
	if err != nil {
		return "", fmt.Errorf("create temp file: %w", err)
	}
	if !strings.HasSuffix(content, "\n") {
		content += "\n"
	}
	if _, werr := f.WriteString(content); werr != nil {
		f.Close()
		os.Remove(f.Name())
		return "", fmt.Errorf("write message file: %w", werr)
	}
	if cerr := f.Close(); cerr != nil {
		os.Remove(f.Name())
		return "", fmt.Errorf("close message file: %w", cerr)
	}
	return f.Name(), nil
}

// runGitWriteInSlot 已持有写队列槽位时的裸 git 执行（abortRebaseInSlot 同款
// 约束：持槽期间不得再经 execGit 入队，原因见 mergeSquash 注释）。stdout 与
// stderr 合并返回——merge/commit 的过程说明（Squash commit -- not updating
// HEAD 等）多在 stderr，失败时是错误定位的唯一线索
func runGitWriteInSlot(repoPath string, timeout time.Duration, args ...string) (string, error) {
	cmd := exec.Command("git", append(gitLongPathsArgs(), args...)...)
	cmd.Dir = repoPath
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	setProcessGroup(cmd)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	err := runWithTimeout(cmd, timeout)
	return strings.TrimSpace(buf.String()), err
}

// 变基
func Rebase(repoPath string, branch string) (string, error) {
	if err := validateRef(branch); err != nil {
		return "", err
	}
	output, err := execGit(repoPath, "rebase", branch)
	if err != nil {
		return output, fmt.Errorf("rebase conflict or error: %s", output)
	}
	return output, nil
}

// 中止变基
func RebaseAbort(repoPath string) error {
	_, err := execGit(repoPath, "rebase", "--abort")
	return err
}

// 继续变基
func RebaseContinue(repoPath string) error {
	_, err := execGit(repoPath, "rebase", "--continue")
	return err
}

// 获取分支的ahead/behind信息
func GetBranchTracking(repoPath string, branch string) (ahead, behind int, err error) {
	output, err := execGit(repoPath, "rev-list", "--left-right", "--count", branch+"..."+branch+"@{upstream}")
	if err != nil {
		return 0, 0, nil // 没有upstream不算错误
	}

	parts := strings.Fields(strings.TrimSpace(output))
	if len(parts) >= 2 {
		ahead, _ = strconv.Atoi(parts[0])
		behind, _ = strconv.Atoi(parts[1])
	}

	return ahead, behind, nil
}

// SetBranchUpstream 设置本地分支跟踪远程分支
func SetBranchUpstream(repoPath string, branch string, remote string, remoteBranch string) error {
	if err := validateRef(branch, remoteBranch); err != nil {
		return err
	}
	upstream := remote + "/" + remoteBranch
	_, err := execGit(repoPath, "branch", "--set-upstream-to="+upstream, branch)
	return err
}

// RenameBranch 重命名分支
func RenameBranch(repoPath string, oldName string, newName string) error {
	if err := validateRef(oldName, newName); err != nil {
		return err
	}
	_, err := execGit(repoPath, "branch", "-m", oldName, newName)
	return err
}

// CheckoutAndUpdate 切换分支并自动拉取远程变更
func CheckoutAndUpdate(repoPath string, branch string) error {
	if err := validateRef(branch); err != nil {
		return err
	}
	_, err := execGit(repoPath, "checkout", branch)
	if err != nil {
		return err
	}
	// 尝试 pull，忽略错误（可能没有远程分支）
	_, _ = execGit(repoPath, "pull")
	return nil
}

// GetRepoHeadTracking 单进程批量取当前分支及其 ahead/behind（C5 扇出优化）：
// 一次 `for-each-ref` 同时返回 HEAD 标记与全部分支的 upstream track 信息，
// 替代「分支查询 + rev-list --left-right」的两到三个子进程——首页/多项目
// 总览对 N 个仓库扇出时，子进程数从 ~3N 降到 N。
// 无 upstream 或 upstream 已消失（[gone]）按 0/0 处理（与 GetBranchTracking 语义一致）
func GetRepoHeadTracking(repoPath string) (branch string, ahead, behind int, err error) {
	output, err := execGit(repoPath,
		"for-each-ref",
		"--format=%(HEAD)%00%(refname:short)%00%(upstream:track)",
		"refs/heads",
	)
	if err != nil {
		return "", 0, 0, err
	}
	for _, line := range strings.Split(strings.TrimSpace(output), "\n") {
		parts := strings.SplitN(line, "\x00", 3)
		if len(parts) < 3 {
			continue
		}
		if parts[0] != "*" {
			continue // 仅 HEAD 指向的分支
		}
		branch = parts[1]
		track := parts[2]
		// track 形如 "[ahead 1, behind 2]" / "[ahead 3]" / "[gone]" / ""
		firstNum := func(s string) int {
			// 取 s 开头的数字（剔除 "]"、"," 等尾随字符）
			for end := 0; end < len(s); end++ {
				if s[end] < '0' || s[end] > '9' {
					n, e := strconv.Atoi(s[:end])
					if e == nil {
						return n
					}
					return 0
				}
			}
			return 0
		}
		if i := strings.Index(track, "ahead "); i >= 0 {
			ahead = firstNum(track[i+len("ahead "):])
		}
		if i := strings.Index(track, "behind "); i >= 0 {
			behind = firstNum(track[i+len("behind "):])
		}
		break
	}
	return branch, ahead, behind, nil
}

// RevParseHead 返回仓库当前 HEAD 提交哈希（非 git 目录/无提交返回错误）。
// 导出供终端恢复流程补记会话基线等跨包场景使用
func RevParseHead(repoPath string) (string, error) {
	out, err := execGit(repoPath, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(out), nil
}
