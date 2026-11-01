package gitops

import (
	shared "codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/git"
	"codecombo/server/store"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
)

// SearchProjectFiles 在项目中搜索文件内容（基于 git grep）
func SearchProjectFiles(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	query := c.Query("q")
	if query == "" {
		shared.Error(c, http.StatusBadRequest, "query required", nil)
		return
	}

	opts := git.SearchOptions{
		CaseSensitive: c.Query("case") == "1",
		WholeWord:     c.Query("word") == "1",
		UseRegex:      c.Query("regex") == "1",
		FilePattern:   c.Query("glob"),
	}
	if mx := c.Query("max"); mx != "" {
		if n, err := strconv.Atoi(mx); err == nil && n > 0 {
			// 钳制上限：异常大值会让全工作区内容扫描不设边界
			if n > 5000 {
				n = 5000
			}
			opts.MaxResults = n
		}
	}

	matches, err := git.SearchContent(p.Path, query, opts)
	if err != nil {
		respondGitError(c, "Search operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"data": matches})
}

// ── 跨项目批量内容搜索（GET /api/search/projects?ids=a,b,c&q=...）──

// ProjectSearchGroup 批量搜索的单项目结果组：按 projectId 分组返回的最小单元，
// 单项目失败（不存在/路径失效/搜索出错）不拖垮整体——该组空结果 + error 标记
type ProjectSearchGroup struct {
	ProjectID string            `json:"projectId"`
	Name      string            `json:"name"`
	Matches   []git.SearchMatch `json:"matches"`
	// Truncated 单项目命中超上限被截断（单项目路径由前端 max+1 探测，
	// 批量路径服务端多取 1 条探测后裁剪，语义对齐）
	Truncated bool `json:"truncated,omitempty"`
	// Error 该项目失败原因（project not found / path missing / search failed）；
	// 空 = 成功
	Error string `json:"error,omitempty"`
}

const (
	// batchSearchConcurrency 跨项目并发池上限：与 ahead/behind 批量端点同模式的
	// 有界并发；子进程总量约束 = 池 × 单仓搜索（rg/git grep）既有上限
	batchSearchConcurrency = 4
	// maxBatchSearchProjects 单次批量项目数上限（防御性封顶：结果总量 =
	// 单仓上限 × 项目数；更大项目集应由前端引导缩小范围）
	maxBatchSearchProjects = 50
)

// SearchProjectsContent 跨项目批量内容搜索：逐项目复用现有 SearchContent，
// 并发池有界（4），结果按 ids 顺序分组返回。单仓 maxResults 减半防总量爆炸
// （N 项目总上限不随 N 线性放大），服务端各多取 1 条以探测截断
func SearchProjectsContent(c *gin.Context) {
	query := c.Query("q")
	if query == "" {
		shared.Error(c, http.StatusBadRequest, "query required", nil)
		return
	}
	ids := parseIDList(c.Query("ids"))
	if len(ids) == 0 {
		shared.Error(c, http.StatusBadRequest, "ids required", nil)
		return
	}
	if len(ids) > maxBatchSearchProjects {
		shared.Error(c, http.StatusBadRequest, "too many projects in one batch", nil)
		return
	}

	opts := git.SearchOptions{
		CaseSensitive: c.Query("case") == "1",
		WholeWord:     c.Query("word") == "1",
		UseRegex:      c.Query("regex") == "1",
		FilePattern:   c.Query("glob"),
	}
	perProject := 250 // max 缺省 500 的减半值
	if mx := c.Query("max"); mx != "" {
		if n, err := strconv.Atoi(mx); err == nil && n > 0 {
			// 与单项目端点同口径的异常大值钳制
			if n > 5000 {
				n = 5000
			}
			perProject = n / 2
		}
	}
	if perProject < 1 {
		perProject = 1
	}
	// 多取 1 条探测截断（与单项目路径前端 max+1 探测同语义，服务端收口）
	opts.MaxResults = perProject + 1

	// 先串行查项目元数据（store 查询轻量，串行足够；worker 内零锁访问）
	projects := make([]*config.ProjectConfig, len(ids))
	for i, id := range ids {
		p, err := store.Get().Project.GetByID(id)
		if err != nil {
			projects[i] = nil
			continue
		}
		projects[i] = p
	}

	// 有界并发逐项目搜索：结果按索引落位（各 worker 只写自己的槽位，无数据竞争）
	results := make([]ProjectSearchGroup, len(ids))
	var wg sync.WaitGroup
	sem := make(chan struct{}, batchSearchConcurrency)
	for i := range ids {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			group := ProjectSearchGroup{ProjectID: ids[idx], Matches: []git.SearchMatch{}}
			if p := projects[idx]; p != nil {
				group.Name = p.Name
				// 路径失效（目录被删/移动）显式标记：git grep 回退路径对缺失目录
				// 的空输出按「无匹配」吞错（server/git/search.go 既有语义），Stat 前置补位
				if info, statErr := os.Stat(p.Path); statErr != nil || !info.IsDir() {
					group.Error = "path missing"
				} else if matches, err := git.SearchContent(p.Path, query, opts); err != nil {
					// 单项目失败不拖垮整体：空结果 + 错误标记
					group.Error = "search failed"
				} else {
					if len(matches) > perProject {
						matches = matches[:perProject]
						group.Truncated = true
					}
					group.Matches = matches
				}
			} else {
				group.Error = "project not found"
			}
			results[idx] = group
		}(i)
	}
	wg.Wait()

	c.JSON(http.StatusOK, gin.H{"data": results})
}

// parseIDList 逗号分隔 id 列表解析：去空白、丢空段、按首次出现去重（保序）
func parseIDList(raw string) []string {
	seen := make(map[string]struct{}, 8)
	ids := make([]string, 0, 8)
	for _, part := range strings.Split(raw, ",") {
		id := strings.TrimSpace(part)
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids
}
