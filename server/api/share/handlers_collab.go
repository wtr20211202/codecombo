package shareapi

// 分享协作通道——管理面端点族（P-20261024-1）：分享无编辑面（全仓分享零
// PUT/PATCH，生命=创建→revoke/rotate/freeze），开关与收回全部**动作化**
// 行内端点，不做编辑接口：
//   - POST /:token/collab          协作通道开关（上传/受限留言输入面）
//   - POST /:token/direct-input    直通输入档开关（第二档独立开关，缺省关）
//   - GET  /:token/drops           收件清单（含绝对路径——主人侧唯一出口）
//   - POST /:token/drops/:id/consume  标已消费（交给会话即标，TTL 消费语义）
//   - DELETE /:token/drops/:id     单删素材（垃圾出清通道）
//   - POST /:token/direct/approve  批准访客申请（agent 会话限定判定在此）
//   - POST /:token/direct/revoke   一键收回持权（四路入口共用）
//   - GET  /:token/direct          持权/申请状态投影（管理面轮询数据源）
//
// 直通档安全链：开启（需显式 confirm 管理面摩擦）→ 访客申请（60s 时效）
// → 批准（判定锚定会话 kind=agent + 置会话只读闸）→ 访客输入（4KB/批，
// 全量审计）→ 收回/超时/级联（解除只读闸）。store.SetDirectInput 只管
// 记录字段，持权状态机在 server/share.Service（进程内短时效）。

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"codecombo/server/api/shared"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/share"
	"codecombo/server/store"
	"codecombo/server/terminal"

	"github.com/gin-gonic/gin"
)

// shareSvc 运行中的访客面服务（Module Start 装配、Stop 摘除——liveWire
// 同款包级接线；nil = 未装配，协作端点 503 降级）。
var shareSvc *share.Service

// setShareSvc 注入/摘除访客面服务（Module Start/Stop 调用；测试可直接置 nil）
func setShareSvc(s *share.Service) { shareSvc = s }

// setShareDirectCallbacks 注入直通持权回调（Module Start 接线）：会话只读
// 闸解除 + 非 owner 缘由的审计（expired 在访客面惰性路径产生，无 gin 上下文，
// 经 store.Audit.Append 直写——FlushViewAudits 同款裸 Append 先例）
func setShareDirectCallbacks(s *share.Service) {
	s.WithDirectRelease(func(token, sessionID, reason string) {
		releaseDirectGate(sessionID)
		if reason == "owner" {
			return // owner 缘由的审计在带 gin 上下文的 handler 落，不双写
		}
		if st := store.Get(); st != nil && st.Audit != nil {
			name := token
			if sh, err := st.Share.Get(token); err == nil {
				name = sh.Name
			}
			st.Audit.Append(store.AuditEvent{
				Action: store.AuditShareDirectRevoke,
				Result: store.AuditResultSuccess,
				Time:   time.Now(),
				Detail: fmt.Sprintf("%s (%s), reason: %s", name, token, reason),
			})
		}
	})
}

// releaseDirectGate 解除会话侧直通只读闸（会话已关 = 闸随会话消亡，幂等直通）
func releaseDirectGate(sessionID string) {
	if sessionID == "" {
		return
	}
	if sess := terminal.DefaultManager.GetSession(sessionID); sess != nil {
		sess.SetDirectInputHold(false)
	}
}

// ── 协作通道开关（动作化行内端点） ──

// collabToggleReq 协作通道开关请求（true 开 / false 关——关闭即回收上传
// 位与受限留言档，存量素材保留可读）
type collabToggleReq struct {
	Collab bool `json:"collab"`
}

// SetShareCollab POST /api/share/:token/collab —— 协作通道开关（动作化，
// 分享无编辑面）。任何形态可开（素材上行不依赖分享形态；受限留言档随
// 记录开关取档）。开关是暴露面变更，与创建/撤销同族入审计。
// 未知/已撤销/已过期 → 404（与轮换同口径）
func SetShareCollab(c *gin.Context) {
	token := c.Param("token")
	var req collabToggleReq
	if err := c.ShouldBindJSON(&req); err != nil {
		shared.Error(c, http.StatusBadRequest, "invalid request", err)
		return
	}
	updated, err := store.Get().Share.SetCollab(token, req.Collab)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusNotFound, "share not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "set share collab failed", err)
		return
	}
	action := "off"
	if req.Collab {
		action = "on"
	}
	slog.Info("share collab toggled", "token", share.TokenSummary(token), "state", action)
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareCollab,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s %s", token, action),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*updated)})
}

// ── 直通输入档开关（第二档独立开关，与协作通道互不联动） ──

// directInputToggleReq 直通档开关请求。On=true 需 Confirm 显式确认（管理面
// 密码级摩擦：前端二次确认弹层 + 服务端确认标记双闸——缺 confirm 一律 400，
// agent/脚本不可静默开启直通档）；On=false 即回收（持权立刻失效 + 会话闸
// 解除，Confirm 不需要——回收永远是安全方向）
type directInputToggleReq struct {
	On      bool `json:"on"`
	Confirm bool `json:"confirm"`
}

// SetShareDirectInput POST /api/share/:token/direct-input —— 直通输入档开关。
// 开启仅对 kind=terminal 记录有意义（直通输入锚定会话；store 兜底清只防
// 绕过 API 直入，这里给可编程感知的 400）；关闭时级联回收持权 + 解除会话
// 只读闸。开启/关闭均入审计
func SetShareDirectInput(c *gin.Context) {
	token := c.Param("token")
	var req directInputToggleReq
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
		// 开启三闸：显式确认（管理面摩擦）+ 形态限定（terminal）+ 会话锚点在场
		if !req.Confirm {
			shared.Error(c, http.StatusBadRequest,
				"direct input requires explicit confirmation", nil)
			return
		}
		if cur.Kind != store.ShareKindTerminal || cur.TerminalID == "" {
			shared.Error(c, http.StatusBadRequest,
				"direct input requires a terminal live share", nil)
			return
		}
	}
	updated, err := st.Share.SetDirectInput(token, req.On)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusNotFound, "share not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "set share direct input failed", err)
		return
	}
	if !req.On && shareSvc != nil {
		// 关闭即回收：持权立刻失效 + 会话只读闸解除（cascade 缘由经回调
		// 就地解除闸；开关动作的审计在下面以本 handler 请求上下文落）
		_, _ = shareSvc.RevokeDirect(token, "cascade")
	}
	action := "off"
	if req.On {
		action = "on"
	}
	slog.Info("share direct-input toggled", "token", share.TokenSummary(token), "state", action)
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareCollab,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s direct-input %s", token, action),
	})
	c.JSON(http.StatusOK, gin.H{"data": shareResponse(*updated)})
}

// ── 收件清单与消费语义（主人侧） ──

// ListShareDrops GET /api/share/:token/drops —— 收件清单（含绝对路径：
// 主人侧唯一出口，「把绝对路径贴进所选会话」动作链的取数点；访客面清单
// 无路径——零路径泄露的界在这里）。未知/已撤销 → 404；协作开关关闭不
// 阻断清单（存量已收素材保留可读）
func ListShareDrops(c *gin.Context) {
	token := c.Param("token")
	cur, err := store.Get().Share.Get(token)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	list := share.ListDropsFor(token)
	out := make([]gin.H, 0, len(list))
	for _, m := range list {
		out = append(out, gin.H{
			"id":         m.ID,
			"name":       m.Name,
			"fileName":   m.FileName,
			"size":       m.Size,
			"kind":       m.Kind,
			"nick":       m.Nick,
			"at":         m.At,
			"consumedAt": m.ConsumedAt,
			"sensitive":  m.Sensitive,
			"absPath":    share.DropAbsPath(token, m.FileName),
		})
	}
	c.JSON(http.StatusOK, gin.H{"data": out, "share": gin.H{"name": cur.Name, "collab": cur.Collab}})
}

// ConsumeShareDrop POST /api/share/:token/drops/:id/consume —— 标记素材
// 已消费（TTL 消费语义的落盘点：已消费 24h 清、未消费 72h 清——防主人
// 未看即被清）。「交给当前会话/新会话处理」动作链成功后调用；未知素材
// 404（清单与落盘竞态的诚实呈现）
func ConsumeShareDrop(c *gin.Context) {
	token, id := c.Param("token"), c.Param("id")
	if _, err := store.Get().Share.Get(token); err != nil {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	if err := share.ConsumeDrop(token, id, time.Now()); err != nil {
		shared.Error(c, http.StatusNotFound, "drop not found", nil)
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareDropConsume,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s/%s", token, id),
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// DeleteShareDrop DELETE /api/share/:token/drops/:id —— 主人单删素材
// （垃圾出清通道；未知 id 幂等成功，dismiss 语义）
func DeleteShareDrop(c *gin.Context) {
	token, id := c.Param("token"), c.Param("id")
	if _, err := store.Get().Share.Get(token); err != nil {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	if err := share.DeleteDrop(token, id); err != nil {
		shared.Error(c, http.StatusInternalServerError, "delete drop failed", err)
		return
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareDrop,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("delete %s/%s", token, id),
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true}})
}

// ── 直通输入档：批准/收回/状态（握手面的 owner 半边） ──

// directApproveReq 批准请求。VisitorID 可选（缺省 = 批准唯一在途申请；
// 显式携带时须与在途申请一致——管理面多访客场景的指认位）
type directApproveReq struct {
	VisitorID string `json:"visitorId"`
	Nickname  string `json:"nickname"`
}

// ApproveShareDirect POST /api/share/:token/direct/approve —— 批准访客的
// 直通输入申请（单持有者握手 owner 半边）。agent 会话限定判定在此：锚定
// 会话不存在（404）/非 agent（400）都拒绝授予——普通终端直通 = 匿名远程
// shell 等价，明确不做。授予即置会话只读闸（owner 侧让位，单持有者语义）
// + 审计。
func ApproveShareDirect(c *gin.Context) {
	token := c.Param("token")
	var req directApproveReq
	if c.Request.Body != nil && c.Request.ContentLength > 0 {
		if err := c.ShouldBindJSON(&req); err != nil {
			shared.Error(c, http.StatusBadRequest, "invalid request", err)
			return
		}
	}
	st := store.Get()
	cur, err := st.Share.Get(token)
	if err != nil || cur.Expired(time.Now()) {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	if !cur.DirectInput {
		shared.Error(c, http.StatusBadRequest, "direct input is not enabled", nil)
		return
	}
	if cur.Kind != store.ShareKindTerminal || cur.TerminalID == "" {
		shared.Error(c, http.StatusBadRequest, "direct input requires a terminal live share", nil)
		return
	}
	sess := terminal.DefaultManager.GetSession(cur.TerminalID)
	if sess == nil {
		shared.Error(c, http.StatusNotFound, "terminal session not found", nil)
		return
	}
	// agent 会话限定（红线第一闸）：shell 会话直通 = 匿名远程 shell，明确不做
	if sess.Kind != terminal.KindAgent {
		shared.Error(c, http.StatusBadRequest, "direct input is limited to agent sessions", nil)
		return
	}
	if shareSvc == nil {
		shared.Error(c, http.StatusServiceUnavailable, "share service unavailable", nil)
		return
	}
	// 在途申请解析：显式 visitorId 须有对应在途申请（60s 时效内）；缺省
	// 取唯一在途。无申请 409（批准无对象，前端如实提示「申请已过期」）
	pending, _ := shareSvc.DirectState(token)
	if pending == nil {
		shared.Error(c, http.StatusConflict, "no pending direct-input request", nil)
		return
	}
	visitorID := req.VisitorID
	if visitorID == "" {
		visitorID = pending.VisitorID
	} else if visitorID != pending.VisitorID {
		shared.Error(c, http.StatusConflict, "request no longer pending", nil)
		return
	}
	nick := pending.Nick
	if nick == "" {
		nick = req.Nickname
	}
	shareSvc.GrantDirect(token, visitorID, nick)
	// 会话只读闸置位（owner 侧让位——「谁在输入」单持有者语义的服务端
	// 强制面；收回/超时/级联统一解除）
	sess.SetDirectInputHold(true)
	// 持权卡通知（P-20261024-1 回收四路入口之二）：授予即入账一条带「收回」
	// 行内动作的通知条目（Action=shdirect-revoke，payload=token）——owner 不
	// 在管理器时通知中心直达收回。类别走 system（协作面系统事件；drop 类别
	// 语义是素材到达，静音粒度不混淆）。持权过期/收回后本条目留存（点收回
	// 幂等成功），不做条目级联撤——通知是事件留痕非状态投影
	if st.Notification != nil {
		// 昵称展示兜底（Title/Body 是 i18n 模板缺失时的中文兜底，同 share 包
		// displayNick 口径；该函数未导出，api 层同款内联）
		nickShow := nick
		if nickShow == "" {
			nickShow = "匿名访客"
		}
		st.Notification.Add(notification.Notification{
			Type:     "info",
			Category: notification.CategorySystem,
			TitleKey: "share.direct.notify.title",
			BodyKey:  "share.direct.notify.body",
			Title:    "访客直通输入已授予",
			Body:     "「" + cur.Name + "」" + nickShow + " 正在向会话输入（10 分钟无输入自动收回）",
			Time:     time.Now(),
			MsgParams: map[string]any{
				"name": cur.Name, "nick": nickShow,
			},
			Action:        "shdirect-revoke",
			ActionPayload: token,
		})
	}
	slog.Info("share direct-input granted", "token", share.TokenSummary(token),
		"session", cur.TerminalID, "visitor", visitorBrief(visitorID))
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareDirectGrant,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (%s), visitor %s -> session %s (idle ttl %s)",
			cur.Name, token, visitorBrief(visitorID), cur.TerminalID,
			share.DirectHoldIdleTTL),
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{
		"granted":   true,
		"visitorId": visitorID,
		"nick":      nick,
		"sessionId": cur.TerminalID,
	}})
}

// RevokeShareDirect POST /api/share/:token/direct/revoke —— 一键收回直通
// 输入权（管理器行内/通知中心持权卡/会话侧徽标三路入口 + 回收端点第四路
// 共用）。幂等（无持权也成功——「确保收回」语义）；回收即解除会话只读闸
// + 审计
func RevokeShareDirect(c *gin.Context) {
	token := c.Param("token")
	cur, err := store.Get().Share.Get(token)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	if shareSvc == nil {
		shared.Error(c, http.StatusServiceUnavailable, "share service unavailable", nil)
		return
	}
	_, ok := shareSvc.RevokeDirect(token, "owner")
	if ok {
		releaseDirectGate(cur.TerminalID)
		slog.Info("share direct-input revoked", "token", share.TokenSummary(token),
			"session", cur.TerminalID)
	}
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareDirectRevoke,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s (%s), reason: owner, had: %t", cur.Name, token, ok),
	})
	c.JSON(http.StatusOK, gin.H{"data": gin.H{"ok": true, "had": ok}})
}

// GetShareDirect GET /api/share/:token/direct —— 直通档状态投影（管理面
// 轮询数据源 + 会话侧徽标）：开关/锚定会话存活与 kind/在途申请/生效持权。
// 惰性时效在投影路径顺带生效（超时持权回收 + 回调解除会话闸）
func GetShareDirect(c *gin.Context) {
	token := c.Param("token")
	cur, err := store.Get().Share.Get(token)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	out := gin.H{"enabled": cur.DirectInput, "kind": cur.Kind}
	if cur.Kind != store.ShareKindTerminal || cur.TerminalID == "" {
		c.JSON(http.StatusOK, gin.H{"data": out})
		return
	}
	sess := terminal.DefaultManager.GetSession(cur.TerminalID)
	session := gin.H{"id": cur.TerminalID, "alive": sess != nil, "kind": ""}
	if sess != nil {
		session["kind"] = sess.Kind
		session["name"] = sess.Name
	}
	out["session"] = session
	if shareSvc == nil {
		c.JSON(http.StatusOK, gin.H{"data": out})
		return
	}
	pending, hold := shareSvc.DirectState(token)
	if pending != nil {
		out["pending"] = gin.H{
			"visitorId":   pending.VisitorID,
			"nick":        pending.Nick,
			"requestedAt": pending.At,
			"expiresIn":   int((share.DirectRequestTTL - time.Since(pending.At)).Seconds()),
		}
	}
	if hold != nil {
		out["hold"] = gin.H{
			"visitorId":   hold.VisitorID,
			"nick":        hold.Nick,
			"grantedAt":   hold.GrantedAt,
			"lastInputAt": hold.LastInputAt,
			"expiresIn":   int(time.Until(hold.LastInputAt.Add(share.DirectHoldIdleTTL)).Seconds()),
		}
	}
	c.JSON(http.StatusOK, gin.H{"data": out})
}

// visitorBrief 审计 Detail 的 visitorId 摘要（包内转发——share.visitorBrief
// 未导出，api 层用同款形态：前 8 位 + 省略）
func visitorBrief(v string) string {
	if len(v) <= 8 {
		return v
	}
	return v[:8] + "…"
}
