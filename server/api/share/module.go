// Package shareapi 文件分享管理面：/api/share（创建/列表/撤销/子服务状态）
// + 分享子服务监听的生命周期（独立端口，匿名访客访问）。
// 本包是 store、server/share（访客面服务）与 kernel 之间的装配与协议层
package shareapi

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	"codecombo/server/api/opschannel"
	"codecombo/server/bindhint"
	"codecombo/server/config"
	"codecombo/server/kernel"
	"codecombo/server/liveterm"
	"codecombo/server/notification"
	"codecombo/server/share"
	"codecombo/server/store"
	"codecombo/server/terminal"
)

// ── 子服务运行状态（Module Start/Stop 维护，管理接口只读） ──

type serviceStatus struct {
	Running bool
	Port    int
	Scheme  string
}

var statusPtr atomic.Pointer[serviceStatus]

func setStatus(running bool, port int, scheme string) {
	statusPtr.Store(&serviceStatus{Running: running, Port: port, Scheme: scheme})
}

func currentStatus() serviceStatus {
	if s := statusPtr.Load(); s != nil {
		return *s
	}
	return serviceStatus{}
}

// Module 分享领域模块。Start 拉起独立端口子服务（失败降级为告警 +
// 状态上报"未就绪"，不影响主服务）；Stop 优雅关闭监听
type Module struct {
	cfg *config.Config
	// TLS 运行参数由组合根声明式传入（CLI 覆盖只存在于组合根的解析结果里）
	tlsOn             bool
	certFile, keyFile string
	srv               *http.Server
	// flushPending 访客面攒批的落盘收口（访问计数 + 访问审计，Start 装配，
	// Stop 兜底冲一次——停机窗口内攒下的命中与留痕不丢）
	flushPending func() int
	// live 终端直播馈线 hub（Start 构造，Stop 收尾全部馈线并摘对账回调）
	live *liveterm.Hub
	// unsubStale 快照陈旧加速器的总线退订（P-20261114-3-S2，Start 装配，
	// Stop 摘除——停机后旧 hub 不得再收 file.changed）
	unsubStale func()
}

// NewModule 创建分享模块（tlsOn/cert/key = 主服务已解析的传输配置）
func NewModule(cfg *config.Config, tlsOn bool, certFile, keyFile string) *Module {
	return &Module{cfg: cfg, tlsOn: tlsOn, certFile: certFile, keyFile: keyFile}
}

func (m *Module) Name() string        { return "share" }
func (m *Module) DependsOn() []string { return nil }

func (m *Module) Init(_ context.Context, _ kernel.Kernel) error { return nil }

// gcFrozenOrphans 冻结快照孤儿对账（P-20261003-320）：按存活冻结记录重算
// keep 集（FrozenNativeToken 是零代际值，轮换记录同样命中），删除集外目录。
// 正常路径撤销即删、TTL 记录消亡由本对账兜底——记录侧清理（CleanupExpired/
// 访客面惰性删除）与副本侧删除是两个落盘点，崩溃窗口的孤儿在这里收口。
// List 失败时跳过本轮（keep 不可信绝不清账，防误删全库）
func gcFrozenOrphans(st *store.Store, logger *slog.Logger) {
	shares, err := st.Share.List()
	if err != nil {
		logger.Warn("share frozen gc skipped: list failed", "err", err)
		return
	}
	keep := make(map[string]bool)
	for _, s := range shares {
		switch {
		case s.Kind == store.ShareKindFile && s.Frozen && s.ProjectID != "" && len(s.Paths) > 0:
			// 多路径冻结分享（P-20261008-1）同区同对账：集合键派生目录名，
			// 漏登会被巡检当孤儿清成 target_gone
			keep[store.FrozenBatchNativeToken(config.MasterKey(), s.ProjectID, s.Paths)] = true
		case s.Kind == store.ShareKindFile && s.Frozen && s.ProjectID != "":
			keep[store.FrozenNativeToken(config.MasterKey(), s.ProjectID, s.Path)] = true
		case s.Kind == store.ShareKindTermFrozen && s.TerminalID != "" && s.ContentHash != "":
			// 终端输出冻结快照（P-20261005-205）住同一隔离区，同一对账通道
			// 收口（不进 keep 集会被当孤儿误删——这是本形态存活的生命线）
			keep[store.TermFrozenNativeToken(config.MasterKey(), s.TerminalID, s.ContentHash)] = true
		case s.Kind == store.ShareKindCast && s.RecordingID != "":
			// 会话回放 cast 快照（P-20261004-103）同区同对账：记录存活则快照
			// 必须进 keep 集，否则巡检即把回放页的内容删成 target_gone
			keep[store.CastNativeToken(config.MasterKey(), s.RecordingID)] = true
		case s.Kind == store.ShareKindSession && s.SessionID != "":
			// 会话回放只读分享快照（P-20261003-77）同区同对账：漏登 keep 集
			// 会让巡检把访客页内容删成 target_gone
			keep[store.SessionNativeToken(config.MasterKey(), s.SessionID)] = true
		}
	}
	if removed, err := share.GcOrphanSnapshots(keep); err != nil {
		logger.Warn("share frozen gc failed", "err", err)
	} else if removed > 0 {
		logger.Info("share frozen gc", "removed", removed)
	}
}

// shareCleanupInterval 过期清理的巡检周期。对齐 agentask-cleanup 的 10 分钟
// 粒度：过期记录的实际滞留压在 TTL+10min 内（snippet 的短暴露是特性语义，
// opt-in TTL 文件分享的到期承诺同样不该拖），清理间隙由访客面把守（410 +
// 惰性删除，P-20261003-29）；启动即先清一轮（重启不残留已过期记录）
const shareCleanupInterval = 10 * time.Minute

// shareFlushInterval 访客面攒批的冲刷周期（P-20261002-14 访问计数 +
// P-20261003-257 访问审计同一节奏）：两边都只在访客面攒内存（server/share
// HitCounter/ViewAuditBuffer，访客响应路径零磁盘 I/O），这里定时批量落盘。
// 3s 让管理列表的「访问次数」与审计面板的访客留痕近实时可见（e2e 与人读都
// 不用干等），空批次时冲刷是零成本判空；审计 Append 尽力而为、计数失败丢弃
// 不重试（见 hits.go / viewaudit.go 的各自取舍注记）
const shareFlushInterval = 3 * time.Second

// shareGateReconcileInterval 会话输入闸自愈对账周期（P-20261122-17）：三
// 生命周期路径（撤销/轮换/过期）已有即时收口，ticker 兜的是崩溃窗口、
// 记录先死与半开连接滞留的残账——1min 足以把 owner 键盘的最大误锁期压到
// 分钟级，又不产生可感知的周期开销（无残留时只扫几张内存表）。ListShares
// 入口同口调用（内部 5s 节流）让「有人看管理面」时更快自愈
const shareGateReconcileInterval = time.Minute

// Start 启动分享子服务监听。端口占用等失败不阻断主服务启动——
// 状态端点会暴露"未就绪"，前端提示用户检查配置。
// 另注册过期清理（snippet 固定 24h + 文件分享 opt-in TTL 同管线，P-71/
// P-20261003-29；auditlog-cleanup 同款保留策略 ticker 惯例：低频清理放内核
// 调度器专属 goroutine 串行执行）；ticker 注册先于监听建立——子服务起不来
// 的部署里过期记录同样要被清掉
func (m *Module) Start(_ context.Context, k kernel.Kernel) error {
	st := store.Get()
	if st == nil {
		k.Logger().Warn("share module skipped: store not ready")
		return nil
	}
	if sch := k.Scheduler(); sch != nil {
		sch.AddTicker("share-expired-cleanup", shareCleanupInterval, func(context.Context) {
			if n, err := st.Share.CleanupExpired(time.Now()); err != nil {
				k.Logger().Warn("share expired cleanup failed", "err", err)
			} else if n > 0 {
				k.Logger().Info("share expired cleanup", "removed", n)
			}
			// 冻结快照孤儿对账随同一巡检收口（P-20261003-320）：TTL 到期的
			// 记录刚被上面扫走，其副本目录在此刻成为孤儿，紧随其后删除
			gcFrozenOrphans(st, k.Logger())
			// 收件区孤儿对账 + TTL 消费清理（P-20261024-1）：记录消亡的收件
			// 目录由 keep 集对账收口；已消费 24h / 未消费 72h 的素材到期即清
			//（防主人未看即被清的消费语义见 drops.go）
			if shares, err := st.Share.List(); err == nil {
				keep := make(map[string]bool, len(shares))
				for _, s := range shares {
					keep[s.Token] = true
				}
				share.GcOrphanDrops(keep, k.Logger())
				// 直通持权级联回收：存活集外的持权立即回收（访客面已 404，
				// 不会再有输入触发惰性清扫——会话侧只读闸必须就地解除）
				if svc := shareSvc; svc != nil {
					svc.CascadeRelease(keep)
					// 可写上行连接级联清场（P-20261106-8）：同 keep 集判据，
					// 记录死亡后上行桥不能残留（writable.go 头注级联语义）
					svc.CascadeWritableDown(keep)
				}
				// 陈旧状态 keep 集对账（P-20261114-3-S2 生命周期三件）：过期
				// 清账刚扫走的记录，其陈旧标记/索引项随宿主消亡
				//（CascadeRelease 同族钩子同点位）
				staleHubSvc.Prune(keep)
				// 直播馈线收口（P-20261106-9）：TTL 到期的直播记录刚被
				// CleanupExpired 直接删除（不经 Unwire），其馈线若不收口会挂着
				// tap 直到会话关闭——未过滤馈线的原文尾流不应驻留到那时
				if lw := liveWire; lw != nil {
					if n := lw.Prune(keep); n > 0 {
						k.Logger().Info("share live feeds pruned", "ended", n)
					}
				}
			} else {
				k.Logger().Warn("share drops gc skipped: list failed", "err", err)
			}
			share.CleanExpiredDrops(time.Now(), k.Logger())
			// 留言附表孤儿对账（P-20261006-13）：级联删除/轮换迁键是「分享键
			// 变更 + 留言键跟进」的两段写，崩溃窗口残留由这里清算（宽限期防
			// 误删在途迁移的中间态，见 store.GCOrphans）
			if n, err := st.ShareMsg.GCOrphans(func(token string) bool {
				s, err := st.Share.Get(token)
				return err == nil && !s.Expired(time.Now())
			}, time.Now()); err != nil {
				k.Logger().Warn("share message gc failed", "err", err)
			} else if n > 0 {
				k.Logger().Info("share message gc", "removed", n)
			}
		})
	}
	// 启动即先清一轮：重启不残留已过期记录（disk-watch 巡检同款收口）
	if n, err := st.Share.CleanupExpired(time.Now()); err != nil {
		k.Logger().Warn("share startup cleanup failed", "err", err)
	} else if n > 0 {
		k.Logger().Info("share startup cleanup", "removed", n)
	}
	gcFrozenOrphans(st, k.Logger())

	svc := share.NewService(shareLookup{st: st}, rootResolver{st: st}, k.Logger().With("module", "share"))
	// 冻结快照目录解析（P-20261003-320）：frozen 记录的访客面锚点是快照副本
	svc = svc.WithSnapshotDirs(snapshotResolver{})
	// 访客留言附表（P-20261006-13）：访客 POST 落库 + 主人侧列表/级联的
	// 消费面（store 聚合体内两仓互指，这里只递接口）
	svc = svc.WithMessageBoard(st.ShareMsg)
	// 协作通道（P-20261024-1）：素材到达的 ops 广播接线（回调体只做
	// opschannel 非阻塞投递——通知/审计的攒批在 server/share 侧既有缓冲）
	svc = svc.WithDropEvents(func(ev share.DropEvent) {
		opschannel.BroadcastEvent(opschannel.EventShareDrop, ev)
	})
	// 访客输入（P-20261024-1 直通档 + P-20261106-8 可写分享，P-20261121-1
	// 统一双授权模式）：键入落点与会话闸账本接线——键入统一走
	// writableAdapter（WritableWrite 直写会话 PTY），会话输入闸经
	// share.Service gateLedger 账本单点落 SetWritableGate；持权回收回调只补
	// 非 owner 缘由审计（owner 缘由的审计在 handler 落，不双写）
	setShareDirectCallbacks(svc)
	// 访客输入申请到达广播（P-20261121-2）：回调体只做 opschannel 非阻塞
	// 投递——通知的攒批在 server/share 侧 GuestNoteBuffer 既有缓冲（与素材
	// 到达通知同节奏，share-flush tick 批量入账）
	svc = svc.WithDirectRequestEvents(func(ev share.DirectRequestEvent) {
		opschannel.BroadcastEvent(opschannel.EventShareDirectRequest, ev)
	})
	// WS 上行桥（P-20261106-8，统一后双授权模式单一传输面）：落点/风险预检/
	// 事件三面接线。风险预检复用 commandrisk 模式表（按键级不审批的诚实边界
	// 与粘贴级 danger 审批的分层见 server/share/writable.go 头注）；事件回调
	// 只做 opschannel 非阻塞投递（审批卡的批准/拒绝动作回调在 handlers_writable.go）
	svc = svc.WithWritableSink(writableAdapter{})
	svc = svc.WithWritableResizer(writableAdapter{})
	svc = svc.WithWritableRiskCheck(pasteRiskCheck)
	svc = svc.WithWritableEvents(func(ev share.WritableTypingEvent) {
		opschannel.BroadcastEvent(opschannel.EventShareWritableTyping, ev)
	})
	svc = svc.WithPasteReviewEvents(func(ev share.PasteReviewEvent) {
		opschannel.BroadcastEvent(opschannel.EventSharePasteReview, ev)
	})
	svc = svc.WithWritableResizeEvents(func(ev share.WritableResizeEvent) {
		opschannel.BroadcastEvent(opschannel.EventShareWritableResize, ev)
	})
	// 访客粘贴上传落盘（P-20261122-1）：回调体只做 opschannel 非阻塞投递
	//（审计/敏感名 note 的攒批在 server/share 侧既有缓冲）
	svc = svc.WithPasteUploadEvents(func(ev share.PasteUploadEvent) {
		opschannel.BroadcastEvent(opschannel.EventSharePasteUpload, ev)
	})
	// 管理面协作端点（handlers_collab.go）经包级引用触达持权状态机
	//（liveWire 同款装配契约：Stop 必须摘除，防停机后旧服务被管理端点命中）
	setShareSvc(svc)
	// 终端只读直播馈线（P-20261003-306）：hub 挂 terminal.AddOnChange 对账
	//（会话关闭 → 馈线终结），注入访客面 + 管理面接线口（创建接通/撤销轮换
	// 断流）。Store 未就绪的早退路径不构造 hub——nil 安全
	m.live = liveterm.NewHub()
	svc = svc.WithTerminalLive(liveAdapter{m.live})
	setLiveWire(m.live)
	flushFn := func() int {
		n := svc.FlushHits(func(token string, n int64, at time.Time) error {
			return st.Share.RecordHits(token, n, at)
		})
		// 退役命中计数同批冲刷（P-20261008-2）：宿主锚定在 store 侧
		//（RecordRetiredHit 经反向索引定位宿主并更新台账条目），失败丢弃
		// 不回灌——与访问计数同一「尽力而为旁路指标」取舍
		retiredN := svc.FlushRetiredHits(func(retiredToken string, n int64, at time.Time) error {
			_, err := st.Share.RecordRetiredHit(retiredToken, n, at)
			return err
		})
		n += retiredN
		// 访问留痕同批冲刷（P-20261003-257）：事件在访客面已成型（token/IP/
		// UA 简要，见 share.recordView），这里只递审计台账——Append 自带
		// 尽力而为 + 写失败可见性计数，无额外失败语义。冲刷在调度器 tick
		// （无请求上下文）执行，走裸 Append 口——访客面是独立 http 服务不经
		// gin RequestID 中间件，事件无 rid 可注（双口口径见
		// middleware.AuditAppend 注释，P-20261006-53）
		audits := svc.FlushViewAudits(func(e store.AuditEvent) {
			st.Audit.Append(e)
		})
		// 新留言通知同批入账（P-20261006-13）：通知在访客面已成型（模板键
		// + 参数，见 share.guestNote），Add 落库即经事件总线广播
		// notification.new——主人侧通知中心与 agent 巡检同源可见
		notes := svc.FlushGuestNotes(func(n notification.Notification) {
			st.Notification.Add(n)
		})
		return n + audits + notes
	}
	m.flushPending = flushFn
	if sch := k.Scheduler(); sch != nil {
		// ticker 闭包捕获局部 flushFn（而非读 m.flushPending 字段）：kernel
		// 停机序是模块 Stop 先于 scheduler.Stop，Stop 置 nil 字段后迟到的
		// 一次 tick 会 nil 函数调用 panic——闭包里的函数值永远有效
		sch.AddTicker("share-flush", shareFlushInterval, func(context.Context) {
			flushFn()
		})
		// 会话输入闸自愈对账（P-20261122-17）：来源反向索引 + 记录存活/
		// 开放连接在场核对，残账就地释放（撤销/轮换/过期主路径已即时收口，
		// 本 ticker 兜崩溃窗口与半开连接；DirectState 不重复触达）
		sch.AddTicker("share-gate-reconcile", shareGateReconcileInterval, func(context.Context) {
			svc.ReconcileGates()
		})
	}

	// 快照陈旧状态中枢（P-20261114-3-S2，双档判定）：加速器=订阅内核总线
	// file.changed + 分享根前缀过滤（秒级置位）；主档=管理面列表惰性对比
	//（判定原语在 server/share，此处只调度节流）。降级轮询的广播（path=项目
	// 根、无 op）在回调内双守卫跳过，降级窗口靠主档兜底。事件总线未装配
	//（测试 fake 返回 nil）时只降加速器，主档与投影不受影响
	hub := newStaleHub(st)
	setStaleHub(hub)
	if k.Events() != nil {
		m.unsubStale = k.Events().Subscribe("file.changed", func(env kernel.Envelope) {
			hub.onFileChanged(projectEvent{Payload: env.Payload})
		})
	}

	port := m.cfg.Server.SharePortOrDefault(m.cfg.Server.Port)
	addr := fmt.Sprintf("%s:%d", m.cfg.Server.Host, port)
	srv := &http.Server{
		Addr:              addr,
		Handler:           svc.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		// WriteTimeout 刻意为 0：大目录 zip 打包走慢客户端时不受全局写超时截断
	}
	// 同源入口（P-20261020-2）：先收回可能残留的旧 Handler（重启窗口），
	// 监听成功后再发布——同源 /s/* 的可用性与子服务就绪态保持一致
	share.ClearSameOriginHandler()

	ln, err := net.Listen("tcp", addr)
	if err != nil {
		attrs := []any{"addr", addr, "err", err}
		if hint := bindhint.For(err, port); hint != "" {
			attrs = append(attrs, "hint", hint)
		} else {
			attrs = append(attrs, "hint", "adjust sharePort in config.json")
		}
		k.Logger().Error("share service failed to start — file sharing unavailable", attrs...)
		m.publish(false, 0)
		return nil
	}
	m.srv = srv
	// 主应用同源代理复用同一个访客面 Handler：口令门/响应头/no-store/SSE
	// 全部保持子服务语义，反代与内置隧道只转发主端口即可分享
	share.SetSameOriginHandler(srv.Handler)

	go func() {
		var serveErr error
		if m.tlsOn {
			serveErr = srv.ServeTLS(ln, m.certFile, m.keyFile)
		} else {
			serveErr = srv.Serve(ln)
		}
		if serveErr != nil && serveErr != http.ErrServerClosed {
			k.Logger().Error("share service error", "err", serveErr)
			m.publish(false, 0)
		}
	}()

	m.publish(true, port)
	slog.Info("share service listening", "addr", addr, "tls", m.tlsOn,
		"hint", "share short links point at this port")
	return nil
}

// Stop 优雅关闭子服务（关停后兜底冲一次访问计数——Shutdown 等在途访客
// 请求收尾，此时冲刷拿到的才是完整增量）。终端直播馈线一并收尾：
// Shutdown 已等在途 SSE 请求退出，之后摘对账回调、终结全部馈线。
// 可写上行 WS 连接是 hijacked 长连接（Shutdown 不等待），显式全量清场：
// 空keep 集即「存活的集合为空」——全部上行断开（会话闸随各连接 defer 解除）
func (m *Module) Stop(_ context.Context, _ kernel.Kernel) error {
	// 同源入口先收回：主应用后续的 /s/* 请求走 503，不落到正在关闭的
	// Handler（Stop 末尾会兜底冲一次访问计数，期间无新访客请求更干净）
	share.ClearSameOriginHandler()
	// 陈旧加速器先摘订阅再卸中枢（liveWire 同款装配契约）：停机后总线事件
	// 不得触达旧 hub，管理端点投影随之静默缺省
	if m.unsubStale != nil {
		m.unsubStale()
		m.unsubStale = nil
	}
	setStaleHub(nil)
	// 管理面协作端点同步摘除（setShareSvc 装配契约）：停机后 GetShareDirect
	// 等端点不再触达旧服务实例
	if svc := shareSvc; svc != nil {
		svc.CascadeWritableDown(map[string]bool{})
	}
	setShareSvc(nil)
	if m.srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = m.srv.Shutdown(ctx)
		m.srv = nil
	}
	if m.flushPending != nil {
		m.flushPending()
		m.flushPending = nil
	}
	if m.live != nil {
		m.live.Stop()
		m.live = nil
		setLiveWire(nil)
	}
	m.publish(false, 0)
	return nil
}

func (m *Module) schemeFor() string {
	if m.tlsOn {
		return "https"
	}
	return "http"
}

func (m *Module) publish(running bool, port int) {
	setStatus(running, port, m.schemeFor())
	config.SetSharePort(port)
}

// ── store 适配（server/share 面向接口，不反向依赖管理面） ──

// liveAdapter liveterm.Hub → share.TerminalLive 桥：两包各自持有镜像接口
// （share.LiveSubscription / liveterm.Subscription 方法集相同），Go 接口
// 返回类型不变量决定了需要装配层显式桥接——concrete 返回值同时满足两侧
type liveAdapter struct{ h *liveterm.Hub }

func (a liveAdapter) Subscribe(token, sessionID string, unfiltered bool) (share.LiveSubscription, error) {
	s, err := a.h.Subscribe(token, sessionID, unfiltered)
	if err != nil {
		return nil, err
	}
	return s, nil
}

func (a liveAdapter) Unwire(token string) { a.h.Unwire(token) }

// shareLookup store.ShareStore 的访客面子集适配（查询 + 惰性清理过期记录
// + 退役短链反查 P-20261008-2）
type shareLookup struct{ st *store.Store }

func (a shareLookup) Get(token string) (*store.Share, error) {
	return a.st.Share.Get(token)
}

func (a shareLookup) Delete(token string) error {
	return a.st.Share.Delete(token)
}

// FindRetired 退役短链反查宿主（P-20261008-2）：访客面 retiredLookup
// optional 断言取用本法——适配器必须转发到 store，否则退役命中在装配层
// 静默丢失：死链被踩不再有观测（计数/审计/告警全链断），外泄探测面失效。
// MarkFirstView 同款「适配器即装配契约锚点」纪律
func (a shareLookup) FindRetired(retiredToken string) (*store.Share, bool) {
	return a.st.Share.FindRetired(retiredToken)
}

// MarkFirstView 一次性分享显式确认武装（P-20261006-27；P-20261020-3 起
// 唯一触发点是访客 POST /s/{token}/view）。访客面 Service 经 optional
// interface 断言取用本法（见 share.armViewOnce）——适配器必须转发到 store，
// 否则武装在装配层静默丢失：确认后 ViewedAt 仍为零，访客会陷入「确认→
// 仍是确认页」的循环，一次性语义整体失效。methods 集合即装配契约的锚点
// （server/api/share/handlers_viewonce_test.go 有转发用例）
func (a shareLookup) MarkFirstView(token string, at time.Time) error {
	return a.st.Share.MarkFirstView(token, at)
}

type rootResolver struct{ st *store.Store }

func (a rootResolver) RootOf(projectID string) (string, error) {
	p, err := a.st.Project.GetByID(projectID)
	if err != nil {
		return "", err
	}
	if p.Path == "" {
		return "", fmt.Errorf("project %s has no local path", projectID)
	}
	return p.Path, nil
}

// snapshotDirName 记录形态 → 快照目录名（零代际派生 token，稳定键——rotate
// 换链重算同值）；无快照锚点的记录（live/snippet/直播/锚字段缺失）返回空串。
// 访客面解析（DirOf）与管理面占用投影（ListShares 的 frozenBytes，P-20261005-176）
// 共用——目录名重算的单一事实源
func snapshotDirName(sh *store.Share) string {
	if sh.Kind == store.ShareKindSession {
		// 会话回放只读分享（P-20261003-77）：锚 = 会话 ID（不绑项目；快照与
		// 源会话生命周期解耦，会话删除后链接仍可访问）
		if sh.SessionID == "" {
			return ""
		}
		return store.SessionNativeToken(config.MasterKey(), sh.SessionID)
	}
	if sh.Kind == store.ShareKindCast {
		// 会话回放 cast 快照（P-20261004-103）：锚 = 录制 ID（不绑项目；
		// 快照与源会话/录制生命周期解耦，录制删除后链接仍可访问）
		if sh.RecordingID == "" {
			return ""
		}
		return store.CastNativeToken(config.MasterKey(), sh.RecordingID)
	}
	if sh.Kind == store.ShareKindTermFrozen {
		// 终端输出冻结快照（P-20261005-205）：锚 = 会话 ID + 内容哈希
		//（不绑项目；快照与源会话生命周期解耦，会话关闭后链接仍可访问）
		if sh.TerminalID == "" || sh.ContentHash == "" {
			return ""
		}
		return store.TermFrozenNativeToken(config.MasterKey(), sh.TerminalID, sh.ContentHash)
	}
	if !sh.Frozen || sh.ProjectID == "" {
		return ""
	}
	if len(sh.Paths) > 0 {
		// 多路径冻结分享（P-20261008-1）：目录名 = 集合键零代际派生；与单路径
		// frozen 同命名空间族但不同保留前缀（frozen-batch），互不撞名
		return store.FrozenBatchNativeToken(config.MasterKey(), sh.ProjectID, sh.Paths)
	}
	return store.FrozenNativeToken(config.MasterKey(), sh.ProjectID, sh.Path)
}

// snapshotResolver 冻结快照目录解析（share.SnapshotDirs 适配）：按记录形态
// 从记录字段重算零代际派生 token 拼出快照目录——轮换过的记录同样命中同一
// 目录（稳定键，见 store.FrozenNativeToken / store.TermFrozenNativeToken）；
// 副本不在盘返回错误（访客面 target_gone）
type snapshotResolver struct{}

func (snapshotResolver) DirOf(sh *store.Share) (string, error) {
	name := snapshotDirName(sh)
	if name == "" {
		if sh.Kind == store.ShareKindTermFrozen {
			return "", fmt.Errorf("term-frozen share %s has no content anchor", share.TokenSummary(sh.Token))
		}
		if sh.Kind == store.ShareKindCast {
			return "", fmt.Errorf("cast share %s has no recording anchor", share.TokenSummary(sh.Token))
		}
		if sh.Kind == store.ShareKindSession {
			return "", fmt.Errorf("session share %s has no session anchor", share.TokenSummary(sh.Token))
		}
		return "", fmt.Errorf("frozen share %s has no project anchor", sh.Token)
	}
	dir := filepath.Join(share.SnapshotsRoot(), name)
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return "", fmt.Errorf("frozen snapshot missing for token %s", share.TokenSummary(sh.Token))
	}
	return dir, nil
}

// directAdapter 退役（P-20261121-1 统一收编）：直通档的 DirectWrite（4KB/
// sanitize POST 批次）/agent 限定判定/SetDirectGate 三面随键入通道统一走
// WS 上行桥与 gateLedger 账本一并退役——会话输入闸的唯一落点收敛为
// writableAdapter.SetWritableGate（share.Service 账本单点调用）。

// writableAdapter 访客输入的落点适配（P-20261106-8 可写分享，P-20261121-1
// 统一双授权模式后为唯一键入落点）：share.WritableSink 的
// terminal.DefaultManager 桥（装配桥先例）。开放直入与申请批准（持权）两
// 模式的键入统一走本落点直写会话 PTY——**不做会话形态限定**（可写档对
// 普通终端开放正是 P-20261106-8 对 P-20261024-1 红线的显式推翻，P-20261121-1
// 统一收编后申请批准路径同享；五重补偿控制见 server/share/writable.go
// 头注，审批分层沿 commandrisk 诚实边界）
type writableAdapter struct{}

// WritableWrite 把一批访客键入写入锚定会话（字节原样——控制字符是合法
// 终端输入；owner 侧输入闸不拦本路径：访客上行在场时 owner 的 WS 写已被
// directInputHold 拒，闸拦的方向是 owner 键盘不是访客桥）
func (writableAdapter) WritableWrite(sessionID, text string) error {
	sess := terminal.DefaultManager.GetSession(sessionID)
	if sess == nil {
		return fmt.Errorf("terminal session not found: %s", sessionID)
	}
	return sess.WriteInput([]byte(text))
}

// SetWritableGate 会话侧输入互斥闸（gateLedger 合并账本的单点落闸——
// share.Service 经本方法落 terminal.Session.directInputHold 同一服务端强制
// 面：开放直入「连接在场」与申请批准「持权在场」两来源统一记账后翻转置位/
// 解除；会话已关幂等直通）
func (writableAdapter) SetWritableGate(sessionID string, held bool) {
	if sessionID == "" {
		return
	}
	if sess := terminal.DefaultManager.GetSession(sessionID); sess != nil {
		sess.SetDirectInputHold(held)
	}
}

// WritableResizeDenyReason 视口 resize 的会话准入（share.WritableResizer 面，
// P-20261120-8 定案 + P-20261122-16 ④ 升级为可观测原因）：空 = 允许。
//   - external_session：TmuxExternal 外部接管会话禁用（评审必改4——真机 tmux
//     客户端的 window-size 交互未定义，访客改格会与用户本机 tmux 客户端互相
//     踩踏）；
//   - owner_active：主人本机有交互 WS 客户端附着（AttachedClients>0，share 的
//     /termws 与 SSE 不计数）——owner 的 xterm 只在首连时按视口 resize 一次，
//     从不消费访客反喂的 PTY 尺寸变化，附着期间改格 = 主人视图按旧 cols 渲染
//     整屏错位（「在系统里打开同一会话即恢复正常」正是打开时首连 resize 把
//     PTY 改回）。附着期间画布以主机为准，主人在场优先于访客视口；
//   - session_missing：会话不在（落点 Resize 也会报错，原因面在准入口如实区分）
//
// 本判定在 fire 路径**应用前复核**（合并窗 500ms 内 owner 可能刚附着），
// 不能只在收帧时查一次
func (writableAdapter) WritableResizeDenyReason(sessionID string) string {
	if sessionID == "" {
		return "session_missing"
	}
	sess := terminal.DefaultManager.GetSession(sessionID)
	if sess == nil {
		return "session_missing"
	}
	if sess.Origin == terminal.OriginExternal {
		return "external_session"
	}
	if sess.AttachedClients() > 0 {
		return "owner_active"
	}
	return ""
}

// WritableResize 把访客视口尺寸应用到锚定会话 PTY（share.WritableResizer 面）：
// 复用主人侧 PUT resize 同一 Session.Resize 链（同尺寸去重防 PSReadLine banner
// 重发；tmux/POSIX/ConPTY 三平台承接零新分支）。不判 directInputHold——闸拦的
// 是键入方向，画布尺寸随可写让渡
func (writableAdapter) WritableResize(sessionID string, cols, rows uint16) error {
	sess := terminal.DefaultManager.GetSession(sessionID)
	if sess == nil {
		return fmt.Errorf("terminal session not found: %s", sessionID)
	}
	return sess.Resize(rows, cols)
}

// pasteRiskCheck 粘贴级风险预检（装配层桥 commandrisk 模式表——share 包
// 不 import terminal 的分层下，判定在装配层收口）：仅 danger 档触发 owner
// 审批（warning/未命中直接注入，owner 输出侧实时可见兜底）；Summary 沿
// RiskSummary 一行形态作审批卡证据
func pasteRiskCheck(text string) share.WritableRisk {
	matches := terminal.MatchCommandRisk(text)
	danger := false
	for _, m := range matches {
		if m.Level == terminal.RiskDanger {
			danger = true
			break
		}
	}
	return share.WritableRisk{Danger: danger, Summary: terminal.RiskSummary(matches)}
}
