package project

import (
	"codecombo/server/api/gitops"
	shared "codecombo/server/api/shared"
	"codecombo/server/errmarkers"
	"codecombo/server/git"
	"codecombo/server/middleware"
	"codecombo/server/store"
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
)

// 变更列表（changelist，P-20261007-19 UI 落地）：JetBrains 式「一批改动按逻辑
// 分组、active 组收敛提交面、shelve 搁置切任务」。此前 6 handler 全套在位但
// 零消费（前端死代码+手册未登记的功能孤岛），本轮激活：
//   - 条目带 projectId（per-project 作用域，空=存量全局条目全项目可见，升级兼容）
//   - Create/Delete/Shelve 入审计（git.changelist_*，只记名称/数量元数据）
//   - Shelve 走 pathspec stash push（server/git/stash.go ShelvePartial），恢复
//     走既有 stash pop 通道（stash 面板条目带 shelve: 标识）
//
// projectId 均为可选参数：缺省=全局作用域（legacy API 形态不变）。

// auditChangelist 审计入账小 helper：动作 + 项目/列表名元数据（不含文件清单）
func auditChangelist(c *gin.Context, action, result, detail string) {
	middleware.AuditAppend(c, store.AuditEvent{
		Action: action,
		Result: result,
		IP:     c.ClientIP(),
		Detail: detail,
	})
}

// 获取所有 changelist（?projectId= 过滤为「该项目 + 存量全局」可见集）
func GetChangelists(c *gin.Context) {
	cfg := store.Get().Settings.Get()
	c.JSON(http.StatusOK, gin.H{"data": cfg.VisibleChangelists(c.Query("projectId"))})
}

// 创建 changelist
func CreateChangelist(c *gin.Context) {
	var req struct {
		Name      string `json:"name" binding:"required"`
		ProjectID string `json:"projectId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Changelist operation failed", err)
		return
	}

	cfg := store.Get().Settings.Get()
	if !cfg.AddChangelist(req.Name, req.ProjectID) {
		// 同作用域重名拒绝（按名切换活跃/移入文件的前提是名字唯一）：稳定原文
		// 入 errmarkers 注册表，前端 KNOWN_ERROR_I18N 本地化
		auditChangelist(c, store.AuditGitChangelistCreate, store.AuditResultDenied, req.Name)
		shared.Error(c, http.StatusConflict, errmarkers.ChangelistExists, nil)
		return
	}
	if err := store.Get().Settings.Save(); err != nil {
		auditChangelist(c, store.AuditGitChangelistCreate, store.AuditResultFailure, req.Name)
		shared.Error(c, http.StatusInternalServerError, "Changelist operation failed", err)
		return
	}

	auditChangelist(c, store.AuditGitChangelistCreate, store.AuditResultSuccess, req.Name)
	c.JSON(http.StatusCreated, gin.H{"message": "changelist created"})
}

// 删除 changelist（组内文件本身不受影响——列表只是分组视图）
func DeleteChangelist(c *gin.Context) {
	name := c.Param("name")
	projectID := c.Query("projectId")
	cfg := store.Get().Settings.Get()
	cfg.RemoveChangelist(name, projectID)
	if err := store.Get().Settings.Save(); err != nil {
		auditChangelist(c, store.AuditGitChangelistDelete, store.AuditResultFailure, name)
		shared.Error(c, http.StatusInternalServerError, "Changelist operation failed", err)
		return
	}

	auditChangelist(c, store.AuditGitChangelistDelete, store.AuditResultSuccess, name)
	c.JSON(http.StatusOK, gin.H{"message": "changelist removed"})
}

// 设置活跃 changelist（同作用域内互斥）
func SetActiveChangelist(c *gin.Context) {
	var req struct {
		Name      string `json:"name" binding:"required"`
		ProjectID string `json:"projectId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Changelist operation failed", err)
		return
	}

	cfg := store.Get().Settings.Get()
	cfg.SetActiveChangelist(req.Name, req.ProjectID)
	if err := store.Get().Settings.Save(); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Changelist operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "active changelist set"})
}

// 移动文件到指定 changelist（同作用域内至多归属一个列表）
func MoveFileToChangelist(c *gin.Context) {
	var req struct {
		Changelist string `json:"changelist" binding:"required"`
		File       string `json:"file" binding:"required"`
		ProjectID  string `json:"projectId"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Changelist operation failed", err)
		return
	}

	cfg := store.Get().Settings.Get()
	cfg.AddFileToChangelist(req.Changelist, req.File, req.ProjectID)
	if err := store.Get().Settings.Save(); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Changelist operation failed", err)
		return
	}

	c.JSON(http.StatusOK, gin.H{"message": "file moved"})
}

// Shelve 搁置部分文件（组内文件未提交变更整体入 stash，消息带 shelve: 标识；
// created=false = 组内文件当前无变更、未产生条目——如实回告不谎报成功）
func ShelveFiles(c *gin.Context) {
	p := shared.GetProjectFromContext(c)
	if p == nil {
		return
	}

	var req struct {
		Files   []string `json:"files" binding:"required"`
		Message string   `json:"message"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Changelist operation failed", err)
		return
	}

	created, err := git.ShelvePartial(p.Path, req.Files, req.Message)
	if err != nil {
		auditChangelist(c, store.AuditGitChangelistShelve, store.AuditResultFailure, fmt.Sprintf("%s: %d file(s)", p.Name, len(req.Files)))
		shared.Error(c, http.StatusInternalServerError, "Changelist operation failed", err)
		return
	}

	// gitops 层 status 3s TTL 缓存就地失效（P-20261004-25 先例）：搁置把组内
	// 文件变更移出工作区，前端紧随的 status 重拉若命中陈旧缓存会把已搁置文件
	// 继续挂在变更树上，且此后无刷新触发（无后续 file.changed/用户动作）——
	// 恢复路径的 stash pop 同款处理见 gitops/stash.go
	gitops.InvalidateGitStatusCache(p.Path)

	auditChangelist(c, store.AuditGitChangelistShelve, store.AuditResultSuccess,
		fmt.Sprintf("%s: %d file(s)", p.Name, len(req.Files)))
	c.JSON(http.StatusOK, gin.H{"message": "files shelved", "created": created})
}
