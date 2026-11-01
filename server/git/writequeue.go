package git

// 同仓库 git 写操作串行队列（P-20261002-78）：
// agent 自动 commit 与用户手动 stage/commit 并发是本产品日常形态，git 自身的
// index.lock 是崩溃式冲突（两个写命令并发即报「Another git process seems to
// be running」，挂起的进程还会让后续命令连锁挂起）。应用层按仓库排队才是正解：
//   - 写类命令按仓库互斥（chan 容量 1 信号量，sync.Map 惰性创建，复用
//     gitops pathLocks 的 per-path 模式），等锁上限 30s，超时返回含稳定标记
//     的友好错误（前端 http.ts KNOWN_ERROR_I18N 映射「上一 git 操作仍在进行中」）
//   - 读类命令（status/log/diff/blame 等）不入队：读不抢 index.lock，
//     排队只会白白增加延迟
//   - 网络类长操作（push/fetch/pull）不持锁：慢网会长时间占住队列、把本地
//     快操作全堵在后面——而网络操作不写本地 index（push 只推本地已有的
//     引用状态，fetch/pull 的索引写主要发生在远端引用更新后的合并段），
//     牺牲该窄窗口的互斥换本地操作的全程可用，是明确取舍
// 与 indexlock.go（P-20261002-150）互补：那条恢复遗留锁（事后），本条防新增
// 冲突（事前）。
//
// 互斥键 = 传入的 workDir 原样字符串。agent 与用户对同一项目的操作路径同源
//（项目 store 的 Path），实际形态一致；不做 gitdir 规整化（那需要每次写命令
// 前置文件解析）。清理竞态与 gitops pathLocks.Delete 同款取舍：删除中的项目
// 极端交错下可能出现短暂无串行窗口，后果=退化为现状（git 自身锁兜底），不
// 产生额外损坏。

import (
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"codecombo/server/errmarkers"
)

// GitWriteBusyMarker 错误原文中的稳定英文标记：写队列等待超时（命令未执行）
// 时随错误返回，前端 http.ts KNOWN_ERROR_I18N 按此子串映射本地化文案
// （对齐 IndexLockStaleMarker 的「服务端稳定英文原文 → 子串匹配」机制）。
// 文本唯一事实源在 errmarkers 注册表（P-20261004-29），此处保名别名
const GitWriteBusyMarker = errmarkers.GitWriteBusy

// errWriteQueueTimeout 写队列等待超时（sentinel，调用方 errors.Is 可判）
var errWriteQueueTimeout = errors.New("git write queue wait timeout")

// writeQueueWaitTimeout 队列等待上限：写命令正常毫秒~秒级，等 30s 还没轮到
// 说明有操作异常挂起（超时兜底 60s~15min 才会放行），继续等只会把 HTTP 请求
// 吊死——按超时失败让用户稍后重试。var 便于单测注入短超时
var writeQueueWaitTimeout = 30 * time.Second

// gitWriteQueueVerbs 进队列的写类子命令白名单（持有 index.lock 或改写工作树/
// 暂存区，并发即 git 层冲突）。以 repo_cache.mutatingGitSubcommands（缓存失效
// 分类）为基，差异：
//   - 去掉 push（网络类不持锁，见文件头取舍说明）
//   - 去掉 branch / tag：只写引用级锁（refs/heads/<name>.lock），不碰
//     index.lock，且高频读形态（branch -a / tag 列表）共用动词，入队会误伤
//   - 补 add（暂存写 index）与 clean（清工作树，提案白名单点名）
//
// 遗漏的写命令后果 = 退化为现状（git 自身锁兜底，不恶化），白名单从紧起步；
// 新增写类入口时同步本表（有单测锚定核心成员）
var gitWriteQueueVerbs = map[string]bool{
	"add": true, "rm": true, "mv": true, "restore": true,
	"commit": true, "reset": true, "checkout": true, "switch": true,
	"merge": true, "rebase": true, "revert": true, "cherry-pick": true,
	"am": true, "apply": true, "clean": true,
	"stash": true, // stash 需子命令甄别（list/show 是读），见 gitStashReadSubs
}

// gitBranchRenameForms branch 动词的重命名形态（P-20261003-221）：
// `git branch -m/-M/--move` 会改写 refs/heads/<name> 引用、reflog 与（当前分支
// 改名时）HEAD 符号引用——与并发的本地写族（持 index.lock 的 commit/checkout
// 等）存在引用级竞态，按写队列域串行。branch 动词整体仍维持白名单外的既有
// 取舍（列表/建/删只写引用级锁不碰 index.lock，入队误伤高频读），仅重命名
// 形态入队：与 stash 同款「动词需甄别」处理，语义与 P-78「写互斥」一致且
// 不回退已锚定的直通用例（writequeue_test）
var gitBranchRenameForms = map[string]bool{
	"-m": true, "-M": true, "--move": true,
}

// gitStashReadSubs stash 的只读子命令/形态：stash 面板高频调用（stash.go
// ListStash），排队只会白等——stash 动词入队前先甄别
var gitStashReadSubs = map[string]bool{
	"list": true, "show": true, "--list": true,
}

// isQueuedWriteCommand 判定一组 git 参数是否需要进按仓库写队列。
// 全局选项跳过复用 repo_cache.findSubcommand（gitLongPathsArgs 前置的
// -c core.longpaths=true 已被正确跳过）
func isQueuedWriteCommand(args []string) bool {
	sub := findSubcommand(args)
	if sub == "" {
		return false
	}
	if sub == "stash" {
		return !isStashReadForm(args)
	}
	if sub == "branch" {
		return isBranchRenameForm(args)
	}
	return gitWriteQueueVerbs[sub]
}

// isBranchRenameForm 判定 branch 动词参数是否重命名形态（-m/-M/--move 任一
// 出现即入队）。遍历语义与 isStashReadForm 同款：先跳过全局选项及其值定位
// 动词，再扫描动词后的参数；flag 的取值不甄别（--format -m 这类取值撞上
// 重命名旗标的形态在本仓库不存在，误判代价 = 多排一次队，无害）
func isBranchRenameForm(args []string) bool {
	i := 0
	for ; i < len(args); i++ {
		a := args[i]
		if globalOptsWithValue[a] {
			i++
			continue
		}
		if hasFlagPrefix(a) {
			continue
		}
		break // 动词位次
	}
	for j := i + 1; j < len(args); j++ {
		if gitBranchRenameForms[args[j]] {
			return true
		}
	}
	return false
}

// isStashReadForm stash 动词后首个「实质参数」命中只读子命令/形态即纯读：
// `git stash list` / `git stash show` / `git stash --list`；裸 `git stash` 与
// flag 形态（--include-untracked 等）默认 = push，属写。遍历语义与
// classifyGitTimeout 的子命令甄别同款：先跳过全局选项及其值定位动词，
// 再从动词后扫描，flag 跳过、白名单命中定档、首个非 flag 实参定档
func isStashReadForm(args []string) bool {
	i := 0
	for ; i < len(args); i++ {
		a := args[i]
		if globalOptsWithValue[a] {
			i++
			continue
		}
		if hasFlagPrefix(a) {
			continue
		}
		break // 动词位次
	}
	for j := i + 1; j < len(args); j++ {
		a := args[j]
		if gitStashReadSubs[a] {
			return true
		}
		if hasFlagPrefix(a) {
			continue
		}
		return false // push/pop/apply 等子命令 = 写形态
	}
	return false // 裸 `git stash` 默认 = push
}

// repoWriteQueues 仓库路径 → 容量 1 的 chan 信号量（sync.Map 惰性创建）。
// chan 天然支持带超时的 select 获取，无需轮询 TryLock
var repoWriteQueues sync.Map // workDir -> chan struct{}

// acquireRepoWriteGate 按仓库获取写槽位，等锁超过 timeout 返回
// errWriteQueueTimeout。成功返回释放函数（幂等安全：只 drain 自己填的槽）。
// 持有槽位期间必须执行 git 命令并在完成后释放——本函数不做任何阻塞型
// 子操作，杜绝队列自身成为挂起点
func acquireRepoWriteGate(workDir string, timeout time.Duration) (func(), error) {
	v, _ := repoWriteQueues.LoadOrStore(workDir, make(chan struct{}, 1))
	ch := v.(chan struct{})
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case ch <- struct{}{}:
		return func() { <-ch }, nil
	case <-timer.C:
		return nil, errWriteQueueTimeout
	}
}

// InvalidateRepoWriteQueue 项目删除/迁移路径调用：清理该路径的写队列条目，
// 防止反复增删项目时条目缓慢驻留（与 gitops pathLocks 清理同点位同取舍，
// 竞态影响见文件头）
func InvalidateRepoWriteQueue(repoPath string) {
	if repoPath == "" {
		return
	}
	repoWriteQueues.Delete(repoPath)
}

// acquireRepoWriteSlot execGitWithEnvLog / execGitWithStdin 的统一入队口：
// 写类命令按仓库排队（读类直通），成功返回释放函数；等待超时经 logFn 记
// 日志/广播（与 git 命令其他失败路径同面，前端命令台可见）后返回含稳定
// 标记的错误。返回的释放函数必须由调用方 defer 执行
func acquireRepoWriteSlot(workDir string, args []string, logFn func(args []string, workDir string, elapsed time.Duration, err error, errStr, output string)) (func(), error) {
	if workDir == "" || !isQueuedWriteCommand(args) {
		return func() {}, nil
	}
	start := time.Now()
	release, err := acquireRepoWriteGate(workDir, writeQueueWaitTimeout)
	waited := time.Since(start)
	if err == nil {
		if waited > 0 {
			// 只在真发生过等待（有竞争）时留痕，诊断排队压力
			slog.Debug("git write command queued", "args", redactArgs(args), "dir", workDir, "waited", waited)
		}
		return release, nil
	}
	qerr := fmt.Errorf("git %s: %w: %s (queued %v, command not executed)",
		redactArgs(args), err, GitWriteBusyMarker, waited.Round(time.Millisecond))
	logFn(args, workDir, waited, qerr, qerr.Error(), "")
	return nil, qerr
}
