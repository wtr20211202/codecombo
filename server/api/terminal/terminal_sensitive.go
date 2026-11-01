package terminal

import (
	"fmt"
	"net/http"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// 会话敏感标记（P-20261003-155）：AgentSessionMeta.Sensitive 的行操作端点。
// 出域闸门判定与警示 token 在 shared.IsSessionSensitive / shared.SensitiveSessionWarning
//（终端输出导出与终端直播分享两条出域链共用，见 sensitivegate.go）。

// SetSessionSensitive POST /api/terminals/:id/sensitive {"sensitive": bool}
// 行操作标记（P-20261003-155）：侧栏会话行/终端 tab 右键「标记敏感」。幂等
// 重复置同值无害；meta 缺失（创建异步落库未达的窗口期）按 manager 存活会话
// 补建最小 meta（saveSessionDisplayName 同款 upsert 惯例），会话也不在 → 404
// （标记随 meta 生命周期存续，死会话无处可标）。成功后广播快照——多端角标
// 与导出/分享闸门即时跟随
func SetSessionSensitive(c *gin.Context) {
	id := c.Param("id")
	var req struct {
		Sensitive *bool `json:"sensitive" binding:"required"`
	}
	if !shared.BindJSON(c, &req, shared.CodeTerminalPayloadInvalid) {
		return
	}
	meta, err := store.Get().AgentSession.Get(id)
	if err != nil || meta == nil {
		// meta 未落库的窗口期：按存活会话补建（标记动作不因创建链异步而失败）
		if s := terminal.DefaultManager.GetSession(id); s != nil {
			meta = &store.AgentSessionMeta{
				ID:        s.ID,
				Dir:       s.Path,
				Name:      s.Name,
				ProjectID: s.ProjectID,
				CreatedAt: s.CreatedAt,
			}
		} else {
			shared.Error(c, http.StatusNotFound, "session not found", fmt.Errorf("session meta not found"))
			return
		}
	}
	meta.Sensitive = *req.Sensitive
	if err := store.Get().AgentSession.Save(*meta); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Terminal operation failed", err)
		return
	}
	broadcastTerminalsChanged()
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"sessionId": id, "sensitive": meta.Sensitive, "at": time.Now()}})
}
