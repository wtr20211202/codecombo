package notify

import (
	"codecombo/server/api/shared"
	"net/http"
	"time"

	"codecombo/server/notification"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// ListNotifications GET /api/notifications
func ListNotifications(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"data": store.Get().Notification.List(0)})
}

// AddNotification POST /api/notifications
func AddNotification(c *gin.Context) {
	var n notification.Notification
	if err := c.ShouldBindJSON(&n); err != nil {
		shared.Error(c, http.StatusBadRequest, "Notification operation failed", err)
		return
	}
	if n.Type == "" || n.Title == "" {
		shared.Error(c, http.StatusBadRequest, "type and title are required", nil)
		return
	}
	n.ID = ""
	n.Time = time.Time{}
	n.Read = false
	n.SnoozeUntil = nil // 新入账通知不携带延后态（字段随载荷可反序列化，防御性清零）
	store.Get().Notification.Add(n)
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// SnoozeNotification POST /api/notifications/snooze/:id
// 稍后提醒（P-20261003-36）：body {"snoozeUntil":"RFC3339"} 打延后标记（前端
// 三档菜单算好绝对时刻传入，服务端不做相对时长语义）；空串/缺省 = 取消延后，
// 条目恢复原位次与原已读态。到点重挂由 notify 模块分钟巡检完成，不经本端点
func SnoozeNotification(c *gin.Context) {
	var req struct {
		SnoozeUntil string `json:"snoozeUntil"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Notification operation failed", err)
		return
	}
	var until time.Time
	if req.SnoozeUntil != "" {
		parsed, err := time.Parse(time.RFC3339, req.SnoozeUntil)
		if err != nil {
			// err 传 nil：publicMsg 直出不依赖 devMode（P-20261003-26 同款），
			// 前端按稳定原文匹配展示
			shared.Error(c, http.StatusBadRequest, "snoozeUntil must be RFC3339 or empty", nil)
			return
		}
		until = parsed
	}
	if !store.Get().Notification.Snooze(c.Param("id"), until) {
		shared.Error(c, http.StatusNotFound, "notification not found", nil)
		return
	}
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// ReadAllNotifications POST /api/notifications/read-all
func ReadAllNotifications(c *gin.Context) {
	store.Get().Notification.MarkAllRead()
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// ReadOneNotification POST /api/notifications/read/:id
func ReadOneNotification(c *gin.Context) {
	store.Get().Notification.MarkRead(c.Param("id"))
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// DismissNotification POST /api/notifications/dismiss/:id
func DismissNotification(c *gin.Context) {
	store.Get().Notification.Dismiss(c.Param("id"))
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// DismissNotificationsBatch POST /api/notifications/dismiss-batch
// 批量移除：通知中心同类聚合后整组清除、按分类清空（ids 上限 1000 防误传
// 超大载荷；通知总量本身封顶 200）
func DismissNotificationsBatch(c *gin.Context) {
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || len(req.IDs) == 0 {
		shared.Error(c, http.StatusBadRequest, "ids required", err)
		return
	}
	if len(req.IDs) > 1000 {
		req.IDs = req.IDs[:1000]
	}
	store.Get().Notification.DismissMany(req.IDs)
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// ClearNotifications POST /api/notifications/clear
func ClearNotifications(c *gin.Context) {
	store.Get().Notification.Clear()
	c.JSON(http.StatusOK, gin.H{"message": "ok"})
}

// GetNotificationPrefs GET /api/notifications/prefs
func GetNotificationPrefs(c *gin.Context) {
	c.JSON(http.StatusOK, store.Get().Notification.GetPrefs())
}

// UpdateNotificationPrefs PUT /api/notifications/prefs
// 部分合并语义：只更新请求体中出现的字段（指针判存在），未提及字段保留
// 原值——此前整体覆盖曾把「只调阈值」的部分请求变成「关闭全部通知 +
// 关桌面通知」（零值覆盖），实测由 API 回环测试揪出
func UpdateNotificationPrefs(c *gin.Context) {
	var req struct {
		Enabled                *map[string]bool            `json:"enabled"`
		LongTaskThresholdMs    *int                        `json:"longTaskThresholdMs"`
		DesktopNotify          *bool                       `json:"desktopNotify"`
		Webhook                *notification.WebhookPrefs  `json:"webhook"`
		LongSessionNotifySec   *int                        `json:"longSessionNotifySec"`
		ClaudeSpendAlertTokens *int                        `json:"claudeSpendAlertTokens"`
		ProjectMutes           *[]notification.ProjectMute `json:"projectMutes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "Notification operation failed", err)
		return
	}
	p := store.Get().Notification.GetPrefs()
	if req.Enabled != nil {
		p.Enabled = *req.Enabled
	}
	// 项目静音清单（P-20261003-168）：归一在写入端收口（去空/去重/封顶），
	// GET 回读即合法值
	if req.ProjectMutes != nil {
		p.ProjectMutes = notification.NormalizeProjectMutes(*req.ProjectMutes)
	}
	if req.LongTaskThresholdMs != nil {
		p.LongTaskThresholdMs = *req.LongTaskThresholdMs
	}
	if req.LongSessionNotifySec != nil {
		p.LongSessionNotifySec = notification.ClampLongSessionSec(*req.LongSessionNotifySec)
	}
	// 会话花费阈值告警（P-20261003-157）：钳制写入端收口（<=0=关，越界收敛
	// 边界），GET 回读即合法值
	if req.ClaudeSpendAlertTokens != nil {
		p.ClaudeSpendAlertTokens = notification.ClampSpendTokens(*req.ClaudeSpendAlertTokens)
	}
	if req.DesktopNotify != nil {
		p.DesktopNotify = *req.DesktopNotify
	}
	if req.Webhook != nil {
		p.Webhook = req.Webhook.Normalized()
	}
	if err := store.Get().Notification.SavePrefs(p); err != nil {
		shared.Error(c, http.StatusInternalServerError, "Notification operation failed", err)
		return
	}
	c.JSON(http.StatusOK, p)
}

// TestWebhookPush POST /api/notifications/webhook-test
// 设置页「发送测试推送」：走已保存偏好同步外发一条测试消息（5s 超时），
// 结果回传 UI 展示——配置错误/端点不可达在此即知，不等第一条真实事件
func TestWebhookPush(c *gin.Context) {
	p := store.Get().Notification.GetPrefs()
	if err := notification.SendTest(p); err != nil {
		shared.Error(c, http.StatusBadRequest, err.Error(), err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
