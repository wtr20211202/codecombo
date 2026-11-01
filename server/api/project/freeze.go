package project

import (
	"net/http"

	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/model"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ── 项目冻结（P-20261003-9）──
//
// 历史遗留/只读参考项目折入首页列表尾部弱化分区（可搜索、一键解冻），
// 不删配置不丢重定位信息；冻结项目顺带跳过 ahead/behind 批量探测
// （ListAllAheadBehind）。仅影响首页呈现与探测，项目功能面不变。

// SetProjectFrozen PUT /api/projects/:id/frozen：设置冻结布尔。
// 经既有 ProjectStore.Update 链持久化（与重定位同款），响应体回传最新态
// 供前端就地替换列表项（relocateProject 同款模式）
func SetProjectFrozen(c *gin.Context) {
	id := c.Param("id")
	p, err := store.Get().Project.GetByID(id)
	if err != nil || p == nil {
		shared.Error(c, http.StatusNotFound, "project not found", nil)
		return
	}

	var req model.SetProjectFrozenRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Project operation failed", err)
		return
	}

	p.Frozen = req.Frozen
	if err := store.Get().Project.Update(*p); err != nil {
		shared.Error(c, http.StatusInternalServerError, "failed to save project: failed", err)
		return
	}

	// 智能操作通道：通知前端项目列表已变（订阅方自动刷新，多实例同款知情）
	opschannel.BroadcastEvent(opschannel.EventProjectsChanged, gin.H{"action": "frozen", "id": id, "frozen": req.Frozen})

	c.JSON(http.StatusOK, gin.H{"data": model.Project{
		ID:     p.ID,
		Name:   p.Name,
		Path:   p.Path,
		Frozen: p.Frozen,
	}})
}
