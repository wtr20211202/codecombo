package shareapi

// 可写分享——管理面端点族（P-20261106-8「对方可直接输入」模式）：分享无
// 编辑面（协作通道 handlers_collab.go 同款动作化纪律），开关与批量全部
// **动作化**行内端点：
//   - POST /:token/writable        可写开关（单条；口令门强制在此）
//   - POST /writable/batch         可写批量开关（管理列表多选）
//   - POST /:token/paste/:pid/decision  粘贴审批决策（批准/拒绝）
//
// 安全面（评审修订点5定案）：开启可写把泄露半径从「看输出」抬到「打
// shell」——三道闸缺一不可：①显式 confirm（管理面摩擦硬闸，与直通档
// 同款，缺标记 400——agent/脚本不可静默开启）；②强制口令门（记录未持
// 口令时必须随请求补设，passphrase 落库即发门——token 短链是 bearer 凭据
// 会在聊天中转发，一道口令是成比例的补偿）；③开启响应附 ttlHint（前端
// 提示缩短 TTL——暴露窗口与授权面成正比，提示非强制）。关闭方向零摩擦
//（回收永远是安全方向），关闭即断全部上行连接 + 清待批粘贴面 + 解除会话
// 侧输入闸。

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/share"
	"codecombo/server/store"

	"github.com/gin-gonic/gin"
)

// maxBatchWritableTokens 单次批量开关的条目上限（与批量冻结分享的 50 项
// 同档）：管理列表多选的真实量级是个位数到十位数，上限防把端点当批处理
// 通道滥用
const maxBatchWritableTokens = 50

// writableToggleReq 可写开关请求。On=true 需 Confirm 显式确认 + 口令门就位
// （记录无口令时必携 Passphrase 补设——明文只存在于本请求内，哈希落库即
// 发门）；On=false 即回收（上行连接断开/待批面清空/会话闸解除，Confirm
// 不需要）
type writableToggleReq struct {
	On         bool   `json:"on"`
	Confirm    bool   `json:"confirm"`
	Passphrase string `json:"passphrase"`
}

// SetShareWritable POST /api/share/:token/writable —— 可写分享开关（动作化，
// 分享无编辑面）。仅 kind=terminal 直播形态可开（组合语义修订点6：frozen/
// cast/session/file 天然只读，400 可编程感知）；开关/补设口令均入审计。
// 未知/已撤销/已过期 → 404（与轮换同口径）
func SetShareWritable(c *gin.Context) {
	token := c.Param("token")
	var req writableToggleReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	st := store.Get()
	cur, err := st.Share.Get(token)
	if err != nil || cur.Expired(time.Now()) {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	if req.On {
		// 开启三闸：显式确认 + 形态限定（terminal live）+ 强制口令门
		if !req.Confirm {
			shared.Error(c, http.StatusBadRequest, "writable requires explicit confirmation", nil)
			return
		}
		if cur.Kind != store.ShareKindTerminal || cur.TerminalID == "" {
			shared.Error(c, http.StatusBadRequest,
				"writable requires a terminal live share", nil)
			return
		}
	}
	if req.On && cur.PassphraseHash == "" {
		// 口令门强制（修订点5）：无门记录必须随请求补设——拒绝不带口令的
		// 开启（错误码稳定，前端据此弹「先设口令」输入框）
		if req.Passphrase == "" {
			shared.Error(c, http.StatusBadRequest, "writable requires a passphrase", nil)
			return
		}
		hash, herr := hashPassphrase(req.Passphrase)
		if herr != nil {
			shared.Error(c, http.StatusBadRequest, herr.Error(), nil)
			return
		}
		if _, err := st.Share.SetPassphrase(token, hash); err != nil {
			shared.Error(c, http.StatusInternalServerError, "set share passphrase failed", err)
			return
		}
		// 口令门设置与可写开启是同一动作的两面，各留一条审计（口令门台账
		// 的完整性优先于事件合并——SetSharePassphrase 同族 Detail 口径）
		middleware.AuditAppend(c, store.AuditEvent{
			Action: store.AuditSharePassphrase,
			Result: store.AuditResultSuccess,
			IP:     c.ClientIP(),
			Detail: fmt.Sprintf("%s set", token),
		})
	}
	updated, err := st.Share.SetWritable(token, req.On)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusNotFound, "share not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "set share writable failed", err)
		return
	}
	if !req.On && shareSvc != nil {
		// 关闭即回收：上行连接即刻断开（各连接回落只读）+ 待批粘贴面清空
		//（拒绝广播随清场发出）+ 会话侧输入闸随连接 defer 解除
		shareSvc.WritableDown(token)
	}
	action := "off"
	if req.On {
		action = "on"
	}
	slog.Info("share writable toggled", "token", share.TokenSummary(token),
		"state", action, "session", updated.TerminalID)
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareWritable,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (%s) %s, session %s", updated.Name, token, action, updated.TerminalID),
	})
	// ttlHint 开启方向恒带（P-20261020-5 的 TTL 面前端已有——提示缩短
	// TTL 是响应级约定，前端弹层展示；零值 = 已是短窗或记录永不过期）
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*updated), "ttlHint": req.On})
}

// batchWritableReq 批量开关请求。On=true 时逐条校验（形态/口令门不就位的
// 条目按 reason 跳过而非整单失败——批量语义下部分就位是常态）；On=false
// 全部回收。confirm 摩擦与单条同款（批量方向同样的硬闸）
type batchWritableReq struct {
	Tokens  []string `json:"tokens" binding:"required"`
	On      bool     `json:"on"`
	Confirm bool     `json:"confirm"`
}

// BatchShareWritable POST /api/share/writable/batch —— 可写批量开关（管理
// 列表多选）。逐条独立结算并返回 per-token 结果（{token,ok,reason}——
// reason: ok/not_found/not_terminal/passphrase_required/confirm_required），
// 审计一条汇总（批量动作的暴露面变更是单事件，逐条 token 摘要在 Detail）
func BatchShareWritable(c *gin.Context) {
	var req batchWritableReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	if len(req.Tokens) == 0 {
		shared.Error(c, http.StatusBadRequest, "tokens is empty", nil)
		return
	}
	if len(req.Tokens) > maxBatchWritableTokens {
		shared.Error(c, http.StatusBadRequest,
			fmt.Sprintf("tokens exceeds %d entries", maxBatchWritableTokens), nil)
		return
	}
	if req.On && !req.Confirm {
		// 批量开启与单条同一摩擦硬闸（confirm_required 逐条返还不如整体
		// 400——这是调用方的协议错误不是条目差异）
		shared.Error(c, http.StatusBadRequest, "writable requires explicit confirmation", nil)
		return
	}
	st := store.Get()
	type itemResult struct {
		Token  string `json:"token"`
		Ok     bool   `json:"ok"`
		Reason string `json:"reason,omitempty"`
		Name   string `json:"-"`
	}
	out := make([]itemResult, 0, len(req.Tokens))
	for _, token := range req.Tokens {
		cur, err := st.Share.Get(token)
		if err != nil || cur.Expired(time.Now()) {
			out = append(out, itemResult{Token: token, Reason: "not_found"})
			continue
		}
		if req.On {
			if cur.Kind != store.ShareKindTerminal || cur.TerminalID == "" {
				out = append(out, itemResult{Token: token, Reason: "not_terminal"})
				continue
			}
			if cur.PassphraseHash == "" {
				// 批量方向不携带逐条口令：无门条目跳过（管理面提示逐条补设
				// 后重试）——批量补设口令会把「一道口令」变成「一个口令管
				// 多链」，补偿强度反而摊薄
				out = append(out, itemResult{Token: token, Reason: "passphrase_required"})
				continue
			}
		}
		if _, err := st.Share.SetWritable(token, req.On); err != nil {
			out = append(out, itemResult{Token: token, Reason: "failed"})
			continue
		}
		if !req.On && shareSvc != nil {
			shareSvc.WritableDown(token)
		}
		out = append(out, itemResult{Token: token, Ok: true, Reason: "ok", Name: cur.Name})
	}
	okN := 0
	for _, r := range out {
		if r.Ok {
			okN++
		}
	}
	slog.Info("share writable batch", "on", req.On, "total", len(req.Tokens), "ok", okN)
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareWritable,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("batch %s: %d/%d ok", writableActionLabel(req.On), okN, len(req.Tokens)),
	})
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// writableActionLabel 审计 Detail 的方向标注（语言中立）
func writableActionLabel(on bool) string {
	if on {
		return "on"
	}
	return "off"
}

// pasteDecisionReq 粘贴审批决策请求（approve=true 注入 / false 丢弃）
type pasteDecisionReq struct {
	Approve bool `json:"approve"`
}

// DecideSharePasteReview POST /api/share/:token/paste/:pid/decision —— 可写
// 分享粘贴审批决策（审批分层修订点2的 owner 半边）：approve=true 把待批
// 整块注入 PTY（回显经输出流到达双方屏幕）；false 丢弃。幂等（未知/已决
// 404——决策卡只能点一次，重复点击零副作用）。决策入审计（批准记摘要
// 元数据，粘贴块本体不入账——quickdrop 同口径；块内容在终端回显侧全程
// 可见，审计承载的是「谁在何时批准了什么模式」的对账面）
func DecideSharePasteReview(c *gin.Context) {
	token, pid := c.Param("token"), c.Param("pid")
	var req pasteDecisionReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	cur, err := store.Get().Share.Get(token)
	if err != nil || cur.Expired(time.Now()) {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	if shareSvc == nil {
		shared.Error(c, http.StatusServiceUnavailable, "share service unavailable", nil)
		return
	}
	if !shareSvc.ResolvePasteReview(token, pid, req.Approve) {
		shared.Error(c, http.StatusNotFound, "paste review not found or already decided", nil)
		return
	}
	decision := "denied"
	if req.Approve {
		decision = "approved"
	}
	slog.Info("share paste review decided", "token", share.TokenSummary(token),
		"paste", pid, "decision", decision)
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareWritablePaste,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (%s) paste %s %s by owner, session %s", cur.Name, token, pid, decision, cur.TerminalID),
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true, "approved": req.Approve}})
}
