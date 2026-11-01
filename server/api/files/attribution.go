package files

import (
	"net/http"
	"strconv"

	shared "codecombo/server/api/shared"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// 文件改动来源归因查询（P-20261005-170）：fsattr 模块在事件发生当时判定的
// 账面（watcher 事件 × OSC133 命令窗时间关联 + 编辑器 API 写标记），此处只读。
// agent 对账原语——「我/别的会话刚才改了哪些文件」可程序化核验（ops 手册
// files 节已登记），人侧入口 = 文件树/编辑器右键「改动来源」。

// fsAttributionDefaultLimit / fsAttributionMaxLimit 单次返回条数缺省与上限：
// 账面每项目环形 500，上限即全量兜底；弹窗渲染条数随 limit 有界
const (
	fsAttributionDefaultLimit = 50
	fsAttributionMaxLimit     = 500
)

// FSAttributionList GET /api/projects/:id/fs-attribution?path=&limit=
// path 为项目相对 slash 路径（精确匹配归一形态；空 = 全部路径的最近事件，
// 「项目刚刚发生了什么」口径）。账面随事件实时追加，挂 no-store
func FSAttributionList(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	limit := fsAttributionDefaultLimit
	if n, err := strconv.Atoi(c.Query("limit")); err == nil && n > 0 {
		limit = n
	}
	if limit > fsAttributionMaxLimit {
		limit = fsAttributionMaxLimit
	}
	// 查询路径与账面同尺归一（写进账的形态与查询形态必然同键，snapshotForHistory
	// 同款归一语义）；归一为空（根/越界形态）= 不过滤
	path := NormalizeRelPath(c.Query("path"))

	events, err := store.Get().FSAttribution.Query(p.ID, path, limit)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "File attribution query failed", err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": events})
}
