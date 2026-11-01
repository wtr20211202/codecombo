package project

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/git"
	mw "codecombo/server/middleware"
	"codecombo/server/store"
	"net/http"
	"os"
	"sync"

	"github.com/gin-gonic/gin"
)

// ── 一键全部拉取（P-20261002-41）：多项目晨间例程收敛为一次点击 ──
// 逐项目复用既有 git.Fetch（与 GitPanel 快捷拉取同语义：fetch --prune --tags、
// remote 为空走 execGitWithEnv），并发池有界 + 失败隔离逐项报告：
// 单个项目失败（路径失效/非 git 仓库/网络错误）只标记该项，不拖垮整批。

// FetchAllItem 批量拉取的单项目结果：OK=true 成功；Error 非空 = 失败原因
// （"path missing" / "not a git repo" / 已脱敏的 git 错误串），空 = 成功
type FetchAllItem struct {
	ProjectID string `json:"projectId"`
	Name      string `json:"name"`
	OK        bool   `json:"ok"`
	// Error 该项目失败原因；空 = 成功
	Error string `json:"error,omitempty"`
}

// fetchAllConcurrency 批量拉取并发池上限：fetch 是网络 IO（不抢 index.lock，
// 仓间无共享工作区），与后台 auto-fetch（autoFetchConcurrency）及跨项目搜索
// 池同档取 4——多项目并发提速且不放大出站连接压力
const fetchAllConcurrency = 4

// FetchAllProjects 全项目批量拉取：POST /api/fetch-all（独立路径——挂
// /projects/fetch-all 会与 /projects/:id 通配符冲突，同 ahead-behind 先例）。
// 前端 timeout: 0（P-53 涉网矩阵）：整批耗时 = 最慢项目，由服务端
// git_timeout 网络档（默认 900s）兜底，前端不设上限防「假失败真在跑」
func FetchAllProjects(c *gin.Context) {
	projectConfigs, err := store.Get().Project.List()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Project operation failed", err)
		return
	}

	// 项目硬锁（P-20261004-3）：locked 项目逐项标跳过——批量入口是
	// POST /projects/:id/fetch 守卫的旁路（内部直调 git.Fetch 不经路由），
	// 不滤会把归档的 .git 远程跟踪引用静默刷新掉。带稳定标记与「path missing」
	// 同款进前端逐项报告，锁是用户有意的，明示优于静默
	c.JSON(http.StatusOK, gin.H{"data": fetchAllProjects(projectConfigs, fetchAllConcurrency, fetchAllItemLockedAware)})
}

// fetchAllItemLockedAware 硬锁感知的单项目拉取动作（P-20261004-3）：locked
// 直接标跳过（错误串含稳定标记 project.locked，前端 KNOWN_ERROR_I18N 映射），
// 其余走既有 fetchAllItem
func fetchAllItemLockedAware(p config.ProjectConfig) FetchAllItem {
	if p.Locked {
		return FetchAllItem{ProjectID: p.ID, Name: p.Name, Error: "project is locked (" + mw.ProjectLockedMarker + ")"}
	}
	return fetchAllItem(p)
}

// fetchAllProjects 核心实现（itemFn 单项目动作可注入，以便单测并发上限与失败
// 隔离）：结果按输入顺序落位（各 worker 只写自己的槽位，无数据竞争）。
// 注意：与未合入的 git 写串行队列（P-78）无耦合假设——fetch 为网络类
// 不触碰 index.lock，仓间天然隔离，直接并发即可
func fetchAllProjects(projects []config.ProjectConfig, concurrency int, itemFn func(config.ProjectConfig) FetchAllItem) []FetchAllItem {
	if concurrency < 1 {
		concurrency = 1
	}
	results := make([]FetchAllItem, len(projects))
	var wg sync.WaitGroup
	sem := make(chan struct{}, concurrency)
	for i := range projects {
		wg.Add(1)
		go func(idx int, p config.ProjectConfig) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			results[idx] = itemFn(p)
		}(i, projects[i])
	}
	wg.Wait()
	return results
}

// fetchAllItem 单项目完整拉取动作（默认实现）：前置校验 + 既有 git.Fetch。
// git 错误串已由执行层脱敏（RedactCredentials），可直达前端
func fetchAllItem(p config.ProjectConfig) FetchAllItem {
	item := FetchAllItem{ProjectID: p.ID, Name: p.Name}
	if info, err := os.Stat(p.Path); err != nil || !info.IsDir() {
		// 路径失效（目录被删/移动）显式标记，与跨项目搜索同语义
		item.Error = "path missing"
	} else if !git.IsRepo(p.Path) {
		// 非 git 项目无可拉取远端：合法项目类型，逐项标跳过原因
		item.Error = "not a git repo"
	} else if _, err := git.Fetch(p.Path, ""); err != nil {
		item.Error = err.Error()
	} else {
		item.OK = true
	}
	return item
}
