package middleware

import (
	"github.com/gin-gonic/gin"

	"codecombo/server/api/shared"
	"codecombo/server/config"
	"codecombo/server/errmarkers"
	"codecombo/server/store"
)

// ── 项目硬锁守卫（P-20261004-3）──
//
// locked 项目 = 归档不可变档：挂了本守卫的端点对该项目一律 403，读面全放行。
// 覆盖三族（router.go 逐路由显式挂载，grep ProjectHardLock 可对账防漏）：
//   - 文件写族：write/create/mkdir/rename/delete/upload/history-restore
//   - git 写族：stage/unstage/commit/rollback/reset/push/pull/merge/rebase/
//     stash/tag/worktree/patch-import/hook 等一切变更仓库或工作区的路由
//   - 终端创建：POST /terminals（body 携 projectId / agent 会话 dir，无 :id
//     参数挂不上路由守卫——terminal.CreateTerminal 内走 DenyLockedProject 同源）
//
// 【错误契约】403 响应体携结构化 code "project.locked"（P-305 已落地，
// shared.CodeProjectLocked），且 message 明文保留同一关键字——前端
// KNOWN_ERROR_I18N 与旧 agent 的关键字子串识别契约不回退，新 agent 按
// code 分支；关键字与码值同串（shared/errors.go 交叉注释对账）。文本唯一
// 事实源在 errmarkers 注册表（P-20261004-29），此处保名别名
const ProjectLockedMarker = errmarkers.ProjectLocked

// lockedDeniedMsg 403 响应明文（对外契约：前端/agent 按 ProjectLockedMarker
// 子串识别，勿改措辞中的标记本身）
const lockedDeniedMsg = "project is locked (" + ProjectLockedMarker + "): archived project is immutable; unlock it to modify"

// DenyLockedProject 就地硬锁守卫（无 :id 路由参数的写入口用）：p 为 Locked
// 项目时写 403 并返回 true（调用方直接 return），否则返回 false 放行。
func DenyLockedProject(c *gin.Context, p *config.ProjectConfig) bool {
	if p == nil || !p.Locked {
		return false
	}
	shared.ErrorWithCode(c, shared.CodeProjectLocked, lockedDeniedMsg, nil)
	return true
}

// ProjectHardLock 项目硬锁路由守卫：以 :id 参数解析项目，Locked 置位即 403。
// 仅挂写族路由；项目查不到（err）时放行——404 语义归各 handler，
// 守卫不做存在性裁决。GetByID 走 3s 读缓存，热路径开销 O(项目数) 内存比对。
func ProjectHardLock() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		if id == "" {
			c.Next()
			return
		}
		p, err := store.Get().Project.GetByID(id)
		if err != nil || p == nil {
			c.Next()
			return
		}
		if DenyLockedProject(c, p) {
			c.Abort()
			return
		}
		c.Next()
	}
}
