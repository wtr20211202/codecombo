package git

import (
	"codecombo/server/errmarkers"
	"codecombo/server/model"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Stash 创建范围三态值（model.StashRequest.Scope；前端 domains/git.ts StashScope
// 同源镜像，改值须两侧同步）
const (
	StashScopeAll      = "all"
	StashScopeStaged   = "staged"
	StashScopeUnstaged = "unstaged"
)

// ErrStashStagedUnsupported：scope=staged 但本机 git 不支持 --staged（< 2.35）的
// 降级拒绝。原文是对外契约——前端 KNOWN_ERROR_I18N 按此映射双语提示，改措辞须
// 两侧同步。文本唯一事实源在 errmarkers 注册表（P-20261004-29）
var ErrStashStagedUnsupported = errors.New(errmarkers.StashStagedUnsupported)

// ErrStashEntryGone：按 stable hash 操作 stash 但该条目已不在当前 refs/stash
// 栈（已被 drop/pop 或仓库切走）的明确拒绝（P-20261003-264）。原文是对外契约
// （errmarkers 注册表），前端映射为「条目已不存在，刷新列表」——绝不允许退化为
// 按 hash 直接 apply（悬空 commit 对象仍在对象库，git 会照常套用）或按旧 index
// 落到相邻条目（多标签页错位根因）
var ErrStashEntryGone = errors.New(errmarkers.StashEntryGone)

var (
	stashStagedOnce   sync.Once
	stashStagedCached bool
	// stashStagedSupportedFn 注入缝：单测可在不装旧版 git 的机器上验证降级拒绝路径
	stashStagedSupportedFn = SupportsStashStaged
)

// SupportsStashStaged 报告本机 git 是否支持 `git stash push --staged`（2.35+，
// 2022-01 引入）。进程级缓存一次：git 版本在服务运行期内视为不变（升级 git 需
// 重启服务，与工具链探测同款边界）；探测失败按不支持处理——安全降级只禁用一个
// 增强选项，不影响全量 stash 现状
func SupportsStashStaged() bool {
	stashStagedOnce.Do(func() {
		out, err := GitVersionOutput()
		stashStagedCached = err == nil && gitVersionAtLeast(out, 2, 35)
	})
	return stashStagedCached
}

// gitVersionAtLeast 从 `git --version` 输出解析版本并判断 >= major.minor。
// 兼容真实世界变体："git version 2.45.1.windows.1" / "git version 2.39.5
// (Apple Git-143)"；解析失败（异常输出/git 变体）一律 false——降级禁用优于误启用
func gitVersionAtLeast(output string, major, minor int) bool {
	fields := strings.Fields(strings.TrimSpace(output))
	for i, f := range fields {
		if f != "version" || i+1 >= len(fields) {
			continue
		}
		ver := fields[i+1]
		dot := strings.IndexByte(ver, '.')
		if dot <= 0 {
			return false
		}
		gotMajor, err := strconv.Atoi(ver[:dot])
		if err != nil {
			return false
		}
		rest := ver[dot+1:]
		dot2 := strings.IndexByte(rest, '.')
		gotMinorStr := rest
		if dot2 >= 0 {
			gotMinorStr = rest[:dot2]
		}
		gotMinor, err := strconv.Atoi(gotMinorStr)
		if err != nil {
			return false
		}
		return gotMajor > major || (gotMajor == major && gotMinor >= minor)
	}
	return false
}

// 获取Stash列表
//
// 输出格式用 `--format=%H %gd %gs` 自取结构化三段（P-20261003-264）：第一段是
// stash 提交完整 OID（稳定引用），第二段是 stash@{N} reflog 选择器（列表 index），
// 第三段是 reflog subject（On <branch>: message / WIP on <branch>: ...）。单次
// git 调用同时拿到 hash 与既有解析所需的其余字段，避免「list 一次 + rev-parse
// 每条」的 N+1 或两次 list 之间的栈位漂移窗口
func GetStashes(repoPath string) ([]model.StashEntry, error) {
	output, err := execGit(repoPath, "stash", "list", "--format=%H %gd %gs")
	if err != nil {
		return nil, err
	}

	stashes := parseStashList(output)
	// 无 stash 时跳过 reflog 查询：refs/stash 不存在会导致 git reflog stash 报错，
	// 该错误是预期行为，不应作为失败广播到命令标签
	if len(stashes) == 0 {
		return stashes, nil
	}

	// 通过 reflog 获取每个 stash 的时间戳
	dates, dateErr := getStashDates(repoPath)
	if dateErr == nil {
		for i := range stashes {
			if t, ok := dates[stashes[i].Index]; ok {
				stashes[i].Date = t
			}
		}
	}

	return stashes, nil
}

// getStashDates 通过 reflog 获取 stash 条目的时间戳
func getStashDates(repoPath string) (map[int]time.Time, error) {
	output, err := execGit(repoPath, "reflog", "stash", "--format=%gD %ct")
	if err != nil {
		return nil, err
	}

	dates := make(map[int]time.Time)
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		// 格式: stash@{0} 1234567890
		parts := strings.SplitN(line, " ", 2)
		if len(parts) < 2 {
			continue
		}

		indexStr := strings.TrimPrefix(parts[0], "stash@{")
		indexStr = strings.TrimSuffix(indexStr, "}")
		index, err := strconv.Atoi(indexStr)
		if err != nil {
			continue
		}

		timestamp, err := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		if err != nil {
			continue
		}

		dates[index] = time.Unix(timestamp, 0)
	}

	return dates, nil
}

// stashBranchFromReflog 从 stash list 行的 reflog 段提取条目创建时所在分支：
// git 只产两种形态——自定义消息 "On <branch>"、缺省消息 "WIP on <branch>"（分支
// 名不含空格，段内无歧义）。其余形态（stash store 手工入栈等）返回空串：匹配端
// 按「分支为空不命中」处理，宁可少提示不误提示
func stashBranchFromReflog(reflog string) string {
	switch {
	case strings.HasPrefix(reflog, "On "):
		return strings.TrimPrefix(reflog, "On ")
	case strings.HasPrefix(reflog, "WIP on "):
		return strings.TrimPrefix(reflog, "WIP on ")
	default:
		return ""
	}
}

// parseStashList 解析 `git stash list --format=%H %gd %gs` 的结构化输出：
// 每行 `<完整 hash> stash@{N} <reflog subject>`。index 取 %gd 段、branch/message
// 取 subject 段（与默认 `stash@{N}: On <branch>: msg` 的旧解析语义一致：
// subject 首个 ": " 前是 reflog 段、其后是消息；非标形态分支留空）。
// hash 恒下发（P-20261003-264），供前端 hash 稳定引用；格式解析失败的行跳过
// （手工构造的异常 reflog 不阻断整表）
func parseStashList(output string) []model.StashEntry {
	var stashes []model.StashEntry
	lines := strings.Split(output, "\n")

	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		// 格式: <hash> stash@{0} On main: message
		fields := strings.SplitN(line, " ", 3)
		if len(fields) < 2 {
			continue
		}

		indexStr := strings.TrimPrefix(fields[1], "stash@{")
		indexStr = strings.TrimSuffix(indexStr, "}")
		index, err := strconv.Atoi(indexStr)
		if err != nil {
			continue
		}

		message := ""
		// 创建时所在分支（P-20261006-48）：仅标准形态可提取（subject 首段即
		// reflog 段）；非标形态（无 ": " 分隔）message 取整段，分支留空不参与匹配
		branch := ""
		if len(fields) >= 3 {
			subject := fields[2]
			if sep := strings.Index(subject, ": "); sep >= 0 {
				branch = stashBranchFromReflog(subject[:sep])
				message = subject[sep+2:]
			} else {
				message = subject
			}
		}

		stashes = append(stashes, model.StashEntry{
			Index:   index,
			Hash:    fields[0],
			Message: message,
			Branch:  branch,
		})
	}

	return stashes
}

// ResolveStashIndex 把 stash 稳定引用解析为当前栈位（P-20261003-264）。
//
// hash 为空 → 原样返回 index（index 入口渐进兼容：旧前端/旧 API 调用方零改动）；
// hash 非空 → 必须以完整 stash commit OID 命中当前 refs/stash 栈，命中返回其
// **当前** index，未命中返回 ErrStashEntryGone。解析后紧接执行 `stash@{N}` 命令：
// git 的 drop/pop 只接受 stash reflog 引用（裸 hash 会报 "is not a stash
// reference"），apply/show 虽接受裸 hash，但 drop 后的悬空 commit 仍可被 apply
// ——因此 hash 必须先过栈位成员校验，旧 hash 才不会被「静默套用」绕过语义。
//
// 竞态窗口：hash→index 解析与随后的 git 命令是同请求内的紧邻两步，窗口远小于
// 前端「列表刷新 → 用户点击」的跨请求 index 漂移（多标签页场景的本提案动机）
func ResolveStashIndex(repoPath string, index int, hash string) (int, error) {
	if hash == "" {
		return index, nil
	}
	output, err := execGit(repoPath, "stash", "list", "--format=%H")
	if err != nil {
		return 0, err
	}
	for i, line := range strings.Split(output, "\n") {
		if strings.EqualFold(strings.TrimSpace(line), hash) {
			return i, nil
		}
	}
	return 0, ErrStashEntryGone
}

// Stash 创建Stash。req.Scope 三态（P-20261003-119 选择性 stash）：
//   - "" / StashScopeAll：全量（现状语义，includeUntracked 仍生效）
//   - StashScopeStaged：仅已暂存 —— `git stash push --staged`（git 2.35+ 引入；
//     版本不足经 SupportsStashStaged 降级拒绝，ErrStashStagedUnsupported 原文为
//     前端 KNOWN_ERROR_I18N 映射契约）
//   - StashScopeUnstaged：仅未暂存 —— `git stash push --keep-index`（git 既有
//     语义：stash 收下全部已跟踪变更、工作区/索引保留已暂存部分，故后续 pop
//     会把已暂存部分以未暂存形态带回——范围 stash 的时间舱注记）
//
// scope=staged/unstaged 时不透传 includeUntracked：untracked 没有「暂存」概念，
// 混入会让「仅未暂存」把未跟踪文件一并收走、超出范围选择语义。
func Stash(repoPath string, req model.StashRequest) (string, error) {
	args := []string{"stash"}
	switch req.Scope {
	case "", StashScopeAll:
		if req.IncludeUntracked {
			args = append(args, "-u")
		}
	case StashScopeStaged:
		// push 子命令显式落形态：--staged 是 push 的 flag，裸 `git stash --staged`
		// 语义相同，但显式 push 让命令台/写队列甄别日志都读得懂
		if !stashStagedSupportedFn() {
			return "", ErrStashStagedUnsupported
		}
		args = append(args, "push", "--staged")
	case StashScopeUnstaged:
		args = append(args, "push", "--keep-index")
	default:
		return "", fmt.Errorf("invalid stash scope: %q", req.Scope)
	}
	if req.Message != "" {
		args = append(args, "-m", req.Message)
	}

	output, err := execGit(repoPath, args...)
	if err != nil {
		return "", err
	}
	return output, nil
}

// 应用Stash（Pop）
//
// index 为 -1 时省略 stash 选择器（git 语义 = 最新条目）；API 层在 hash 引用
// 非空时先经 ResolveStashIndex 解析为当前栈位再调用本函数（P-20261003-264）
func StashPop(repoPath string, index int) (string, error) {
	args := []string{"stash", "pop"}
	if index >= 0 {
		args = append(args, "stash@{"+strconv.Itoa(index)+"}")
	}
	output, err := execGit(repoPath, args...)
	if err != nil {
		return output, err
	}
	return output, nil
}

// 应用Stash（保留）。hash 引用解析同 StashPop（API 层先 ResolveStashIndex）
func StashApply(repoPath string, index int) (string, error) {
	args := []string{"stash", "apply"}
	if index >= 0 {
		args = append(args, "stash@{"+strconv.Itoa(index)+"}")
	}
	output, err := execGit(repoPath, args...)
	if err != nil {
		return output, err
	}
	return output, nil
}

// 删除Stash。hash 引用解析同 StashPop（API 层先 ResolveStashIndex；已 drop
// 的旧 hash 在解析层明确拒绝，不会落到相邻栈位）
func StashDrop(repoPath string, index int) error {
	args := []string{"stash", "drop"}
	if index >= 0 {
		args = append(args, "stash@{"+strconv.Itoa(index)+"}")
	}
	_, err := execGit(repoPath, args...)
	return err
}

// ShelvePartial 搁置部分文件（类似 IDEA Shelve）：把指定文件的未提交变更整体
// 存入一条 stash 条目（消息带 `shelve: ` 标识，P-203 autoStash 前缀惯例），工作
// 区随即干净——「切走修紧急 bug，回来从 stash 面板恢复接着提交」的原语；恢复
// 走既有 stash pop 通道（changelist UI 与手册统一注记该双入口分工）。
//
// 实现走 pathspec 限定 `git stash push -u`（2.13+）：文件级分组语义——组内文件
// 的已暂存+未暂存+untracked 变更全部入栈、其余变更（含用户手动 staged 的无关
// 文件）一概不碰。原实现 stage → `git stash --cached` 两段式已废弃：--cached
// 不是 stash 的合法选项（git 2.35+ 的等价物叫 --staged，原端点对非空 files 实
// 际必失败），且「stash 只取已暂存」会让搁置前用户已有的无关 staged 文件误入
// 搁置条目——pathspec 形态把这两个问题一并消除，也不需要 2.35 能力位。
//
// 返回 created：组内文件当前无变更时 git 是退出 0 的 no-op（"No local changes
// to save" 文案随 locale 漂移不可作判定），按 refs/stash 指纹前后对比（P-203
// autoStash 同款）如实回告调用方，由其决定用户反馈。
func ShelvePartial(repoPath string, files []string, message string) (bool, error) {
	if len(files) == 0 {
		return false, nil
	}

	// shelve 标识恒在（stash 面板按此前缀渲染「搁置」徽标）；空消息落文件数兜底
	if message == "" {
		message = fmt.Sprintf("%d file(s)", len(files))
	}
	args := []string{"stash", "push", "-u", "-m", "shelve: " + message, "--"}
	args = append(args, files...)

	before := stashRefFingerprint(repoPath)
	if _, err := execGit(repoPath, args...); err != nil {
		return false, err
	}
	return stashRefFingerprint(repoPath) != before, nil
}

// StashBranch 从 stash 创建分支并检出（P-20261003-263 stash 实验性应用：
// 「先开个分支试试这个 stash」）。`git stash branch` 本身就是任务书所说的
// checkout -b + apply 原子链——新分支基于该 stash 的原创建点提交，git 保证
// stash 在原基线上干净套用；成功后 stash 条目按 git 语义移除（内容已在新
// 分支工作区，原分支不被污染）。相较自行拼两段命令，单命令免掉「checkout
// 成功而 apply 失败」的中间态（用户被搁在空新分支上自行收拾）。
// 分支名冲突先经 branchRefExists 预检拒绝（稳定原文供前端 KNOWN_ERROR_I18N
// 映射）；预检与执行间的竞态由 git 自身 "a branch named ... already exists"
// 兜底——同一正则族映射，最终裁决方是 git。写队列域：stash 非 list/show
// 形态即写（writequeue isStashReadForm），本命令天然入队。
// hash 引用解析同 StashPop（API 层先 ResolveStashIndex）：git stash branch 的
// 裸 hash 形态虽能 apply，但不会按 reflog 语义移除条目——先解析为 stash@{N}
// 才能保持「成功后条目移除」的原子链语义（P-20261003-264）
func StashBranch(repoPath string, branch string, index int) (string, error) {
	if err := validateRef(branch); err != nil {
		return "", err
	}
	if branchRefExists(repoPath, branch) {
		return "", fmt.Errorf(errmarkers.BranchExistsTemplate, branch)
	}
	args := []string{"stash", "branch", branch}
	if index >= 0 {
		args = append(args, "stash@{"+strconv.Itoa(index)+"}")
	}
	output, err := execGit(repoPath, args...)
	if err != nil {
		return "", err
	}
	return output, nil
}

// branchRefExists 报告本地分支引用是否已存在（rev-parse --quiet --verify，
// stashRefFingerprint 同款只读探测形态）。探测失败按不存在处理——继续执行
// 让 git 自身在执行期拒绝，不会因探测路径误放行造成覆盖（git 对已存在分支
// 的 checkout -b 是拒绝而非复用）
func branchRefExists(repoPath, branch string) bool {
	_, err := execGit(repoPath, "rev-parse", "--quiet", "--verify", "refs/heads/"+branch)
	return err == nil
}

// StashShow 查看 stash 内容（unified diff，含 untracked 文件，输出走既有 diff
// 截文约定 truncateDiff 防超大 stash 冲垮内存/前端）。
//
// index 语义：与 GetStashes（git stash list）展示顺序一一对应——git 以 stash@{N}
// 引用条目，N=0 恒为最新入栈条目；pop/drop 中间条目会使更高 N 整体前移，故 index
// 仅在栈未被变更的窗口内稳定。API 层在 hash 引用非空时先经 ResolveStashIndex
// 解析为当前栈位再调用本函数（P-20261003-264：前端每次操作都带列表下发的 hash，
// 不再依赖跨请求的 index 稳定性）
func StashShow(repoPath string, index int) (string, error) {
	if index < 0 {
		return "", fmt.Errorf("invalid stash index: %d", index)
	}
	args := []string{"stash", "show", "-p", "--include-untracked", "stash@{" + strconv.Itoa(index) + "}"}
	output, err := execGit(repoPath, args...)
	if err != nil {
		return "", err
	}
	return truncateDiff(output), nil
}
