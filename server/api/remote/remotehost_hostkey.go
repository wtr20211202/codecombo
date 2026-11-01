package remote

import (
	"fmt"
	"net/http"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// SSH 主机指纹 TOFU 重置入口（P-20261003-34）：合法迁移（服务器重装/换主机钥）
// 后连接被拒，管理员在此重置钉扎、下次连接重新 TOFU。重置动作入审计与通知
// 中心（指纹重置意味着下一连不再有中间人防护，属需感知的安全事件）。

// GetRemoteHostKey GET /api/remotehosts/:id/hostkey —— 当前钉扎的 SSH 主机指纹
// （未记录 = 尚未连接过，首连时按 TOFU 记录）
func GetRemoteHostKey(c *gin.Context) {
	rh, err := store.Get().RemoteHost.Get(c.Param("id"))
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return
	}
	fp, algo, ok, err := store.Get().SSHHostKey.Get(rh.Host, rh.Port)
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "read host key fingerprint failed", err)
		return
	}
	if !ok {
		c.JSON(http.StatusOK, gin.H{"data": gin.H{"pinned": false}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"pinned":      true,
		"fingerprint": fp,
		"algo":        algo,
	}})
}

// ResetRemoteHostKey POST /api/remotehosts/:id/hostkey/reset —— 清除该主机
// 的钉扎指纹（下次连接重新 TOFU）。幂等：未钉扎时同样返回成功
func ResetRemoteHostKey(c *gin.Context) {
	rh, err := store.Get().RemoteHost.Get(c.Param("id"))
	if err != nil {
		shared.Error(c, http.StatusNotFound, "remote host not found", err)
		return
	}
	if err := store.Get().SSHHostKey.Delete(rh.Host, rh.Port); err != nil {
		shared.Error(c, http.StatusInternalServerError, "reset host key fingerprint failed", err)
		return
	}
	// 池内旧连接即时出池（P-20261005-159）：指纹重置后下次借出按新钥重新
	// TOFU——池化连接存活期跳过重复校验是「同一信任连接」的语义，重置必须
	// 打破它，否则重置入口对池内活连接形同虚设
	FlushPoolHost(rh.ID)
	// 审计入账：重置后下一连不再有中间人防护，属安全敏感动作（记 host 摘要）
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditHostKeyReset,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (%s:%d)", rh.Name, rh.Host, rh.Port),
	})
	// 通知中心感知：i18n 模板键优先（audit.notify.hostkeyReset.*），原文兜底；
	// 标题含对象名、来源 IP 入 body（P-20261003-54：三类破坏性安全操作回执
	// 统一带对象名与审计同源 ClientIP，webhook 外发的手机端可定位可归因）
	store.Get().Notification.Add(notification.Notification{
		Type:      "warning",
		Category:  notification.CategorySystem,
		TitleKey:  "audit.notify.hostkeyReset.title",
		BodyKey:   "audit.notify.hostkeyReset.body",
		Title:     fmt.Sprintf("SSH 主机指纹已重置：%s", rh.Name),
		Body:      fmt.Sprintf("%s (%s:%d) 的主机密钥指纹已清除，下次连接将重新记录（来源 IP %s）", rh.Name, rh.Host, rh.Port, c.ClientIP()),
		MsgParams: map[string]any{"name": rh.Name, "host": rh.Host, "port": rh.Port, "ip": c.ClientIP()},
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"pinned": false, "resetAt": time.Now().Format(time.RFC3339)}})
}
