package share

// 分享协作通道——直通输入档（P-20261024-1 第二档独立开关）：访客向分享锚定
// 的 agent 会话直接输入补充信息（文字批次）。本档的安全定位 = 「无 shell 面、
// 批次补信息」的低授权位；普通终端的键入面由可写分享档承接（P-20261106-8，
// 见 writable.go——那是本档头注历史红线的显式推翻，非本档语义扩张）：
//
//   - agent 会话限定：开关只对 kind=terminal 分享可开（store 创建面兜底清），
//     批准时装配层判定锚定会话 kind=agent。历史红线「普通终端直通 = 匿名
//     远程 shell 等价，明确不做」已由 P-20261106-8 可写分享档显式推翻
//     （owner 逐案开关+出域警示+全量审计+实时可见+一键收回五重补偿控制
//     同时在场才成立，见 writable.go 头注）——本档仍维持 agent 限定，
//     与可写档构成两档正交的授权位（文字批次 vs 键盘直通）。
//   - 单持有者握手：访客申请（60s 不决自动过期）→ owner 批准 → 授予持权
//     （绑 token+visitorId），同一时刻全链仅一人持权；访客页首访生成
//     localStorage 随机 visitor id，SSE 断线重连凭 visitorId 恢复持权。
//     ask 卡正式作答走 owner 鉴权链访客够不到——本档的实际形态 = 访客文本
//     进会话、agent 从对话读到（owner 侧「一键转 ask 作答」为后续可选增量）。
//   - 短时效：10min 无输入自动回收（滑动窗口，输入即续）；owner 一键收回
//     （管理器行内/通知中心持权卡/会话侧徽标/回收端点四路入口共用同一
//     端点）；分享撤销/轮换/关闭级联回收。
//   - 全量审计：每一输入批次入账（元数据口径——长度/visitorId 摘要/IP，
//     文本本体不入账，quickdrop「内容不入审计」同口径）；授予/收回入账。
//
// 联动：持权期间锚定会话挂 owner 侧只读闸（terminal.Session 直通持权闸，
// 与 P-20261008-17 input-lock 同一服务端强制面）——「谁在输入」单持有者
// 语义的 owner 侧强制面，owner 可锁回（收回即解锁）。可写分享档的上行桥
// 复用同一闸口（writableAdapter.SetWritableGate 直通 SetDirectInputHold），
// 两档在会话级共享「非 owner 持权即 owner 让位」的强制语义。
//
// 状态存进程内（重启即全回收——短时效持权状态的保守侧语义：重启后 owner
// 重新批准一次即可，不落盘的丢失面 = 多一次点击；持权持久化反而要处理
// 「重启后无人看管的悬空写权」这个更糟的态）。可写分享档的上行连接/
// 待批粘贴面同款进程内取态（writable.go 头注）。

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"codecombo/server/store"
)

const (
	// DirectRequestTTL 申请时效：60s 不决自动过期（owner 不在场=不授权，
	// 申请面不留悬空许可）。导出常量：管理面响应投影与文档共用同一取值
	DirectRequestTTL = 60 * time.Second
	// DirectHoldIdleTTL 持权滑动时效：10min 无输入自动回收（输入即续）。
	// 导出常量：管理面响应投影与文档共用同一取值
	DirectHoldIdleTTL = 10 * time.Minute
	// MaxDirectInputBytes 单批次输入字节上限（4KB）：补一句现场说明的量级，
	// 长文走素材上传或留言板（协作通道 2000 rune）；上限是 PTY 刷屏护栏
	MaxDirectInputBytes = 4 << 10
	// directMaxPerIP / directMaxPerToken 握手与输入频控：申请/状态/输入共用
	// 一组窗口（访客直通位的动作全部落在这三个端点）；每 (token,IP) 每分钟
	// 30 次、token 全局 120 次（含 2s 轮询的 status 查询——30/min 对单访客
	// 轮询 + 交互足够，防的是脚本刷面）
	directMaxPerIP    = 30
	directMaxPerToken = 120
	directWindow      = time.Minute

	// directBodyLimit 直通端点请求体封顶：visitorId（≤64）+ 昵称（≤24 rune）
	// + 文本（≤4KB）的 JSON 至多几 KB，16KiB 与留言体封顶同口径
	directBodyLimit = 16 << 10

	// visitorIDMaxLen visitorId 的长度上限（访客页生成的随机串 32 字符量级，
	// 上限防把持权绑定键当存储通道）
	visitorIDMaxLen = 64
)

// DirectSink 直通输入的落点（装配层适配 terminal 会话——本包不 import
// terminal，TerminalLive/ShareLookup 同款接口注入先例）。
type DirectSink interface {
	// DirectWrite 把一批访客文本写入会话（装配层判定 kind=agent 后直写
	// PTY——语义 = 键入而非执行，无尾部 \r；agent 从对话读到）
	DirectWrite(sessionID, text string) error
	// DirectSessionInfo 会话元数据（kind 与存活态）。v1 的批准限定判定在
	// 装配层 handlers 直查 terminal.DefaultManager（同包无界），本方法为
	// 接口完整性与测试桩保留——server/share 不 import terminal 的先例下，
	// 未来把判定收进 Service 时是现成的注入位
	DirectSessionInfo(sessionID string) (kind string, alive bool)
	// SetDirectGate 锚定会话的 owner 侧只读闸（直通持权联动面，P-20261008-17
	// 同一服务端强制机制）：授予置位、回收/超时/级联解除——装配层实现承担
	// 「会话已关」的幂等（闸随会话消亡）
	SetDirectGate(sessionID string, locked bool)
}

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

// releasedHold 一次惰性回收的快照（token+会话锚点，装配层回调所需）
type releasedHold struct {
	Token     string
	SessionID string
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
// owner 是唯一仲裁者）。返回持权快照供审计
func (h *directHub) grant(token, visitorID, nick string, now time.Time) *DirectHold {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.pending, token)
	hold := DirectHold{VisitorID: visitorID, Nick: nick, GrantedAt: now, LastInputAt: now}
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
// released 待回调队列（sessionID 由调用方经 lookup 补——hub 不感知记录）
func (h *directHub) expireLocked(token, sessionID string, now time.Time) {
	h.expirePendingLocked(now)
	if hold, ok := h.holds[token]; ok && now.Sub(hold.LastInputAt) > DirectHoldIdleTTL {
		delete(h.holds, token)
		h.released = append(h.released, releasedHold{Token: token, SessionID: sessionID})
		_ = hold
	}
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

// handleDirectRequest POST /s/{token}/direct/request：访客申请直通输入权。
// 体 {"visitorId","nickname"}——visitorId 是访客页首访生成的 localStorage
// 随机 id（持权绑定键），nickname 沿用留言板清洗。成功即登记（60s 时效），
// 响应 {status:"pending"}；重复申请顶掉旧申请（单申请面语义）
func (s *Service) handleDirectRequest(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	if !sh.DirectInput || sh.Kind != store.ShareKindTerminal || sh.TerminalID == "" {
		// 开关关/形态不对 = 端点不存在（存在性不可探测，drop 族同款语义）
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
	// 判断的上下文；与输入批次审计同批攒入 views
	s.views.Add(store.AuditEvent{
		Action: store.AuditShareDirectInput,
		Result: store.AuditResultSuccess,
		Time:   now,
		IP:     clientIPOf(r),
		Detail: fmt.Sprintf("%s (%s), visitor %s requested direct-input",
			sh.Name, sh.Token, visitorBrief(visitorID)),
	})
	writeJSON(w, map[string]any{"status": "pending"})
}

// handleDirectState GET /s/{token}/direct/state?visitorId=：访客轮询握手/
// 持权状态（2s 档轮询是访客直通位的既有节奏——留言板「首次展开取数」同款
// 克制：只在直通位在场时轮询）。响应 {status, mine, remainSeconds, nick?}：
//
//	status = none（无持权无申请）| pending（本访客申请在途）| held（有人持权）
//	mine   = 持权者是否是本 visitorId（held 时有效）
func (s *Service) handleDirectState(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	if !sh.DirectInput {
		writeJSONErrorStatus(w, http.StatusNotFound, "share_not_found")
		return
	}
	now := time.Now()
	visitorID := sanitizeVisitorID(r.URL.Query().Get("visitorId"))
	hold := s.direct.holdOf(sh.Token, sh.TerminalID, now)
	s.flushReleasedHolds(sh)
	if hold == nil {
		if pend := s.direct.pendingOf(sh.Token, now); pend != nil && pend.VisitorID == visitorID {
			writeJSON(w, map[string]any{"status": "pending"})
			return
		}
		writeJSON(w, map[string]any{"status": "none"})
		return
	}
	mine := visitorID != "" && hold.VisitorID == visitorID
	remain := int(hold.LastInputAt.Add(DirectHoldIdleTTL).Sub(now).Seconds())
	if remain < 0 {
		remain = 0
	}
	out := map[string]any{"status": "held", "mine": mine, "remainSeconds": remain}
	if mine {
		out["nick"] = hold.Nick
	}
	writeJSON(w, out)
}

// handleDirectInput POST /s/{token}/direct/input：访客输入批次。四闸全检：
// 开关门禁（404）→ 持权在且绑本 visitorId（403）→ 未超时（惰性回收后 403）
// → 文本非空 ≤4KB（400）→ 装配层 DirectWrite（agent 限定判定在彼侧）。
// 成功即续期（滑动 10min）+ 全量审计（元数据口径）
func (s *Service) handleDirectInput(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	if !sh.DirectInput || sh.Kind != store.ShareKindTerminal || sh.TerminalID == "" {
		writeJSONErrorStatus(w, http.StatusNotFound, "share_not_found")
		return
	}
	if !s.directLimit.allow(sh.Token, r) {
		writeJSONErrorStatus(w, http.StatusTooManyRequests, "rate_limited")
		return
	}
	var req struct {
		VisitorID string `json:"visitorId"`
		Text      string `json:"text"`
	}
	if decodeJSONBody(w, r, directBodyLimit, &req) != nil {
		return
	}
	visitorID := sanitizeVisitorID(req.VisitorID)
	now := time.Now()
	hold := s.direct.holdOf(sh.Token, sh.TerminalID, now)
	s.flushReleasedHolds(sh)
	if hold == nil || visitorID == "" || hold.VisitorID != visitorID {
		// 无持权/换人：403 direct_denied（与 404 区分——端点在，权不在）
		writeJSONErrorStatus(w, http.StatusForbidden, "direct_denied")
		return
	}
	text := sanitizeGuestText(req.Text)
	if text == "" || len(text) > MaxDirectInputBytes {
		writeJSONErrorStatus(w, http.StatusBadRequest, "invalid_input")
		return
	}
	if s.directSink == nil {
		// 装配缺失（测试/降级部署）：诚实 503，不静默吞批次
		writeJSONErrorStatus(w, http.StatusServiceUnavailable, "unavailable")
		return
	}
	if err := s.directSink.DirectWrite(sh.TerminalID, text); err != nil {
		// 会话已关/拒绝写：410 target_gone（直播访客面同款语义——锚定的
		// 会话没了；不把写失败伪装成访客错误）
		writeJSONErrorStatus(w, http.StatusGone, "target_gone")
		return
	}
	s.direct.touch(sh.Token, now)
	s.views.Add(store.AuditEvent{
		Action: store.AuditShareDirectInput,
		Result: store.AuditResultSuccess,
		Time:   now,
		IP:     clientIPOf(r),
		Detail: fmt.Sprintf("%s (%s), visitor %s input %d bytes -> session %s",
			sh.Name, sh.Token, visitorBrief(visitorID), len(text), sh.TerminalID),
	})
	remain := int(hold.LastInputAt.Add(DirectHoldIdleTTL).Sub(now).Seconds())
	if remain < 0 {
		remain = 0
	}
	writeJSON(w, map[string]any{"ok": true, "remainSeconds": remain})
}

// flushReleasedHolds 把惰性回收快照转发装配层（锁外回调——OnRelease 联动
// 会话只读闸与非 owner 缘由的审计；回调缺失时快照丢弃，状态已清无泄漏）。
// sessionID 取自快照（expireLocked 时经 lookup 桥接补齐，记录消亡后兜底
// 空串——装配层对空 sessionID 幂等直通）
func (s *Service) flushReleasedHolds(sh *store.Share) {
	for _, rel := range s.direct.drainReleased() {
		sessionID := rel.SessionID
		if sessionID == "" && sh != nil && sh.Token == rel.Token {
			sessionID = sh.TerminalID
		}
		if s.directOnRelease != nil {
			s.directOnRelease(rel.Token, sessionID, "expired")
		}
	}
}

// ── 装配层入口（owner 管理面经 server/api/share 调用） ──

// GrantDirect 装配层授予入口：agent 会话限定判定通过后落持权。返回持权
// 快照供审计/响应；会话侧只读闸由调用方经 sink.SetDirectGate 置位
func (s *Service) GrantDirect(token, visitorID, nick string) *DirectHold {
	hold := s.direct.grant(token, visitorID, nick, time.Now())
	if sh, err := s.shares.Get(token); err == nil {
		s.flushReleasedHolds(sh)
	} else {
		s.direct.drainReleased()
	}
	return hold
}

// RevokeDirect 收回持权（owner 一键/级联共用；幂等）。reason 传装配回调
// 留痕（owner|cascade——owner 缘由的审计在带 gin 上下文的 handler 落，
// 回调只负责会话闸解除；expired 在惰性路径经 flushReleasedHolds 走）
func (s *Service) RevokeDirect(token, reason string) (*DirectHold, bool) {
	hold, ok := s.direct.revoke(token)
	if ok && reason != "owner" && s.directOnRelease != nil {
		sessionID := ""
		if sh, err := s.shares.Get(token); err == nil {
			sessionID = sh.TerminalID
		}
		s.directOnRelease(token, sessionID, reason)
	}
	return hold, ok
}

// CascadeRelease 存活集外的持权级联回收（清账管线调用：分享撤销/过期/
// 轮换后持权 token 键不在 keep 集即回收，OnRelease 以 cascade 缘由发出——
// 会话侧只读闸的解除不能依赖访客下一次触达：记录死亡后访客面 404，没人
// 再来触发惰性清扫）。返回回收条数
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
		if _, ok := s.direct.revoke(token); ok {
			sessionID := ""
			if sh, err := s.shares.Get(token); err == nil {
				sessionID = sh.TerminalID
			}
			if s.directOnRelease != nil {
				s.directOnRelease(token, sessionID, "cascade")
			}
		}
	}
	return len(doomed)
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
