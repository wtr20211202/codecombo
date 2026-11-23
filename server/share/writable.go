package share

// 访客输入·统一 WS 上行桥（P-20261106-8 可写分享，P-20261121-1 统一收编
// 为「访客输入」双授权模式的单一传输面）：
//
//   - 开放直入模式（store.Share.Writable，owner 显式开关 + 强制口令门——
//     P-20261106-8 五重补偿控制原样在场：owner 逐案开关/出域警示/全量审计/
//     实时可见/一键收回）：持链接（+口令）访客接入即开键入，远程协助语义
//    （等价「坐在同一台键盘前」——语义升格诚实口径：访客可实际提交并
//     驱动终端，管理面文案已如实改写）。
//   - 申请批准模式（申请通道默认在场，GuestInputOff=false；P-20261024-1
//     直通档的握手机制保留为统一能力的授权路径）：访客接入只看状态
//    （申请/等待/持权），键入帧仅在持权（directHub.holds 绑 token+visitorId）
//     时被接受，持权帧顺带 directHub.touch 续 10min 滑动时效；收回/过期
//     主动断开该访客连接（direct.go kickDirectVisitor）。
//   - 两开关独立不互斥（用户定案：owner 面两枚开关）：并开时开放直入覆盖
//     申请路径（宽松优先——任何访客已可直接键入，申请批准形同虚设由 owner
//     开启面提示承担告知），连接按接入时点定格模式（字段翻转不断开既有
//     连接，保守侧语义）。
//   - 会话输入闸经 gateLedger 合并账本驱动（direct.go 必改3）：开放直入的
//     「开放连接在场」与申请批准的「持权在场」统一记账，单点落
//     writableSink.SetWritableGate（= terminal.Session.directInputHold 同一
//     服务端强制面，P-20261008-17 input-lock 同源）；双开关并存时关其一
//     不得误归还 owner 键盘给另一模式在场访客。
//
// 五重补偿控制（开放直入，缺一即整档不落地）：
//
//   - owner 逐案开关：可写从不悄悄出生（创建面快捷选择同样显式 opt-in +
//     口令门强制，store.Share.Writable），开启走管理面动作端点（显式
//     confirm + 强制口令门——token 短链是 bearer 凭据会在聊天中转发，可写
//     把泄露半径从「看输出」抬到「打 shell」，一道口令是成比例的补偿），
//     主人随时开/关，关闭即断开放直入上行连接。
//   - 出域警示：访客页常驻「你的输入将直达主人终端」横幅（termpage），
//     管理面开启时二次确认（confirm 标记）。
//   - 全量审计：开/关/批量入账（share.writable）+ 每一注入批次入账
//     （share.writableInput 统一单事件，Detail mode=open|hold 分档授权
//     模式，元数据口径——字节数/visitorId 摘要/IP，文本本体不入账，
//     quickdrop「内容不入审计」同口径）+ 粘贴审批决策入账
//     （share.writablePaste）。
//   - 实时可见：任一**开放**上行连接在场即广播 sc-ops:share.wtyping（owner
//     侧「访客输入中」会话行徽标即时点亮；申请批准路径的持权在 direct
//     投影有同族徽标——徽标语义=可键入，连接在场但无持权不点亮），且
//     owner 终端 WS 输入被 directInputHold 反向闸拒绝（复用 P-20261024-1
//     同一服务端强制面——「谁在输入」单写语义的 owner 侧让位）。
//   - 一键收回：管理面开关关 / 会话行右键 / 撤销轮换级联，三路入口同一
//     下游（WritableDown）——开放直入连接即刻断开、输入闸账本即刻解除。
//
// 审批分层（评审修订点2定案，沿 commandrisk 诚实边界）：
//   - 按键级输入**不做命令审批**——PTY 流无法可靠提取当前输入行，模式表
//     对字节流无处锚定；替代控制 = owner 实时可见（wtyping 徽标 + 输出回显）
//     + 一键收回。
//   - 粘贴形态输入（单帧 ≥ WritablePasteReviewBytes 或含换行的整块输入，
//     命令串整体可知）复用 commandrisk 预检（装配层注入，本包不 import
//     terminal）：命中 danger 档即挂待批面、广播 sc-ops:share.paste-review
//     审批卡，**未批不注入 PTY**；warning/未命中直接注入（owner 输出侧
//     实时可见）。60s 不决自动拒绝（owner 不在场 = 不注入）。两授权模式
//     同闸——申请批准路径的持权访客键入同样过粘贴预检。
//   - 脱敏仅作用输出侧（liveterm 同一管线）；访客输入不做「脱敏」——
//     否则主人看到的审批卡与回显都不可信。
//
// WS 上行鉴权规格（评审修订点3定案）：
//   - 升级握手过与 HTTP 访客面同一 token+口令门（路由挂 gateGuard，口令
//     cookie/viewOnce 同语义）+ Origin 同源校验（与 api/shared.SameOrigin
//     同判据：Origin 在场必须同 Host，缺失放行=非浏览器客户端——凭据面
//     仍由口令门把守，跨站 WS 劫持在 CheckOrigin 被拒）。
//   - 访客身份绑 visitorId（localStorage 随机 id，sanitizeVisitorID 清洗；
//     此处是审计/可见性/持权绑定的标识键，不是凭据——凭据 = 短链 + 口令
//     门会话）。
//   - 上行限流新定档（令牌桶）：连接级 40 帧/秒持续 / 120 帧瞬发 + token
//     全局 120 帧/秒持续 / 240 帧瞬发（≤ MaxWritersPerToken 条连接的合计
//     护栏）+ **连接级字节桶**（1MiB/s 持续 / 2MiB 瞬发，P-20261122-18 ⑤），
//     单帧 1MiB 读上限（与主人端同参）——帧桶管帧数、字节桶管字节量，防
//     PTY 刷屏；触限帧整帧丢弃并回 input_throttled 控制帧（访客侧提示
//     「输入太快」）。
//   - 断连语义：**开放直入 WS 断开即释放连接**（末条开放连接断开即经账本
//     解除会话输入闸，owner 键盘即时归还——方向安全的取态；可写键入没有
//     可恢复的队列态，重连即重新接入并重过全部门禁）。**申请批准路径的
//     持权不受断连影响**（持权=显式授权物，凭 visitorId 恢复键入资格——
//     P-20261024-1 保留语义；收回/过期/关通道才断开，kickDirectVisitor）。
//     持权/连接/待批面全部进程内（重启即清——「无人看管的悬空写权」不该
//     活过重启，保守侧语义）。
//
// 并发输入语义（评审修订点4定案）：
//   - owner vs 访客：互斥，经 terminal.Session.directInputHold 反向闸强制
//     （闸值由 gateLedger 账本驱动，任一来源在场 owner 输入即拒，末个来源
//     离场即归还）。
//   - 访客 vs 访客：**开放直入多访客并发键入（「多人混打」）显式声明为
//     允许**——单 token 上行连接上限 MaxWritersPerToken=3（远程结对/教学
//     的量级），各连接独立注入、互不仲裁；**单持有者语义由申请批准路径
//     提供**（申请-批准握手天然单持有者：持权 visitorId 绑定，非持权帧
//     拒收）。
//
// 组合语义（评审修订点6定案）：仅 live 直播形态（kind=terminal），
// frozen/cast/session/file 定格或静态语义天然只读；遮蔽只作用输出流
// （liveterm 主人/访客同一管线），访客输入的明文回显对 owner 可见——
// 否则「看到访客输入中」与审批卡都失去裁决依据。
//
// 视口反喂 resize（P-20261120-8）：访客键入让渡的画布面——访客视口宽度
// 反喂主机 PTY（业界 ttyd/VS Code web 终端「客户端窗口=终端宽度」语义），
// 文字按视口折行零结构性留白。只读直播页不新增任何 resize 上行（严格只读
// 契约不变），其显示栅格仍经 SSE resize 帧跟随主机变化（P-20261107-4 既有
// 面）。resize 控制面复用同一 WS 连接与门禁（gateGuard+Origin+visitor
// 绑定），帧类型新增控制指令而非走键入帧率桶；服务端承接链 = 钳制 →
// conn 节流 ≥1s → token 合并窗 500ms（last-write-wins）→ 落点应用
// （TmuxExternal 会话禁用）→ resize_applied 回执 + 审计 + sc-ops 广播；
// 申请批准连接仅持权在窗口期才受理 resize（无持权忽略——画布让渡随键入
// 资格走）。

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

	// wsUpFrameMaxBytes 单帧字节读上限（1MiB，P-20261122-18 ⑤）：与主人端
	// WSReadLimitInput 同参（server/api/shared/ws.go）。xterm.onData 把一次
	// 粘贴整块交给一个 WebSocket 帧——旧值 16KiB 下大段文本粘贴（长命令/
	// 日志/代码块）超限即被 gorilla 以 1009 关闭，访客只看到断桥、内容
	// 丢失。上限之下另设连接级**字节桶**（wsUpConnByteRate/Burst）做速率面
	// 收口；明确不做客户端分片：分片会让一条危险命令跨帧逃过 commandrisk
	// 预检（服务端按单帧 ≥WritablePasteReviewBytes 或含换行判定），并让
	// 帧桶丢弃无 ACK 的分片造成 PTY 收到缺块命令（半条命令比不执行更危险）
	wsUpFrameMaxBytes = 1 << 20

	// 连接级帧率令牌桶（帧/秒）：人类键入 ≤15 帧/秒，粘贴是少量大帧；
	// 40/120 对真实交互零误伤，防的是脚本灌帧
	wsUpConnFrameRate  = 40
	wsUpConnFrameBurst = 120

	// 连接级字节桶（字节/秒，P-20261122-18 ⑤）：帧率桶只管「帧数」，1MiB
	// 帧上限放开后单帧可携大量字节——两桶并行才封住「少量超大帧刷屏」。
	// 1MiB/s 持续 + 2MiB 突发：人类粘贴（含连按 Ctrl+V）远低于此，大文件
	// 走 REST upload 不占本桶；超限整帧丢弃并回 input_throttled（PTY 输入流
	// 没有「部分注入」的安全语义）
	wsUpConnByteRate  = 1 << 20
	wsUpConnByteBurst = 2 << 20

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

	// ── 视口反喂 resize（P-20261120-8）：可写上行桥的控制面指令 ──

	// wsResizeConnMinInterval conn 级 resize 帧独立节流（≥1s，评审必改3）：与
	// 键入帧率桶分离——resize 是控制面低频指令，跟输入字节共享桶既不必要也会
	// 在窗口拖拽时挤占键入配额；1s 对真实拖拽（前端另有 250ms 防抖）零感知
	wsResizeConnMinInterval = time.Second

	// wsResizeMergeWindow token 级合并窗（评审必改4：多访客 last-write-wins +
	// 500ms-1s 服务端合并窗）：窗内多访客/多帧只保留最后上报值（pending 覆盖），
	// 到期一次应用——并发突刺收敛为单次 PTY resize（Session.Resize 同尺寸去重
	// 兜底防 PSReadLine banner 重发污染，terminal/manager.go Resize 注记）
	wsResizeMergeWindow = 500 * time.Millisecond

	// 访客上报尺寸的服务端钳制域（评审必改3）：与访客页栅格钳制（termpage
	// setHost cols≤500/rows≤300）对齐——两端同域则应用值恒等于请求值，不产生
	// 钳制差振荡。**cols 下限 80（P-20261122-16 ⑤）**：访客视口算出 <80 列时
	// 前端直接不反喂（手机硬喂窄列只会把主人终端压成窄条+访客页横滚），服务端
	// 同域钳制是直连 WS 绕过的兜底；**只动访客路径**——Session.Resize 全局与
	// 主人侧 PUT resize 的 ≥20 下限不受影响（主人自己可以要窄终端）
	writableResizeMinCols = 80
	writableResizeMaxCols = 500
	writableResizeMinRows = 2
	writableResizeMaxRows = 300
)

// WritableSink 访客输入落点（装配层适配 terminal 会话——本包不 import
// terminal，接口注入先例）。
type WritableSink interface {
	// WritableWrite 把一批访客键入写入会话 PTY（语义 = 键入，字节原样——
	// 控制字符是合法终端输入；开放直入与申请批准两模式统一走本落点）
	WritableWrite(sessionID, text string) error
	// SetWritableGate 会话侧输入互斥闸：gateLedger 合并账本的单点落闸
	//（direct.go 必改3）——开放直入「连接在场」与申请批准「持权在场」两
	// 来源统一记账后在此落 terminal.Session.directInputHold 同一强制面。
	// 会话已关幂等直通（闸随会话消亡）
	SetWritableGate(sessionID string, held bool)
}

// WritableResizer 可写视口 resize 落点（可选装配，P-20261120-8——与 WritableSink
// 分面注入：resize 权随可写让渡，但落点能力独立（测试桩不必实现；nil = resize
// 帧静默忽略，键入链零影响）。装配层桥 terminal.Session.Resize 与
// TmuxExternal/owner 附着判定，本包不 import terminal）
type WritableResizer interface {
	// WritableResizeDenyReason 会话是否允许访客视口 resize（P-20261122-16 ④，
	// 由 P-20261120-8 的 bool 准入升级为可观测原因）：空串 = 允许；非空 =
	// 拒绝原因，随 resize_denied 帧下发给访客页据此回落/退避：
	//   - "external_session" 外部接管会话（TmuxExternal，真机 tmux 客户端
	//     window-size 交互未定义，访客改格会与其互相踩踏）——驱动停用不重试；
	//   - "owner_active"     主人在本机有交互客户端附着（owner 的 xterm 不随
	//     PTY 改格重排，访客反喂会让主人视图错位）——30s 退避后重试，画布
	//     以主机为准；
	//   - "session_missing"  会话不在（落点会报错，原因面在准入口如实区分）
	WritableResizeDenyReason(sessionID string) string
	// WritableResize 调整锚定会话 PTY 尺寸（语义=视口反喂，rows×cols 与
	// terminal.Session.Resize 同序）。不判 directInputHold——闸拦的是键入方向
	// （owner 键盘让位），画布尺寸是可写让渡面的一部分
	WritableResize(sessionID string, cols, rows uint16) error
}

// WritableResizeEvent sc-ops:share.wresize 广播载荷（owner 侧「终端被改格」的
// 最小可见性面，评审必改5：wtyping 徽标给出「访客在场」，本事件给出「改成了
// 什么格」；agent 侧同事件可感知。仅元数据）
type WritableResizeEvent struct {
	Token       string `json:"token"`
	ShareName   string `json:"shareName"`
	TerminalID  string `json:"terminalId"`
	Cols        uint16 `json:"cols"`
	Rows        uint16 `json:"rows"`
	VisitorTail string `json:"visitorTail,omitempty"`
	At          int64  `json:"at"`
}

// pendingResize 合并窗内的一段待应用 resize（token 键一条，last-write-wins；
// timer 到期由 fireWritableResize 取走应用）。open/visitorID 是提交时点的
// 授权身份定格（P-20261122-17）：fire 前复核——open 需仍有开放连接且记录
// 仍开着 Writable，hold 需持权仍绑同一 visitorId；否则整段丢弃（授权物收回
// 后旧 resize 不得再落到 PTY——收回后 500ms 内仍应用旧值是与 P-20261120-8
// 语义相悖的窗口）
type pendingResize struct {
	cols, rows uint16
	visitorID  string
	ip         string
	open       bool
	timer      *time.Timer
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
// 拒绝；开放直入关闭/分享撤销级联清）。文本本体滞留内存至决策时点（批准
// 注入的是当时提交的整块；重放窗口 = 审批时效内且仅 owner 批准方向）。
// open = 提交连接的授权模式定格（WritableDown 选择性清场按此分档——申请
// 批准路径的待批块不随开放直入关闭而清，其授权物是持权不是开关）
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
	Open      bool
}

// writableConn 一路上行连接的驻留态（token/sessionID/visitorID/nick/ip/
// conn/bucket/open 在接入时定格，此后只读；audit* 走自身 mu）。open =
// 接入时点的授权模式定格（true=开放直入 sh.Writable；false=申请批准——
// 两开关独立不互斥，字段翻转不断开既有连接，本连接的键入资格判定按定格
// 模式走）。byteBucket 是连接级字节桶（P-20261122-18 ⑤）——帧桶的字节
// 维度并行闸，接入时建、随连接消亡
type writableConn struct {
	token      string
	sessionID  string
	visitorID  string
	nick       string
	ip         string
	conn       *wssafe.Conn
	bucket     *tokenBucket
	byteBucket *tokenBucket
	open       bool

	// audit 聚合器（5s 窗口一条批次事件，断开兜底冲一次——粒度见
	// pasteAuditWindow 注记）
	auditMu      sync.Mutex
	auditBytes   int
	auditFrames  int
	auditLastAdd time.Time

	// lastResize conn 级 resize 帧节流锚（wsResizeConnMinInterval；与键入帧率
	// 桶分离的控制面独立节流，评审必改3）——resize 帧频度低（前端 250ms 防抖
	// + 拖拽间歇），互斥锁就够，不必上桶
	resizeMu   sync.Mutex
	lastResize time.Time
}

// tokenBucket 令牌桶（速率限流的最小实现）：middleware.RateLimiter 是滑窗
// 事件计数（访客 HTTP 面语义），帧率/字节闸需要「持续速率 + 瞬发余量」的桶
// 语义，就地 40 行实现不引依赖（passgate 复用 RateLimiter 的先例针对的
// 是「次数」维度，本处是「速率」维度，不可同构套用）。令牌单位由调用方
// 定义：帧桶 1 枚 = 1 帧（allow），字节桶 1 枚 = 1 字节（allowN）
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

func (b *tokenBucket) refillLocked(now time.Time) {
	if d := now.Sub(b.last).Seconds(); d > 0 {
		b.tokens = min(b.burst, b.tokens+d*b.rate)
		b.last = now
	}
}

// allow 取一枚令牌；桶空 = 本帧触限（调用方丢弃帧并回告）
func (b *tokenBucket) allow(now time.Time) bool {
	return b.allowN(now, 1)
}

// allowN 取 n 枚令牌（字节桶用：n = 本帧字节数）。不足则**不消耗**直接
// 拒绝——调用方整帧丢弃，不回补半份（PTY 输入无部分注入语义）
func (b *tokenBucket) allowN(now time.Time, n float64) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refillLocked(now)
	if b.tokens < n {
		return false
	}
	b.tokens -= n
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

// shareWSReadTimeout 可写上行 WS 读超时（P-20261122-17）：对照主人终端 WS
// 的 60s 读超时 + pong 续期（api/terminal ws_attach）。半开连接（休眠/拔网
// 线，TCP 层不报错）会让读循环永久阻塞，开放连接在场使 "ws:" 闸来源滞留、
// owner 键盘被永久让位。只解决半开检测，不替代 direct 授权闸（持权时效
// 独立）。var 仅供测试注入 1s 短窗钉住语义（replayChunkDeadline 同款）
var shareWSReadTimeout = 60 * time.Second

// writableHub 可写上行状态机（Service 持有一枚）：连接表（token → conns）+
// 待批粘贴面（pasteID 键全局表）+ token 全局帧率桶 + 视口 resize 合并窗
// （token → pendingResize，P-20261120-8）。锁纪律：mu 护四表；外部回调
// （事件广播/会话闸）一律锁外执行（directHub released 快照同款
// 纪律——锁内不执行外部代码）
type writableHub struct {
	mu      sync.Mutex
	conns   map[string]map[*writableConn]struct{}
	pastes  map[string]*pendingPaste
	buckets map[string]*tokenBucket
	resizes map[string]*pendingResize
}

func newWritableHub() *writableHub {
	return &writableHub{
		conns:   map[string]map[*writableConn]struct{}{},
		pastes:  map[string]*pendingPaste{},
		buckets: map[string]*tokenBucket{},
		resizes: map[string]*pendingResize{},
	}
}

// addConn 登记连接（上限护栏）；返回 (是否首条开放连接, 是否准入)。token
// 全局桶在首条连接时惰性建、末条断开随表清扫。开放连接首条判定在 hub 锁内
// 原子完成（调用方据此做闸账本 acquire——锁外判 openCount 会与并发接入竞态，
// 两个同刻接入可能都判非首条而漏 acquire，闸悬挂）
func (h *writableHub) addConn(c *writableConn, now time.Time) (openFirst bool, ok bool) {
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
	if c.open {
		openFirst = h.countOpenLocked(c.token) == 1
	}
	return openFirst, true
}

// removeConn 摘除连接并清扫空 token 的桶；返回 (剩余连接数, 剩余开放连接数)
// ——两值同锁内原子带出（调用方据此做闸账本 release：末条开放连接离场判定
// 与摘除原子，防「摘除后新开放连接接入、旧连接误 release」的窗口）
func (h *writableHub) removeConn(c *writableConn) (remain, openRemain int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	set := h.conns[c.token]
	if set == nil {
		return 0, 0
	}
	delete(set, c)
	if len(set) == 0 {
		delete(h.conns, c.token)
		delete(h.buckets, c.token)
		return 0, 0
	}
	return len(set), h.countOpenLocked(c.token)
}

// countOpenLocked 在场开放直入连接数（调用方持 h.mu）
func (h *writableHub) countOpenLocked(token string) int {
	n := 0
	for c := range h.conns[token] {
		if c.open {
			n++
		}
	}
	return n
}

// openCountOf 在场开放直入连接数（管理面 wtyping 投影——徽标语义=可键入，
// 申请批准连接在场但无持权不点亮；旧全量 countOf 随 P-20261121-1 投影切换
// openCountOf 失去唯一调用方一并退役，防 lint unused）
func (h *writableHub) openCountOf(token string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.countOpenLocked(token)
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

// clearPastesLocked 清某 token 的待批粘贴（调用方已持 h.mu——WritableDown
// 在同一临界区内摘连接表/桶/待批面，多表清场原子化）；all=false 只清开放
// 路径的待批块（申请批准路径的待批块授权物是持权不是开关，保留待 owner
// 决策）。返回被清列表供调用方补「拒绝」侧广播
func (h *writableHub) clearPastesLocked(token string, all bool) []*pendingPaste {
	var out []*pendingPaste
	for id, p := range h.pastes {
		if p.Token == token && (all || p.Open) {
			delete(h.pastes, id)
			out = append(out, p)
		}
	}
	return out
}

// clearPendingResizeLocked 摘除某 token 的待应用 resize（调用方已持 h.mu）：
// 停定时器防泄漏，pending 一并删——owner 杀开关（WritableDown）必须切断访客
// 侧一切驻留态，合并窗内的尺寸请求不越过开关时刻生效
func (h *writableHub) clearPendingResizeLocked(token string) {
	if st, ok := h.resizes[token]; ok {
		if st.timer != nil {
			st.timer.Stop()
		}
		delete(h.resizes, token)
	}
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

// handleTermWS GET /s/{token}/termws?visitorId=&nickname= —— 访客输入的
// WS 上行桥（统一双授权模式）。协议面（与终端 WS 同约定：BinaryMessage =
// PTY 输入字节，TextMessage = 控制帧 JSON；P-20261120-8 起 Text 上行方向
// 开控制指令；P-20261121-1 增 state 指令与 direct_state/direct_revoked/
// input_denied 帧）：
//
//	客户端 → 服务端：
//	  BinaryMessage 一帧 = 一批键入字节（按键帧或粘贴块）
//	  {"type":"resize","cols":N,"rows":M}  视口反喂（P-20261120-8）：客户端
//	                                       窗口=终端宽度语义，服务端钳制+
//	                                       conn 节流+token 合并窗后应用
//	                                       到主机 PTY（WritableResizer 落点；
//	                                       申请批准连接仅持权在窗口期受理）
//	  {"type":"state"}                     申请批准连接的状态对账轮询（约 10s
//	                                       一发——hold 惰性时效的对账触发器，
//	                                       服务端回 direct_state 帧；开放
//	                                       直入连接忽略）
//	服务端 → 客户端（TextMessage 控制帧）：
//	  {"type":"hello","mode":"open"}        接入成功（开放直入，键入即开）
//	  {"type":"hello","mode":"hold","status":s,   接入成功（申请批准——
//	        "mine":b,"remainSeconds":n}     s=none|pending|held，键入资格随
//	                                        持权；direct_state 帧同形）
//	  {"type":"direct_state",...}           申请/持权状态对账（per-conn 计算
//	                                        mine；授予/收回/过期/轮询各迁移
//	                                        点推送，见 direct.go）
//	  {"type":"direct_revoked","reason":r}  本访客持权被收回/过期/关通道
//	                                        （连接将关闭，可重新申请）
//	  {"type":"input_throttled"}       帧率/字节桶触限，本帧已丢弃（整帧语义，
//	                                        访客侧提示稍候）
//	  {"type":"input_denied","reason":"no_hold"}  申请批准连接无持权键入帧
//	                                        被拒（客户端应停发——服务端仍兜底）
//	  {"type":"paste_review","id":p}   粘贴命中 danger，待 owner 审批（未注入）
//	  {"type":"paste_approved","id":p} 审批通过，字节已注入（回显经 SSE 到达）
//	  {"type":"paste_denied","id":p}   审批拒绝/超时，字节已丢弃
//	  {"type":"resize_applied","cols","rows"}  视口 resize 已应用（P-20261120-8，
//	                                           诚实回执——SSE resize 帧 ≤1s
//	                                           到达同值对账）
//	  {"type":"resize_denied","reason":r}      视口 resize 被拒（P-20261122-16：
//	                                           r=owner_active 主人本机有交互
//	                                           客户端附着/以主机为准；r=
//	                                           external_session 外部接管会话
//	                                           禁用；r=session_missing 会话不在）
//	  {"type":"ended"}                 会话已关（锚定终端不在，连接将关闭）
//	  {"type":"writable_off"}          主人已关闭开放直入（仅开放连接收到，
//	                                   连接将关闭，回落只读观看；申请批准
//	                                   连接不受影响——两开关独立）
func (s *Service) handleTermWS(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	// 双授权模式准入（必改2）：开放直入（Writable 标）或申请批准（申请通道
	// 开，GuestInputOff 反向极性零值=开）任一在场即接入；两开关全关 = 端点
	// 不存在（存在性不可探测，drop 族同款语义）。接入时点定格模式（字段
	// 翻转不断开既有连接——保守侧语义，访客重连即取新模式）
	open := sh.Writable
	if sh.Kind != store.ShareKindTerminal || sh.TerminalID == "" || (!open && sh.GuestInputOff) {
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
	// 读超时 + pong 续期（P-20261122-17，与主人终端 WS 同口径）：StartPing
	// 发出的 ping 由对端 pong 续期；无 pong（半开/死端）至多 60s 即退出读
	// 循环，defer 释放 ws 闸来源。脚本客户端不自动 pong 会在空闲 60s 后被
	// 断开——诚实边界（协议层活跃检测），重连即恢复
	_ = rawConn.SetReadDeadline(time.Now().Add(shareWSReadTimeout))
	rawConn.SetPongHandler(func(string) error {
		_ = rawConn.SetReadDeadline(time.Now().Add(shareWSReadTimeout))
		return nil
	})

	c := &writableConn{
		token:      sh.Token,
		sessionID:  sh.TerminalID,
		visitorID:  visitorID,
		nick:       sanitizeGuestNickname(r.URL.Query().Get("nickname")),
		ip:         clientIPOf(r),
		conn:       conn,
		bucket:     newTokenBucket(wsUpConnFrameRate, wsUpConnFrameBurst, time.Now()),
		byteBucket: newTokenBucket(wsUpConnByteRate, wsUpConnByteBurst, time.Now()),
		open:       open,
	}
	openFirst, ok := s.writable.addConn(c, time.Now())
	if !ok {
		s.writeControl(c, "denied", map[string]any{"reason": "writer_limit"})
		_ = conn.Close()
		return
	}
	defer func() {
		_, openRemain := s.writable.removeConn(c)
		s.flushConnAudit(c, true)
		if c.open && openRemain == 0 {
			// 末条开放连接断开：账本摘除 ws 来源（另一模式来源在场则闸保持
			// ——gateLedger 注记）+ 输入中广播摘除。按来源释放（P-20261122-17：
			// 记录可能已撤销/轮换，会话锚点不可靠；ws 来源的唯一在场依据
			// 就是开放连接数）。回调均锁外执行
			s.gateReleaseSource("ws:" + sh.Token)
			s.emitWritableTyping(sh, 0, false)
		}
	}()
	if openFirst {
		// 首条开放连接：账本登记 ws 来源（owner 键盘让位——闸值经合并账本
		// 单点落）+ 输入中广播点亮。申请批准连接不登记（键入资格随持权，
		// 闸来源是 "direct:"+token）
		s.gateAcquire(sh.TerminalID, "ws:"+sh.Token)
		s.emitWritableTyping(sh, 1, true)
	}
	// hello 帧带模式与（申请批准路径的）当前状态——访客页免轮询即知接线形态；
	// 状态半边复用 writeDirectState 的 per-conn 计算（pending/held/mine）
	if c.open {
		s.writeControl(c, "hello", map[string]any{"mode": "open"})
	} else {
		now := time.Now()
		s.flushReleasedHolds(sh)
		s.writeControl(c, "hello", map[string]any{"mode": "hold"})
		s.writeDirectState(sh, c, now, "")
	}
	stopPing := conn.StartPing()
	defer stopPing()

	// 读循环：Binary 帧 = 一批键入字节；Text 帧方向反转（P-20261120-8）= 访客
	// 控制指令（resize/state，handleTextControl 内判型）。断连即退出（defer
	// 解除闸/审计收尾）——开放直入无持权恢复面（重连即重新接入并重过门禁）；
	// 申请批准持权凭 visitorId 恢复键入资格（direct.go 头注断连语义分档）
	for {
		typ, msg, err := rawConn.ReadMessage()
		if err != nil {
			return
		}
		if typ == websocket.TextMessage {
			// 控制面分流：Text 上行不与键入帧混走——在键入帧率桶之前判型分流，
			// resize/state 各走自己的承接路径；未知 Text 帧维持「协议误用，
			// 忽略不关」的既有容忍（探活端零破坏）
			s.handleTextControl(sh, c, msg)
			continue
		}
		if typ != websocket.BinaryMessage || len(msg) == 0 {
			continue // 键入只走 Binary；其余类型忽略不关（容忍探活端）
		}
		now := time.Now()
		// 申请批准准入（必改2）：无持权/换人帧拒收（input_denied 回告——
		// 客户端应停发，服务端兜底；与旧 POST 端点 403 direct_denied 同语义
		// 的控制帧形态）。持权帧顺带惰性清扫（超时持权回收对账）
		if !c.open {
			hold := s.direct.holdOf(sh.Token, sh.TerminalID, now)
			s.flushReleasedHolds(sh)
			if hold == nil || c.visitorID == "" || hold.VisitorID != c.visitorID {
				s.writeControl(c, "input_denied", map[string]any{"reason": "no_hold"})
				continue
			}
		}
		// 帧率双桶：连接级 + token 全局（合流护栏）。触限帧整帧丢弃——
		// PTY 输入流没有「部分注入」的安全语义（半条命令比不执行更危险），
		// 回告让访客侧主动降速
		tb := s.writable.tokenBucketOf(c.token)
		if !c.bucket.allow(now) || tb == nil || !tb.allow(now) {
			s.writeControl(c, "input_throttled", nil)
			continue
		}
		// 字节桶（P-20261122-18 ⑤）：帧桶放开了 1MiB 单帧，字节维度必须
		// 并行收口——按本帧字节数取令牌，不足整帧丢弃并回告（与帧桶同语义：
		// 不做部分注入；不做客户端分片，见 wsUpFrameMaxBytes 注记）
		if !c.byteBucket.allowN(now, float64(len(msg))) {
			s.writeControl(c, "input_throttled", nil)
			continue
		}
		text := string(msg)
		// 粘贴形态判定（整块输入，命令串整体可知）→ 复用 commandrisk 预检；
		// 按键级帧不做命令审批（头注审批分层定案）——两授权模式同闸
		if len(msg) >= WritablePasteReviewBytes || bytes.ContainsRune(msg, '\n') {
			if risk := s.writableRiskOf(text); risk != nil && risk.Danger {
				s.holdPasteForReview(sh, c, text, risk, now)
				continue
			}
		}
		if !s.injectWritable(sh, c, text, now) {
			return
		}
		if !c.open {
			// 持权帧注入成功即续期（滑动 10min——directHub.touch，必改2：
			// WS 键入帧路径触达续期，替代旧 POST 端点路径）
			s.direct.touch(sh.Token, now)
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

// handleTextControl Text 上行控制帧分流（P-20261120-8 视口反喂 + P-20261121-1
// 状态轮询）：判型 → 各走承接路径（resize：服务端钳制 → conn 级独立节流 →
// token 合并窗；state：hold 模式连接的 direct_state 对账回帧）。任何一步
// 不合法都静默忽略（与既有 Text 面同取向：协议误用不关连接）——resize 是
// 幂等指令，丢帧由访客下一次视口变化重发自愈；state 轮询丢一轮下轮再来
func (s *Service) handleTextControl(sh *store.Share, c *writableConn, msg []byte) {
	var fr struct {
		Type string `json:"type"`
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	if err := json.Unmarshal(msg, &fr); err != nil {
		return
	}
	switch fr.Type {
	case "resize":
		// 画布让渡随键入资格走：申请批准连接仅在持权在窗口期受理 resize
		//（无持权静默忽略——访客页在无持权态不驱动反喂，此处是服务端兜底）；
		// 开放直入连接无资格门
		if !c.open {
			now := time.Now()
			hold := s.direct.holdOf(sh.Token, sh.TerminalID, now)
			if hold == nil || c.visitorID == "" || hold.VisitorID != c.visitorID {
				return
			}
		}
		// 服务端钳制（访客上报值不可信）：钳到访客路径合法域（cols ≥80 /
		// rows ≥2，上限 500/300 与访客页栅格钳制逐字对齐——两端同域防钳制差
		// 振荡；cols 下限 80 见 writableResizeMinCols 注记，主人 PUT 的 20
		// 下限不走本路径）
		cols := uint16(max(writableResizeMinCols, min(writableResizeMaxCols, int(fr.Cols))))
		rows := uint16(max(writableResizeMinRows, min(writableResizeMaxRows, int(fr.Rows))))
		// conn 级独立节流（≥1s）：与键入帧率桶分离——控制面低频指令不该也不需要
		// 消耗键入配额；节流锚在 conn 上的取态=同连接窗口拖拽的后续帧丢弃，窗口
		// 稳定后的最后一帧已在合并窗里（pending 覆盖），无需重发
		now := time.Now()
		c.resizeMu.Lock()
		if now.Sub(c.lastResize) < wsResizeConnMinInterval {
			c.resizeMu.Unlock()
			return
		}
		c.lastResize = now
		c.resizeMu.Unlock()
		s.scheduleWritableResize(sh, c, cols, rows)
	case "state":
		// 申请批准连接的状态对账轮询（writablepage.go ~10s 一发——hold 惰性
		// 时效的对账触发器：无 ticker 设计下，等待页的轮询让超时持权在
		// flushReleasedHolds 收口并对账帧回推）。开放直入连接无状态面，忽略
		if c.open {
			return
		}
		s.flushReleasedHolds(sh)
		s.writeDirectState(sh, c, time.Now(), "")
	}
}

// scheduleWritableResize 进 token 合并窗（评审必改4 last-write-wins 定案）：
// 窗内任意访客/任意帧只覆盖 pending（最后写者胜），到期一次性应用最终值——
// 多访客并发 resize 的突刺收敛为单次 PTY 改格（防多访客互相踩踏出的连续
// banner 重绘）。定时器触发在 hub 锁外跑（锁内不执行外部代码纪律）
func (s *Service) scheduleWritableResize(sh *store.Share, c *writableConn, cols, rows uint16) {
	s.writable.mu.Lock()
	st := s.writable.resizes[c.token]
	if st == nil {
		st = &pendingResize{}
		s.writable.resizes[c.token] = st
	}
	st.cols, st.rows, st.visitorID, st.ip = cols, rows, c.visitorID, c.ip
	st.open = c.open
	if st.timer != nil {
		// 窗口已在跑：只覆盖 pending，定时器不动（trailing debounce 语义）
		s.writable.mu.Unlock()
		return
	}
	st.timer = time.AfterFunc(wsResizeMergeWindow, func() { s.fireWritableResize(c.token) })
	s.writable.mu.Unlock()
}

// fireWritableResize 合并窗到期：应用 pending 的最终尺寸（last-write-wins 的
// 收口）。落点未装配（测试/降级）或记录已撤销/过期时静默丢弃——resize 是幂
// 等指令，访客侧下一次视口变化自然重发；**应用前复核准入**（P-20261122-16 ④）
// 拒绝即下发 resize_denied 原因、零应用；应用成功即广播 resize_applied 回执
// + 审计入账（元数据口径：尺寸/visitor 摘要/IP——新增指令类型不入敏感值账）
// + sc-ops:share.wresize（owner 侧最小可见性，评审必改5）
func (s *Service) fireWritableResize(token string) {
	s.writable.mu.Lock()
	st := s.writable.resizes[token]
	if st == nil {
		s.writable.mu.Unlock()
		return
	}
	delete(s.writable.resizes, token)
	s.writable.mu.Unlock()

	if s.writableResizer == nil {
		return
	}
	sh, err := s.shares.Get(token)
	if err != nil || sh.Kind != store.ShareKindTerminal || sh.TerminalID == "" {
		return
	}
	// 应用前复核授权物（P-20261122-17）：合并窗最长 500ms，期间持权可能被
	// 收回/过期/换人、开放直入可能被关闭或最后一条连接已断——旧 resize 不
	// 得越过授权物存续时刻生效。hold 路径不要求连接在场（visitorId 恢复
	// 语义），但要求持权仍绑定提交者
	now := time.Now()
	if st.open {
		if !sh.Writable || s.writable.openCountOf(token) == 0 {
			return
		}
	} else {
		hold := s.direct.holdOf(token, sh.TerminalID, now)
		s.flushReleasedHolds(sh) // holdOf 可能触发惰性回收，快照就地收口
		if hold == nil || st.visitorID == "" || hold.VisitorID != st.visitorID {
			return
		}
	}
	// 应用前复核准入（P-20261122-16 ④ 二审必改②）：只在收帧时查不够——500ms
	// 合并窗内 owner 可能刚附着（打开系统内终端）或会话刚被外部接管，窗到期
	// 照旧改格就会在「主人正看着」的时刻把 PTY 改掉。拒绝原因如实下发，访客页
	// 据此回落主机栅格（owner_active 30s 退避重试，external_session 停用）
	if reason := s.writableResizer.WritableResizeDenyReason(sh.TerminalID); reason != "" {
		s.broadcastControl(token, "resize_denied", map[string]any{"reason": reason})
		return
	}
	if err := s.writableResizer.WritableResize(sh.TerminalID, st.cols, st.rows); err != nil {
		return // 会话已关：读循环即将收 ended 帧，不伪装成功
	}
	s.broadcastControl(token, "resize_applied", map[string]any{"cols": st.cols, "rows": st.rows})
	name := token
	if sh.Name != "" {
		name = sh.Name
	}
	s.views.Add(store.AuditEvent{
		Action: store.AuditShareWritableResize,
		Result: store.AuditResultSuccess,
		Time:   time.Now(),
		IP:     st.ip,
		Detail: fmt.Sprintf("%s (%s), visitor %s resized terminal to %dx%d -> session %s",
			name, token, visitorBrief(st.visitorID), st.cols, st.rows, sh.TerminalID),
	})
	if s.writableResizeEvents != nil {
		s.writableResizeEvents(WritableResizeEvent{
			Token:       sh.Token,
			ShareName:   sh.Name,
			TerminalID:  sh.TerminalID,
			Cols:        st.cols,
			Rows:        st.rows,
			VisitorTail: visitorBrief(st.visitorID),
			At:          time.Now().UnixMilli(),
		})
	}
}

// appendConnAudit 把连接的审计聚合余量写成一条批次事件（窗口到期由
// injectWritable 触发带余量、断开兜底由 flushConnAudit 全量触发；字节/帧数
// 在调用前已由调用方清账，这里只负责事件成型）。统一单键入批次事件
// （P-20261121-1 必改8：share.direct.input 批次随 POST 端点退役并入本键，
// Detail 加 mode=open|hold 分档授权模式——审计对账面区分「谁的键入走了
// 哪条授权路径」，键入规则统一采用 WS 桥现行规则）
func (s *Service) appendConnAudit(c *writableConn, bytesAcc, frames int) {
	if bytesAcc <= 0 {
		return
	}
	name := c.token
	if sh, err := s.shares.Get(c.token); err == nil && sh.Name != "" {
		name = sh.Name
	}
	mode := "open"
	if !c.open {
		mode = "hold"
	}
	s.views.Add(store.AuditEvent{
		Action: store.AuditShareWritableInput,
		Result: store.AuditResultSuccess,
		Time:   time.Now(),
		IP:     c.ip,
		Detail: fmt.Sprintf("%s (%s), visitor %s input %d bytes in %d frames mode=%s -> session %s",
			name, c.token, visitorBrief(c.visitorID), bytesAcc, frames, mode, c.sessionID),
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
		Open:      c.open,
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

// WritableDown 关闭某 token 的开放直入上行（owner 开关关闭/撤销轮换级联
// 共用）。all=false（owner 开关方向）：只断**开放**连接（回收的是开放直入
// 的授权物——申请批准路径持权访客的键入通道独立，不受开关翻转影响，两
// 开关独立定案）、只清开放路径的待批粘贴面；all=true（级联清场：分享
// 撤销/过期/轮换后记录死亡）：全部连接断开（访客面已 404，上行桥不能
// 残留）。各连接 defer 经账本解除闸+冲审计；待批面广播拒绝；合并窗
// pending 在全清时摘除（有 hold 连接残留时保留——持权访客的 resize 请求
// 仍合法）。幂等（无动作返回 false）。
// P-20261122-17 纪律：本方法**不显式释放 ws 闸来源**——Close() 只是发起
// 关闭，读循环退出后的连接 defer 才持有「末条开放连接」原子事实；在关闭
// 前抢放会让访客键入窗口内的 owner 键盘提前回位。无连接可断的 early-return
// 交给 ReconcileGates 兜底（ws 来源只在开放连接数为 0 时释放）
func (s *Service) WritableDown(token string, all bool) bool {
	s.writable.mu.Lock()
	set := s.writable.conns[token]
	var doomed []*writableConn
	holdRemain := false
	for c := range set {
		if all || c.open {
			doomed = append(doomed, c)
		} else {
			holdRemain = true
		}
	}
	pastes := s.writable.clearPastesLocked(token, all)
	if !holdRemain {
		// 无 hold 连接残留：合并窗 pending 一并摘（持权访客的 resize 请求
		// 仍合法时保留——pending 不越过授权物存续时刻生效）
		s.writable.clearPendingResizeLocked(token)
	}
	if len(doomed) == len(set) {
		// 全清：连接表/桶一并摘（级联或无 hold 残留的开关关闭——该 token
		// 无残留连接）
		delete(s.writable.conns, token)
		delete(s.writable.buckets, token)
	}
	s.writable.mu.Unlock()
	if len(doomed) == 0 && len(pastes) == 0 {
		return false
	}
	for _, c := range doomed {
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
// 桥不能残留；all=true 全清含申请批准连接，持权由 CascadeRelease 同 keep
// 集一并回收）。返回清场条数
func (s *Service) CascadeWritableDown(keep map[string]bool) int {
	if keep == nil || s == nil {
		return 0
	}
	n := 0
	for _, token := range s.writable.tokensOf() {
		if !keep[token] && s.WritableDown(token, true) {
			n++
		}
	}
	return n
}

// WritableState 管理面的开放直入在场投影（shareResponse wtyping 字段数据
// 源；15s 轮询是 sc-ops 广播的断线兜底）。visitors>0 即「访客输入中」——
// 只数开放直入连接（徽标语义=可键入；申请批准路径的持权在 direct 投影有
// 同族徽标，两投影不重叠）
func (s *Service) WritableState(token string) (visitors int) {
	return s.writable.openCountOf(token)
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

// emitWritableTyping 广播「访客输入中」状态（开放直入连接建立/末条断开
// 两界；装配层接 opschannel——server/share 不反向依赖 api 层，dropEvents
// 同款回调注入。申请批准路径的持权在 direct 投影有同族徽标，不走本事件
// ——徽标语义=可键入，hold 连接在场但无持权不点亮）
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
		if !c.open {
			continue // 指认位只取开放连接（hold 连接的指认在 direct 投影）
		}
		ev.Nick = c.nick
		ev.VisitorTail = visitorBrief(c.visitorID)
		break // 单写者语义展示首位（多写者并存的指认位在审计台账）
	}
	s.writableEvents(ev)
}

// handleWritableState GET /s/{token}/writable/state —— 访客输入状态轮询端
// 点（访客页在未接入上行桥期间 5s 轮询：主人开启任一授权模式时访客页即时
// 接入，WS 在场即停轮）。gateGuard 后零额外门——开关关也如实回 false（此
// 端点不承载存在性敏感面：页面本身已经过口令门才可见，轮询节奏与留言板
// 对账同族且更疏）。响应增 guestInput 布尔（P-20261121-1 统一收编增量字段
// ——申请通道在场与否；旧客户端只读 writable 零影响）
func (s *Service) handleWritableState(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	on := sh.Writable && sh.Kind == store.ShareKindTerminal && sh.TerminalID != ""
	chanOpen := !sh.GuestInputOff && sh.Kind == store.ShareKindTerminal && sh.TerminalID != ""
	writeJSON(w, map[string]any{"writable": on, "guestInput": chanOpen})
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
