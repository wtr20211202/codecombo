// Package share 文件/目录分享子服务：独立端口的只读预览/下载服务。
//
// 职责边界：本包只面向「拿短链来的匿名访客」——按 token 解析分享记录、
// 在项目根内做路径安全解析、按 preview 注册表决定呈现方式；分享记录的
// 管理面（创建/列表/撤销）在 server/api/share。文件内容实时读自项目
// 目录（不落库、不复制），分享页为内嵌单文件 HTML（无外部依赖）。
//
// 路径安全：os.Root 双层锚定——项目根打开后经 OpenRoot 收紧到分享根
// （分享根内符号链接物理上只能落在分享根内），叠加逐段 Lstat 拒绝符号
// 链接（列表/zip/定位同策略）；raw/render 响应加 CSP sandbox + nosniff，
// 防止把用户文件当活动文档在本源执行。
package share

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"html"
	"io"
	"io/fs"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"codecombo/server/share/preview"
	"codecombo/server/store"
)

// ShareLookup 分享记录查询/清理（store.ShareStore 的子集，测试可替换）。
// Delete 供访客面惰性清理过期记录使用（清理 ticker 有周期间隙，访客首踩
// 即清，记录不留 corpse）
type ShareLookup interface {
	Get(token string) (*store.Share, error)
	Delete(token string) error
}

// ProjectRoots 项目根目录解析（store.ProjectStore 的适配由装配层注入）
type ProjectRoots interface {
	// RootOf 返回项目根的绝对路径；项目不存在/不可用返回错误
	RootOf(projectID string) (string, error)
}

// TerminalLive 终端只读直播源（liveterm.Hub 的结构性最小面，本包不反向
// 依赖装配层——ShareLookup/ProjectRoots 同款接口注入先例）。
// 订阅返回的字节经服务端流式遮蔽（mask.Masker，P-108 模式族独立成包），本包不做
// 二次处理；遮蔽与否是 live 源参数（P-20261106-9）——由访客命中的分享记录
// Unfiltered 决定，源头 feeder 侧生效，访客面不存在任何渲染过滤（脚本绕过即得
// 原文的那种「过滤」不成立）
type TerminalLive interface {
	// Subscribe 为访客开一路只读订阅（尾流快照 + 实时通道 + 终结信号）；
	// 单 token 并发访客超限返回错误（SSE 端点映射 429）。unfiltered 取分享
	// 记录（记录是遮蔽配置单一事实源，馈线模式不符由源侧整条替换）
	Subscribe(token, sessionID string, unfiltered bool) (LiveSubscription, error)
	// Unwire 撤销 token 的馈线（访客面自身不调用；管理面撤销/轮换经装配层触发）
	Unwire(token string)
}

// LiveSubscription TerminalLive.Subscribe 的返回面（liveterm.Subscription
// 的结构性镜像；接口解耦让 server/share 不 import liveterm/terminal）
type LiveSubscription interface {
	Tail() []byte
	Live() <-chan []byte
	Done() <-chan struct{}
	Ended() bool
	Size() (cols, rows uint16)
	Release()
}

// SnapshotDirs 冻结快照目录解析（装配层注入的结构性最小面，P-20261003-320）。
// frozen 记录的访客面锚点是创建时复制的快照副本而非项目目录——本包不感知
// 派生细节（token 命名空间/数据目录），由装配层从记录字段重算目录名
type SnapshotDirs interface {
	// DirOf 返回该冻结记录的快照根目录绝对路径；副本不在盘/记录不可解析
	// 返回错误（访客面映射 target_gone——副本丢失是服务端数据事故，不给
	// 访客「路径敲错」的误导）
	DirOf(sh *store.Share) (string, error)
}

// maxRenderBytes markdown 服务端渲染的字节上限（超出给 413 仅下载提示）。
// 20MB 对齐前端文本预览上限：真实使用里大 README/导出文档在此量级常见，
// 2MB 时代"能下载不能看"的抱怨集中于此；渲染耗时随体积线性，20MB 在
// 秒级完成，内存峰值可控
const maxRenderBytes = 20 << 20

// maxDocxBytes docx 包文件的读取上限（zip 解压侧另有 64MB 独立上限）
const maxDocxBytes = 128 << 20

// Service 分享子服务（无状态；依赖经构造注入，便于测试）
type Service struct {
	shares ShareLookup
	roots  ProjectRoots
	logger *slog.Logger
	// hits 访问计数聚合器（P-20261002-14）：命中只攒内存，落盘由装配层
	// 经 FlushHits 定时批量执行（见 hits.go——访客响应路径零磁盘 I/O）
	hits *HitCounter
	// views 访问审计聚合器（P-20261003-257）：留痕与计数同一两段式纪律，
	// 攒批由装配层经 FlushViewAudits 定时批量入账（见 viewaudit.go）
	views *ViewAuditBuffer
	// live 终端只读直播源（nil = 终端直播未装配，stream 端点降级为立即终结；
	// 文件/片段分享路径不触达）
	live TerminalLive
	// snaps 冻结快照目录解析（nil = 冻结模式未装配，frozen 记录降级
	// target_gone；live/片段/终端路径不触达）
	snaps SnapshotDirs
	// gate 访问口令门（P-20261006-25）：会话签发/校验 + 错口令限流（见
	// passgate.go）。签名密钥惰性派生自 master-key，构造期零 I/O
	gate *gateSessions
	// view 一次性分享显式确认（P-20261020-3）：查看 cookie 签发/校验 +
	// 确认 POST 限流（见 viewonce.go）。与 gate 独立——口令门会话不能当作
	// 一次性确认（不同 cookie 名/不同签名域）
	view *viewSessions
	// msgs 访客留言附表（P-20261006-13，nil = 未装配：GET 空态、POST 503
	// 降级——测试/降级部署零 panic）
	msgs MessageBoard
	// msgLimit 留言频控（(token,IP) + token 全局双维度固定窗口，见
	// guestboard.go）
	msgLimit *msgRateLimiter
	// notes 新留言通知缓冲（访客响应路径只攒内存，装配层随 share-flush
	// tick 批量入账通知中心 + Stop 兜底，见 guestboard.go）
	notes *GuestNoteBuffer
	// retired 退役短链命中聚合器（P-20261008-2）：外泄观测与计数/审计同一
	// 两段式纪律，攒批由装配层经 FlushRetiredHits 定时落盘（见 retired.go）
	retired *RetiredHitTracker
	// dropLimit 访客素材上行频控（P-20261024-1，ratePair 参数化复用：
	// (token,IP) + token 全局双维固定窗口，见 drops.go）
	dropLimit *ratePair
	// dropEvents 素材到达的装配层回调（nil = 不广播）：ops 通道
	// share.drop 事件的发布口在装配层接线（本包不反向依赖 api 层，
	// liveWire 同款回调注入先例）
	dropEvents func(DropEvent)
	// direct 直通输入档持权状态机（P-20261024-1 第二档，进程内短时效状态，
	// 见 direct.go）
	direct *directHub
	// directLimit 直通握手/输入频控（参数与上传频控独立）
	directLimit *ratePair
	// directSink 直通输入落点（装配层适配 terminal 会话；nil = 输入端点
	// 503 降级——测试/降级部署零 panic）
	directSink DirectSink
	// directOnRelease 持权回收回调（惰性超时/级联缘由；nil 安全）——装配层
	// 据此解除会话侧只读闸与补审计，本包不感知 terminal
	directOnRelease func(token, sessionID, reason string)
	// writable 可写分享上行状态机（P-20261106-8，进程内短时效状态，
	// 见 writable.go 头注——连接表/待批粘贴面/帧率桶，重启即清）
	writable *writableHub
	// writableSink 可写输入落点（装配层适配 terminal 会话；nil = WS 端点
	// 503 降级——测试/降级部署零 panic）
	writableSink WritableSink
	// writableRisk 粘贴级风险预检（装配层桥 terminal.MatchCommandRisk——
	// 本包不 import terminal，判定在装配层收口；nil = 不挂审批直接注入，
	// 仅测试/降级部署会出现）
	writableRisk func(text string) WritableRisk
	// writableEvents 「访客输入中」广播回调（连接建立/末条断开两界；装配层
	// 接 opschannel——本包不反向依赖 api 层，dropEvents 同款回调注入先例）
	writableEvents func(WritableTypingEvent)
	// pasteReviewEvents 粘贴审批卡广播回调（命中 danger 挂待批面时一次；
	// 装配层接 opschannel 同上）
	pasteReviewEvents func(PasteReviewEvent)
}

// shareCtxKey 守卫层已解析记录的上下文键（gateGuard 查过一次，handler 内
// lookup 复用——访客面单请求保持单次记录读取，filestore.Get 是磁盘读）。
// err 同样随上下文走：守卫的 lookup 对过期记录有惰性删除副作用，若只传
// 成功不传错误，handler 的二次 lookup 会在删除后拿到 404，丢掉既有的
// 410「已过期」语义（TestShareExpiredJSONCode 锚定）
type shareCtxKey struct{}

type resolvedCtx struct {
	share *store.Share
	err   *httpError
}

func withResolvedShare(ctx context.Context, sh *store.Share) context.Context {
	return context.WithValue(ctx, shareCtxKey{}, &resolvedCtx{share: sh})
}

func withLookupError(ctx context.Context, herr *httpError) context.Context {
	return context.WithValue(ctx, shareCtxKey{}, &resolvedCtx{err: herr})
}

// NewService 构造分享子服务
func NewService(shares ShareLookup, roots ProjectRoots, logger *slog.Logger) *Service {
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{shares: shares, roots: roots, logger: logger, hits: NewHitCounter(),
		views: &ViewAuditBuffer{}, gate: newGateSessions(), view: newViewSessions(),
		msgLimit: newMsgRateLimiter(), notes: &GuestNoteBuffer{}, retired: &RetiredHitTracker{},
		dropLimit: newRatePair(dropMaxPerIP, dropMaxPerToken, dropWindow),
		direct:    newDirectHub(), directLimit: newRatePair(directMaxPerIP, directMaxPerToken, directWindow),
		writable: newWritableHub()}
}

// WithTerminalLive 注入终端直播源（链式；装配层在模块 Start 时调用）
func (s *Service) WithTerminalLive(live TerminalLive) *Service {
	s.live = live
	return s
}

// WithMessageBoard 注入访客留言附表（链式；装配层在模块 Start 时调用。
// nil = 留言端点降级：GET 空态、POST 503——「随装配可用」的旁路面）
func (s *Service) WithMessageBoard(m MessageBoard) *Service {
	s.msgs = m
	return s
}

// WithSnapshotDirs 注入冻结快照目录解析（链式；装配层在模块 Start 时调用）
func (s *Service) WithSnapshotDirs(snaps SnapshotDirs) *Service {
	s.snaps = snaps
	return s
}

// WithDropEvents 注入素材到达回调（链式；装配层在模块 Start 时接线——
// 回调体内只做 ops 通道的非阻塞投递，绝不背落盘）
func (s *Service) WithDropEvents(fn func(DropEvent)) *Service {
	s.dropEvents = fn
	return s
}

// WithDirectSink 注入直通输入落点（链式；装配层适配 terminal 会话）
func (s *Service) WithDirectSink(sink DirectSink) *Service {
	s.directSink = sink
	return s
}

// WithDirectRelease 注入持权回收回调（链式；惰性超时与级联缘由经此联动
// 会话侧只读闸与审计——owner 缘由的审计在带请求上下文的 handler 落）
func (s *Service) WithDirectRelease(fn func(token, sessionID, reason string)) *Service {
	s.directOnRelease = fn
	return s
}

// WithWritableSink 注入可写输入落点（链式；装配层适配 terminal 会话——
// P-20261106-8 可写分享档，writable.go 头注五重补偿控制的服务端半边）
func (s *Service) WithWritableSink(sink WritableSink) *Service {
	s.writableSink = sink
	return s
}

// WithWritableRiskCheck 注入粘贴级风险预检（链式；装配层桥
// terminal.MatchCommandRisk——命中 danger 档挂 owner 审批，未批不注入）
func (s *Service) WithWritableRiskCheck(fn func(text string) WritableRisk) *Service {
	s.writableRisk = fn
	return s
}

// WithWritableEvents 注入「访客输入中」广播回调（链式；装配层接 opschannel）
func (s *Service) WithWritableEvents(fn func(WritableTypingEvent)) *Service {
	s.writableEvents = fn
	return s
}

// WithPasteReviewEvents 注入粘贴审批卡广播回调（链式；装配层接 opschannel）
func (s *Service) WithPasteReviewEvents(fn func(PasteReviewEvent)) *Service {
	s.pasteReviewEvents = fn
	return s
}

// FlushHits 把攒下的访问计数批量落盘（apply = store.Share.RecordHits）。
// 装配层（shareapi Module）经内核调度器定时调用 + Stop 兜底各一次
func (s *Service) FlushHits(apply func(token string, n int64, at time.Time) error) int {
	return s.hits.Flush(apply, s.logger)
}

// Handler 组装路由（Go 1.22 方法+通配符模式）。
// /dl/{name...} 为自描述下载链接：URL 以原文件名结尾，下载工具可直接
// 取名；{name...} 整段即分享根内相对路径。
// 只注册 GET + 有限几条 POST：/s/{token}/gate（口令验证，P-20261006-25）、
// /s/{token}/messages（访客留言，P-20261006-13）、/s/{token}/view（一次性
// 显式确认，P-20261020-3）、/s/{token}/drop 与 /s/{token}/direct/*（协作
// 通道，P-20261024-1——开关缺省关，关闭时恒 404 与「端点不存在」不可区分，
// 存在性不可探测）。除留言/素材/直通输入外这是访客面唯一的写入端点
// （限长/频控/转义/级联防线见 guestboard.go 与 drops.go；终端直播的
// 「严格只读」仍由「无内容写入」+ 路由面 405 第一层保证：POST/PUT 到
// /s/* 其他路径都是 405）；全部内容子资源与协作端点经 gateGuard 统一
// 把口令门。
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /s/{token}", s.handlePage)
	// 口令验证（访客面输入端点之一）：成功发门会话 cookie，303 回内容页
	mux.HandleFunc("POST /s/{token}/gate", s.handleGatePost)
	// 一次性分享显式确认（P-20261020-3）：确认页提交后武装 + 计数 + 发
	// 查看 cookie，303 回内容页。GET 预览抓取不再触达武装
	mux.HandleFunc("POST /s/{token}/view", s.handleViewPost)
	// 内容子资源统一过守卫（P-20261006-25）：口令记录未持有效门会话一律
	// 401——防绕过口令页直取子资源；无口令记录零变化直通
	mux.Handle("GET /s/{token}/meta", s.gateGuard(http.HandlerFunc(s.handleMeta)))
	mux.Handle("GET /s/{token}/list", s.gateGuard(http.HandlerFunc(s.handleList)))
	mux.Handle("GET /s/{token}/render", s.gateGuard(http.HandlerFunc(s.handleRender)))
	mux.Handle("GET /s/{token}/raw", s.gateGuard(http.HandlerFunc(s.handleRaw)))
	mux.Handle("GET /s/{token}/html", s.gateGuard(http.HandlerFunc(s.handleHTMLDoc)))
	mux.Handle("GET /s/{token}/f/{name...}", s.gateGuard(http.HandlerFunc(s.handleRawPath)))
	mux.Handle("GET /s/{token}/download", s.gateGuard(http.HandlerFunc(s.handleDownloadQuery)))
	mux.Handle("GET /s/{token}/dl/{name...}", s.gateGuard(http.HandlerFunc(s.handleDownloadPath)))
	// 终端只读直播（P-20261003-306）：SSE 只读推流 + 访客 xterm 页（同门）
	mux.Handle("GET /s/{token}/stream", s.gateGuard(http.HandlerFunc(s.handleStream)))
	// 会话回放（P-20261004-103）：cast 快照文本（asciinema v2，回放页解析）
	mux.Handle("GET /s/{token}/cast", s.gateGuard(http.HandlerFunc(s.handleCastFile)))
	// 会话回放只读分享（P-20261003-77）：条目快照 JSON（净本，访客页解析渲染）
	mux.Handle("GET /s/{token}/session", s.gateGuard(http.HandlerFunc(s.handleSessionFile)))
	// 访客留言板（P-20261006-13）：读列表 + 写留言（同门；写侧四道防线
	// 见 guestboard.go 头注释）
	mux.Handle("GET /s/{token}/messages", s.gateGuard(http.HandlerFunc(s.handleGuestMessagesGet)))
	mux.Handle("POST /s/{token}/messages", s.gateGuard(http.HandlerFunc(s.handleGuestMessagePost)))
	// 协作通道（P-20261024-1）：素材上行 + 收件清单（开关门禁在 handler——
	// 关闭恒 404；口令门继承 gateGuard，访客先过 passgate 再见上传位）
	mux.Handle("POST /s/{token}/drop", s.gateGuard(http.HandlerFunc(s.handleGuestDropPost)))
	mux.Handle("GET /s/{token}/drops", s.gateGuard(http.HandlerFunc(s.handleGuestDropsGet)))
	// 直通输入档（P-20261024-1 第二档）：申请/状态/输入三端点（握手见
	// direct.go 头注释——单持有者 + 短时效 + 审计 + agent 会话限定四闸）
	mux.Handle("POST /s/{token}/direct/request", s.gateGuard(http.HandlerFunc(s.handleDirectRequest)))
	mux.Handle("GET /s/{token}/direct/state", s.gateGuard(http.HandlerFunc(s.handleDirectState)))
	mux.Handle("POST /s/{token}/direct/input", s.gateGuard(http.HandlerFunc(s.handleDirectInput)))
	// 可写分享上行桥（P-20261106-8）：WS 键入注入 + 状态轮询（开关门禁在
	// handler——关闭恒 404 与「端点不存在」不可区分；升级握手同过 gateGuard
	// 口令门 + Origin 同源校验，防线全录 writable.go 头注）
	mux.Handle("GET /s/{token}/termws", s.gateGuard(http.HandlerFunc(s.handleTermWS)))
	mux.Handle("GET /s/{token}/writable/state", s.gateGuard(http.HandlerFunc(s.handleWritableState)))
	mux.HandleFunc("GET /assets/{name}", s.handleAsset)
	// 全捕获：分享口上任何未匹配路径（/s/、/s/、乱敲的路径）一律渲染
	// 品牌 404 页，绝不露出默认裸文本
	mux.HandleFunc("/", s.handleNotFoundAny)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		// 预览抓取防线（P-20261020-3）：访客面全部响应 noindex（短链常被
		// IM/邮件网关抓取生成预览，不应进入搜索索引；页面另带 meta robots
		// noindex 双保险）。确认页与内容页均不向预览抓取暴露文件名
		w.Header().Set("X-Robots-Tag", "noindex")
		// 访客页文档不可被任何页面嵌套（CSP frame-ancestors 'none' 的兼容旧
		// 浏览器重复面）。同源代理（P-20261020-2）会继承主应用 X-Frame-Options:
		// SAMEORIGIN 基线，文档面显式 Set 覆盖。
		// 例外：分享页自身会用 sandbox iframe 引用同源 /html 与 /raw（PDF）做
		// 内嵌预览——这两个端点各自覆写为 SAMEORIGIN（见 serveRaw/handleHTMLDoc），
		// 否则 DENY 会把页内预览一并拦死（沙箱属性挡的是脚本，不是嵌入本身）
		w.Header().Set("X-Frame-Options", "DENY")
		// 私有内容缓存防线（P-20261002-121）：访客面全部响应 no-store（+
		// Pragma 兜底旧代理）——短链常在共享/公共设备上打开，页面/元信息/
		// 渲染/原文/下载一律不在本地缓存留痕。与主应用 mw.NoStore 同族但
		// 自带（本服务是独立 http.Server，不经主引擎中间件链）；本服务只出
		// 私有分享内容（无静态/公共资源），入口统一施加即全覆盖。
		// 例外：/assets/* 的 vendored xterm 三件是公共静态库（无任何私有
		// 内容），handleAsset 内覆写为不可变长缓存
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		// 页面级 CSP：锁死资源来源（脚本/样式仅内联——页面是零外部依赖
		// 的单文件），禁对象/表单/外框嵌套；raw/render 端点会按需覆写为
		// sandbox 头（Set 语义为替换，不冲突）。img-src/media-src 的 blob:
		// 供导出预览弹层展示内存编码出的图片（canvas.toBlob 对象 URL）。
		// script-src/style-src 的 'self' 供终端直播页加载 /assets/ 下
		// vendored xterm（同为同源静态件，文件分享页不用到但统一放行——
		// 放宽面限于本服务自身 origin，无第三方来源）
		w.Header().Set("Content-Security-Policy",
			"default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "+
				"img-src 'self' data: blob: http: https:; media-src 'self' blob: http: https:; "+
				"frame-src 'self'; connect-src 'self'; font-src 'self'; "+
				"object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
		mux.ServeHTTP(w, r)
	})
}

// ── 请求解析 ──

// resolved 一次文件定位的结果
type resolved struct {
	share *store.Share
	// root 分享根锚定的 os.Root——安全边界是分享根（而非项目根）：
	// 分享目录内的符号链接即便存在也只能落在分享根内，绝不可能
	// 摸到分享外的任何文件
	root *os.Root
	// projRoot 项目根锚定（root 的派生来源；仅用于生命周期管理）
	projRoot *os.Root
	// rel 分享根内的 fs 路径（os.Root 操作基准；"." 表示分享根本身）
	rel string
	// vrel 分享根内的访客路径（"" = 分享根本身；meta/list 对外 path 语义）
	vrel string
	info fs.FileInfo
}

func (s *Service) closeRes(res resolved) {
	if res.root != nil && res.root != res.projRoot {
		_ = res.root.Close()
	}
	if res.projRoot != nil {
		_ = res.projRoot.Close()
	}
}

// httpError 携带 HTTP 语义的错误
type httpError struct {
	status int
	code   string
}

func (e *httpError) Error() string { return e.code }

var (
	errShareNotFound = &httpError{http.StatusNotFound, "share_not_found"}
	// errShareExpired 已过保留窗口（snippet 固定 24h / 文件分享 opt-in TTL）。
	// 410 Gone 而非与 404 混同（P-20261003-29）：明确文案让收件人知道是
	// 「有效期到了、找分享者要新链」而不是疑心链接敲错。存在性信号无从
	// 探测——token 空间 80-bit HMAC 派生，枚举不可行
	errShareExpired = &httpError{http.StatusGone, "share_expired"}
	// errShareConsumed 一次性分享已被查看且宽限窗走完（P-20261006-27）。
	// 同为 410 但 code/文案与 TTL 过期刻意区分：「已被查看并失效」是访客
	// 行为触发的焚毁，与「有效期到了」语境不同（转发链上的第二位访客该
	// 知道自己来晚了，而不是怀疑链接敲错或服务故障）。不惰性删除——失效
	// 态要留在管理器里供分享者对账（见 lookup 消费分支）
	errShareConsumed = &httpError{http.StatusGone, "share_consumed"}
	errTargetGone    = &httpError{http.StatusGone, "target_gone"}
	errTargetMissing = &httpError{http.StatusNotFound, "target_missing"}
	errNotDir        = &httpError{http.StatusBadRequest, "not_a_directory"}
	errNotFile       = &httpError{http.StatusBadRequest, "not_a_file"}
	errUnrenderable  = &httpError{http.StatusBadRequest, "not_renderable"}
	errTooLarge      = &httpError{http.StatusRequestEntityTooLarge, "too_large"}
)

// errPathEscape 访客/管理路径试图越过分享根
var errPathEscape = errors.New("share: path escapes share root")

// entryKindSnippet 访客面条目形态标注：文本片段（分享页据此选渲染分支——
// 服务端渲染代码块形态，与 markdown 同走页内注入管线）
const entryKindSnippet = "snippet"

// lookup 按 token 取分享记录（页面/meta 等免文件定位端点共用）：
// 形态不对或不存在 → 友好 404；已过保留窗口（snippet 固定 24h / 文件分享
// opt-in TTL，P-20261003-29 起两类同管线）→ 410 Gone 明确文案 + 惰性删除
// ——清理 ticker 有周期间隙，访客首踩即清（失败不影响本次 410，下轮
// ticker 兜底），不给已过期记录留可再命中的 corpse。
// gateGuard 已在同一请求里解析过的记录经上下文复用（守卫先行是口令门的
// 把守位置，handler 不该为拿同一份记录再付一次磁盘读）
func (s *Service) lookup(r *http.Request, token string) (*store.Share, *httpError) {
	if !validToken(token) {
		return nil, errShareNotFound
	}
	if cv, ok := r.Context().Value(shareCtxKey{}).(*resolvedCtx); ok {
		if cv.err != nil {
			return nil, cv.err
		}
		if cv.share != nil && cv.share.Token == token {
			return cv.share, nil
		}
	}
	sh, err := s.shares.Get(token)
	if err != nil {
		// 退役短链命中观测（P-20261008-2）：映射查询未命中先经 store 的退役
		// 反向索引反查——死链仍被踩是零误报的外泄确认信号，只补主人侧观测
		// （计数/审计/告警全在内存攒批），响应语义零变化（仍 404，见
		// retired.go）。HEAD 不计（探测不是「被看」，P-14 口径）
		s.noteRetiredHit(r, token)
		return nil, errShareNotFound
	}
	now := time.Now()
	if sh.Expired(now) {
		_ = s.shares.Delete(token)
		return nil, errShareExpired
	}
	// 一次性已消费（P-20261006-27）：与 TTL 过期同口把守但**不删记录**——
	// 失效态要留在管理器供分享者对账（「这条链已经被看过了」），清扫交给
	// 分享者撤销或记录自身的 TTL（若有）
	if sh.Consumed(now) {
		return nil, errShareConsumed
	}
	return sh, nil
}

// resolve 按 URL 中的 token 与 path 查询参数定位文件（页面/预览端点用）
func (s *Service) resolve(r *http.Request) (resolved, *httpError) {
	return s.resolveRel(r, r.PathValue("token"), r.URL.Query().Get("path"))
}

// resolveRel 按 token 与分享根内相对路径定位文件。
// rel 语义：目录分享 = 分享根内相对路径（os.Root 锚定分享根）；文件/项目
// 根分享 = 项目根内路径（os.Root 锚定项目根，访客路径为空才可命中）。
// 调用方仅在 err == nil 时持有 root/projRoot（closeRes）。
//
// 双层边界：
//  1. os.Root 锚定（目录分享经 OpenRoot 收紧到分享根）——分享根内符号
//     链接即便被解析也只能落在分享根内，物理上无法触达分享外的文件；
//  2. 分享根路径与访客路径逐段 Lstat 拒绝符号链接——策略层保持
//     "符号链接对访客不可见"（列表/zip 同策略跳过），防平台差异。
func (s *Service) resolveRel(r *http.Request, token, relQuery string) (resolved, *httpError) {
	sh, herr := s.lookup(r, token)
	if herr != nil {
		return resolved{}, herr
	}
	// 片段无文件系统锚定：root/projRoot 恒 nil、info 零值——meta/render/raw
	// 各自按 Kind 分支取落库内容，list/download 类端点在各自入口拒绝。
	// 终端直播同形：锚点是终端会话而非文件系统，直播内容走 /stream 端点；
	// 会话回放（P-20261004-103）同形：锚点是 cast 快照目录，内容走 /cast；
	// 会话回放只读分享（P-20261003-77）同形：锚点是条目快照，内容走 /session
	if sh.Kind == store.ShareKindSnippet || sh.Kind == store.ShareKindTerminal ||
		sh.Kind == store.ShareKindCast || sh.Kind == store.ShareKindSession {
		return resolved{share: sh}, nil
	}
	// 终端输出冻结快照（P-20261005-205）：单文件形态——锚点是创建时刻的
	// 净化文本快照（P-320 快照机制的单文件版），resolve 语义与文件分享同构
	// （rel 恒指向快照单文件，raw/download 免 path 参数）
	if sh.Kind == store.ShareKindTermFrozen {
		return s.resolveTermFrozen(sh)
	}
	// 冻结分享（P-20261003-320）：锚点是创建时复制的快照副本（内容定格），
	// 路径语义与 live 同构（快照内按项目内路径镜像存放，rel = Path[/q]）
	if sh.Frozen {
		return s.resolveFrozen(sh, relQuery)
	}
	rootDir, err := s.roots.RootOf(sh.ProjectID)
	if err != nil {
		return resolved{}, errTargetGone
	}
	// 访客路径归一：越过分享根的（../ 越过顶层）直接拒绝，不钳制——
	// 分享根是能力边界，宁可 404 不可越界
	q, nerr := NormalizeRelPath(relQuery)
	if nerr != nil {
		return resolved{}, errTargetMissing
	}
	projRoot, err := os.OpenRoot(rootDir)
	if err != nil {
		s.logger.Error("share: open project root failed", "projectId", sh.ProjectID, "err", err)
		return resolved{}, errTargetGone
	}
	// 分享根本身逐段拒绝符号链接（防分享根路径被链接偷换到别处）
	if herr := rejectSymlinkPath(projRoot, sh.Path); herr != nil {
		projRoot.Close()
		return resolved{}, herr
	}
	if sh.Path == "" {
		// 项目根分享：分享根 = 项目根，projRoot 即边界。访客路径与目录
		// 分享同语义参与解析（历史上写死 rel="."，子目录浏览/取文件全部
		// 落回根目录——预览增强的相对链接重写依赖正确的路径解析）
		if herr := rejectSymlinkPath(projRoot, q); herr != nil {
			projRoot.Close()
			return resolved{}, herr
		}
		rel := q
		if rel == "" {
			rel = "."
		}
		return s.resolveWithin(projRoot, projRoot, sh, rel, q)
	}
	targetInfo, err := projRoot.Lstat(sh.Path)
	if err != nil {
		projRoot.Close()
		return resolved{}, errTargetMissing
	}
	if !targetInfo.IsDir() {
		// 文件分享：边界就是该文件——q 非空时 join 出的路径必然不存在
		rel := sh.Path
		if q != "" {
			rel = sh.Path + "/" + q
		}
		return s.resolveWithin(projRoot, projRoot, sh, rel, q)
	}
	root, err := projRoot.OpenRoot(sh.Path)
	if err != nil {
		projRoot.Close()
		s.logger.Warn("share: open share root failed", "projectId", sh.ProjectID, "path", sh.Path, "err", err)
		return resolved{}, errTargetMissing
	}
	// 访客路径逐段拒绝符号链接（分享根内链接对访客不可见）
	if herr := rejectSymlinkPath(root, q); herr != nil {
		root.Close()
		projRoot.Close()
		return resolved{}, herr
	}
	rel := q
	if rel == "" {
		rel = "."
	}
	return s.resolveWithin(root, projRoot, sh, rel, q)
}

// resolveFrozen 冻结分享的文件定位：os.Root 锚定快照副本目录（副本由创建
// 时的受控复制产出——树内无符号链接，逐段拒绝仅作防御纵深），路径语义与
// live 同构：非根分享的快照内按分享根的项目内路径镜像存放（fsRel =
// Path[/q]）；项目根分享（Path=""）的副本内容即快照根（fsRel = q 或 "."），
// 与 CreateFrozenSnapshot 的镜像布局一一对应。副本目录被外部清走（清账竞态/
// 人工误删）→ target_gone：冻结链的内容边界已消失，与项目删除的 live 语义同类
func (s *Service) resolveFrozen(sh *store.Share, relQuery string) (resolved, *httpError) {
	q, nerr := NormalizeRelPath(relQuery)
	if nerr != nil {
		return resolved{}, errTargetMissing
	}
	if s.snaps == nil {
		return resolved{}, errTargetGone
	}
	dir, err := s.snaps.DirOf(sh)
	if err != nil {
		s.logger.Warn("share: frozen snapshot dir unavailable", "token", TokenSummary(sh.Token), "err", err)
		return resolved{}, errTargetGone
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		s.logger.Error("share: open frozen snapshot root failed", "token", TokenSummary(sh.Token), "err", err)
		return resolved{}, errTargetGone
	}
	if herr := rejectSymlinkPath(root, q); herr != nil {
		root.Close()
		return resolved{}, errTargetMissing
	}
	if sh.Path == "" {
		rel := q
		if rel == "" {
			rel = "."
		}
		return s.resolveWithin(root, root, sh, rel, q)
	}
	rel := sh.Path
	if q != "" {
		rel = sh.Path + "/" + q
	}
	return s.resolveWithin(root, root, sh, rel, q)
}

// resolveTermFrozen 终端输出冻结快照（P-20261005-205）的文件定位：os.Root
// 锚定快照目录（目录名 = TermFrozenNativeToken，装配层从记录字段重算——
// rotate 换链快照原地不动），rel 恒为快照单文件、访客路径 query 忽略
// （单文件快照无子路径语义，token 即能力边界）。副本目录/单文件不在盘
// → target_gone/target_missing：副本丢失是服务端数据事故，与目录冻结同款
// 不给访客「路径敲错」的误导（创建侧幂等重写可修复，见 WriteTermFrozenSnapshot）
func (s *Service) resolveTermFrozen(sh *store.Share) (resolved, *httpError) {
	if s.snaps == nil {
		return resolved{}, errTargetGone
	}
	dir, err := s.snaps.DirOf(sh)
	if err != nil {
		s.logger.Warn("share: term-frozen snapshot dir unavailable", "token", TokenSummary(sh.Token), "err", err)
		return resolved{}, errTargetGone
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		s.logger.Error("share: open term-frozen snapshot root failed", "token", TokenSummary(sh.Token), "err", err)
		return resolved{}, errTargetGone
	}
	// 防御纵深与 resolveFrozen 同款：副本树内不该有符号链接，逐段拒绝兜底
	if herr := rejectSymlinkPath(root, termFrozenFileName); herr != nil {
		root.Close()
		return resolved{}, errTargetMissing
	}
	return s.resolveWithin(root, root, sh, termFrozenFileName, "")
}

// resolveWithin 在已锚定的 root 内完成 Stat 收尾（vrel 仅用于对外展示）。
// Stat 失败必须释放两个 Root（调用方拿不到 resolved，无人代关）
func (s *Service) resolveWithin(root, projRoot *os.Root, sh *store.Share, rel, vrel string) (resolved, *httpError) {
	info, err := root.Stat(rel)
	if err != nil {
		if root != projRoot {
			root.Close()
		}
		projRoot.Close()
		return resolved{}, errTargetMissing
	}
	return resolved{share: sh, root: root, projRoot: projRoot, rel: rel, vrel: vrel, info: info}, nil
}

// rejectSymlinkPath 对 root 内 path 的每个组件前缀 Lstat，任一组件是符号
// 链接即拒绝（分享内容中的符号链接对访客不可见——列表、打包、定位三种
// 路径执行同一策略，防"列表看得到、下载 404"式的策略割裂）
func rejectSymlinkPath(root *os.Root, path string) *httpError {
	if path == "" {
		return nil
	}
	parts := strings.Split(path, "/")
	for i := range parts {
		prefix := strings.Join(parts[:i+1], "/")
		fi, err := root.Lstat(prefix)
		if err != nil {
			// 中间组件缺失/不可达：交给后续 Stat 统一给 target_missing
			return nil
		}
		if fi.Mode()&fs.ModeSymlink != 0 {
			return errTargetMissing
		}
	}
	return nil
}

// validToken 短链标识形态门禁（base36 16 位；形不对直接 404，不查库）
func validToken(t string) bool {
	if len(t) != 16 {
		return false
	}
	for _, c := range t {
		switch {
		case c >= '0' && c <= '9', c >= 'a' && c <= 'z':
		default:
			return false
		}
	}
	return true
}

// ── 端点 ──

// handlePage 分享页（HTML）。目标文件不存在时页面仍返回——由页内 meta
// 探测后给出友好错误卡，短链保持可用语义；已过保留窗口时 410 Gone 专页
// 明确文案（有效期已到、找分享者要新链），一次性已消费同样 410 专页
// （「已被查看并失效」，P-20261006-27——两态语境不同，文案区分），未知/
// 已撤销仍 404。
// 口令门（P-20261006-25）：口令记录未持有效门会话时本页只出口令页——
// 内容未出域，不计访问不留痕（P-14/P-257 的「链接被看过」口径以解锁后
// 的页面打开为准，解锁回程再走本入口即照常计数）。
// 一次性分享（P-20261020-3）：本页不再武装——未持查看 cookie 时只出确认页
// （不计数、不武装、不渲染内容、不泄露文件名，预览抓取 GET/HEAD 不会烧掉
// 链接）；显式确认在 POST /s/{token}/view。已确认且在宽限窗内正常渲染；
// 窗后由 lookup 的 consumed 分支给 410 专页。HEAD 一律不计数（探测不是
// 「被看」，防御性收口）。
func (s *Service) handlePage(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	sh, herr := s.lookup(r, token)
	if herr != nil {
		if herr == errShareExpired {
			s.writeExpired(w, r)
			return
		}
		if herr == errShareConsumed {
			s.writeConsumed(w, r)
			return
		}
		s.writeNotFound(w, r)
		return
	}
	if sh.PassphraseHash != "" && !s.gate.valid(r, sh) {
		s.writeGate(w, r, http.StatusOK, "")
		return
	}
	if sh.ViewOnce && !s.viewConfirmed(r, sh) {
		s.writeConfirm(w, r, http.StatusOK, false)
		return
	}
	// 命中有效分享即计一次访问（P-20261002-14；页面打开是「链接被看过」
	// 的主信号。目标文件已被删除时页面仍 200——记录有效即算暴露，与
	// 页内 meta 探测的友好错误卡不冲突）。一次性分享的计数已收口到显式
	// 确认 POST（刷新/同窗重开不重复计数）；HEAD 是探测不计数。只攒内存，
	// 见 hits.go
	if !sh.ViewOnce && r.Method != http.MethodHead {
		s.hits.Count(token)
		// 同点位留痕（P-20261003-257）：计数答「几次」，审计答「谁看的」——
		// 链接 id/IP/UA 简要攒内存入账，见 viewaudit.go
		s.recordView(r, sh)
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// 溯源水印文案（P-20261005-193）：记录开了 watermark 才非空，随 boot
	// 状态进页面（三访客页同源文案，见 watermark.go）
	var wm string
	if sh.Watermark {
		wm = WatermarkLabel(sh, time.Now())
	}
	// 终端直播：专属访客页（xterm 只读渲染 + 直播指示 + 遮蔽声明横幅），
	// 内容经 /stream SSE 推送；标题取记录展示名（缺省会话 ID）。协作开关
	//（P-20261024-1）随 boot 下发——缺省双关时页面零协作位（存量语义）；
	// 未过滤标记（P-20261106-9）随 boot 下发，横幅位换「未过滤」警示
	if sh.Kind == store.ShareKindTerminal {
		w.WriteHeader(http.StatusOK)
		_ = renderTermPage(w, token, prefLang(r), sh.Name, wm, sh.Collab, sh.DirectInput, sh.Unfiltered, sh.Writable)
		return
	}
	// 终端输出冻结快照（P-20261005-205）：xterm 一次性写入定格 buffer 的
	// 只读变体（无 SSE 接线），内容经 /raw 单文件端点取净本（未过滤记录
	// P-20261106-9 取原文快照，横幅位同标「未过滤」）
	if sh.Kind == store.ShareKindTermFrozen {
		w.WriteHeader(http.StatusOK)
		_ = renderTermFrozenPage(w, token, prefLang(r), sh.Name, wm, sh.Collab, sh.Unfiltered)
		return
	}
	// 会话回放（P-20261004-103）：xterm 按时序回放的只读访客页，cast 文本经
	// /cast 端点取（快照即净本），无 SSE/轮询/输入通道
	if sh.Kind == store.ShareKindCast {
		w.WriteHeader(http.StatusOK)
		_ = renderCastPage(w, token, prefLang(r), sh.Name, wm)
		return
	}
	// 会话回放只读分享（P-20261003-77）：结构化时间线访客页（user/assistant/
	// thinking/tool/result 全量可见），条目快照经 /session 取（快照即净本），
	// 无 SSE/轮询/输入通道
	if sh.Kind == store.ShareKindSession {
		w.WriteHeader(http.StatusOK)
		_ = renderSessionPage(w, token, prefLang(r), sh.Name, wm)
		return
	}
	w.WriteHeader(http.StatusOK)
	// 冻结快照时点横幅（P-20261005-168）：frozen 记录向观看者声明「内容定格
	// 于创建时刻」——诚实性横幅惯例族（与终端页遮蔽声明同族）；live 记录
	// 零值不出横幅。
	// 链接元信息（P-20261020-11）：服务端直出文件名/项目/类型——IM 与邮件
	// 网关不执行页面 JS，首屏 title/description/OG 是它们唯一能看到的说明。
	// 口令/一次性分享在 OG 层泛化（即便将来出现新的解锁前渲染路径，记录
	// 字段也不会从这层泄露）；snippet 无项目语义，按片段类型描述
	meta := pageMeta{
		Name:        sh.Name,
		ProjectName: sh.ProjectName,
		IsDir:       sh.IsDir,
		Snippet:     sh.Kind == store.ShareKindSnippet,
		Sensitive:   sh.PassphraseHash != "" || sh.ViewOnce,
		URL:         sharePageURL(r, token),
	}
	// 有效期弱提示（P-20261020-5）：非永久记录（显式 TTL/默认档/frozen 30 天）
	// 在页首声明到期时点；snippet 的内容区已有既有提示（P-20261003-29），
	// 传零值避免同一页面重复声明
	pageExpiry := sh.ExpiresAt
	if sh.Kind == store.ShareKindSnippet {
		pageExpiry = time.Time{}
	}
	_ = renderSharePage(w, token, prefLang(r), wm, sh.Frozen, sh.CreatedAt, pageExpiry, meta, sh.Collab)
}

// sharePageURL 访客页绝对地址（og:url）。分享子服务可能直连也可能在反代
// 后面：Host 取请求 Host（反代通常保留/改写为公开域名），TLS 态按连接判定；
// 拿不到 Host 时不出 og:url，而不是吐一个相对地址。
func sharePageURL(r *http.Request, token string) string {
	host := strings.TrimSpace(r.Host)
	if host == "" {
		return ""
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + host + "/s/" + token
}

// handleNotFoundAny 分享口上所有未匹配路径的品牌 404（/s/、/、乱敲路径等）。
// /s/* 上的写方法例外为 405：分享口注册 GET + 有限几条 POST（/s/{token}/gate
// 口令验证 P-20261006-25、/s/{token}/messages 访客留言 P-20261006-13、
// /s/{token}/view 一次性显式确认 P-20261020-3、/s/{token}/drop 素材上行与
// /s/{token}/direct/* 直通输入档 P-20261024-1——协作端点开关缺省关且关闭时
// 恒 404，存在性不可探测），已注册路径到不了这里；
// 除上述写入端点外访客面无「内容写入」端点——终端直播「严格只读」的第一层
// 保证，404 会让客户端误以为端点不存在而非方法不对，405 + Allow: GET 才是对
// 该契约的诚实表达
func (s *Service) handleNotFoundAny(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/s/") && r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeJSONErrorStatus(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	s.writeNotFound(w, r)
}

// writeNotFound 友好 404 页（未知/已取消的短链）
func (s *Service) writeNotFound(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	_ = renderNotFoundPage(w, prefLang(r))
}

// writeExpired 友好 410 页（已过保留窗口的短链——明确「已过期」而非
// 与 404 混同）
func (s *Service) writeExpired(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusGone)
	_ = renderExpiredPage(w, prefLang(r))
}

// writeConsumed 友好 410 页（一次性分享已被查看且宽限窗走完——文案是
// 「已被查看并失效」而非「已过期」，P-20261006-27 两态语境区分）
func (s *Service) writeConsumed(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusGone)
	_ = renderConsumedPage(w, prefLang(r))
}

// armViewOnce 一次性分享显式确认武装（P-20261020-3 起唯一调用点是
// POST /s/{token}/view；P-20261006-27 的 GET 首开武装已收口——预览抓取
// 不得烧链）：访客确认后把宽限倒计时落库（ViewedAt，first-writer-wins）。
// 已是常态零开销（非一次性或已武装在 store 侧短路）；仅首开付一次同步写
// ——武装时点是失效判定的安全锚，不能攒批（崩在批窗口 = 倒计时凭空重置）。
// 落库面经 optional interface 断言取自 s.shares：生产装配（shareapi.
// shareLookup→store.ShareStore）恒有该能力，测试桩未实现时跳过武装（只
// 影响该桩的失效分支测试，不影响其余行为）
func (s *Service) armViewOnce(sh *store.Share) {
	if !sh.ViewOnce || !sh.ViewedAt.IsZero() {
		return
	}
	m, ok := s.shares.(interface {
		MarkFirstView(token string, at time.Time) error
	})
	if !ok {
		return
	}
	if err := m.MarkFirstView(sh.Token, time.Now()); err != nil {
		// 武装失败（存储故障）：本次照常出内容（倒计时未启动），留痕让
		// 运维可察——下一位访客会重试武装（ViewedAt 仍为零）
		s.logger.Warn("share: mark first view failed", "token", TokenSummary(sh.Token), "err", err)
	}
}

// entryJSON meta/list 共用的条目结构
type entryJSON struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
	// Kind/Mime 仅文件条目携带（分享页据此选渲染分支）
	Kind string `json:"kind,omitempty"`
	Mime string `json:"mime,omitempty"`
}

func entryFrom(name, relPath string, d fs.FileInfo) entryJSON {
	e := entryJSON{
		Name:    name,
		Path:    relPath,
		IsDir:   d.IsDir(),
		Size:    d.Size(),
		ModTime: d.ModTime().UTC().Format(time.RFC3339),
	}
	if !d.IsDir() {
		desc := preview.ForFile(name)
		e.Kind = string(desc.Kind)
		e.Mime = desc.MIME
	}
	return e
}

// handleMeta 当前定位目标的元信息（分享页首屏 + 切换目录/文件时探测）
func (s *Service) handleMeta(w http.ResponseWriter, r *http.Request) {
	res, herr := s.resolve(r)
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	defer s.closeRes(res)

	// 片段：条目即记录本身（无文件探测）；expiresAt 供页头展示过期时点。
	// 终端直播同形（kind=terminal 供调用方辨识；内容走 /stream，meta 只答元数据）
	if res.share.Kind == store.ShareKindSnippet {
		writeJSON(w, map[string]any{
			"share": map[string]any{
				"name":        res.share.Name,
				"projectName": res.share.ProjectName,
				"isDir":       false,
				"kind":        entryKindSnippet,
			},
			"entry": entryJSON{
				Name:    res.share.Name,
				IsDir:   false,
				Size:    res.share.Size,
				ModTime: res.share.CreatedAt.UTC().Format(time.RFC3339),
				Kind:    entryKindSnippet,
			},
			"expiresAt": res.share.ExpiresAt.UTC().Format(time.RFC3339),
		})
		return
	}
	if res.share.Kind == store.ShareKindTerminal {
		writeJSON(w, map[string]any{
			"share": map[string]any{
				"name":        res.share.Name,
				"projectName": res.share.ProjectName,
				"isDir":       false,
				"kind":        string(store.ShareKindTerminal),
			},
			"entry": entryJSON{
				Name:    res.share.Name,
				IsDir:   false,
				ModTime: res.share.CreatedAt.UTC().Format(time.RFC3339),
				Kind:    string(store.ShareKindTerminal),
			},
			"expiresAt": res.share.ExpiresAt.UTC().Format(time.RFC3339),
		})
		return
	}
	// 会话回放（P-20261004-103）：元信息只有记录字段（内容走 /cast），与
	// snippet/terminal 同形——entry 供页头/调用方辨识
	if res.share.Kind == store.ShareKindCast {
		writeJSON(w, map[string]any{
			"share": map[string]any{
				"name":        res.share.Name,
				"projectName": res.share.ProjectName,
				"isDir":       false,
				"kind":        string(store.ShareKindCast),
			},
			"entry": entryJSON{
				Name:    res.share.Name,
				IsDir:   false,
				Size:    res.share.Size,
				ModTime: res.share.CreatedAt.UTC().Format(time.RFC3339),
				Kind:    string(store.ShareKindCast),
			},
			"expiresAt": res.share.ExpiresAt.UTC().Format(time.RFC3339),
		})
		return
	}
	// 会话回放只读分享（P-20261003-77）：元信息只有记录字段（内容走
	// /session），与 cast 同形——entry 供页头/调用方辨识
	if res.share.Kind == store.ShareKindSession {
		writeJSON(w, map[string]any{
			"share": map[string]any{
				"name":        res.share.Name,
				"projectName": res.share.ProjectName,
				"isDir":       false,
				"kind":        string(store.ShareKindSession),
			},
			"entry": entryJSON{
				Name:    res.share.Name,
				IsDir:   false,
				Size:    res.share.Size,
				ModTime: res.share.CreatedAt.UTC().Format(time.RFC3339),
				Kind:    string(store.ShareKindSession),
			},
			"expiresAt": res.share.ExpiresAt.UTC().Format(time.RFC3339),
		})
		return
	}

	name := res.info.Name()
	if res.vrel == "" {
		// 分享根本身：目录/文件统一用记录里的展示名（项目根分享 = 项目名）
		name = res.share.Name
	}
	e := entryFrom(name, res.vrel, res.info)
	out := map[string]any{
		"share": map[string]any{
			"name":        res.share.Name,
			"projectName": res.share.ProjectName,
			"isDir":       res.share.IsDir,
		},
		"entry": e,
	}
	// 有效期（P-20261020-5）：文件/目录/冻结分享的到期时点与 snippet/terminal/
	// cast/session 同键透出（访客页首屏与 agent 程序化读取共用同一契约）。
	// 永久分享零值不携带——避免 0001-01-01T00:00:00Z 哨兵值被消费者误读为有效
	if !res.share.ExpiresAt.IsZero() {
		out["expiresAt"] = res.share.ExpiresAt.UTC().Format(time.RFC3339)
	}
	writeJSON(w, out)
}

// handleList 目录条目列表（仅目录分享；子目录递归浏览的取数端点）
func (s *Service) handleList(w http.ResponseWriter, r *http.Request) {
	res, herr := s.resolve(r)
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	defer s.closeRes(res)
	if res.share.Kind == store.ShareKindSnippet || res.share.Kind == store.ShareKindTerminal ||
		res.share.Kind == store.ShareKindCast || res.share.Kind == store.ShareKindSession || !res.info.IsDir() {
		// 片段/直播/回放（cast/session）无文件系统条目；info 短路避免零值探测
		writeJSONError(w, errNotDir)
		return
	}
	// 多路径冻结分享（P-20261008-1）：根层由 manifest 驱动——逐项列出选择集
	// （跨目录的原始项目相对路径），而不是快照里按祖先目录展开的树。点入
	// 目录/文件后 vrel 非空，落回下方常规快照列表语义（所见即副本）
	if res.share.Frozen && len(res.share.Paths) > 0 && res.vrel == "" {
		out := make([]entryJSON, 0, len(res.share.Paths))
		for _, p := range res.share.Paths {
			info, ierr := res.root.Stat(p)
			if ierr != nil {
				// 副本与 manifest 不一致（数据事故）：跳过该项但保其余可用
				s.logger.Warn("share: batch manifest entry missing",
					"token", TokenSummary(res.share.Token), "path", p, "err", ierr)
				continue
			}
			e := entryFrom(path.Base(p), p, info)
			// 列表展示完整项目相对路径：跨目录选择下仅 basename 无法辨识
			//（同名 index.ts 两个来源），也提示访客条目在快照中的落点
			e.Name = p
			out = append(out, e)
		}
		writeJSON(w, map[string]any{"path": "", "entries": out})
		return
	}
	dirEntries, err := fs.ReadDir(res.root.FS(), res.rel)
	if err != nil {
		writeJSONError(w, errTargetMissing)
		return
	}
	base := res.vrel
	out := make([]entryJSON, 0, len(dirEntries))
	for _, de := range dirEntries {
		// 符号链接对访客不可见（与 resolve/zip 同策略）
		if de.Type()&fs.ModeSymlink != 0 {
			continue
		}
		info, err := de.Info()
		if err != nil {
			continue
		}
		childPath := de.Name()
		if base != "" {
			childPath = base + "/" + de.Name()
		}
		out = append(out, entryFrom(de.Name(), childPath, info))
	}
	// 目录在前、同级按名排序（大小写不敏感的稳定序）
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	writeJSON(w, map[string]any{"path": base, "entries": out})
}

// handleRender markdown/Word/CSV 服务端渲染为净化 HTML（页面以页内注入
// 呈现）。解析失败时返回内嵌错误卡的正常页面（而非让 iframe 显示 JSON
// 报错），下载按钮始终可用
func (s *Service) handleRender(w http.ResponseWriter, r *http.Request) {
	res, herr := s.resolve(r)
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	defer s.closeRes(res)
	// 片段：服务端渲染代码块形态（正文转义 + 等宽），页面照 markdown 管线
	// 页内注入——复制按钮/主题化/打印样式由通用增强管道自动生效。
	// 分支须先于 res.info 探测（片段无文件锚定，info 为零值）
	if res.share.Kind == store.ShareKindSnippet {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "sandbox")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(renderSnippetHTML(res.share.Content)))
		return
	}
	// 会话回放（cast/session）无服务端渲染文本（内容分别经 /cast、/session
	// 交给回放页）
	if res.share.Kind == store.ShareKindCast || res.share.Kind == store.ShareKindSession {
		writeJSONError(w, errUnrenderable)
		return
	}
	if res.info.IsDir() {
		writeJSONError(w, errNotFile)
		return
	}
	kind := preview.ForFile(res.info.Name()).Kind
	if kind != preview.KindMarkdown && kind != preview.KindDocx && kind != preview.KindCSV {
		writeJSONError(w, errUnrenderable)
		return
	}
	// md/csv 20MB（超上限给 413 仅下载提示）；docx 128MB（解压侧另有独立
	// 上限防 zip 炸弹）
	limit := int64(maxRenderBytes)
	if kind == preview.KindDocx {
		limit = maxDocxBytes
	}
	f, err := res.root.Open(res.rel)
	if err != nil {
		writeJSONError(w, errTargetMissing)
		return
	}
	defer f.Close()
	content, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		writeJSONError(w, errTargetMissing)
		return
	}
	if int64(len(content)) > limit {
		// 超预览上限是可预期的常态（非异常）：专用错误码让分享页呈现
		// "仅提供下载"提示，而不是误导性的"文件不存在"
		writeJSONError(w, errTooLarge)
		return
	}

	var body string
	switch kind {
	case preview.KindMarkdown:
		body = renderMarkdownHTML(content)
		if !utf8.Valid(content) {
			// 非 UTF-8（GBK/Latin 旧文档常见）：前置提示而非静默乱码
			body = encodingNoteHTML(r) + body
		}
		// 分享内相对图片/链接重写为 raw/页内导航（净化后执行，见函数注释）
		dir := path.Dir(res.vrel)
		if dir == "." {
			dir = ""
		}
		body = rewriteRelativeAssets(res.share.Token, dir, body)
	case preview.KindCSV:
		comma := ','
		if strings.HasSuffix(strings.ToLower(res.info.Name()), ".tsv") {
			comma = '\t'
		}
		body = renderCSVHTML(content, comma)
		if !utf8.Valid(content) {
			body = encodingNoteHTML(r) + body
		}
	default:
		body, err = renderDocHTML(content)
		if err != nil {
			// 解析失败：净化片段内嵌可行动提示（页面注入后展示为错误卡，
			// 下载始终可用）
			tip := dictFor(prefLang(r))["unsupportedTip"]
			body = `<div class="doc-err"><p>` + html.EscapeString(tip) + `</p></div>`
		}
	}
	// 裸净化片段：分享页页内注入到 .md-article（单滚动区，无 iframe 双滚动）；
	// 保留 CSP sandbox 头作为直接访问该端点时的兜底
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(body))
}

// encodingNoteHTML 非 UTF-8 文件的前置提示（服务端生成，双语按 Accept-Language）
func encodingNoteHTML(r *http.Request) string {
	msg := "This file is not valid UTF-8; some characters may look wrong. Download it for best results."
	if prefLang(r) == "zh" {
		msg = "此文件不是有效的 UTF-8 编码，部分字符可能显示异常，建议下载后查看"
	}
	return `<div class="doc-note">` + html.EscapeString(msg) + `</div>`
}

// handleRaw 文件内容内联输出（图片/PDF/音视频/文本预览的取数端点）。
// ServeContent 支持 Range（视频拖动进度条）
func (s *Service) handleRaw(w http.ResponseWriter, r *http.Request) {
	res, herr := s.resolve(r)
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	defer s.closeRes(res)
	s.serveRaw(w, r, res)
}

// handleRawPath 路径形态的 raw（/s/{t}/f/<分享内路径>）：html 预览的
// <base href> 落点——相对 css/img 子资源按 URL 层级回源分享根。
// 字体子资源另加 Access-Control-Allow-Origin（P-20261020-4）：HTML 预览的
// iframe 是沙箱不透明源，@font-face 的跨源请求按 CORS 校验，缺 ACAO 时
// 字体加载被浏览器拒绝；放宽面只限 /f/ 的字体响应，其余子资源不放宽
func (s *Service) handleRawPath(w http.ResponseWriter, r *http.Request) {
	res, herr := s.resolveRel(r, r.PathValue("token"), r.PathValue("name"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	defer s.closeRes(res)
	if res.info != nil && !res.info.IsDir() && isFontMIME(preview.ForFile(res.info.Name()).MIME) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
	}
	s.serveRaw(w, r, res)
}

// isFontMIME 字体描述符判定（/f/ 的 CORS 放宽面；共享给 raw 响应头收敛）
func isFontMIME(mime string) bool {
	return strings.HasPrefix(mime, "font/")
}

// rawContentType raw 响应的 Content-Type：仅文本族追加 charset——字体/图片/
// 音视频不带 charset 参数（P-20261020-4 起 MIME 表含 font/*，二进制类型
// 挂 charset 是无意义的元数据噪声）
func rawContentType(mime string) string {
	if strings.HasPrefix(mime, "text/") || mime == "application/json" ||
		mime == "application/javascript" || strings.HasSuffix(mime, "+xml") {
		return mime + "; charset=utf-8"
	}
	return mime
}

// serveRaw raw 输出的公共尾段（Range/Content-Type/CSP 与两个端点共用）
func (s *Service) serveRaw(w http.ResponseWriter, r *http.Request, res resolved) {
	// 片段的 raw：text/plain 原文输出（curl/脚本取回排障文本的直连口径）
	if res.share.Kind == store.ShareKindSnippet {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("Content-Security-Policy", "sandbox")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(res.share.Content))
		return
	}
	// 直播/回放无 raw 文件语义（内容分别走 /stream、/cast、/session；root
	// 恒 nil，显式拒绝防未来分支误触 nil Open）
	if res.share.Kind == store.ShareKindTerminal || res.share.Kind == store.ShareKindCast ||
		res.share.Kind == store.ShareKindSession {
		writeJSONError(w, errUnrenderable)
		return
	}
	if res.info.IsDir() {
		writeJSONError(w, errNotFile)
		return
	}
	f, err := res.root.Open(res.rel)
	if err != nil {
		writeJSONError(w, errTargetMissing)
		return
	}
	defer f.Close()
	// *os.File 直接满足 io.ReadSeeker（ServeContent 由此提供 Range 支持）
	desc := preview.ForFile(res.info.Name())
	w.Header().Set("Content-Type", rawContentType(desc.MIME))
	w.Header().Set("Content-Security-Policy", "sandbox")
	// PDF 预览以同源 iframe 引用本端点（share 页 page.js）：全局 X-Frame-Options
	// DENY 会连页内预览一起拦死，这里放宽到同源（CSP sandbox 已挡脚本执行）
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	http.ServeContent(w, r, res.info.Name(), res.info.ModTime(), f)
}

// handleHTMLDoc html 预览文档：读取 html、注入 <base href="/s/{t}/f/<目录>/">
// 后以 text/html 供 iframe 引用——相对 css/img 子资源按层级回源分享根。
// 脚本隔离（P-20261020-4 阶段 B）：默认 CSP sandbox（脚本全禁）；访客在
// 预览上显式「运行脚本（隔离）」时带 ?scripts=1，响应改为
// sandbox allow-scripts——脚本页仍是不透明源，绝不追加 allow-same-origin
// （与 iframe 侧 sandbox 属性同步放开，两层取交集、互斥规则一致），因此
// 脚本读不到主应用 cookie/localStorage，表单/弹窗/顶层导航仍被沙箱禁用。
// base 不影响拦截面：相对资源仍按分享根解析。
func (s *Service) handleHTMLDoc(w http.ResponseWriter, r *http.Request) {
	res, herr := s.resolve(r)
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	defer s.closeRes(res)
	if res.share.Kind == store.ShareKindSnippet || res.share.Kind == store.ShareKindTerminal ||
		res.share.Kind == store.ShareKindCast || res.share.Kind == store.ShareKindSession ||
		res.info.IsDir() || preview.ForFile(res.info.Name()).Kind != preview.KindHTML {
		// 片段/直播/回放（terminal/cast/session）无 html 文档形态；这些记录
		// 的 resolve 不产 info（零值），必须先按 Kind 短路再探测
		writeJSONError(w, errUnrenderable)
		return
	}
	f, err := res.root.Open(res.rel)
	if err != nil {
		writeJSONError(w, errTargetMissing)
		return
	}
	defer f.Close()
	content, err := io.ReadAll(io.LimitReader(f, maxRenderBytes+1))
	if err != nil {
		writeJSONError(w, errTargetMissing)
		return
	}
	if int64(len(content)) > maxRenderBytes {
		writeJSONError(w, errTooLarge)
		return
	}
	dir := path.Dir(res.vrel)
	base := "/s/" + res.share.Token + "/f/"
	if dir != "." && dir != "" {
		segs := strings.Split(dir, "/")
		for i := range segs {
			segs[i] = url.PathEscape(segs[i])
		}
		base += strings.Join(segs, "/") + "/"
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	sandbox := "sandbox"
	if r.URL.Query().Get("scripts") == "1" {
		sandbox += " allow-scripts"
	}
	w.Header().Set("Content-Security-Policy", sandbox)
	// 本端点的唯一消费方是分享页的 sandbox iframe（同源）——语义同 serveRaw
	w.Header().Set("X-Frame-Options", "SAMEORIGIN")
	_, _ = w.Write(injectHTMLBase(content, base))
}

// injectHTMLBase 在 html 的 <head> 后插入 <base>（大小写不敏感；无 head
// 时前置——浏览器容错解析同样生效）
func injectHTMLBase(content []byte, base string) []byte {
	tag := []byte(`<base href="` + html.EscapeString(base) + `">`)
	lower := []byte(strings.ToLower(string(content)))
	idx := strings.Index(string(lower), "<head")
	if idx < 0 {
		return append(tag, content...)
	}
	gt := strings.Index(string(lower[idx:]), ">")
	if gt < 0 {
		return append(tag, content...)
	}
	pos := idx + gt + 1
	out := make([]byte, 0, len(content)+len(tag))
	out = append(out, content[:pos]...)
	out = append(out, tag...)
	out = append(out, content[pos:]...)
	return out
}

// handleDownloadQuery 下载（查询参数形态，兼容旧链接）：?path= 相对路径
func (s *Service) handleDownloadQuery(w http.ResponseWriter, r *http.Request) {
	res, herr := s.resolve(r)
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	defer s.closeRes(res)
	s.doDownload(w, r, res)
}

// handleDownloadPath 自描述下载链接（URL 即路径）：/s/{token}/dl/{name...}。
// URL 以原文件名结尾——下载工具可直接从地址取名；响应头仍带原名
// Content-Disposition 双保险。解析顺序：
//  1. 精确路径（真实存在的 .zip 文件/目录按原样处理）
//  2. 精确未命中且以 .zip 结尾 → 剥后缀定位目录流式打包（URL 后缀即
//     所见格式，下载得到的就是 zip）；空路径 = 分享根本身
//  3. 未知 token → 友好 404 页；其余缺失 → JSON 语义
func (s *Service) handleDownloadPath(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")
	// 空路径（/dl/ 尾斜杠形态）= 分享根本身
	name := r.PathValue("name")
	if token == "" {
		writeJSONErrorStatus(w, http.StatusNotFound, errTargetMissing.code)
		return
	}
	rel, nerr := NormalizeRelPath(name)
	if nerr != nil {
		writeJSONErrorStatus(w, http.StatusNotFound, errTargetMissing.code)
		return
	}
	res, herr := s.resolveRel(r, token, rel)
	if herr == nil {
		defer s.closeRes(res)
		s.doDownload(w, r, res)
		return
	}
	// 精确未命中且 .zip 形态：剥后缀按目录打包重试（docs.zip → docs 目录）；
	// 后缀大小写不敏感（Docs.ZIP 同样命中）
	if herr == errTargetMissing && len(name) > 4 && strings.EqualFold(name[len(name)-4:], ".zip") {
		if rel2, nerr2 := NormalizeRelPath(name[:len(name)-4]); nerr2 == nil {
			res2, herr2 := s.resolveRel(r, token, rel2)
			if herr2 == nil {
				defer s.closeRes(res2)
				s.doDownload(w, r, res2)
				return
			}
		}
	}
	s.downloadErr(w, r, herr)
}

// downloadErr 下载端点的错误呈现：分享不存在给友好 404 页（链接常被
// 直接粘贴到地址栏），其余保持 JSON 语义
func (s *Service) downloadErr(w http.ResponseWriter, r *http.Request, herr *httpError) {
	if herr == errShareNotFound {
		s.writeNotFound(w, r)
		return
	}
	writeJSONError(w, herr)
}

func (s *Service) doDownload(w http.ResponseWriter, r *http.Request, res resolved) {
	// 片段/回放无文件可下载（片段经页面/raw 取阅；回放的 cast 文本经 /cast
	// 端点，访客页内以回放器呈现，下载走页面链接的 download 语义）
	if res.share.Kind == store.ShareKindSnippet || res.share.Kind == store.ShareKindCast ||
		res.share.Kind == store.ShareKindSession {
		writeJSONError(w, errUnrenderable)
		return
	}
	// 一次性分享：下载也是内容出域，必须已完成显式确认（查看 cookie 由
	// POST /s/{token}/view 发放）。未确认 → 回内容页入口的确认页（不武装
	// 不计数）；直链/预览抓取不能借下载通道烧链
	if res.share.ViewOnce && !s.viewConfirmed(r, res.share) {
		http.Redirect(w, r, "/s/"+res.share.Token, http.StatusSeeOther)
		return
	}
	// 下载启动（文件直下或目录打包）即计一次访问（P-20261002-14）——直链
	// /dl/ 分享常跳过页面直接取文件，不计数会把这类暴露漏掉。一次性分享
	// 的计数已收口到显式确认 POST（下载不重复计数）；HEAD 是探测不计数。
	// 只攒内存，见 hits.go
	if !res.share.ViewOnce && r.Method != http.MethodHead {
		s.hits.Count(res.share.Token)
		// 同点位留痕（P-20261003-257，viewaudit.go）：直链取件是跳过页面的
		// 暴露面，审计尤其不能漏
		s.recordView(r, res.share)
	}
	if !res.info.IsDir() {
		f, err := res.root.Open(res.rel)
		if err != nil {
			writeJSONError(w, errTargetMissing)
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Disposition", contentDisposition(res.info.Name(), false))
		http.ServeContent(w, r, res.info.Name(), res.info.ModTime(), f)
		return
	}

	// 目录打包：流式写出（不落临时盘），文件名取目录名.zip
	zipName := res.info.Name()
	if res.rel == "." {
		zipName = res.share.Name
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", contentDisposition(zipName+".zip", false))
	w.WriteHeader(http.StatusOK)
	if err := writeZip(w, res.root, res.rel); err != nil {
		// 头已发出，只能在日志留痕（前端表现为 zip 提前截断/损坏）；
		// token 打摘要不打全值（P-20261002-95）——同包 TokenSummary
		s.logger.Warn("share: zip streaming failed", "token", TokenSummary(res.share.Token), "path", res.rel, "err", err)
	}
}

// ── 终端只读直播（P-20261003-306） ──

// sseKeepaliveInterval SSE 保活注释帧周期：代理/LB 对静默连接的空闲裁剪
// 通常在 30~60s，15s 注释帧（`: ping`）把连接钉在活跃侧；输出密集时该
// ticker 空转（select 随机就绪，注释帧不挤占数据帧的推送及时性）
const sseKeepaliveInterval = 15 * time.Second

// sseSizePollInterval 主机尺寸对账周期（P-20261107-4 渲染保真）：主人调整窗口
// 后访客栅格必须跟随（cols/rows 不符即 TUI 折行/光标定位错乱）。数据帧路径
// 逐帧对账（resize 引发的 SIGWINCH 重绘必然带输出，新尺寸先于重绘字节到达
// 访客），本 ticker 兜「调整后无输出」的静默窗口；Size 只是一次会话锁内读，
// 单 token 访客 ≤5 路，1s 周期开销可忽略
const sseSizePollInterval = time.Second

// handleStream 终端只读推流（SSE）：hello（尺寸/终态）→ tail（订阅点前
// 遮蔽尾流快照，base64）→ data*（实时遮蔽字节）→ end（馈线终结）；主机
// 尺寸变化时插入 resize 帧（{"cols","rows"}，P-20261107-4——先于新尺寸下
// 重绘的字节送达，访客按主机栅格渲染）。
// 字节帧一律 base64：PTY 输出是任意字节流，多字节 UTF-8 字符可被 4KB 分片
// 劈开，SSE 的 text 语义要求 UTF-8 合法——base64 让帧边界与字节边界解耦。
// 访客额度（单 token 并发 ≤ MaxGuestsPerToken）由直播源把守，超限 429。
// 严格只读：本端点只写不读（忽略请求体），终端输出流没有反向通道——
// 访客面写入端点只触独立数据面（/gate 口令验证 P-20261006-25、/view 一次性
// 确认 P-20261020-3、/messages 访客留言附表、/drop 素材上行与 /direct/*
// 直通输入档 P-20261024-1——直通输入走独立的会话写入授权链，不经直播流；
// 未开协作的分享无任何写入端点）
func (s *Service) handleStream(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	if sh.Kind != store.ShareKindTerminal {
		// 文件/片段分享没有流语义（不是 405——路由面语义上该端点存在，
		// 是该记录形态不可直播）
		writeJSONError(w, errUnrenderable)
		return
	}
	if s.live == nil {
		// 直播源未装配（测试/降级部署）：按已终结流语义收场，不 5xx
		s.writeSSEEnd(w, r)
		return
	}
	sub, err := s.live.Subscribe(sh.Token, sh.TerminalID, sh.Unfiltered)
	if err != nil {
		writeJSONErrorStatus(w, http.StatusTooManyRequests, "guest_limit")
		return
	}
	defer sub.Release()

	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONErrorStatus(w, http.StatusInternalServerError, "streaming_unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	// 禁代理缓冲（nginx 同名头约定），SSE 帧即时到达访客
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	// 每帧一个写超时：半死连接的 Write 无 deadline 会永久阻塞
	//（proxy/ws.go 泄漏事故同款教训），http.ResponseController 帧粒度控时，
	// 不牵连整条连接的生命周期
	rc := http.NewResponseController(w)
	writeEvent := func(event, data string) bool {
		_ = rc.SetWriteDeadline(time.Now().Add(30 * time.Second))
		if _, err := io.WriteString(w, "event: "+event+"\ndata: "+data+"\n\n"); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}

	// hello：终端尺寸 + 是否已终结（访客页据此初始化 xterm 网格/直接呈现
	// 「已结束」）；tail：订阅点前快照。顺序先于实时订阅消费——订阅点登记
	// 在 Subscribe 内部与快照同锁完成，快照与此后的实时通道无重叠无缝隙。
	// struct 序列化定字段序（map 序列化按键序漂移，访客端解析虽无感，
	// e2e 断言与日志对账都需要稳定帧形态）
	type helloFrame struct {
		Cols  uint16 `json:"cols,omitempty"`
		Rows  uint16 `json:"rows,omitempty"`
		Ended bool   `json:"ended"`
	}
	cols, rows := sub.Size()
	hb, _ := json.Marshal(helloFrame{Cols: cols, Rows: rows, Ended: sub.Ended()})
	if !writeEvent("hello", string(hb)) {
		return
	}
	if len(sub.Tail()) > 0 {
		if !writeEvent("tail", base64.StdEncoding.EncodeToString(sub.Tail())) {
			return
		}
	}

	// syncSize 主机尺寸对账（P-20261107-4）：与上次下发值不同即补 resize 帧；
	// 0 尺寸（会话不可读）不下发——访客保持现栅格，不被打回默认网格
	type sizeFrame struct {
		Cols uint16 `json:"cols"`
		Rows uint16 `json:"rows"`
	}
	syncSize := func() bool {
		c, r := sub.Size()
		if c == 0 || r == 0 || (c == cols && r == rows) {
			return true
		}
		cols, rows = c, r
		sb, _ := json.Marshal(sizeFrame{Cols: c, Rows: r})
		return writeEvent("resize", string(sb))
	}

	keepalive := time.NewTicker(sseKeepaliveInterval)
	defer keepalive.Stop()
	sizePoll := time.NewTicker(sseSizePollInterval)
	defer sizePoll.Stop()
	for {
		select {
		case data, ok := <-sub.Live():
			if !ok {
				return
			}
			// 尺寸先于字节：resize 后的重绘按新栅格落屏
			if !syncSize() {
				return
			}
			if len(data) > 0 && !writeEvent("data", base64.StdEncoding.EncodeToString(data)) {
				return
			}
		case <-sizePoll.C:
			if !syncSize() {
				return
			}
		case <-sub.Done():
			// 馈线终结（会话关闭/撤销/慢消费踢出）：终结前的最后一批字节
			// 可能仍在通道里，非阻塞排干再收场
			for {
				select {
				case data, ok := <-sub.Live():
					if ok && len(data) > 0 {
						if !writeEvent("data", base64.StdEncoding.EncodeToString(data)) {
							return
						}
						continue
					}
				default:
				}
				writeEvent("end", "{}")
				return
			}
		case <-r.Context().Done():
			return
		case <-keepalive.C:
			// SSE 注释帧保活（`: ping` 对 EventSource 透明）
			_ = rc.SetWriteDeadline(time.Now().Add(30 * time.Second))
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// writeSSEEnd 直播源未装配时的降级流：一帧 hello(ended) + end 即关
func (s *Service) writeSSEEnd(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONErrorStatus(w, http.StatusInternalServerError, "streaming_unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "event: hello\ndata: {\"ended\":true}\n\n")
	_, _ = io.WriteString(w, "event: end\ndata: {}\n\n")
	flusher.Flush()
}

// handleCastFile 会话回放文本（P-20261004-103）：访客页回放引擎的取数端点，
// 输出创建时刻的 cast 快照（快照写盘前已完成敏感值兜底遮蔽——净本直出，
// 本包不做二次处理）。单文件语义：目录由装配层从记录字段重算（CastNativeToken
// 零代际稳定键，rotate 换链快照原地不动），文件名固定。副本丢失 → 410
// target_gone（与 terminal-frozen 的坏副本语义同族，不给「路径敲错」误导）。
// ?dl=1 走附件下载（访客可导出 cast 交给外部播放器，属只读取数不构成写入面）
func (s *Service) handleCastFile(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	if sh.Kind != store.ShareKindCast {
		writeJSONError(w, errUnrenderable)
		return
	}
	if s.snaps == nil {
		writeJSONError(w, errTargetGone)
		return
	}
	dir, err := s.snaps.DirOf(sh)
	if err != nil {
		s.logger.Warn("share: cast snapshot dir unavailable", "token", TokenSummary(sh.Token), "err", err)
		writeJSONError(w, errTargetGone)
		return
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		s.logger.Error("share: open cast snapshot root failed", "token", TokenSummary(sh.Token), "err", err)
		writeJSONError(w, errTargetGone)
		return
	}
	defer root.Close()
	f, err := root.Open(castFileName)
	if err != nil {
		writeJSONError(w, errTargetGone)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeJSONError(w, errTargetGone)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "sandbox")
	if r.URL.Query().Get("dl") != "" {
		w.Header().Set("Content-Disposition", contentDisposition("replay.cast", false))
	}
	http.ServeContent(w, r, "replay.cast", info.ModTime(), f)
}

// handleSessionFile 会话回放只读分享的条目快照（P-20261003-77）：输出创建
// 时刻的净本 JSON（快照写盘前已完成 P-108 敏感值遮蔽——本包不做二次处理，
// 也不提供「显示原文」参数：匿名访客没有放行语境）。单文件语义：目录由装配
// 层从记录字段重算（SessionNativeToken 零代际稳定键，rotate 换链快照原地
// 不动），文件名固定。副本丢失 → 410 target_gone（与 cast/terminal-frozen
// 的坏副本语义同族，不给「路径敲错」误导）。application/json + nosniff：
// 访客页 fetch 解析，浏览器直开是一份结构化数据而非可执行文档
func (s *Service) handleSessionFile(w http.ResponseWriter, r *http.Request) {
	sh, herr := s.lookup(r, r.PathValue("token"))
	if herr != nil {
		writeJSONError(w, herr)
		return
	}
	if sh.Kind != store.ShareKindSession {
		writeJSONError(w, errUnrenderable)
		return
	}
	if s.snaps == nil {
		writeJSONError(w, errTargetGone)
		return
	}
	dir, err := s.snaps.DirOf(sh)
	if err != nil {
		s.logger.Warn("share: session snapshot dir unavailable", "token", TokenSummary(sh.Token), "err", err)
		writeJSONError(w, errTargetGone)
		return
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		s.logger.Error("share: open session snapshot root failed", "token", TokenSummary(sh.Token), "err", err)
		writeJSONError(w, errTargetGone)
		return
	}
	defer root.Close()
	f, err := root.Open(sessionFileName)
	if err != nil {
		writeJSONError(w, errTargetGone)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		writeJSONError(w, errTargetGone)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "sandbox")
	http.ServeContent(w, r, sessionFileName, info.ModTime(), f)
}

// handleAsset vendored 静态资产（终端直播访客页的 xterm 三件）：白名单精确
// 命中防目录穿越与任意读；内容是公共静态库（无私有数据），覆写全局 no-store
// 为不可变长缓存——内容随二进制发布，升级即换 URL 无缓存失效问题
func (s *Service) handleAsset(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	data, ct, ok := assetByName(name)
	if !ok {
		s.writeNotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Del("Pragma")
	w.Header().Set("Content-Type", ct)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

// ── 小工具 ──

// NormalizeRelPath 分享路径归一（对外语义的唯一权威实现，管理面与
// 访客面共用）：反斜杠 → 斜杠、丢弃空段与 "."、内部 ".." 逐级上跳；
// 试图越过根的路径（顶层多余的 ../）返回错误——分享根是能力边界，
// 归一只做安全的等价变换，绝不钳制改写指向。
// 病态路径防御：总长/段数超限直接拒绝（访客路径会逐段 Lstat，超长
// 输入不应换取系统调用放大）
func NormalizeRelPath(p string) (string, error) {
	if len(p) > 1024 {
		return "", errPathEscape
	}
	parts := strings.Split(strings.ReplaceAll(p, "\\", "/"), "/")
	if len(parts) > 64 {
		return "", errPathEscape
	}
	var stack []string
	for _, seg := range parts {
		switch {
		case seg == "", seg == ".":
		case seg == "..":
			if len(stack) == 0 {
				return "", errPathEscape
			}
			stack = stack[:len(stack)-1]
		default:
			stack = append(stack, seg)
		}
	}
	return strings.Join(stack, "/"), nil
}

// TargetInfo 管理面创建分享前的目标探测结果
type TargetInfo struct {
	Name  string
	IsDir bool
	Size  int64
}

// StatTarget 校验 rootDir 下 rel 真实存在并返回展示信息。
// 与访问路径同一套归一与逃逸防护（os.Root），rootDir 本身必须是
// 已校验的项目根；分享目标路径上的符号链接一律拒绝——保证分享根
// 从创建那一刻起就是真实目录/文件，不存在被链接偷换的起点
func StatTarget(rootDir, rel string) (TargetInfo, error) {
	rel, err := NormalizeRelPath(rel)
	if err != nil {
		return TargetInfo{}, err
	}
	root, err := os.OpenRoot(rootDir)
	if err != nil {
		return TargetInfo{}, err
	}
	defer root.Close()
	if herr := rejectSymlinkPath(root, rel); herr != nil {
		return TargetInfo{}, fs.ErrNotExist
	}
	fsRel := rel
	if fsRel == "" {
		fsRel = "."
	}
	info, err := root.Stat(fsRel)
	if err != nil {
		return TargetInfo{}, err
	}
	return TargetInfo{Name: info.Name(), IsDir: info.IsDir(), Size: info.Size()}, nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

func writeJSONError(w http.ResponseWriter, herr *httpError) {
	writeJSONErrorStatus(w, herr.status, herr.code)
}

func writeJSONErrorStatus(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": code})
}

// contentDisposition 生成含 UTF-8 文件名的 Content-Disposition
// （mime.FormatMediaType 自动按 RFC 2231 处理非 ASCII）
func contentDisposition(name string, inline bool) string {
	disp := "attachment"
	if inline {
		disp = "inline"
	}
	v := mime.FormatMediaType(disp, map[string]string{"filename": name})
	if v == "" {
		return disp
	}
	return v
}

// prefLang Accept-Language → 页面语言（zh 系 → 中文，其余英文）
func prefLang(r *http.Request) string {
	al := r.Header.Get("Accept-Language")
	if al != "" {
		al = strings.ToLower(al)
		if idx := strings.Index(al, "zh"); idx >= 0 {
			// "zh" 出现在偏好列表里即中文（zh-CN/zh-TW/*；简单语义足够）
			return "zh"
		}
	}
	return "en"
}
