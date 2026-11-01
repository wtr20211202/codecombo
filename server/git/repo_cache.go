package git

import (
	"os"
	"strings"
	"sync"
	"time"
)

// ============== 仓库信息短 TTL 缓存（首页/项目页全量扫描性能优化） ==============
//
// 背景：首页与项目页每次挂载都会对全部项目跑 git 子进程（Stat/IsRepo、当前分支、
// remoteURL、ahead/behind），项目多时（真实用户 40+ 项目）构成 git 子进程风暴，
// 是"首页慢/进项目卡"的主因。本缓存把 TTL 窗口内的重复扫描合并为一次：
//   - 窗口内的页面切换（首页↔项目页来回）只扫一遍
//   - 应用内的写操作（提交/推送/切换分支等）经 execGitWithEnv 的统一钩子立即失效，
//     不产生可感知的陈旧
//   - 应用外的变更（终端里手敲 git、CLI agent）最多陈旧 TTL 窗口（5s），自愈

var (
	// repoInfoTTL 仓库基本信息（valid/分支/remoteURL）缓存窗口（var 便于测试缩短）
	repoInfoTTL = 5 * time.Second
	// aheadTTL ahead/behind 缓存窗口
	aheadTTL = 5 * time.Second
)

type repoInfoEntry struct {
	gitRepo   bool
	pathOK    bool
	branch    string
	remoteURL string
	at        time.Time
}

type aheadEntry struct {
	ahead  int
	behind int
	branch string // 计算所用的分支：分支变了（切分支）结果不可复用
	at     time.Time
}

var (
	repoInfoCache sync.Map // path -> repoInfoEntry
	aheadCache    sync.Map // path -> aheadEntry
)

// GetRepoInfoCached 带 TTL 的仓库基本信息（项目列表卡片用）。
// 未命中/过期时现场计算并回填；无效仓库同样缓存（TTL 内不反复 Stat+rev-parse）
func GetRepoInfoCached(path string) (branch, remoteURL string, gitRepo bool, pathOK bool) {
	if e, ok := repoInfoCache.Load(path); ok {
		if entry := e.(repoInfoEntry); time.Since(entry.at) < repoInfoTTL {
			return entry.branch, entry.remoteURL, entry.gitRepo, entry.pathOK
		}
	}
	branch, remoteURL, gitRepo, pathOK = computeRepoInfo(path)
	repoInfoCache.Store(path, repoInfoEntry{gitRepo: gitRepo, pathOK: pathOK, branch: branch, remoteURL: remoteURL, at: time.Now()})
	return branch, remoteURL, gitRepo, pathOK
}

func computeRepoInfo(path string) (branch, remoteURL string, gitRepo bool, pathOK bool) {
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return "", "", false, false
	}
	pathOK = true
	if !IsRepo(path) {
		return "", "", false, pathOK
	}
	gitRepo = true
	if b, err := GetCurrentBranch(path); err == nil {
		branch = b
	}
	if u, err := GetRemoteURL(path); err == nil {
		remoteURL = u
	}
	return branch, remoteURL, gitRepo, pathOK
}

// GetBranchTrackingCached 带 TTL 的 ahead/behind；分支不匹配（切过分支）视为未命中
func GetBranchTrackingCached(path, branch string) (ahead, behind int) {
	if e, ok := aheadCache.Load(path); ok {
		if entry := e.(aheadEntry); entry.branch == branch && time.Since(entry.at) < aheadTTL {
			return entry.ahead, entry.behind
		}
	}
	ahead, behind, _ = GetBranchTracking(path, branch)
	aheadCache.Store(path, aheadEntry{ahead: ahead, behind: behind, branch: branch, at: time.Now()})
	return ahead, behind
}

// invalidateRepoCaches 使某仓库的全部缓存失效（本地写操作后调用）
func invalidateRepoCaches(path string) {
	if path == "" {
		return
	}
	repoInfoCache.Delete(path)
	aheadCache.Delete(path)
}

// invalidateAheadCache 只失效 ahead/behind 缓存。
// fetch 类操作只更新远端引用——分支名/remoteURL 不变，失效 repoInfo 纯属浪费
//（auto-fetch 每轮都会触发，若连 repoInfo 一起失效，等于每轮制造一次全量冷扫描风暴）
func invalidateAheadCache(path string) {
	if path == "" {
		return
	}
	aheadCache.Delete(path)
}

// InvalidateRepoCaches 项目删除路径调用（导出）：清理该路径全部仓库缓存条目，
// 否则反复增删项目的会话中条目缓慢驻留
func InvalidateRepoCaches(path string) {
	invalidateRepoCaches(path)
}

// mutatingGitSubcommands 改变仓库状态（提交/引用/工作树）的 git 子命令——
// 成功执行后必须失效缓存，否则提交后 ahead 徽章在 TTL 窗口内不更新。
// 注意 fetch/pull 不在此列：它们走 fetchLikeGitSubcommands 的定向失效
var mutatingGitSubcommands = map[string]bool{
	"commit": true, "push": true,
	"checkout": true, "switch": true, "merge": true, "rebase": true,
	"reset": true, "revert": true, "cherry-pick": true, "am": true,
	"apply": true, "branch": true, "tag": true, "stash": true,
	"restore": true, "rm": true, "mv": true,
}

// fetchLikeGitSubcommands 远端同步类子命令：只失效 ahead/behind（远端引用变了），
// 不失效 repoInfo（本地分支/remoteURL 没变）
var fetchLikeGitSubcommands = map[string]bool{
	"fetch": true, "pull": true,
}

// globalOptsWithValue 需要消费「下一个参数」作为值的 git 全局选项
// （-c key=value / -C path / --git-dir path 等；带等号附着值的形态如 --git-dir=x
// 以 "-" 前缀规则覆盖）
var globalOptsWithValue = map[string]bool{
	"-C": true, "-c": true, "--git-dir": true, "--work-tree": true,
	"--namespace": true, "--super-prefix": true,
}

// findSubcommand 从 git 参数中定位真实子命令（跳过全局选项及其值）
func findSubcommand(args []string) string {
	for i := 0; i < len(args); i++ {
		a := args[i]
		if globalOptsWithValue[a] {
			i++ // 跳过该选项的值
			continue
		}
		if strings.HasPrefix(a, "-") {
			continue
		}
		return a
	}
	return ""
}

// maybeInvalidateCaches execGitWithEnv 的统一失效钩子：写操作成功执行后按语义定向失效该仓库缓存。
// 放在最低层执行器上保证覆盖所有上层入口（REST gitops / 凭据注入路径 / tmux 兜底命令）。
// 定向规则：fetch/pull 只失效 ahead（远端引用变了、本地分支/remoteURL 没变）；
// 其余写操作全部失效
func maybeInvalidateCaches(workDir string, args []string, err error) {
	if err != nil || len(args) == 0 || workDir == "" {
		return
	}
	sub := findSubcommand(args)
	switch {
	case fetchLikeGitSubcommands[sub]:
		invalidateAheadCache(workDir)
	case mutatingGitSubcommands[sub]:
		invalidateRepoCaches(workDir)
	}
}

// GetHeadTrackingCached GetRepoHeadTracking 的缓存包装（与 aheadCache 共用条目，
// TTL/失效语义一致）：批量端点（/ahead-behind）每仓库一次 for-each-ref 进程，
// 冷启动子进程数 ~3N → N
func GetHeadTrackingCached(path string) (branch string, ahead, behind int) {
	if e, ok := aheadCache.Load(path); ok {
		if entry := e.(aheadEntry); time.Since(entry.at) < aheadTTL {
			return entry.branch, entry.ahead, entry.behind
		}
	}
	branch, ahead, behind, err := GetRepoHeadTracking(path)
	if err != nil {
		// 非 git 仓库等场景：保留空结果并按 TTL 缓存，避免反复冷扫
		aheadCache.Store(path, aheadEntry{branch: "", at: time.Now()})
		return "", 0, 0
	}
	aheadCache.Store(path, aheadEntry{ahead: ahead, behind: behind, branch: branch, at: time.Now()})
	return branch, ahead, behind
}
