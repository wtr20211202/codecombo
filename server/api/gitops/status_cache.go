package gitops

import (
	"sort"
	"sync"
	"time"

	"codecombo/server/git"
	"codecombo/server/model"
)

// gitStatusCache 文件树/状态接口的 git 状态缓存：项目路径 → 采集结果 + 时间。
// 文件树逐层导航会对同一项目连续请求，3 秒 TTL 内复用一次采集结果，
// 避免每层都起 git status / check-ignore 子进程（大仓库单次可达数百毫秒）。
// 缓存条目同时保留三种形态：完整 FileStatus 列表（/status 端点，字段无损）、
// path→status 映射与 ignored 集合（文件树渲染用），一次采集三方复用。
//
// 并发模型：锁按仓库路径隔离（per-path mutex）。历史实现用一把全局锁罩住
// 两条全工作区 git 扫描，多项目场景下 A 仓库的大 untracked 集会串行卡死
// B 仓库的树加载；改后不同仓库的采集完全并行，同仓库仍串行去重。
// 缓存 map 的结构变更由 cacheMu 短暂保护（绝不持锁跑 git）。
type gitStatusCacheEntry struct {
	files   []model.FileStatus
	status  map[string]string
	ignored map[string]bool
	at      time.Time
}

const gitStatusCacheTTL = 3 * time.Second

var (
	cacheMu        sync.RWMutex
	gitStatusCache = map[string]gitStatusCacheEntry{}
	pathLocks      sync.Map // repoPath -> *sync.Mutex
)

// pathLock 返回仓库路径专属锁（懒创建）
func pathLock(repoPath string) *sync.Mutex {
	l, _ := pathLocks.LoadOrStore(repoPath, &sync.Mutex{})
	return l.(*sync.Mutex)
}

func cachedGitStatus(repoPath string) gitStatusCacheEntry {
	cacheMu.RLock()
	e, ok := gitStatusCache[repoPath]
	cacheMu.RUnlock()
	if ok && time.Since(e.at) < gitStatusCacheTTL {
		return e
	}

	mu := pathLock(repoPath)
	mu.Lock()
	defer mu.Unlock()

	// 双检：等锁期间可能已被并发采集
	cacheMu.RLock()
	e, ok = gitStatusCache[repoPath]
	cacheMu.RUnlock()
	if ok && time.Since(e.at) < gitStatusCacheTTL {
		return e
	}

	files, err := git.GetStatus(repoPath)
	if err != nil {
		files = nil
	}
	statusMap := make(map[string]string, len(files))
	for _, s := range files {
		statusMap[s.Path] = s.Status
	}
	ignored := make(map[string]bool)
	if ig, err := git.GetIgnoredFiles(repoPath); err == nil {
		ignored = ig
	}
	e = gitStatusCacheEntry{files: files, status: statusMap, ignored: ignored, at: time.Now()}
	cacheMu.Lock()
	gitStatusCache[repoPath] = e
	cacheMu.Unlock()
	return e
}

// cachedGitMaps 文件树用：path→status 映射 + ignored 集合
func cachedGitMaps(repoPath string) (map[string]string, map[string]bool) {
	e := cachedGitStatus(repoPath)
	return e.status, e.ignored
}

// InvalidateGitStatusCache 项目删除路径调用：清理该仓库的缓存条目与专属锁，
// 否则条目（完整 FileStatus 列表 + ignored 集合，单仓库可达 MB 级）随增删项目缓慢驻留
func InvalidateGitStatusCache(repoPath string) {
	if repoPath == "" {
		return
	}
	cacheMu.Lock()
	delete(gitStatusCache, repoPath)
	cacheMu.Unlock()
	pathLocks.Delete(repoPath)
}

// CachedStatusList /projects/:id/status 端点用：完整 FileStatus 列表（字段无损，
// 与直接调用 git.GetStatus 等价），复用同一 3s TTL 缓存——历史实现完全无缓存，
// 文件树与状态接口各自起 git 全工作区扫描。返回按路径字典序，响应稳定
func CachedStatusList(repoPath string) []model.FileStatus {
	files := cachedGitStatus(repoPath).files
	out := make([]model.FileStatus, len(files))
	copy(out, files)
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}
