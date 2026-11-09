package share

// 可写分享——「对方可直接输入」模式（P-20261106-8）：访客经 WS 上行桥把
// 键入直接注入锚定终端的 PTY。这是对 P-20261024-1 直通输入档头注红线
// （「普通终端直通 = 匿名远程 shell 等价，明确不做」）的**显式推翻**：
// 远程协助语义需要把终端临时交给对方操作，等价「坐在同一台键盘前」。
// 推翻的前提 = 五重补偿控制同时在场（缺一即整档不落地）：
//
//   - owner 逐案开关：可写从不悄悄出生（创建面兜底清零，store.Share.Writable），
//     开启走管理面动作端点（显式 confirm + 强制口令门——token 短链是 bearer
//     凭据会在聊天中转发，可写把泄露半径从「看输出」抬到「打 shell」，一道
//     口令是成比例的补偿），主人随时开/关，关闭即断全部上行连接。
//   - 出域警示：访客页常驻「你的输入将直达主人终端」横幅（termpage），
//     管理面开启时二次确认（confirm 标记，与直通档同款摩擦硬闸）。
//   - 全量审计：开/关/批量入账（share.writable）+ 每一注入批次入账
//     （share.writable.input，元数据口径——字节数/visitorId 摘要/IP，
//     文本本体不入账，quickdrop「内容不入审计」同口径）+ 粘贴审批决策
//     入账（share.writable.paste）。
//   - 实时可见：任一上行连接在场即广播 sc-ops:share.wtyping（owner 侧
//     「访客输入中」会话行徽标即时点亮），且 owner 终端 WS 输入被
//     directInputHold 反向闸拒绝（复用 P-20261024-1 同一服务端强制面——
//     「谁在输入」单写语义的 owner 侧让位）。
//   - 一键收回：管理面开关关 / 会话行右键 / 撤销轮换级联，三路入口同一
//     下游（WritableDown）——上行连接即刻断开、输入闸即刻解除。
//
// 审批分层（评审修订点2定案，沿 commandrisk 诚实边界）：
//   - 按键级输入**不做命令审批**——PTY 流无法可靠提取当前输入行，模式表
//     对字节流无处锚定；替代控制 = owner 实时可见（wtyping 徽标 + 输出回显）
//     + 一键收回。
//   - 粘贴形态输入（单帧 ≥ WritablePasteReviewBytes 或含换行的整块输入，
//     命令串整体可知）复用 commandrisk 预检（装配层注入，本包不 import
//     terminal）：命中 danger 档即挂待批面、广播 sc-ops:share.paste-review
//     审批卡，**未批不注入 PTY**；warning/未命中直接注入（owner 输出侧
//     实时可见）。60s 不决自动拒绝（owner 不在场 = 不注入）。
//   - 脱敏仅作用输出侧（liveterm 同一管线）；访客输入不做「脱敏」——
//     否则主人看到的审批卡与回显都不可信。
//
// WS 上行鉴权规格（评审修订点3定案）：
//   - 升级握手过与 HTTP 访客面同一 token+口令门（路由挂 gateGuard，口令
//     cookie/viewOnce 同语义）+ Origin 同源校验（与 api/shared.SameOrigin
//     同判据：Origin 在场必须同 Host，缺失放行=非浏览器客户端——凭据面
//     仍由口令门把守，跨站 WS 劫持在 CheckOrigin 被拒）。
//   - 访客身份绑 visitorId（直通档持权绑定键同款：localStorage 随机 id，
//     sanitizeVisitorID 清洗；此处是审计/可见性的标识键，不是凭据——凭据
//     = 短链 + 口令门会话）。
//   - 上行限流新定档（令牌桶）：连接级 40 帧/秒持续 / 120 帧瞬发 + token
//     全局 120 帧/秒持续 / 240 帧瞬发（≤ MaxWritersPerToken 条连接的合计
//     护栏），单帧 16KiB 读上限——防 PTY 刷屏；触限帧丢弃并回
//     input_throttled 控制帧（访客侧提示「输入太快」）。
//   - 断连语义：**WS 断开即释放持权**（末条上行连接断开即解除会话输入闸，
//     owner 键盘即时归还——方向安全的取态；SSE「凭 visitorId 恢复持权」
//     的直通档先例在此不映射：可写键入没有可恢复的队列态，重连即重新
//     接入并重过全部门禁）。持权/连接/待批面全部进程内（重启即清——
//     「无人看管的悬空写权」不该活过重启，直通档同款保守侧语义）。
//
// 并发输入语义（评审修订点4定案）：
//   - owner vs 访客：互斥，经 terminal.Session.directInputHold 反向闸强制
//     （任一上行连接在场 owner 输入即拒，末条断开即归还）。
//   - 访客 vs 访客：**多访客并发键入（「多人混打」）显式声明为允许**——
//     单 token 上行连接上限 MaxWritersPerToken=3（远程结对/教学的量级），
//     各连接独立注入、互不仲裁；「单持有者模式」（owner 限定一次只一人
//     键入）v1 不提供——需要时走直通输入档（申请-批准握手天然单持有者）。
//
// 组合语义（评审修订点6定案）：可写仅 live 直播形态（kind=terminal），
// frozen/cast/session/file 定格或静态语义天然只读；遮蔽只作用输出流
// （liveterm 主人/访客同一管线），访客输入的明文回显对 owner 可见——
// 否则「看到访客输入中」与审批卡都失去裁决依据。

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"codecombo/server/store"
	"codecombo/server/wssafe"

	"github.com/gorilla/websocket"
)

const (
	// MaxWritersPerToken 单 token 并发上行连接上限（并发输入护栏）：远程
	// 结对/教学的真实量级；超出拒绝升级（访客页提示稍后再试，SSE 只读
	// 观看不受影响）。导出常量：管理面响应投影与文档共用同一取值
	MaxWritersPerToken = 3

	// wsUpFrameMaxBytes 单帧字节读上限（16KiB）：键入单帧（含 IME 成句）
	// 远低于此，容纳大粘贴块；超限 gorilla 自动 1009 关闭——与「粘贴走
	// 整块预检」的协议面一致，超大块不该从帧边界悄悄漏过
	wsUpFrameMaxBytes = 16 << 10

	// 连接级帧率令牌桶（帧/秒）：人类键入 ≤15 帧/秒，粘贴是少量大帧；
	// 40/120 对真实交互零误伤，防的是脚本灌帧
	wsUpConnFrameRate  = 40
	wsUpConnFrameBurst = 120

	// token 全局帧率令牌桶：≤ MaxWritersPerToken 条连接的合计护栏
	//（连接级桶相加的理论上限已封顶，全局桶防未来连接数上调后的合流刷屏）
	wsUpTokenFrameRate  = 120
	wsUpTokenFrameBurst = 240

	// WritablePasteReviewBytes 整块输入判定阈值（字节）：单帧 ≥ 此值或含
	// 换行按粘贴形态走 commandrisk 预检。人类单帧键入（含 IME 成句提交，
	// 20 字汉字 ≈60 字节也在内）命中即预检——预检未命中零打扰，只有
	// danger 档才挂审批，阈值偏保守宁可多查一次
	WritablePasteReviewBytes = 64

	// WritablePasteReviewTTL 粘贴审批时效：60s 不决自动拒绝（owner 不在场
	// = 不注入；与直通申请面 DirectRequestTTL 同款保守侧语义）。
	// 导出常量：管理面响应投影与文档共用同一取值
	WritablePasteReviewTTL = 60 * time.Second

	// pasteAuditWindow 审计聚合窗口：WS 帧粒度是按键频次（10+ 帧/秒），
	// 逐帧入账会把审计台账撑成无界流水——按窗口聚合成一条批次事件
	//（连接断开时兜底冲一次），粒度仍是「批次字节数+visitorId 摘要+IP」
	// 的元数据口径，台账增速有界（单连接 ≤1 条/窗口）
	pasteAuditWindow = 5 * time.Second

	// maxPendingPastesPerToken 同 token 在途待批粘贴上限：连发危险粘贴的
	// 堆积上限（每条都挂 owner 审批卡会造成告警风暴），超出直接拒绝
	maxPendingPastesPerToken = 8

	// pastePreviewRunes 审批卡预览的 rune 上限：让 owner 认出「这是在粘什么」
	// 即可，完整块在终端回显侧随时可见
	pastePreviewRunes = 200
)

// WritableSink 可写输入落点（装配层适配 terminal 会话——本包不 import
// terminal，DirectSink 同款接口注入先例）。
type WritableSink interface {
	// WritableWrite 把一批访客键入写入会话 PTY（语义 = 键入，字节原样——
	// 控制字符是合法终端输入；普通终端开放，这正是对直通档红线的推翻点）
	WritableWrite(sessionID, text string) error
	// SetWritableGate 会话侧输入互斥闸：复用直通持权闸 directInputHold
	//（owner WS 键盘让位的服务端强制面，P-20261024-1 同一闸口）——首条
	// 上行连接建立置位、末条断开/开关关闭/级联解除。会话已关幂等直通
	//（闸随会话消亡）
	SetWritableGate(sessionID string, held bool)
}

// WritableRisk 粘贴级风险判定投影（装配层桥 terminal.MatchCommandRisk 的
// 结构性最小面——share 包不 import terminal，判定在装配层收口）
type WritableRisk struct {
	// Danger 命中 danger 档（rm 递归/-f、reset --hard、强推等不可逆破坏）
	// ——必须 owner 审批，未批不注入
	Danger bool
	// Summary 命中集一行摘要（terminal.RiskSummary 形态，审批卡证据）
	Summary string
}

// WritableTypingEvent sc-ops:share.wtyping 广播载荷（「访客输入中」徽标的
// 即时对账源；15s 轮询的 share 行投影是断线兜底，两路同源服务端状态）
type WritableTypingEvent struct {
	Token       string `json:"token"`
	ShareName   string `json:"shareName"`
	TerminalID  string `json:"terminalId"`
	Active      bool   `json:"active"`
	Visitors    int    `json:"visitors"`
	Nick        string `json:"nick,omitempty"`
	VisitorTail string `json:"visitorTail,omitempty"`
}

// PasteReviewEvent sc-ops:share.paste-review 广播载荷（owner 审批卡数据面；
// preview ≤200 rune 原样——访客输入不脱敏，owner 要看到真实命令才能裁决）
type PasteReviewEvent struct {
	Token       string `json:"token"`
	ShareName   string `json:"shareName"`
	TerminalID  string `json:"terminalId"`
	PasteID     string `json:"pasteId"`
	Summary     string `json:"summary"`
	Preview     string `json:"preview"`
	VisitorTail string `json:"visitorTail"`
	At          int64  `json:"at"`
}

// pendingPaste 一条待批粘贴块（审批中间态，进程内短时效——60s 不决自动
// 拒绝；开关关闭/分享撤销级联清）。文本本体滞留内存至决策时点（批准注入
// 的是当时提交的整块；重放窗口 = 审批时效内且仅 owner 批准方向）
type pendingPaste struct {
	ID        string
	Token     string
	SessionID string
	VisitorID string
	Summary   string
	Preview   string
	Bytes     int
	Text      string
	At        time.Time
}

// writableConn 一路上行连接的驻留态（token/sessionID/visitorID/nick/ip/
// conn/bucket 在接入时定格，此后只读；audit* 走自身 mu）
type writableConn struct {
	token     string
	sessionID string
	visitorID string
	nick      string
	ip        string
	conn      *wssafe.Conn
	bucket    *tokenBucket

	// audit 聚合器（5s 窗口一条批次事件，断开兜底冲一次——粒度见
	// pasteAuditWindow 注记）
	auditMu      sync.Mutex
	auditBytes   int
	auditFrames  int
	auditLastAdd time.Time
}

// tokenBucket 令牌桶（帧率限流的最小实现）：middleware.RateLimiter 是滑窗
// 事件计数（访客 HTTP 面语义），帧率闸需要「持续速率 + 瞬发余量」的桶
// 语义，就地 30 行实现不引依赖（passgate 复用 RateLimiter 的先例针对的
// 是「次数」维度，本处是「速率」维度，不可同构套用）
type tokenBucket struct {
	mu     sync.Mutex
	rate   float64 // 每秒补充令牌
	burst  float64 // 桶容量（瞬发余量）
	tokens float64
	last   time.Time
}

func newTokenBucket(rate, burst int, now time.Time) *tokenBucket {
	return &tokenBucket{rate: float64(rate), burst: float64(burst), tokens: float64(burst), last: now}
}

// allow 取一枚令牌；桶空 = 本帧触限（调用方丢弃帧并回告）
func (b *tokenBucket) allow(now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if d := now.Sub(b.last).Seconds(); d > 0 {
		b.tokens = min(b.burst, b.tokens+d*b.rate)
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// wsUpgrader 可写上行 WS 升级器：CheckOrigin 同源校验（与 api/shared.SameOrigin
// 同判据：Origin 在场必须同 Host——浏览器跨源握手在此被拒，防跨站 WS 劫持；
// 缺失放行 = curl/脚本客户端，凭据面仍由 gateGuard 把守）。就地实现而非引
// api/shared.WSUpgrade 工厂：工厂统一了压缩与 CheckOrigin 默认值，本包保持
// 「server/share 不反向依赖 api 层」的分层（判据与工厂逐字对齐，并有一致性
// 单测锚定不漂移——见 writable_test.go TestWSUpgraderSameOrigin）
var wsUpgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host == r.Host
}}

// writableHub 可写上行状态机（Service 持有一枚）：连接表（token → conns）+
// 待批粘贴面（pasteID 键全局表）+ token 全局帧率桶。锁纪律：mu 护三表；
// 外部回调（事件广播/会话闸）一律锁外执行（directHub released 快照同款
// 纪律——锁内不执行外部代码）
type writableHub struct {
	mu      sync.Mutex
	conns   map[string]map[*writableConn]struct{}
	pastes  map[string]*pendingPaste
	buckets map[string]*tokenBucket
}

func newWritableHub() *writableHub {
	return &writableHub{
		conns:   map[string]map[*writableConn]struct{}{},
		pastes:  map[string]*pendingPaste{},
		buckets: map[string]*tokenBucket{},
	}
}

// addConn 登记连接（上限护栏）；返回 (是否首条, 是否准入)。token 全局桶
// 在首条连接时惰性建、末条断开随表清扫
func (h *writableHub) addConn(c *writableConn, now time.Time) (first bool, ok bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.conns[c.token]) >= MaxWritersPerToken {
		return false, false
	}
	set := h.conns[c.token]
	if set == nil {
		set = map[*writableConn]struct{}{}
		h.conns[c.token] = set
	}
	set[c] = struct{}{}
	if _, exist := h.buckets[c.token]; !exist {
		h.buckets[c.token] = newTokenBucket(wsUpTokenFrameRate, wsUpTokenFrameBurst, now)
	}
	return len(set) == 1, true
}

// removeConn 摘除连接并清扫空 token 的桶；返回剩余连接数
func (h *writableHub) removeConn(c *writableConn) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.conns[c.token]
	if set == nil {
		return 0
	}
	delete(set, c)
	if len(set) == 0 {
		delete(h.conns, c.token)
		delete(h.buckets, c.token)
		return 0
	}
	return len(set)
}

// countOf 在场上行连接数（管理面 wtyping 投影）
func (h *writableHub) countOf(token string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.conns[token])
}

// tokenBucketOf 取 token 全局桶（连接读循环热路径；连接在场桶必在——
// addConn 与 removeConn 对桶的生命周期同锁维护）。nil 安全（理论不可达：
// 桶随连接生死，读循环持有连接期间桶必然存在；防御读防 panic）
func (h *writableHub) tokenBucketOf(token string) *tokenBucket {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.buckets[token]
}

// putPaste 挂待批粘贴（同锁内先清扫超时再查堆积上限）
func (h *writableHub) putPaste(token string, p *pendingPaste, now time.Time) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.expirePastesLocked(token, now)
	n := 0
	for _, x := range h.pastes {
		if x.Token == token {
			n++
		}
	}
	if n >= maxPendingPastesPerToken {
		return false
	}
	h.pastes[p.ID] = p
	return true
}

// resolvePaste 取走待批粘贴（批准/拒绝决策共口；幂等——未知/已决/非本
// token 返回 nil）。顺带清扫该 token 的超时粘贴（摘除结果经返回值带出）
func (h *writableHub) resolvePaste(token, pasteID string, now time.Time) (*pendingPaste, []*pendingPaste) {
	h.mu.Lock()
	defer h.mu.Unlock()
	expired := h.expirePastesLocked(token, now)
	p := h.pastes[pasteID]
	if p != nil && p.Token == token {
		delete(h.pastes, pasteID)
		return p, expired
	}
	return nil, expired
}

// expirePastesLocked 超时粘贴清扫：就地摘除并返回摘除列表（调用方持锁；
// 广播/审计由调用方锁外补——锁内不执行外部代码）
func (h *writableHub) expirePastesLocked(token string, now time.Time) []*pendingPaste {
	var expired []*pendingPaste
	for id, p := range h.pastes {
		if p.Token == token && now.Sub(p.At) > WritablePasteReviewTTL {
			delete(h.pastes, id)
			expired = append(expired, p)
		}
	}
	return expired
}

// drainExpiredPastes 取走某 token 的超时粘贴（管理面投影/状态端点触达时
// 顺带清扫——审批时效的兜底收口与 directHub 惰性时效同款取态：回收精度
// = 一次端点触达，60s 量级的时效完全够用）
func (h *writableHub) drainExpiredPastes(token string, now time.Time) []*pendingPaste {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.expirePastesLocked(token, now)
}

// clearTokenLocked 清空某 token 的全部待批粘贴（调用方已持 h.mu——
// WritableDown 在同一临界区内一并摘连接表/桶/待批面，三表清场原子化）；
// 返回被清列表供调用方补「拒绝」侧广播
func (h *writableHub) clearTokenLocked(token string) []*pendingPaste {
	var out []*pendingPaste
	for id, p := range h.pastes {
		if p.Token == token {
			delete(h.pastes, id)
			out = append(out, p)
		}
	}
	return out
}

// connsOf 取某 token 的连接快照（锁外广播用）
func (h *writableHub) connsOf(token string) []*writableConn {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.conns[token]
	out := make([]*writableConn, 0, len(set))
	for c := range set {
		out = append(out, c)
	}
	return out
}

// tokensOf 全部在场 token 快照（级联清场用）
func (h *writableHub) tokensOf() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]string, 0, len(h.conns))
	for token := range h.conns {
		out = append(out, token)
	}
	return out
}

// ── 访客端点（gateGuard 后——升级握手过与 HTTP 访客面同一 token+口令门） ──

// handleTermWS GET /s/{token}/termws?visitorId=&nickname= —— 可写分享的访客
// WS 上行桥。协议面（与终端 WS 同约定：BinaryMessage = PTY 输入字节，
// TextMessage 整类保留给服务端控制帧 JSON）：
//
//	客户端 → 服务端：BinaryMessage 一帧 = 一批键入字节（按键帧或粘贴块）
//	服务端 → 客户端（TextMessage 控制帧）：
//	  {"type":"hello"}                 接入成功（可写在场）
//	  {"type":"input_throttled"}       帧率触限，本帧已丢弃（访客侧提示稍候）
//	  {"type":"paste_review","id":p}   粘贴命中 danger，待 owner 审批（未注入）
//	  {"type":"paste_approved","id":p} 审批通过，字节已注入（回显经 SSE 到达）
//	  {"type":"paste_denied","id":p}   审批拒绝/超时，字节已丢弃
//	  {"type":"ended"}                 会话已关（锚定终端不在，连接将关闭）
//	  {"type":"writable_off"}          主人已关闭可写（连接将关闭，回落只读观看）
func (s *Service) handleTermWS(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	if !sh.Writable || sh.Kind != store.ShareKindTerminal || sh.TerminalID == "" {
		// 开关关/形态不对 = 端点不存在（存在性不可探测，drop 族同款语义）
		writeJSONErrorStatus(w, http.StatusNotFound, "share_not_found")
		return
	}
	visitorID := sanitizeVisitorID(r.URL.Query().Get("visitorId"))
	if visitorID == "" {
		writeJSONErrorStatus(w, http.StatusBadRequest, "invalid_visitor")
		return
	}
	if s.writableSink == nil {
		// 装配缺失（测试/降级部署）：诚实 503，不静默吞连接
		writeJSONErrorStatus(w, http.StatusServiceUnavailable, "unavailable")
		return
	}
	// Origin 同源校验 + 升级（CheckOrigin 判据见 wsUpgrader 注记）
	rawConn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	rawConn.SetReadLimit(wsUpFrameMaxBytes)
	conn := wssafe.New(rawConn)

	c := &writableConn{
		token:     sh.Token,
		sessionID: sh.TerminalID,
		visitorID: visitorID,
		nick:      sanitizeGuestNickname(r.URL.Query().Get("nickname")),
		ip:        clientIPOf(r),
		conn:      conn,
		bucket:    newTokenBucket(wsUpConnFrameRate, wsUpConnFrameBurst, time.Now()),
	}
	first, ok := s.writable.addConn(c, time.Now())
	if !ok {
		s.writeControl(c, "denied", map[string]any{"reason": "writer_limit"})
		_ = conn.Close()
		return
	}
	defer func() {
		remain := s.writable.removeConn(c)
		s.flushConnAudit(c, true)
		if remain == 0 {
			// 末条连接断开：闸解除（owner 键盘即时归还）+ 输入中广播摘除。
			// 回调均锁外执行（writableHub 锁纪律）
			s.writableSink.SetWritableGate(sh.TerminalID, false)
			s.emitWritableTyping(sh, 0, false)
		}
	}()
	if first {
		s.writableSink.SetWritableGate(sh.TerminalID, true)
		s.emitWritableTyping(sh, 1, true)
	}
	s.writeControl(c, "hello", nil)
	stopPing := conn.StartPing()
	defer stopPing()

	// 读循环：每帧 = 一批键入字节。断连即退出（defer 解除闸/审计收尾），
	// 无持权恢复面（头注断连语义定案：重连即重新接入并重过全部门禁）
	for {
		typ, msg, err := rawConn.ReadMessage()
		if err != nil {
			return
		}
		if typ != websocket.BinaryMessage || len(msg) == 0 {
			continue // 键入只走 Binary；Text 是协议误用，忽略不关（容忍探活端）
		}
		now := time.Now()
		// 帧率双桶：连接级 + token 全局（合流护栏）。触限帧整帧丢弃——
		// PTY 输入流没有「部分注入」的安全语义（半条命令比不执行更危险），
		// 回告让访客侧主动降速
		tb := s.writable.tokenBucketOf(c.token)
		if !c.bucket.allow(now) || tb == nil || !tb.allow(now) {
			s.writeControl(c, "input_throttled", nil)
			continue
		}
		text := string(msg)
		// 粘贴形态判定（整块输入，命令串整体可知）→ 复用 commandrisk 预检；
		// 按键级帧不做命令审批（头注审批分层定案）
		if len(msg) >= WritablePasteReviewBytes || bytes.ContainsRune(msg, '\n') {
			if risk := s.writableRiskOf(text); risk != nil && risk.Danger {
				s.holdPasteForReview(sh, c, text, risk, now)
				continue
			}
		}
		if !s.injectWritable(sh, c, text, now) {
			return
		}
	}
}

// injectWritable 注入一批键入并聚合审计；会话已关回 ended 帧并返回 false
// （读循环退出）。注入成功顺带触达待批面清扫（惰性时效的免 ticker 取态，
// directHub 同款）
func (s *Service) injectWritable(sh *store.Share, c *writableConn, text string, now time.Time) bool {
	if err := s.writableSink.WritableWrite(c.sessionID, text); err != nil {
		// 会话已关/拒绝写：锚定终端不在（不把写失败伪装成访客错误）——
		// 回 ended 帧并断开，访客页呈现「已结束」（与 SSE 流终结同语义）
		s.writeControl(c, "ended", nil)
		return false
	}
	for _, p := range s.writable.drainExpiredPastes(c.token, now) {
		s.broadcastControl(c.token, "paste_denied", map[string]any{"id": p.ID, "reason": "expired"})
	}
	// 审计聚合：首帧锚定窗口（单键批次不成账——逐键事件是台账噪音），
	// 此后窗口到期即成账（余量取走清账，事件成型在锁外——appendConnAudit
	// 只读快照）；断开兜底走 flushConnAudit
	c.auditMu.Lock()
	c.auditBytes += len(text)
	c.auditFrames++
	due := false
	var bytesAcc, frames int
	if c.auditLastAdd.IsZero() {
		c.auditLastAdd = now
	} else if now.Sub(c.auditLastAdd) >= pasteAuditWindow {
		due = true
		bytesAcc, frames = c.auditBytes, c.auditFrames
		c.auditBytes, c.auditFrames = 0, 0
		c.auditLastAdd = now
	}
	c.auditMu.Unlock()
	if due {
		s.appendConnAudit(c, bytesAcc, frames)
	}
	return true
}

// appendConnAudit 把连接的审计聚合余量写成一条批次事件（窗口到期由
// injectWritable 触发带余量、断开兜底由 flushConnAudit 全量触发；字节/帧数
// 在调用前已由调用方清账，这里只负责事件成型）
func (s *Service) appendConnAudit(c *writableConn, bytesAcc, frames int) {
	if bytesAcc <= 0 {
		return
	}
	name := c.token
	if sh, err := s.shares.Get(c.token); err == nil && sh.Name != "" {
		name = sh.Name
	}
	s.views.Add(store.AuditEvent{
		Action: store.AuditShareWritableInput,
		Result: store.AuditResultSuccess,
		Time:   time.Now(),
		IP:     c.ip,
		Detail: fmt.Sprintf("%s (%s), visitor %s input %d bytes in %d frames -> session %s",
			name, c.token, visitorBrief(c.visitorID), bytesAcc, frames, c.sessionID),
	})
}

// flushConnAudit 冲连接的审计聚合余量（断开兜底路径；窗口路径走
// appendConnAudit）。取余量后清账，事件成型在锁外
func (s *Service) flushConnAudit(c *writableConn, _ bool) {
	c.auditMu.Lock()
	bytesAcc, frames := c.auditBytes, c.auditFrames
	c.auditBytes, c.auditFrames = 0, 0
	c.auditMu.Unlock()
	s.appendConnAudit(c, bytesAcc, frames)
}

// holdPasteForReview 粘贴命中 danger：挂待批面 + 回 paste_review 帧 + 广播
// 审批卡。未批不注入（字节滞留在待批面，批准时注入的是当时提交的整块）
func (s *Service) holdPasteForReview(sh *store.Share, c *writableConn, text string, risk *WritableRisk, now time.Time) {
	summary := ""
	if risk != nil {
		summary = risk.Summary
	}
	p := &pendingPaste{
		ID:        newPasteID(),
		Token:     c.token,
		SessionID: c.sessionID,
		VisitorID: c.visitorID,
		Summary:   summary,
		Preview:   pastePreview(text),
		Bytes:     len(text),
		Text:      text,
		At:        now,
	}
	if !s.writable.putPaste(c.token, p, now) {
		// 在途堆积超限：诚实拒绝（访客侧提示），不静默吞
		s.writeControl(c, "paste_denied", map[string]any{"id": p.ID, "reason": "too_many"})
		return
	}
	s.writeControl(c, "paste_review", map[string]any{"id": p.ID})
	if s.pasteReviewEvents != nil {
		s.pasteReviewEvents(PasteReviewEvent{
			Token:       sh.Token,
			ShareName:   sh.Name,
			TerminalID:  sh.TerminalID,
			PasteID:     p.ID,
			Summary:     p.Summary,
			Preview:     p.Preview,
			VisitorTail: visitorBrief(c.visitorID),
			At:          now.UnixMilli(),
		})
	}
}

// ResolvePasteReview owner 审批决策（api 层端点调用）：approve=true 注入
// 当时的整块并广播 paste_approved；false 丢弃并广播 paste_denied。
// 幂等：未知/已决 pasteID 返回 false（决策卡只能点一次，重复点击零副作用）。
// 决策审计由 api 层落（带请求上下文与操作者 IP）
func (s *Service) ResolvePasteReview(token, pasteID string, approve bool) bool {
	now := time.Now()
	p, expired := s.writable.resolvePaste(token, pasteID, now)
	for _, e := range expired {
		// 决策触达顺带收口的超时粘贴：拒绝侧广播（审计在共享路径补——
		// 无 gin 上下文，经 views 攒批走裸 Append 先例）
		s.broadcastControl(token, "paste_denied", map[string]any{"id": e.ID, "reason": "expired"})
		s.auditPasteExpired(e)
	}
	if p == nil {
		return false
	}
	if approve && s.writableSink != nil {
		if err := s.writableSink.WritableWrite(p.SessionID, p.Text); err == nil {
			s.broadcastControl(token, "paste_approved", map[string]any{"id": p.ID})
			return true
		}
		// 会话已关：按拒绝收场（诚实呈现——批准了也注入不进去）
	}
	s.broadcastControl(token, "paste_denied", map[string]any{"id": p.ID})
	return true
}

// auditPasteExpired 超时自动拒绝的审计（无请求上下文的共享路径——views
// 攒批 + 裸 Append 的 FlushViewAudits 同款先例；owner 决策的审计在 api
// 层带上下文落，不双写）
func (s *Service) auditPasteExpired(p *pendingPaste) {
	name := p.Token
	if sh, err := s.shares.Get(p.Token); err == nil && sh.Name != "" {
		name = sh.Name
	}
	s.views.Add(store.AuditEvent{
		Action: store.AuditShareWritablePaste,
		Result: store.AuditResultSuccess,
		Time:   time.Now(),
		Detail: fmt.Sprintf("%s (%s), paste %s auto-expired (%d bytes, visitor %s), not injected",
			name, p.Token, p.ID, p.Bytes, visitorBrief(p.VisitorID)),
	})
}

// WritableDown 关闭某 token 的可写上行（owner 开关关闭/撤销轮换级联共用）：
// 断开全部连接（各连接 defer 解除闸+冲审计）、清待批粘贴面并广播拒绝。
// 三表清场同临界区原子化（连接表/桶/待批面，clearTokenLocked 变体）。
// 幂等（无连接且无在途粘贴返回 false）
func (s *Service) WritableDown(token string) bool {
	s.writable.mu.Lock()
	set := s.writable.conns[token]
	delete(s.writable.conns, token)
	delete(s.writable.buckets, token)
	pastes := s.writable.clearTokenLocked(token)
	s.writable.mu.Unlock()
	if len(set) == 0 && len(pastes) == 0 {
		return false
	}
	for c := range set {
		s.writeControl(c, "writable_off", nil)
		_ = c.conn.Close()
	}
	for _, p := range pastes {
		s.broadcastControl(token, "paste_denied", map[string]any{"id": p.ID, "reason": "off"})
	}
	return true
}

// CascadeWritableDown 存活集外的上行连接清场（清账管线调用：分享撤销/
// 过期/轮换后 token 键不在 keep 集即断开——记录死亡后访客面 404，上行
// 桥不能残留）。返回清场条数
func (s *Service) CascadeWritableDown(keep map[string]bool) int {
	if keep == nil || s == nil {
		return 0
	}
	n := 0
	for _, token := range s.writable.tokensOf() {
		if !keep[token] && s.WritableDown(token) {
			n++
		}
	}
	return n
}

// WritableState 管理面的上行在场投影（shareResponse wtyping 字段数据源；
// 15s 轮询是 sc-ops 广播的断线兜底）。visitors>0 即「访客输入中」
func (s *Service) WritableState(token string) (visitors int) {
	return s.writable.countOf(token)
}

// broadcastControl token 全体上行连接广播一枚控制帧
func (s *Service) broadcastControl(token, typ string, extra map[string]any) {
	for _, c := range s.writable.connsOf(token) {
		s.writeControl(c, typ, extra)
	}
}

// writeControl 向单连接写一枚 TextMessage 控制帧。写失败静默（读循环的
// 下一次 ReadMessage 会拿到断连错误统一收场）
func (s *Service) writeControl(c *writableConn, typ string, extra map[string]any) {
	frame := map[string]any{"type": typ}
	for k, v := range extra {
		frame[k] = v
	}
	data, err := json.Marshal(frame)
	if err != nil {
		return
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_ = c.conn.WriteMessage(websocket.TextMessage, data)
}

// emitWritableTyping 广播「访客输入中」状态（连接建立/末条断开两界；装配层
// 接 opschannel——server/share 不反向依赖 api 层，dropEvents 同款回调注入）
func (s *Service) emitWritableTyping(sh *store.Share, visitors int, active bool) {
	if s.writableEvents == nil {
		return
	}
	ev := WritableTypingEvent{
		Token:      sh.Token,
		ShareName:  sh.Name,
		TerminalID: sh.TerminalID,
		Active:     active,
		Visitors:   visitors,
	}
	for _, c := range s.writable.connsOf(sh.Token) {
		ev.Nick = c.nick
		ev.VisitorTail = visitorBrief(c.visitorID)
		break // 单写者语义展示首位（多写者并存的指认位在审计台账）
	}
	s.writableEvents(ev)
}

// handleWritableState GET /s/{token}/writable/state —— 可写状态轮询端点
// （访客页在未接入上行桥期间 5s 轮询：主人随时开启可写时访客页即时接入，
// WS 在场即停轮）。gateGuard 后零额外门——开关关也如实回 false（此端点
// 不承载存在性敏感面：页面本身已经过口令门才可见，轮询节奏与直通档
// 2s 对账同族且更疏）
func (s *Service) handleWritableState(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	on := sh.Writable && sh.Kind == store.ShareKindTerminal && sh.TerminalID != ""
	writeJSON(w, map[string]any{"writable": on})
}

// ── 小工具 ──

// pastePreview 审批卡预览：头部 ≤200 rune 原样截取（访客输入不脱敏——
// owner 要看到真实命令才能裁决；完整块在终端回显侧随时可见）
func pastePreview(text string) string {
	runes := []rune(text)
	if len(runes) > pastePreviewRunes {
		return string(runes[:pastePreviewRunes])
	}
	return text
}

// newPasteID 待批粘贴标识：crypto/rand 16 字节 hex——决策端点按 id 定位，
// 不可预测性防访客侧枚举猜 id 抢先「自批」（决策在 owner 鉴权链后，id 是
// 对账键不是凭据，随机化只是不把枚举面递到访客手里）
func newPasteID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("p-%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// ensureUTF8Text 输入文本的 UTF-8 兜底（非法序列替换 RuneError——PTY 注入
// 原样字节不受此影响，仅风险判定/审计口径需要合法字符串）
func ensureUTF8Text(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	return string([]rune(strings.ToValidUTF8(s, string(utf8.RuneError))))
}

// writableRiskOf 粘贴风险预检（装配层注入；nil = 未装配，诚实按「无判定
// 可用」处理——不挂待批面直接注入，由 owner 输出侧实时可见兜底。装配
// 缺失只发生在测试/降级部署，真实部署必然注入）
func (s *Service) writableRiskOf(text string) *WritableRisk {
	if s.writableRisk == nil {
		return nil
	}
	r := s.writableRisk(ensureUTF8Text(text))
	return &r
}
