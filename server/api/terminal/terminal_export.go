package terminal

import (
	"fmt"
	"net/http"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/sensitive"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// GetTerminalExport GET /api/terminals/:id/export（P-20261003-100）
// 会话输出整体留档导出：既有 scrollback 读取链（CaptureScrollback）取全量缓冲，
// 剥 ANSI 后直出 text/plain 附件下载（文件名 terminal-<会话名>-<日期>.txt，
// 头净化复用 shared.ContentDispositionFile）。体积护栏沿 scrollback history
// 上限（native 环形容量钳制 / tmux history-limit），见 server/terminal/export.go。
// 寻址与 /terminals/:id/scrollback 同族（会话维度）：提案原拟 /api/terminal-history/:id/export，
// 但 terminal-history 域是按项目的命令历史（OSC 133），会话输出读取链在 /terminals/:id/*。
// 敏感出域闸门（P-20261003-155）：会话被人工标记敏感且未带 override=1 时不出
// 附件，改回 JSON warnings（SensitiveSessionWarning）——前端弹「确认出域」后
// 带 override 重试直出；响应形态差异（JSON vs 附件）即协商通道，与分享扫描
// 的 warnings+override 同一契约。override 直出不打折扣：标记是提示性闸门
// （人工策展），确认后放行是设计语义而非绕过
// 内容敏感闸（P-20261004-113）：导出文本再跑共享敏感扫描（凭据形态 + 敏感
// 文件名），命中且未 confirm=1 时与标记闸合并成一次 JSON warnings（类型计数
// 不附原文）；两条闸并存时前端一次确认后同时带 override=1&confirm=1。扫描
// 在已取出的全量文本上做（scrollback 天然有界），不影响出域字节
// 审计入账（P-20261005-186，terminal.export）：滚回常含命令回显的凭据/token
// 形态，敏感度不低于会话导出（claude.export）/补丁导出同族——「谁在何时导出
// 了哪个会话的输出」可追认（出域动作记账对称，导出族清单见 auditlog.go 常量
// 块尾注）。只记会话名/id/字节量元数据，内容绝不入账；放行路径追加命中类型
// 与计数（仍不含原文），无命中时 Detail 逐字节不变。Append 尽力而为不阻断
// 下载。敏感闸 warnings 分支不入账：未出内容不算出域（override/confirm 放行
// 路径才算），与 share.view「命中有效分享才留痕」的口径一致
func GetTerminalExport(c *gin.Context) {
	id := c.Param("id")
	session := terminal.DefaultManager.GetSession(id)
	if session == nil {
		shared.Error(c, http.StatusNotFound, "session not found", nil)
		return
	}
	// 人工标记闸先判（token 并入同一次警示响应，不让用户为同一导出确认两轮）
	var earlierWarnings []string
	if shared.IsSessionSensitive(id) && c.Query("override") != "1" {
		earlierWarnings = append(earlierWarnings, shared.SensitiveSessionWarning)
	}
	data, err := session.ExportText()
	if err != nil {
		shared.Error(c, http.StatusInternalServerError, "Terminal operation failed", err)
		return
	}
	hits := sensitive.ScanContent(string(data))
	if exportSensitiveGate(c, hits, earlierWarnings...) {
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditTerminalExport,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (%s, %d bytes)%s", session.Name, session.ID, len(data), sensitiveAuditSuffix(hits)),
	})
	name := terminal.ExportDownloadName(session.Name, session.ID, time.Now())
	c.Header("Content-Disposition", shared.ContentDispositionFile(name))
	c.Data(http.StatusOK, "text/plain; charset=utf-8", data)
}
