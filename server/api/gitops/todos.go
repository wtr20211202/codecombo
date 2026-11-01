package gitops

import (
	"net/http"

	shared "codecombo/server/api/shared"
	"codecombo/server/git"

	"github.com/gin-gonic/gin"
)

// ── 代码 TODO/FIXME 标记扫描（P-20261002-25）──
//
// 聚合代码注释里的 TODO/FIXME/XXX/HACK 为「赊账清单」：数据面走
// git.SearchTodoMarks（复用内容搜索双后端与排除语义，解析器为标记专用），
// 本 handler 只做项目定位、截断探测与按文件分组。

const (
	// maxTodoMarks 返回条目上限：防巨型仓库拖爆响应与前端渲染（截断由
	// truncated 标记，前端提示「仅显示前 N 条」）
	maxTodoMarks = 500
)

// TodoFileGroup 单文件的 TODO 命中组：条目复用 SearchMatch
// （path/line/column/content），字段见 server/git/search.go
type TodoFileGroup struct {
	Path  string            `json:"path"`
	Items []git.SearchMatch `json:"items"`
}

// ProjectTodos GET /projects/:id/todos：扫描项目内 TODO/FIXME/XXX/HACK 标记。
// 多取 1 条探测截断，与批量搜索服务端收口同款（见 SearchProjectsContent）
func ProjectTodos(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	matches, err := git.SearchTodoMarks(p.Path, maxTodoMarks+1)
	if err != nil {
		respondGitError(c, "Search operation failed", err)
		return
	}
	truncated := false
	if len(matches) > maxTodoMarks {
		matches = matches[:maxTodoMarks]
		truncated = true
	}

	// 按文件分组（保持后端输出序，rg/git grep 均按文件聚簇），同文件多命中聚合
	groups := make([]TodoFileGroup, 0, 8)
	indexPath := make(map[string]int, 8)
	total := 0
	for _, m := range matches {
		if gi, ok := indexPath[m.Path]; ok {
			groups[gi].Items = append(groups[gi].Items, m)
		} else {
			indexPath[m.Path] = len(groups)
			groups = append(groups, TodoFileGroup{Path: m.Path, Items: []git.SearchMatch{m}})
		}
		total++
	}

	c.JSON(http.StatusOK, gin.H{"data": groups, "total": total, "truncated": truncated})
}
