package share

// 访客输入·申请批准路径（P-20261024-1 直通输入档，P-20261121-1 统一收编）：
// 访客-批准握手降格为统一「访客输入」能力的**授权路径之一**——申请-批准
// 握手机制完整保留（单持有者/短时效/全量审计），独立能力/开关身份退役：
//
//   - 申请通道默认在场：terminal 直播分享创建后访客页即有「申请输入」入口
//    （无 owner 预开步骤——P-20261121-1 用户定向消除「先开通道才能申请」
//     的沟通摩擦）；owner 面保留「申请通道」开关（store.Share.GuestInputOff
//     反向极性字段，缺省开）——关闭即访客入口不渲染 + 申请端点恒 404 +
//     在途申请/持权级联回收。申请=惰性请求（DirectRequestTTL 不决自动过期、
//     批准才产生授权、directLimit 频控），入口默认在场零授权风险。
//   - 单持有者握手：访客申请（10min 不决自动过期——P-20261121-2 由 60s 延长，
//     申请到达有通知中心条目+ops 广播双路 owner 感知）→ owner 批准/拒绝 →
//     授予持权（绑 token+visitorId），同一时刻全链仅一人持权；访客页首访生成
//     localStorage 随机 visitor id，WS 断线重连凭 visitorId 恢复持权判定。
//   - 键入传输统一走可写 WS 上行桥（writable.go handleTermWS）：旧
//     POST /s/{token}/direct/input 端点与其 4KB/sanitize/无 \r 批次语义
//     随本收编退役，持权访客与开放直入访客共用同一键入帧路径（Binary 帧），
//     持权帧顺带 touch 续滑动时效；粘贴危险块 commandrisk 预检两模式同闸。
//     「普通终端不开放直通」的 agent 会话限定随统一自然消亡（用户定向：
//     访客可向任意锚定终端键入并提交——语义升格，管理面文案已如实改写）。
//   - 短时效：10min 无输入自动回收（滑动窗口，WS 键入帧即续）；owner 一键
//     收回（管理器行内/通知中心持权卡/会话侧徽标/回收端点四路入口共用同一
//     端点）；分享撤销/轮换/关闭通道级联回收。收回/过期**主动断开**该访客
//     的 WS 连接（kickDirectVisitor——断开后访客页回落只读并轮询重连）。
//   - 全量审计：申请到达入账（share.direct.request 元数据口径）；键入批次
//     统一入账 share.writableInput 单事件（Detail mode=hold 分档，见
//     writable.go appendConnAudit）；授予/收回入账。
//
// 联动：持权期间锚定会话挂 owner 侧输入闸——经 gateLedger 合并账本驱动
//（必改3：开放直入的「连接在场」与申请批准的「持权在场」两来源统一记账，
// 单点落 writableSink.SetWritableGate 即 terminal.Session.directInputHold
// 同一服务端强制面；双开关并存时关其一不得误归还 owner 键盘给另一模式
// 在场访客）。
//
// 状态存进程内（重启即全回收——短时效持权状态的保守侧语义：重启后 owner
// 重新批准一次即可，不落盘的丢失面 = 多一次点击；持权持久化反而要处理
// 「重启后无人看管的悬空写权」这个更糟的态）。WS 上行连接/待批粘贴面
// 同款进程内取态（writable.go 头注）。

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"codecombo/server/notification"
	"codecombo/server/store"
)

const (
	// DirectRequestTTL 申请时效：10min 不决自动过期（P-20261121-2 由 60s 延长
	// ——原 60s 内 owner 没看管理器/通知申请即无声消失，申请-批准握手断裂，
	// 是用户实测「访客申请 owner 没收到」的放大因子；10min 与持权滑动时效
	// DirectHoldIdleTTL 同档，仍不取消时效——访客可能早已离场，悬空申请会
	// 顶掉同 token 后到访客的申请位）。导出常量：管理面响应投影与文档共用
	// 同一取值
	DirectRequestTTL = 10 * time.Minute
	// DirectHoldIdleTTL 持权滑动时效：10min 无输入自动回收（输入即续——
	// P-20261121-1 起输入=WS 上行桥键入帧，见 writable.go 持权准入段）。
	// 导出常量：管理面响应投影与文档共用同一取值
	DirectHoldIdleTTL = 10 * time.Minute
	// directMaxPerIP / directMaxPerToken 申请频控：申请端点独立窗口（键入
	// 面已统一走 WS 桥帧率双桶，不再共用 HTTP 频控）；每 (token,IP) 每分钟
	// 30 次、token 全局 120 次——对访客交互足够，防的是脚本刷申请面
	directMaxPerIP    = 30
	directMaxPerToken = 120
	directWindow      = time.Minute

	// directBodyLimit 申请端点请求体封顶：visitorId（≤64）+ 昵称（≤24 rune）
	// 的 JSON 至多几 KB，16KiB 与留言体封顶同口径
	directBodyLimit = 16 << 10

	// visitorIDMaxLen visitorId 的长度上限（访客页生成的随机串 32 字符量级，
	// 上限防把持权绑定键当存储通道）
	visitorIDMaxLen = 64
)

// DirectRequest 一条待批申请（单 token 同时至多一条——后到顶掉先到，
// 申请面不排队：owner 的批准动作是「批准当前这个人」，不是从队列挑选）。
// 导出类型：管理面状态投影（GetShareDirect）消费快照
type DirectRequest struct {
	VisitorID string
	Nick      string
	At        time.Time
}

// DirectHold 一份生效持权（token 键；绑 visitorId——SSE 断线重连凭
// visitorId 恢复，visitorId 换人即无权）。导出类型：管理面状态投影与
// 审计 Detail 消费快照
type DirectHold struct {
	VisitorID   string    `json:"visitorId"`
	Nick        string    `json:"nick,omitempty"`
	GrantedAt   time.Time `json:"grantedAt"`
	LastInputAt time.Time `json:"lastInputAt"`
	// SessionID 授予时点的锚定会话快照（json:"-"：管理面投影有独立的
	// session 键，本字段只为回收路径服务）。P-20261122-17：撤销/轮换/
	// 过期三路径都是「先删/换记录再回收」，记录已亡时 shares.Get 失败——
	// 释放会话闸与回收回调不能再依赖 lookup（快照是最后一份会话锚点）
	SessionID string `json:"-"`
}

// directHub 直通持权状态机（Service 持有一枚，经 newDirectHub 构造）。
// 惰性时效：查询/批准/输入路径顺带清扫超时申请与超时持权——不依赖独立
// ticker（回收精度 = 一次端点触达，10min 量级的持权完全够用）。
type directHub struct {
	mu       sync.Mutex
	pending  map[string]DirectRequest
	holds    map[string]DirectHold
	released []releasedHold // 惰性回收的待回调快照（drain 后由 Service 层锁外转发）
}

// releasedHold 一次惰性回收的快照（token+会话锚点+持权访客——装配层回调
// 与该访客 WS 连接的主动断开所需）
type releasedHold struct {
	Token     string
	SessionID string
	VisitorID string
}

func newDirectHub() *directHub {
	return &directHub{pending: map[string]DirectRequest{}, holds: map[string]DirectHold{}}
}

// request 登记申请（顶掉同 token 旧申请）
func (h *directHub) request(token, visitorID, nick string, now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.expirePendingLocked(now)
	h.pending[token] = DirectRequest{VisitorID: visitorID, Nick: nick, At: now}
}

// grant 直接授予持权（装配层 agent 限定判定后的落权口；重批 = 换人，
// owner 是唯一仲裁者）。sessionID 随快照落账（记录先死的回收路径要用），
// 返回持权快照供审计
func (h *directHub) grant(token, visitorID, nick, sessionID string, now time.Time) *DirectHold {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.pending, token)
	hold := DirectHold{VisitorID: visitorID, Nick: nick, GrantedAt: now, LastInputAt: now, SessionID: sessionID}
	h.holds[token] = hold
	return &hold
}

// revoke 收回持权（幂等：无持权返回 false）。回收动作不在这里触发回调
// ——调用方（Service 层）拿到快照后统一处理，锁内不执行外部代码
func (h *directHub) revoke(token string) (*DirectHold, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	hold, ok := h.holds[token]
	if ok {
		delete(h.holds, token)
	}
	delete(h.pending, token)
	return &hold, ok
}

// expireLocked 惰性时效清扫：超时申请就地清除；超时持权就地清除并记入
// released 待回调队列（sessionID 优先取持权快照——记录已死时调用方的
// lookup 只能给空串；visitorID 随快照带出供该访客 WS 连接的主动断开）
func (h *directHub) expireLocked(token, sessionID string, now time.Time) {
	h.expirePendingLocked(now)
	if hold, ok := h.holds[token]; ok && now.Sub(hold.LastInputAt) > DirectHoldIdleTTL {
		delete(h.holds, token)
		if hold.SessionID != "" {
			sessionID = hold.SessionID
		}
		h.released = append(h.released, releasedHold{Token: token, SessionID: sessionID, VisitorID: hold.VisitorID})
	}
}

// expireAllLocked 全量时效清扫（P-20261122-17 自愈对账）：旧实现的惰性
// 时效只在被查询的 token 上触发——持权访客关页后无人查询，持权（及会话闸）
// 会一直滞留到下一次外部触达。对账 ticker 走这里把到期面一次扫净
func (h *directHub) expireAllLocked(now time.Time) {
	h.expirePendingLocked(now)
	for token, hold := range h.holds {
		if now.Sub(hold.LastInputAt) > DirectHoldIdleTTL {
			delete(h.holds, token)
			h.released = append(h.released, releasedHold{Token: token, SessionID: hold.SessionID, VisitorID: hold.VisitorID})
		}
	}
}

// peek 非时效触达的持权快照（对账路径用：过期清扫已由 expireAllLocked
// 完成，此处只读）
func (h *directHub) peek(token string) *DirectHold {
	h.mu.Lock()
	defer h.mu.Unlock()
	if hold, ok := h.holds[token]; ok {
		return &hold
	}
	return nil
}

// holdTokens / pendingTokens 在场键快照（对账扫描用；顺序无关）
func (h *directHub) holdTokens() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.holds))
	for token := range h.holds {
		out = append(out, token)
	}
	return out
}

func (h *directHub) pendingTokens() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.pending))
	for token := range h.pending {
		out = append(out, token)
	}
	return out
}

// clearPending 摘除在途申请（对账路径：记录已死亡/过期）
func (h *directHub) clearPending(token string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.pending, token)
}

// expirePendingLocked 超时申请清扫
func (h *directHub) expirePendingLocked(now time.Time) {
	for t, req := range h.pending {
		if now.Sub(req.At) > DirectRequestTTL {
			delete(h.pending, t)
		}
	}
}

// holdOf 查询持权快照（先惰性清扫；无持权 nil）
func (h *directHub) holdOf(token, sessionID string, now time.Time) *DirectHold {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.expireLocked(token, sessionID, now)
	if hold, ok := h.holds[token]; ok {
		return &hold
	}
	return nil
}

// pendingOf 查询在途申请快照（过期即视为无；仅当属于本 visitorId 时由
// 调用方比对后呈现）
func (h *directHub) pendingOf(token string, now time.Time) *DirectRequest {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.expirePendingLocked(now)
	if req, ok := h.pending[token]; ok {
		return &req
	}
	return nil
}

// touch 输入即续期（LastInputAt 前推；持权存在才动）
func (h *directHub) touch(token string, now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if hold, ok := h.holds[token]; ok {
		hold.LastInputAt = now
		h.holds[token] = hold
	}
}

// drainReleased 取走惰性回收快照（Service 层锁外触发装配回调）
func (h *directHub) drainReleased() []releasedHold {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := h.released
	h.released = nil
	return out
}

// ── 访客端点（gateGuard 后；开关门禁 = 端点不存在语义，同 drop 族） ──

// handleDirectRequest POST /s/{token}/direct/request：访客申请输入权（申请
// 通道默认在场的唯一访客 HTTP 端点——旧 direct/state 轮询与 direct/input
// 批次端点随 P-20261121-1 统一收编退役，状态对账与键入统一走 WS 上行桥
// 控制帧/Binary 帧，见 writablepage.go）。
// 体 {"visitorId","nickname"}——visitorId 是访客页首访生成的 localStorage
// 随机 id（持权绑定键），nickname 沿用留言板清洗。成功即登记（10min 时效），
// 响应 {status:"pending"}；重复申请顶掉旧申请（单申请面语义）。
// P-20261121-2：登记后双路 owner 感知——通知中心入账（带「批准/拒绝」行内
// 动作，notes 攒批随 share-flush tick 批量落，dropNote 先例）+ sc-ops:
// share.direct-request 即时广播（writableEvents 同款回调注入）。
func (s *Service) handleDirectRequest(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	if sh.GuestInputOff || sh.Kind != store.ShareKindTerminal || sh.TerminalID == "" {
		// 申请通道关/形态不对 = 端点不存在（存在性不可探测，drop 族同款语义；
		// 反向极性字段——零值 false=通道开，owner 显式关才 404）
		writeJSONErrorStatus(w, http.StatusNotFound, "share_not_found")
		return
	}
	if !s.directLimit.allow(sh.Token, r) {
		writeJSONErrorStatus(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	var req struct {
		VisitorID string `json:"visitorId"`
		Nickname  string `json:"nickname"`
	}
	if decodeJSONBody(w, r, directBodyLimit, &req) != nil {
		return
	}
	visitorID := sanitizeVisitorID(req.VisitorID)
	if visitorID == "" {
		writeJSONErrorStatus(w, http.StatusBadRequest, "invalid_visitor")
		return
	}
	nick := sanitizeGuestNickname(req.Nickname)
	now := time.Now()
	s.direct.request(sh.Token, visitorID, nick, now)
	s.flushReleasedHolds(sh)
	// 审计（申请面元数据）：申请不授予任何权限，但「谁在敲门」是 owner
	// 判断的上下文；与键入批次审计（share.writableInput 单事件）分键——
	// 申请与键入语义分账（P-20261121-1 由 share.direct.input 分出本键）
	s.views.Add(store.AuditEvent{
		Action: store.AuditShareDirectRequest,
		Result: store.AuditResultSuccess,
		Time:   now,
		IP:     clientIPOf(r),
		Detail: fmt.Sprintf("%s (%s), visitor %s requested guest input",
			sh.Name, sh.Token, visitorBrief(visitorID)),
	})
	// owner 感知双路（P-20261121-2）：通知中心条目（批准/收回行内动作）攒
	// notes 缓冲 + ops 广播即时面。申请本身零权限，广播载荷只带元数据
	s.notes.Add(directRequestNote(sh, visitorID, nick, now))
	if s.directRequestEvents != nil {
		s.directRequestEvents(DirectRequestEvent{
			Token:       sh.Token,
			ShareName:   sh.Name,
			TerminalID:  sh.TerminalID,
			Nick:        nick,
			VisitorTail: visitorBrief(visitorID),
			At:          now.UnixMilli(),
		})
	}
	writeJSON(w, map[string]any{"status": "pending"})
}

// DirectRequestEvent 访客申请到达的 ops 广播载荷（sc-ops:share.direct-request
// 直通分发；仅元数据——visitorId 全串不上广播面，terminal.message 同纪律）。
// 导出类型：装配层广播接线消费
type DirectRequestEvent struct {
	Token       string `json:"token"`
	ShareName   string `json:"shareName"`
	TerminalID  string `json:"terminalId,omitempty"`
	Nick        string `json:"nick,omitempty"`
	VisitorTail string `json:"visitorTail,omitempty"`
	At          int64  `json:"at"`
}

// directRequestNote 构造申请到达通知（dropNote/guestNote 同款：模板键 +
// 参数供前端按界面语言渲染，Title/Body 中文原文兜底无模板消费方）。类别走
// system（协作面系统事件——grant 持权卡同款口径，drop 类别语义是素材到达，
// 静音粒度不混淆）；行内动作双出口：主动作「批准」（shdirect-approve，
// payload=token——批准走缺省取唯一在途申请的服务端语义，多访客顶替场景
// 以服务端在途为准）+ 第二动作「拒绝」（shdirect-deny，payload=token——
// 与持权卡的 shdirect-revoke 分键：申请卡语义是拒绝不存在的持权，文案与
// 反馈各异，落点同为主人侧收回端点（幂等清 pending+持权，四路入口口径
// 不变），前端 handler 复用同一 API）
func directRequestNote(sh *store.Share, visitorID, nick string, at time.Time) notification.Notification {
	nickShow := displayNick(nick)
	return notification.Notification{
		Type:     "info",
		Category: notification.CategorySystem,
		TitleKey: "share.direct.notify.request.title",
		BodyKey:  "share.direct.notify.request.body",
		Title:    "访客申请输入",
		Body:     "「" + sh.Name + "」" + nickShow + " 申请向会话键入（10 分钟内有效，批准后访客可实际提交）",
		Time:     at,
		MsgParams: map[string]any{
			"name": sh.Name, "nick": nickShow,
		},
		Action:              "shdirect-approve",
		ActionPayload:       sh.Token,
		SecondAction:        "shdirect-deny",
		SecondActionPayload: sh.Token,
	}
}

// flushReleasedHolds 把惰性回收快照就地收口（过期即账本释放会话闸 + 主动
// 断开该访客 WS + 非 owner 缘由审计回调——回调缺失时快照丢弃，状态已清
// 无泄漏）。sessionID 优先取快照（expireLocked 时已用 DirectHold.SessionID
// 补齐；记录消亡后 lookup 只能给空串——账本按来源释放不依赖它）。
// P-20261122-17：所有取快照的路径都必须走本方法，禁止裸 drainReleased——
// 旧实现在「记录缺失」分支直接丢弃整个队列，会连带丢掉其他 token 的回收
// 快照（其他会话闸永久泄漏）
func (s *Service) flushReleasedHolds(sh *store.Share) {
	for _, rel := range s.direct.drainReleased() {
		sessionID := rel.SessionID
		if sessionID == "" && sh != nil && sh.Token == rel.Token {
			sessionID = sh.TerminalID
		}
		s.gateReleaseSource("direct:" + rel.Token)
		if ksh, err := s.shares.Get(rel.Token); err == nil {
			s.kickDirectVisitor(ksh, rel.VisitorID, "expired")
		}
		if s.directOnRelease != nil {
			s.directOnRelease(rel.Token, sessionID, "expired")
		}
	}
}

// dropDirectToken 单 token 的持权收口（幂等）：hub 摘持权 + 账本按来源
// 释放（不依赖记录存活）+ 记录在场时断开该 token 的持权连接 + 非 owner
// 缘由回调。撤销/级联/对账三条路径共用
func (s *Service) dropDirectToken(token, reason string, sh *store.Share) {
	hold, ok := s.direct.revoke(token)
	// 来源级释放无条件执行（P-20261122-17：ok=false 也可能只剩账本里的
	// 毒来源——持权先被清而闸账本项残留）
	s.gateReleaseSource("direct:" + token)
	if !ok {
		return
	}
	sessionID := hold.SessionID
	if sh != nil {
		if sessionID == "" {
			sessionID = sh.TerminalID
		}
		s.kickDirectVisitor(sh, "", reason)
	}
	if reason != "owner" && s.directOnRelease != nil {
		s.directOnRelease(token, sessionID, reason)
	}
}

// ── 装配层入口（owner 管理面经 server/api/share 调用） ──

// GrantDirect 装配层授予入口：落持权 + 账本置会话输入闸（gateAcquire——
// 闸的置位收口在 Service，api 层不再直写 terminal.Session 原子）+ WS 对账
// 帧（等待中的访客即刻看到「已批准」，替代旧 2s 轮询）。返回持权快照供
// 审计/响应；记录缺失/已过期（批准校验后、落权前的撤销/轮换/到期竞态）
// 返回 nil 且不留无闸持权（P-20261122-17）
func (s *Service) GrantDirect(token, visitorID, nick string) *DirectHold {
	now := time.Now()
	sh, err := s.shares.Get(token)
	valid := err == nil && sh != nil && !sh.Expired(now) && sh.TerminalID != ""
	sessionID := ""
	if valid {
		sessionID = sh.TerminalID
	}
	hold := s.direct.grant(token, visitorID, nick, sessionID, now)
	if valid {
		s.gateAcquire(sessionID, "direct:"+token)
		s.pushDirectState(sh, "")
	} else {
		// 记录已亡/过期：持权不得存在（无闸 hold 会永久拒 owner 键盘且
		// 无对应记录可回收）
		s.direct.revoke(token)
		hold = nil
	}
	// 顺带收口其他 token 的惰性回收快照（P-20261122-17：不得整队丢弃）
	s.flushReleasedHolds(nil)
	return hold
}

// RevokeDirect 收回持权（owner 一键/级联/关通道共用；幂等）。reason 传
// 回调留痕与访客侧对账帧（owner|cascade|channel_closed|expired——owner
// 缘由的审计在带 gin 上下文的 handler 落，回调只补非 owner 缘由审计）。
// 收回动作三件套：账本释放会话闸（gateRelease——双开关并存时另一模式的
// 在场来源仍持闸，不得误归还 owner 键盘给另一模式在场访客，gateLedger 注记）+
// 主动断开该访客 WS（kickDirectVisitor，必改2）+ 在途连接状态对账帧。
// channel_closed 缘由指认面扩大到全部 hold 连接（申请路径整体退场——只踢
// 持权者会让在途等待的访客重见申请钮，违背「入口不渲染非置灰」定案；全断
// 后访客页回落轮询，重连即见通道已关）。
// P-20261122-17：会话闸释放改为来源级且无条件执行——撤销/轮换/过期都是
// 「先删记录再回收」，记录 lookup 失败（gerr != nil）与无持权（ok=false）
// 都不是跳过释放的理由
func (s *Service) RevokeDirect(token, reason string) (*DirectHold, bool) {
	hold, ok := s.direct.revoke(token)
	sh, gerr := s.shares.Get(token)
	sessionID := ""
	if ok && hold.SessionID != "" {
		sessionID = hold.SessionID
	}
	if gerr == nil && sh != nil {
		if sessionID == "" {
			sessionID = sh.TerminalID
		}
	}
	// 无条件幂等：覆盖「无持权只剩毒 source」与「记录已删 lookup 不到」
	s.gateReleaseSource("direct:" + token)
	switch {
	case ok:
		if gerr == nil && sh != nil {
			kick := hold.VisitorID
			if reason == "channel_closed" {
				kick = ""
			}
			s.kickDirectVisitor(sh, kick, reason)
		}
		if reason != "owner" && s.directOnRelease != nil {
			s.directOnRelease(token, sessionID, reason)
		}
	case reason == "channel_closed" && gerr == nil && sh != nil:
		// 无持权（仅剩在途申请或空态）的关通道同样要退场等待中的访客连接：
		// revoke 的 ok=false 只说明没有持权可收，在途申请已被顺手清掉——但
		// 等待中的 hold 连接不知道，10s 状态对账会把申请槽重新顶出来（违背
		// 「关闭即入口不渲染非置灰」定案）。全断该 token 的 hold 连接，访客
		// 页回落轮询后即见通道已关
		s.kickDirectVisitor(sh, "", reason)
	}
	s.flushReleasedHolds(sh)
	return hold, ok
}

// CascadeRelease 存活集外的持权级联回收（清账管线调用：分享撤销/过期/
// 轮换后持权 token 键不在 keep 集即回收，OnRelease 以 cascade 缘由发出——
// 会话侧输入闸的解除不能依赖访客下一次触达：记录死亡后访客面 404，没人
// 再来触发惰性清扫）。返回回收条数。
// P-20261122-17 边界：本方法**只放 direct 来源**；开放直入的 "ws:" 来源
// 归 CascadeWritableDown（关连接 → 末条连接 defer 释放）——现有清账顺序
// 是 CascadeRelease 先于 CascadeWritableDown，若此处顺手放 ws 会在访客连接
// 仍可键入时提前归还 owner 键盘
func (s *Service) CascadeRelease(keep map[string]bool) int {
	if keep == nil || s == nil {
		return 0
	}
	s.direct.mu.Lock()
	var doomed []string
	for token := range s.direct.holds {
		if !keep[token] {
			doomed = append(doomed, token)
		}
	}
	for token := range s.direct.pending {
		if !keep[token] {
			delete(s.direct.pending, token)
		}
	}
	s.direct.mu.Unlock()
	for _, token := range doomed {
		var sh *store.Share
		if rec, err := s.shares.Get(token); err == nil {
			sh = rec
		}
		s.dropDirectToken(token, "cascade", sh)
	}
	s.flushReleasedHolds(nil)
	return len(doomed)
}

// gateReconcileMinInterval ListShares 入口对账的节流窗（页面/agent 轮询
// 15s 级会重复触达；ticker 1min 与本窗不冲突——5s 内的重复触达折成一次）
var gateReconcileMinInterval = 5 * time.Second

// ReconcileGates 会话输入闸自愈对账（P-20261122-17）：来源级核对「账本项
// 是否仍有资格在场」——记录死亡/过期的 direct 来源、零开放连接的 ws 来源
// 就地释放；瞬时 store 错误不释放（宁可多等一轮，不误归还主人键盘）。
// 同时清扫过期持权/申请与记录已死的持权（重建同会话分享派生同 token，
// 旧毒持权不得跨重建存活）。入口：1min ticker + ListShares（节流窗内合并）
func (s *Service) ReconcileGates() {
	if s == nil {
		return
	}
	now := time.Now()
	if !s.gates.tryReconcile(now, gateReconcileMinInterval) {
		return
	}
	s.reconcileGatesNow(now)
}

// reconcileGatesNow 对账主体（测试直调面——绕过节流窗）。锁序纪律：
// directHub/gateLedger 锁只在各自快照/摘除临界区内持有，store 读取、
// kickDirectVisitor 与 SetWritableGate 全在锁外
func (s *Service) reconcileGatesNow(now time.Time) {
	s.direct.expireAllLocked(now)
	holds := s.direct.holdTokens()
	pending := s.direct.pendingTokens()
	sources := s.gates.sources()

	// 每个在场 token 至多一次记录读取（持权/申请/账本来源共享结论）
	tokens := make(map[string]struct{}, len(holds)+len(pending)+len(sources))
	for _, t := range holds {
		tokens[t] = struct{}{}
	}
	for _, t := range pending {
		tokens[t] = struct{}{}
	}
	for _, src := range sources {
		if t, ok := strings.CutPrefix(src, "direct:"); ok {
			tokens[t] = struct{}{}
		} else if t, ok := strings.CutPrefix(src, "ws:"); ok {
			tokens[t] = struct{}{}
		}
	}
	type verdict struct {
		sh        *store.Share
		dead      bool // 记录不存在
		expired   bool // 记录已过保留窗口
		transient bool // 读取失败（非 NotFound）——本轮不释放
	}
	verdicts := make(map[string]verdict, len(tokens))
	for t := range tokens {
		sh, err := s.shares.Get(t)
		switch {
		case err == nil && sh != nil:
			verdicts[t] = verdict{sh: sh, expired: sh.Expired(now)}
		case errors.Is(err, store.ErrNotFound):
			verdicts[t] = verdict{dead: true}
		default:
			verdicts[t] = verdict{transient: true}
		}
	}

	// 记录已死亡/过期：持权与在途申请一并清扫（不依赖 10min 空闲时效——
	// 记录死亡后持权本身已无授权物，重建同 token 分享更会继承旧毒状态）
	for _, t := range holds {
		v := verdicts[t]
		if v.dead || v.expired {
			s.dropDirectToken(t, "cascade", v.sh)
			continue
		}
		// 持权早于记录创建 = 上一代分享的残留（撤销未及回收 + 同会话重建
		// 派生同 token 的崩溃窗口）：record 已换新，旧持权不得继承
		if v.sh != nil {
			if hold := s.direct.peek(t); hold != nil && hold.GrantedAt.Before(v.sh.CreatedAt) {
				s.dropDirectToken(t, "cascade", v.sh)
			}
		}
	}
	for _, t := range pending {
		v := verdicts[t]
		if v.dead || v.expired {
			s.direct.clearPending(t)
		}
	}

	// 来源级对账：资格消失即释放（按来源整体摘除，不依赖会话锚点）
	for _, src := range sources {
		if t, ok := strings.CutPrefix(src, "direct:"); ok {
			v := verdicts[t]
			if v.transient {
				continue
			}
			// 「持权中即使访客断连也不放」——visitorId 恢复语义下访客可能
			// 随时重连，而 hold 连接重连不重新 gateAcquire；提前放会让主人
			// 与持权访客同时可键入（误放是安全回归）
			if v.dead || v.expired || s.direct.peek(t) == nil {
				s.gateReleaseSource(src)
			}
			continue
		}
		if t, ok := strings.CutPrefix(src, "ws:"); ok {
			// ws 来源=开放连接在场：零开放连接即释放（half-open 由 60s
			// 读超时收口，对账是第二道兜底）
			if s.writable.openCountOf(t) == 0 {
				s.gateReleaseSource(src)
			}
		}
	}

	s.flushReleasedHolds(nil)
}

// ── 会话输入闸合并账本（gateLedger，必改3） ──

// gateLedger 会话输入闸的来源合并账本：开放直入（来源 "ws:"+token——开放
// 连接在场）与申请批准（来源 "direct:"+token——持权在场）两模式的「访客
// 可键入」状态统一记账，闸值 = 任一来源在场。此前两路写同一
// terminal.Session.directInputHold 原子（SetDirectInputHold 直拼），关其一
// 会误归还 owner 键盘给另一模式在场访客（组合开关竞态）——账本引用计数
// 之下闸只在最后一个来源离场时释放。sessionID 键（token→会话多对一：
// 多条直播分享锚同一会话时来源集并集语义正确）。
// 反向索引 owners（P-20261122-17）：撤销/轮换/过期都是「记录先死、回收后
// 到」，sessionID 的 lookup 不再可靠——释放以来源为第一公民（按来源整体
// 摘除），会话锚点只在落 sink 时从索引反查
type gateLedger struct {
	mu     sync.Mutex
	refs   map[string]map[string]struct{} // sessionID → sources
	owners map[string]map[string]struct{} // source → sessionIDs（反向索引）
	// lastReconcile 最近一次自愈对账的 nanotime（ReconcileGates 节流锚——
	// 与账本同锁维护，避免 Service 再挂一个原子字段）
	lastReconcile int64
}

func newGateLedger() *gateLedger {
	return &gateLedger{
		refs:   map[string]map[string]struct{}{},
		owners: map[string]map[string]struct{}{},
	}
}

// acquire 登记来源；返回是否闸翻转（登记前该会话零来源=入场即翻转）
func (l *gateLedger) acquire(sessionID, source string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	set := l.refs[sessionID]
	if set == nil {
		set = map[string]struct{}{}
		l.refs[sessionID] = set
	}
	if _, ok := set[source]; ok {
		return false
	}
	wasEmpty := len(set) == 0
	set[source] = struct{}{}
	owners := l.owners[source]
	if owners == nil {
		owners = map[string]struct{}{}
		l.owners[source] = owners
	}
	owners[sessionID] = struct{}{}
	return wasEmpty
}

// release 摘除来源；返回是否闸翻转（摘除后该会话零来源=离场即翻转）
func (l *gateLedger) release(sessionID, source string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	set := l.refs[sessionID]
	if set == nil {
		return false
	}
	if _, ok := set[source]; !ok {
		return false
	}
	delete(set, source)
	if owners := l.owners[source]; owners != nil {
		delete(owners, sessionID)
		if len(owners) == 0 {
			delete(l.owners, source)
		}
	}
	empty := len(set) == 0
	if empty {
		delete(l.refs, sessionID)
	}
	return empty
}

// releaseBySource 按来源整体摘除（P-20261122-17）。跨会话生效（同一 token
// 理论上只挂一个会话，但索引是唯一事实源，不假设）；返回本次真正翻转为
// 「零来源」的会话——锁外由调用方落 SetWritableGate（锁内不执行外部代码）
func (l *gateLedger) releaseBySource(source string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	owners := l.owners[source]
	if len(owners) == 0 {
		return nil
	}
	delete(l.owners, source)
	var flipped []string
	for sessionID := range owners {
		set := l.refs[sessionID]
		if set == nil {
			continue
		}
		if _, ok := set[source]; !ok {
			continue
		}
		delete(set, source)
		if len(set) == 0 {
			delete(l.refs, sessionID)
			flipped = append(flipped, sessionID)
		}
	}
	return flipped
}

// sources 在场来源快照（自愈对账扫描用；顺序无关）
func (l *gateLedger) sources() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, 0, len(l.owners))
	for source := range l.owners {
		out = append(out, source)
	}
	return out
}

// tryReconcile 对账节流闸（P-20261122-17）：窗内返回 false。时间戳与账本
// 同锁维护（粗粒度判定，随后对账再各自取锁——锁序恒为 gateLedger→hub，
// 本方法只取自身锁，不嵌套）
func (l *gateLedger) tryReconcile(now time.Time, interval time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if interval > 0 && now.UnixNano()-l.lastReconcile < int64(interval) {
		return false
	}
	l.lastReconcile = now.UnixNano()
	return true
}

// gateAcquire/gateRelease 账本驱动的会话输入闸落点：翻转时单点落
// writableSink.SetWritableGate（= terminal.Session.directInputHold 同一
// 服务端强制面，P-20261008-17 input-lock 同源）。sink 未装配（测试/降级）
// 整段跳过——账本与闸同进退，不出现「账本记了闸没落」的漂移
func (s *Service) gateAcquire(sessionID, source string) {
	if sessionID == "" || s.writableSink == nil {
		return
	}
	if s.gates.acquire(sessionID, source) {
		s.writableSink.SetWritableGate(sessionID, true)
	}
}

func (s *Service) gateRelease(sessionID, source string) {
	if sessionID == "" || s.writableSink == nil {
		return
	}
	if s.gates.release(sessionID, source) {
		s.writableSink.SetWritableGate(sessionID, false)
	}
}

// gateReleaseSource 来源级释放（幂等，不依赖会话锚点/记录存活）：撤销/
// 轮换/过期与自愈对账的统一出口。账本摘除后按反向索引逐会话落 sink——只对
// 真正翻转为零来源的会话关闸（其他来源仍在场时保持 owner 键盘让位）
func (s *Service) gateReleaseSource(source string) {
	flipped := s.gates.releaseBySource(source)
	if s.writableSink == nil {
		return
	}
	for _, sessionID := range flipped {
		s.writableSink.SetWritableGate(sessionID, false)
	}
}

// ── WS 连接状态对账（hold 模式访客面的推送半边，writablepage.go 消费） ──

// pushDirectState 向 token 全部 hold 模式连接广播一枚 direct_state 帧
// （per-conn 计算 mine——pending/持权是否属于本 visitor；授予/收回/过期/
// 关通道各迁移点触达，替代旧 direct/state 2s 轮询）。惰性时效在 holdOf
// 查询路径顺带生效（超时持权回收 → released 快照由下一轮
// flushReleasedHolds 收口）
func (s *Service) pushDirectState(sh *store.Share, note string) {
	now := time.Now()
	for _, c := range s.writable.connsOf(sh.Token) {
		if c.open {
			continue // 开放直入连接无申请/持权语义，不对账
		}
		s.writeDirectState(sh, c, now, note)
	}
}

// writeDirectState 组一枚 direct_state 控制帧写单连接：status = none（无
// 持权无本访客申请）| pending（本访客申请在途）| held（有人持权，mine
// 指认 + remainSeconds 倒计时）
func (s *Service) writeDirectState(sh *store.Share, c *writableConn, now time.Time, note string) {
	extra := map[string]any{}
	if hold := s.direct.holdOf(sh.Token, sh.TerminalID, now); hold != nil {
		mine := c.visitorID != "" && hold.VisitorID == c.visitorID
		remain := int(hold.LastInputAt.Add(DirectHoldIdleTTL).Sub(now).Seconds())
		if remain < 0 {
			remain = 0
		}
		extra["status"] = "held"
		extra["mine"] = mine
		extra["remainSeconds"] = remain
		if mine && hold.Nick != "" {
			extra["nick"] = hold.Nick
		}
	} else if pend := s.direct.pendingOf(sh.Token, now); pend != nil && pend.VisitorID == c.visitorID {
		extra["status"] = "pending"
	} else {
		extra["status"] = "none"
	}
	if note != "" {
		extra["note"] = note
	}
	s.writeControl(c, "direct_state", extra)
}

// kickDirectVisitor 持权收回/过期/关通道后的主动断开（必改2）：该 visitor
// 的 WS 连接先收 direct_revoked 对账帧再断开——「收回」必须可感知且键入
// 通道即刻关闭（断开后访客页回落只读轮询，重连即重过门禁）；同 token 其他
// hold 连接收 direct_state 对账帧（状态摘除——在途申请被一并清时访客面
// 即刻回到「可申请」）。visitorID 空串 = 不指认（级联清场：全部 hold 连接
// 断开）。开放直入连接不触碰（授权物独立，归 WritableDown 管）
func (s *Service) kickDirectVisitor(sh *store.Share, visitorID, reason string) {
	now := time.Now()
	for _, c := range s.writable.connsOf(sh.Token) {
		if c.open {
			continue
		}
		if visitorID == "" || c.visitorID == visitorID {
			s.writeControl(c, "direct_revoked", map[string]any{"reason": reason})
			_ = c.conn.Close()
			continue
		}
		s.writeDirectState(sh, c, now, "")
	}
}

// DirectState 管理面的持权/申请状态投影（ListShares 直投影 + 管理面轮询
// 共用；惰性清扫同点生效——超时持权在任意一次投影/轮询时回收并回调）
func (s *Service) DirectState(token string) (pending *DirectRequest, hold *DirectHold) {
	now := time.Now()
	sessionID := ""
	if sh, err := s.shares.Get(token); err == nil {
		sessionID = sh.TerminalID
	}
	hold = s.direct.holdOf(token, sessionID, now)
	s.flushReleasedHolds(shOrNil(s, token))
	if hold == nil {
		pending = s.direct.pendingOf(token, now)
	}
	return pending, hold
}

// shOrNil 管理面查询用的记录兜底（记录已撤销时传 nil——flushReleasedHolds
// 对 nil 记录只丢 sessionID 补桥，回调照发）
func shOrNil(s *Service, token string) *store.Share {
	if sh, err := s.shares.Get(token); err == nil {
		return sh
	}
	return nil
}

// ── 小工具 ──

// sanitizeVisitorID visitorId 清洗：控制字符剔除 + trim + 长度上限。只要求
// 「同访客稳定自报」不要求密码学强度——持权由 owner 批准动作仲裁，visitorId
// 是恢复键不是凭据
func sanitizeVisitorID(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
	s = strings.TrimSpace(s)
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, string(utf8.RuneError))
	}
	if runes := []rune(s); len(runes) > visitorIDMaxLen {
		s = string(runes[:visitorIDMaxLen])
	}
	return s
}

// visitorBrief 审计 Detail 的 visitorId 摘要（TokenSummary 同款形态：前 8
// 位 + 省略——visitorId 是持权绑定键不是秘密，但摘要化防长串撑爆 Detail）
func visitorBrief(v string) string {
	if len(v) <= 8 {
		return v
	}
	return v[:8] + "…"
}

// decodeJSONBody JSON 体解码（guestMsgBodyLimit 同款 MaxBytesReader 模式；
// 解析失败统一 400 invalid_request 并返回错误供调用方短路）
func decodeJSONBody(w http.ResponseWriter, r *http.Request, limit int64, v any) error {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit)).Decode(v); err != nil {
		writeJSONErrorStatus(w, http.StatusBadRequest, "invalid_request")
		return err
	}
	return nil
}
