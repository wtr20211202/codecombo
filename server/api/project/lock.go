package project

import (
	"net/http"

	"codecombo/server/api/opschannel"
	shared "codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/model"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ── 项目硬锁（P-20261004-3）──
//
// locked 归档不可变档：置位后文件写族/git 写族/该项目终端创建一律 403
// （守卫 server/middleware/projectlock.go，读面全放行）；本文件只负责
// 开关本身——锁定/解锁双向审计 + projects.changed 广播。与 Frozen 独立
// 可并存（静音+不可变叠加），互不级联。

// SetProjectLocked PUT /api/projects/:id/locked：设置硬锁布尔。
// 经既有 ProjectStore.Update 链持久化（SetProjectFrozen 同款），响应体
// 回传最新态供前端就地替换列表项。本端点自身不挂硬锁守卫——它是唯一解锁路径。
func SetProjectLocked(c *gin.Context) {
	id := c.Param("id")
	p, err := store.Get().Project.GetByID(id)
	if err != nil || p == nil {
		shared.Error(c, http.StatusNotFound, "project not found", nil)
		return
	}

	var req model.SetProjectLockedRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Project operation failed", err)
		return
	}

	p.Locked = req.Locked
	if err := store.Get().Project.Update(*p); err != nil {
		shared.Error(c, http.StatusInternalServerError, "failed to save project: failed", err)
		return
	}

	// 双向审计：上锁/解锁都是安全敏感动作（写面开合状态变化）
	action := store.AuditProjectUnlock
	if req.Locked {
		action = store.AuditProjectLock
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: action,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: p.Name,
	})

	// 智能操作通道：通知前端项目列表已变（订阅方自动刷新，frozen 同款知情）
	opschannel.BroadcastEvent(opschannel.EventProjectsChanged, gin.H{"action": "locked", "id": id, "locked": req.Locked})

	c.JSON(http.StatusOK, gin.H{"data": model.Project{
		ID:     p.ID,
		Name:   p.Name,
		Path:   p.Path,
		Locked: p.Locked,
	}})
}
