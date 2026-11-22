package shareapi

// 分享协作通道——管理面端点族（P-20261024-1，P-20261121-1 统一收编）：分享
// 无编辑面（全仓分享零 PUT/PATCH，生命=创建→revoke/rotate/freeze），开关与
// 收回全部**动作化**行内端点，不做编辑接口：
//   - POST /:token/collab          协作通道开关（上传/受限留言输入面）
//   - POST /:token/guest-input     申请通道开关（访客输入·申请批准路径，
//     缺省开——P-20261121-1 由 direct-input 开关统一收编替换）
//   - GET  /:token/drops           收件清单（含绝对路径——主人侧唯一出口）
//   - POST /:token/drops/:id/consume  标已消费（交给会话即标，TTL 消费语义）
//   - DELETE /:token/drops/:id     单删素材（垃圾出清通道）
//   - POST /:token/direct/approve  批准访客申请（会话存活判定在此；agent
//     会话限定随「普通终端不开放直通」限制一并退役）
//   - POST /:token/direct/revoke   一键收回持权（四路入口共用）
//   - GET  /:token/direct          持权/申请状态投影（管理面轮询数据源）
//
// 申请批准路径安全链：申请通道缺省在场（GuestInputOff 反向极性字段，owner
// 可显式关）→ 访客申请（10min 时效，P-20261121-2 由 60s 延长；到达即通知
// 中心入账 + sc-ops:share.direct-request 广播双路 owner 感知）
// → 批准（判定锚定会话存活 + 授予持权；会话输入闸经 Service gateLedger
// 合并账本单点落）→ 访客键入（统一 WS 上行桥，持权帧触达）→ 收回/超时/
// 关通道级联（账本释放闸 + 主动断开该访客 WS）。store.SetGuestInput 只管
// 记录字段，持权状态机与闸账本在 server/share.Service（进程内短时效）。

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

// setShareDirectCallbacks 注入持权回收回调（Module Start 接线）：非 owner
// 缘由的审计（expired/cascade/channel_closed 在访客面惰性路径或无 gin 上下文
// 的服务侧路径产生，经 store.Audit.Append 直写——FlushViewAudits 同款裸
// Append 先例）。会话侧输入闸的解除不在此——P-20261121-1 起收口进 Service
// gateLedger 账本路径（gateRelease 单点落闸），回调只管审计不碰 terminal
func setShareDirectCallbacks(s *share.Service) {
	s.WithDirectRelease(func(token, sessionID, reason string) {
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

// ── 访客输入·申请通道开关（统一收编后的行内端点） ──

// guestInputToggleReq 申请通道开关请求。On=true 开启（写 GuestInputOff=false
// ——通道缺省在场，本方向是显式回开），On=false 关闭即回收（在途申请与持权
// 级联清 + 该访客 WS 连接主动断开——回收永远是安全方向，无 confirm 闸）。
// 与旧 direct-input 开关的差异（P-20261121-1 统一收编定案）：无 confirm 摩擦
// ——申请是惰性请求（批准才产生授权，批准闸始终在 owner），通道开关不再
// 承担「键盘直入」的暴露面变更语义（那已归开放直入开关的 confirm+口令门
// 三闸）；关闭方向照旧零摩擦
type guestInputToggleReq struct {
	On bool `json:"on"`
}

// SetShareGuestInput POST /api/share/:token/guest-input —— 申请通道开关
// （动作化，分享无编辑面）。仅 kind=terminal 记录有意义（申请锚定终端会话；
// 其余形态申请端点天然 404，本端点对形态不做硬闸——通道字段对它们惰性）。
// 关闭时级联回收在途申请与持权（RevokeDirect channel_closed 缘由：账本释放
// 会话输入闸 + 该访客 WS 连接主动断开 + 非 owner 缘由审计经回调落）。开启/
// 关闭均入审计（share.guestInput 动作键）
func SetShareGuestInput(c *gin.Context) {
	token := c.Param("token")
	var req guestInputToggleReq
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
	updated, err := st.Share.SetGuestInput(token, req.On)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			shared.Error(c, http.StatusNotFound, "share not found", nil)
			return
		}
		shared.Error(c, http.StatusInternalServerError, "set share guest input failed", err)
		return
	}
	if !req.On && shareSvc != nil {
		// 关闭即回收：在途申请+持权立刻失效（channel_closed 缘由——回调补
		// 非 owner 缘由审计；会话输入闸由 Service 账本就地解除、该访客 WS
		// 连接主动断开，必改2）。开关动作自身的审计在下面以本 handler 请求
		// 上下文落，不双写
		_, _ = shareSvc.RevokeDirect(token, "channel_closed")
	}
	action := "off"
	if req.On {
		action = "on"
	}
	slog.Info("share guest-input toggled", "token", share.TokenSummary(token), "state", action)
	middleware.AuditAppend(c, store.AuditEvent{
		Action: store.AuditShareGuestInput,
		Result: store.AuditResultSuccess,
		IP:     c.ClientIP(),
		Detail: fmt.Sprintf("%s guest-input %s", token, action),
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
// 输入申请（申请批准路径单持有者握手 owner 半边，P-20261121-1 统一收编后
// 为「访客输入」的授权动作之一）。锚定会话不存在（404）拒绝授予；agent
// 会话限定**退役**（用户定向：「普通终端不开放直通」限制随统一自然消亡
// ——统一后访客向任意锚定终端键入，语义升格已在管理面文案如实改写）。
// 授予即经 GrantDirect 落持权 + 会话输入闸账本置位（owner 侧让位，单持有
// 者语义的服务端强制面）+ WS 对账帧（等待中的访客即刻看到「已批准」）。
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
	if cur.GuestInputOff {
		shared.Error(c, http.StatusBadRequest, "guest input channel is off", nil)
		return
	}
	if cur.Kind != store.ShareKindTerminal || cur.TerminalID == "" {
		shared.Error(c, http.StatusBadRequest, "guest input requires a terminal live share", nil)
		return
	}
	if terminal.DefaultManager.GetSession(cur.TerminalID) == nil {
		shared.Error(c, http.StatusNotFound, "terminal session not found", nil)
		return
	}
	if shareSvc == nil {
		shared.Error(c, http.StatusServiceUnavailable, "share service unavailable", nil)
		return
	}
	// 在途申请解析：显式 visitorId 须有对应在途申请（10min 时效内）；缺省
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
	// GrantDirect 落持权 + 账本置会话输入闸（gateAcquire——「谁在输入」单
	// 持有者语义的服务端强制面；收回/超时/关通道统一解除）+ WS 对账帧
	shareSvc.GrantDirect(token, visitorID, nick)
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
			Title:    "访客输入已授予",
			Body:     "「" + cur.Name + "」" + nickShow + " 正在向会话键入（10 分钟无输入自动收回）",
			Time:     time.Now(),
			MsgParams: map[string]any{
				"name": cur.Name, "nick": nickShow,
			},
			Action:        "shdirect-revoke",
			ActionPayload: token,
		})
	}
	slog.Info("share guest input granted", "token", share.TokenSummary(token),
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

// RevokeShareDirect POST /api/share/:token/direct/revoke —— 一键收回访客
// 输入权（管理器行内/通知中心持权卡/会话侧徽标三路入口 + 回收端点第四路
// 共用）。幂等（无持权也成功——「确保收回」语义）；回收即账本解除会话
// 输入闸 + 该访客 WS 连接主动断开（RevokeDirect 内三件套）+ 审计
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
		slog.Info("share guest input revoked", "token", share.TokenSummary(token),
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

// GetShareDirect GET /api/share/:token/direct —— 申请批准路径状态投影
// （管理面轮询数据源 + 会话侧徽标；agent 可编程消费面）：通道在场（enabled
// ——P-20261121-1 语义收编为申请通道开关投影）/锚定会话存活与 kind/在途
// 申请/生效持权。惰性时效在投影路径顺带生效（超时持权回收 + 账本解除会话
// 闸 + 该访客 WS 断开）
func GetShareDirect(c *gin.Context) {
	token := c.Param("token")
	cur, err := store.Get().Share.Get(token)
	if err != nil {
		shared.Error(c, http.StatusNotFound, "share not found", nil)
		return
	}
	out := gin.H{"enabled": !cur.GuestInputOff, "kind": cur.Kind}
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
