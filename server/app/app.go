// Package app 服务组合根：main 的 --serve 装配流程集中于此。
// main 只保留 CLI 子命令、守护进程管理与 go:embed 资产，
// 通过 Options 注入版本信息、前端资产与信号通道——新增模块的装配点
// 全部收敛在本包（见 docs/design/module-split-plugin-foundation.md §5.3）。
package app

import (
	"context"
	"fmt"
	"io/fs"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"codecombo/server/agentops"
	"codecombo/server/api"
	ai "codecombo/server/api/ai"
	"codecombo/server/api/opschannel"
	"codecombo/server/api/project"
	"codecombo/server/api/system"
	"codecombo/server/api/watchapi"
	"codecombo/server/api/whatsnew"
	"codecombo/server/bindhint"
	"codecombo/server/config"
	"codecombo/server/filestore"
	"codecombo/server/git"
	"codecombo/server/git/auth"
	"codecombo/server/kernel"
	"codecombo/server/mask"
	"codecombo/server/middleware"
	"codecombo/server/notification"
	"codecombo/server/peercert"
	"codecombo/server/servicectx"
	"codecombo/server/share"
	"codecombo/server/store"
	"codecombo/server/tlsutil"
	"codecombo/server/update"
	pprof "net/http/pprof"

	"github.com/gin-gonic/gin"
)

// PWA manifest 的 MIME 注册（P-20261004-134）：Go 内建 mime 表不认 .webmanifest，
// http.ServeContent 会嗅探成 text/plain——按 W3C manifest 处理规则非 JSON 类型
// 可能被拒装（Safari/Firefox 偏严）。嵌入资产经 http.FileServer 伺服时按扩展名
// 查此全局表，进程级注册一次即全部静态路径生效。
func init() {
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
}

// Options 服务运行参数（由 main 注入）
type Options struct {
	Version   string
	Commit    string
	BuildTime string
	// WebFS 嵌入的前端资产（main 经 go:embed 传入，fs.Sub 到 web/dist）
	WebFS fs.FS
	// WhatsNewMD 嵌入的版本更新内容文档（main 经 go:embed docs/whatsnew.md 传入，
	// P-20261007-17；与 WebFS 同模式——内容随构建冻结，离线自含）
	WhatsNewMD string
	// SignalCh 进程信号通道（平台细节留在 main 的 proc_*.go）
	SignalCh <-chan os.Signal
	// Port / Host CLI 覆盖值（0/"" 表示用配置默认）
	Port int
	Host string
	// TLS CLI 覆盖：--tls-cert/--tls-key 成对非空即按指定证书启用；
	// TLSAuto 对应 --tls；NoTLS 对应 --no-tls（显式关闭，优先级最高）
	TLSCert string
	TLSKey  string
	TLSAuto bool
	NoTLS   bool
	// LoopbackPort TLS 启用时的明文回环辅助端口覆盖（0 = 默认主端口+1）
	LoopbackPort int
}

// Run 装配并运行服务（阻塞至服务退出）。
// 组合根职责收敛为：日志 → 内核 → 存储 → 路由/静态资源 →
// 声明式模块注册（modules.go）→ StartAll → HTTP 服务（roadmap M2.3）。
// 各业务模块的装配细节全部在各自包的 Module.Init/Start 内完成
func Run(opts Options) {
	cfg := config.Load()
	// CLI 覆盖：与 main.applyCLIOverrides 同语义（cmdStart 探测与守护参数用它，运行侧在此生效）
	if opts.Port > 0 {
		cfg.Server.Port = opts.Port
	}
	if opts.Host != "" {
		cfg.Server.Host = opts.Host
	}

	// ===== TLS 解析（优先级：--no-tls > 显式证书/--tls > CC_TLS env（SC_TLS
	// 旧名兼容双读一个版本期）> 配置；配置未显式关闭即默认启用）=====
	// 启用后对外经 HTTPS/WSS 服务；自签证书落 DataDir/certs 重启复用。
	// TLS env 在此（运行侧）生效：--serve 直启不经 main.applyCLIOverrides
	useTLS := func() bool {
		if opts.NoTLS {
			return false
		}
		if opts.TLSAuto || (opts.TLSCert != "" && opts.TLSKey != "") {
			return true
		}
		tlsEnv := os.Getenv("CC_TLS")
		if tlsEnv == "" {
			tlsEnv = os.Getenv("SC_TLS")
		}
		switch strings.ToLower(tlsEnv) {
		case "1", "true":
			return true
		case "0", "false":
			return false
		}
		return cfg.Server.TLSEnabledOrDefault()
	}()
	if opts.TLSCert != "" && opts.TLSKey != "" {
		cfg.Server.TLSCertFile = opts.TLSCert
		cfg.Server.TLSKeyFile = opts.TLSKey
	}
	if opts.TLSCert != "" && opts.TLSKey != "" {
		cfg.Server.TLSCertFile = opts.TLSCert
		cfg.Server.TLSKeyFile = opts.TLSKey
	}
	certFile, keyFile := cfg.Server.TLSCertFile, cfg.Server.TLSKeyFile
	if useTLS && (certFile == "" || keyFile == "") {
		var certErr error
		certFile, keyFile, certErr = tlsutil.EnsureCert(filepath.Join(config.DataDir(), "certs"))
		if certErr != nil {
			// 证书失败降级 HTTP 继续服务（功能可用性优先），错误显著留痕
			slog.Error("TLS enabled but certificate setup failed — falling back to plain HTTP", "err", certErr)
			useTLS = false
		}
	}

	// 确保目录存在
	_ = os.MkdirAll(config.DataDir(), 0755)
	_ = os.MkdirAll(filepath.Join(config.DataDir(), "logs"), 0755)
	_ = os.MkdirAll(filepath.Join(config.DataDir(), "data"), 0755)
	// 旧名 pid 文件残留清理（P-20261025-1）：pid 文件改写新名，迁移随目录整体
	// 搬来的旧名文件留着会误导旧版 CLI 的兜底扫描
	config.RemoveLegacyPidFile()

	// 数据目录可写性探针：不可写时锁定/凭据/项目数据全部落盘失败，且后续
	// 错误散落在各请求里难定位。这里一次性打显著日志给出可行动排查方向
	// （systemd 服务属主不匹配 / ProtectHome 沙箱 / SELinux）
	if err := probeDirWritable(config.DataDir()); err != nil {
		attrs := []any{
			"dir", config.DataDir(),
			"err", err,
			"hint", "check the service user owns this directory (chown -R), systemd sandbox (ProtectHome/ReadWritePaths), and SELinux denials (ausearch -m avc)",
		}
		seEnabled, seEnforcing := selinuxStatus()
		switch {
		case seEnabled && seEnforcing:
			// 用户实测的高频坑：受限服务上下文写 /home 被拒。
			// 给出验证命令与两个根治方向，服务继续运行（不做早退，避免重启循环）
			attrs = append(attrs, "selinux", "enforcing")
			slog.Warn("DATA DIR NOT WRITABLE — SELinux is enforcing and likely blocking this service"+
				"(verify: setenforce 0 then restart; fix: relocate data dir to /var/lib/codecombo, or audit2allow a policy)", attrs...)
		default:
			if seEnabled {
				attrs = append(attrs, "selinux", "permissive")
			}
			slog.Error("DATA DIR NOT WRITABLE — password setup, credentials and projects will fail to save", attrs...)
		}
	}

	// 日志先行：内核与后续模块装配日志统一落按天滚动文件。
	// P-20261025-1 起新前缀 codecombo；旧前缀文件（迁移随目录整体搬来）由
	// CleanOldLogs 双前缀清理与 servicelogs 双前缀读取兜底，一个保留期后自然消失
	h := &dailyHandler{
		logDir: filepath.Join(config.DataDir(), "logs"),
		prefix: "codecombo",
		maxAge: 15,
		level:  slog.LevelInfo,
	}
	defer h.Close()
	h.CleanOldLogs()
	slog.SetDefault(slog.New(h))

	// 转发 gin 请求日志到 slog
	gin.DefaultWriter = &slogWriter{level: slog.LevelInfo}
	gin.DefaultErrorWriter = &slogWriter{level: slog.LevelError}

	// 清理上次运行残留的 SSH key tmp 文件
	// defer Cleanup 不保证执行（os.Exit / SIGKILL / panic），需启动期主动扫描
	if err := auth.CleanupStaleSSHKeyCache(config.DataDir()); err != nil {
		slog.Warn("cleanup stale ssh key cache failed", "err", err)
	}

	// ===== 内核装配（见 docs/design/module-split-plugin-foundation.md §5.2）=====
	// 内核先行于存储：store 的通知出站口需要事件总线
	appKernel := kernel.New(slog.Default())
	api.SetKernel(appKernel)
	api.WireBusBridge(appKernel) // 既有 topic → 项目 WS 通道（旧前端兼容面）
	// 跨项目实时变更流（P-20261003-232）：file.changed 全局广播的只读内存
	// 快照环形缓冲（GET /api/watch/activity 轮询面；与 WS 桥互不相干）
	watchapi.WireActivityRecorder(appKernel)

	// 初始化存储层（DocumentStore + Repository）。
	// 通知出站：Add 落库后发布到事件总线（notify 模块订阅桥回 /ws/notifications）
	doc := filestore.New(config.DataDir())
	bus := appKernel.Events()
	store.SetDefault(store.New(doc, func(n notification.Notification) {
		bus.Publish(kernel.Envelope{Topic: notification.TopicNew, Payload: n})
	}))

	// ===== 启动期数据治理（持久化纪律，见 docs/PERSISTENCE_LANES.md）=====
	// 迁移类写盘副作用一律在启动期完成，读路径保持只读（车道 1 禁令）
	peercert.MigrateLegacy()
	if n, err := store.Get().SshKey.MigrateLegacyPem(); err != nil {
		slog.Warn("sshkey legacy pem migration failed", "err", err)
	} else if n > 0 {
		slog.Info("sshkey legacy pem migrated", "count", n)
	}
	// webhook 外发 URL 存量明文补加密（P-20261002-31，同 sshkey pem 迁移模式）
	if n, err := store.Get().Notification.MigrateLegacyWebhookURL(); err != nil {
		slog.Warn("webhook url migration failed", "err", err)
	} else if n > 0 {
		slog.Info("webhook url migrated to encrypted storage", "count", n)
	}
	// deployconfig 旧四槽位模型字段收敛为单一 model 的补迁移（升级兼容审计
	// P-20261005-197：字段合并提交未带迁移，旧数据面升级会静默丢自定义模型）
	if n, err := store.Get().DeployConfig.MigrateLegacyModelFields(); err != nil {
		slog.Warn("deployconfig legacy model fields migration failed", "err", err)
	} else if n > 0 {
		slog.Info("deployconfig legacy model fields migrated", "count", n)
	}
	// 笔记单库化启动迁移（P-20261108-3，前置 P-20261107-2 单篇 → 多篇迁移同链）：
	// 旧项目笔记（projnotes 单篇旧键 + notes-multi 项目作用域篇）并入全局笔记库，
	// 标题带「[项目名] 」前缀——幂等（确定性目标 id，重跑/残留只删源），读路径
	// 零副作用红线下的启动期写盘例外。全局库满额即中止（零丢弃）：滞留告警进
	// 通知中心一条（动作直达笔记视图，面板横幅可续迁）
	if res := project.MigrateNotesOnStartup(); res.Full && res.Pending > 0 {
		store.Get().Notification.Add(notesMigrationPendingNotification(res))
	}
	// config.json 损坏显式降级告知（P-20261006-10）：Load 期已保全坏文件并登记
	// 降级态，store 就绪后在此入账通知中心（构造与时机依据见 config_corrupt.go）。
	// 保全失败（只读盘）同样告知——文案如实区分两种处置面，降级链不引入新 Fatal
	if rep := config.CorruptionReport(); rep != nil {
		store.Get().Notification.Add(configCorruptNotification(rep))
	}
	cleanupOrphanKinds("aiproviders", "opschat_sessions")

	// 自定义智能体运行时：随启动从生效设置同步进 Provider 注册表（此后经
	// 设置 API 增删改时由 saveAndSyncSettings 即时同步）。注册后选型/白名单/
	// Runtimes 清单与内置运行时走同一条链路
	if cfg := store.Get().Settings.Get(); cfg != nil {
		agentops.SyncCustomAgents(cfg.Server.CustomAgents)
		// 自定义敏感模式（P-20261006-11）：随启动注入进程内编译注册表（此后
		// 经 UpdateSettings 落盘成功后即时同步）——Go 侧命令历史跳过/审计
		// 脱敏/快照遮蔽三消费面从首请求起吃同一列表
		mask.SetCustomPatterns(cfg.Server.CustomSensitivePatterns)
	}

	// 运行日志留存期可配（P-20261003-123）：settings 就绪后注入动态读取口——
	// 启动首轮清理发生在 settings 装配前（日志先行），已用默认值兜底清过一轮；
	// 注入后立即按当前配置再清一轮，调小留存的开箱即清（不等次日）。巡更与
	// 审计裁剪（system 模块 auditlog-cleanup）同频每日，调整留存次日生效
	// 无需重启。闭包内即时读 settings（settingsRepo 返回同一活动指针，
	// UpdateSettings 的修改即时可见）
	h.maxAgeFn = func() int {
		if sc := store.Get().Settings.Get(); sc != nil {
			return sc.Server.LogRetentionDaysOrDefault()
		}
		return config.DefaultLogRetentionDays
	}
	h.CleanOldLogs()
	appKernel.Scheduler().AddTicker("log-cleanup", 24*time.Hour, func(context.Context) {
		h.CleanOldLogs()
	})

	// 回环辅助端口：CLI 覆盖 > config.loopbackPort > 默认主端口+1
	loopbackOverride := opts.LoopbackPort
	if loopbackOverride == 0 {
		loopbackOverride = cfg.Server.LoopbackPort
	}

	// 对外协议上報：嵌入类子系统（dsh 反代）据此对齐自身 scheme，保证 iframe
	// 与顶层页面同 scheme（schemeful 同站），dsh 的 SameSite=Strict 会话
	// cookie 才能在 iframe 内携带
	config.SetTLSEnabled(useTLS)

	writePIDFileScheme(cfg.Server.Port, loopbackPortFor(useTLS, cfg.Server.Port, loopbackOverride), schemeFor(useTLS))

	// Agent Guard 审批通知回调（B4 阶段 2）：middleware 不直接依赖 api 层
	//（import 环），经组合根把审批创建事件桥到 ops-channel 广播；
	// P-20261002-31 起同一事件旁路发布到内核总线（webhook 外发转发器订阅，
	// 站内审批卡片之外同步推送手机），opsconfirm 的 Agent 发起路径经同一桥
	middleware.ApprovalNotifier = func(a store.AgentApproval) {
		opschannel.BroadcastEvent(opschannel.EventApprovalPending, a)
		bus.Publish(kernel.Envelope{Topic: notification.TopicApprovalPending, Payload: a})
	}
	// 合并审批主卡更新桥（P-20261006-26）：同会话同型请求入主卡挂起队列后，
	// 携最新 Merged 清单的主卡同 id 重播 approval.pending（前端按 id 幂等
	// upsert，卡面「+N 同型待批」徽标实时跟随）。刻意不旁路总线——webhook
	// 外发只在首卡推一次，N 条入队不放大手机推送
	middleware.ApprovalUpdatedNotifier = func(a store.AgentApproval) {
		opschannel.BroadcastEvent(opschannel.EventApprovalPending, a)
	}
	// 审批规则 deny 终态桥（P-20261003-35）：deny 无 pending 卡片，直接广播
	// approval.resolved——任务事件落库/多标签页审计与人工裁决同链路
	middleware.ApprovalResolvedNotifier = ai.BroadcastApprovalResolved
	// guarded 审批卡 impact 自动填充（P-20261006-35，计算函数见
	// approval_impact.go）：服务端拦截建的审批按守卫模式单方填充结构化影响面
	// （初批删除项目→级联会话计数），无数据降级 nil 老卡形态
	middleware.ImpactFiller = newApprovalImpactFiller()

	gin.SetMode(gin.ReleaseMode)
	// 访问日志走自定义 formatter（等价 gin.Default 的 Logger，行尾追加
	// rid=<request-id>）：slog 落盘的每条访问日志与响应头 X-Request-Id /
	// 前端 errorLog 一键对齐（P-20261003-216）。formatter 从 param.Keys 读
	// id——gin.Logger 在 c.Next() 返回后才组装参数，RequestID 中间件虽注册
	// 更晚（RegisterRoutes 内），写入的 c.Keys 此刻已就位
	r := gin.New()
	// 可信代理（P-20261020-1）：把 server.trustedProxies 装到 ClientIP 与
	// RequestBaseURL 两处转发头信任面；默认空 = 不信任任何转发头（覆盖 Gin
	// 内置的「信任所有代理」默认，直连形态下伪造 XFF 不再能绕过每 IP 限流）。
	// 启动期一次生效，配置变更需重启。数据面设置（设置 API 写入）优先；
	// 其缺省（nil，即存量配置缺该键）回落 config.json 的同一字段。
	trustedProxies := cfg.Server.TrustedProxies
	if sc := store.Get().Settings.Get(); sc != nil && sc.Server.TrustedProxies != nil {
		trustedProxies = sc.Server.TrustedProxies
	}
	if err := middleware.ApplyTrustedProxies(r, trustedProxies); err != nil {
		slog.Warn("invalid server.trustedProxies — all forwarded headers are ignored",
			"err", err, "entries", trustedProxies)
	}
	r.Use(gin.LoggerWithFormatter(ginLogFormatter))
	r.Use(gin.Recovery())

	// TLS 启用时下发 HSTS：浏览器后续访问强制走 https（ws 已随页面协议为 wss）
	if useTLS {
		r.Use(func(c *gin.Context) {
			c.Header("Strict-Transport-Security", "max-age=31536000")
			c.Next()
		})
	}

	// 长操作路由（push/pull/fetch/clone；远程文件上传/下载/互传）清零读写超时：
	// 大文件传输轻松超过全局 WriteTimeout 60s，上传侧 ReadTimeout 30s 同样不够。
	// 中心分发拉取（apply-from-center）在请求内同步下载整包（客户端窗口 5 分钟），
	// 慢链路超 60s 即被写超时截断——前端报失败而服务端照常换包（P-20261109-10；
	// 自更新 /updates/apply 已异步化受理即返回，无须豁免）
	r.Use(func(c *gin.Context) {
		path := c.Request.URL.Path
		longWrite := c.Request.Method == "POST" &&
			(strings.Contains(path, "/push") || strings.Contains(path, "/pull") ||
				strings.Contains(path, "/fetch") || strings.Contains(path, "/clone") ||
				strings.HasSuffix(path, "/updates/apply-from-center"))
		longTransfer := strings.Contains(path, "/files/upload") ||
			strings.Contains(path, "/files/download") ||
			strings.Contains(path, "/files/transfer")
		if longWrite || longTransfer {
			rc := http.NewResponseController(c.Writer)
			_ = rc.SetWriteDeadline(time.Time{})
			if longTransfer {
				_ = rc.SetReadDeadline(time.Time{})
			}
		}
		c.Next()
	})

	// whatsnew 内容注入（P-20261007-17）：装配期一次、先于 HTTP 受理，此后只读
	whatsnew.SetContent(opts.WhatsNewMD)
	// 路由注册收口：快照实际注册路由全集（P-20261003-153）——模块发现清单
	// Manifest.Routes 由组装期按此推导填充，声明面从手工变推导
	// dev 分支按 build version 判定（P-20261007-6）：发布构建注入 semver，
	// 本地/测试构建留 "dev"——后者 CSP Report-Only 额外放行 'unsafe-eval'
	// 供 Vite HMR / Vue devtools，生产不开口子
	routeTable := api.RegisterRoutes(r, opts.Version == "dev")

	if opts.WebFS != nil {
		distFS, err := fs.Sub(opts.WebFS, "web/dist")
		if err != nil {
			slog.Warn("embedded frontend not available", "err", err)
		} else {
			fileServer := http.FileServer(http.FS(distFS))

			r.NoRoute(func(c *gin.Context) {
				path := c.Request.URL.Path

				if strings.HasPrefix(path, "/api/") || strings.HasPrefix(path, "/ws/") {
					c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
					return
				}

				staticPath := strings.TrimPrefix(path, "/")
				if staticPath == "" {
					staticPath = "index.html"
				}
				f, err := distFS.Open(staticPath)
				if err == nil {
					f.Close()
					c.Request.URL.Path = path
					// 缓存策略：/assets/* 文件名带内容哈希（发版即换名）→
					// 一年 immutable，回访零请求；index.html → no-cache
					//（保证新版本入口即时可见）；其余维持浏览器默认
					if strings.HasPrefix(staticPath, "assets/") {
						c.Writer.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
					} else if staticPath == "index.html" {
						c.Writer.Header().Set("Cache-Control", "no-cache")
					}
					// 静态资源 gzip（R4）：嵌入资产最大单文件近 1MB，
					// 压缩后传输量降为约 1/3；API/WS 不经此路径不受影响
					if acceptsGzip(c.Request) && gzipEligible(path) {
						w := &gzipResponseWriter{ResponseWriter: c.Writer}
						defer w.close()
						c.Writer = w
					}
					fileServer.ServeHTTP(c.Writer, c.Request)
					return
				}

				c.Request.URL.Path = "/"
				c.Writer.Header().Set("Cache-Control", "no-cache")
				fileServer.ServeHTTP(c.Writer, c.Request)
			})
		}
	}

	// 声明式模块装配（M2.3）：组合根只剩「注册清单 + StartAll」，
	// 启动/停止顺序由各模块 DependsOn 拓扑排序表达
	registerAll(appKernel, builtinModules(cfg, runtimeInfo{
		Version:   opts.Version,
		Commit:    opts.Commit,
		BuildTime: opts.BuildTime,
		TLSOn:     useTLS,
		CertFile:  certFile,
		KeyFile:   keyFile,
	}, routeTable))
	if err := appKernel.StartAll(context.Background()); err != nil {
		slog.Warn("kernel modules start incomplete", "err", err)
	}
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		appKernel.StopAll(stopCtx)
	}()

	addr := fmt.Sprintf("%s:%d", cfg.Server.Host, cfg.Server.Port)
	scheme := "http"
	if useTLS {
		scheme = "https"
	}
	slog.Info("codecombo starting", "version", opts.Version, "addr", scheme+"://"+addr)
	if h := strings.ToLower(strings.TrimSpace(cfg.Server.Host)); h == "0.0.0.0" || h == "::" || h == "[::]" {
		// 绑定通配 = 运维者有意开放局域网：显著告知，并说明首启设密可经局域网完成
		slog.Info("LAN access enabled (bound to wildcard address) — first-time password setup is allowed from any machine on this network", "addr", scheme+"://"+addr)
	}

	// 使用 http.Server 以支持优雅关闭
	srv := &http.Server{
		Addr:              addr,
		Handler:           r,
		ReadTimeout:       30 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		WriteTimeout:      60 * time.Second,
	}

	// TLS 启用：明文回环辅助监听（仅 127.0.0.1，主端口+1）——Agent 回调与
	// 本机 CLI 的明文通道；自签证书下 curl/fetch 默认拒绝握手，该端口让
	// Agent/CLI 工作流零改动，局域网侧仍全部走 TLS
	closeLoopback := func() {}
	if useTLS {
		closeLoopback = startLoopbackListener(r, cfg.Server.Port, loopbackOverride)
		if fp, ferr := tlsutil.Fingerprint(certFile); ferr == nil {
			slog.Warn("TLS ENABLED — browsers will show a certificate warning on first visit (self-signed)",
				"cert", certFile, "sha256-fingerprint", fp,
				"hint", "verify this fingerprint on clients (TOFU) or replace cert.pem/key.pem with a CA-issued certificate")
		}
	}

	// 明文伴随端口（TLS 启用时默认开启，主端口+3；httpPort 可改道或以 0
	// 显式关闭）：绑定 Host 的局域网可达明文 HTTP 通道——深度检测类设备
	// 拖慢 TLS 的网络里 https 会被拖慢，该口给出开箱即用的 http 访问面。
	// 凭据明文传输，关闭方式为 config 配 "httpPort": 0
	closePlain := func() {}
	if useTLS {
		if plainPort, ok := cfg.Server.HTTPPortOrDefault(cfg.Server.Port); ok {
			closePlain = startPlainListener(r, fmt.Sprintf("%s:%d", cfg.Server.Host, plainPort))
		}
	}
	// pprof 画像端点（C6）：仅绑 127.0.0.1 主端口+2，供 perf 脚本与本地排查
	// 采样 heap/goroutine/profile——与 loopback 助手同一信任级（本机单用户工具，
	// 标准实践；不进主端口/局域网面）
	closePprof := startPprofListener(cfg.Server.Port)

	// 主端口监听器：Host 为回环地址（127.0.0.1/localhost/::1）时双栈同时绑
	// 127.0.0.1 与 [::1]——Windows 下 localhost 优先解析 ::1，仅绑 IPv4 时每个
	// 新连接需等 ::1 超时（实测固定 +200ms）才回退 IPv4，浏览器/dev 代理/e2e
	// 每次新建连接都在付这笔税；双栈仍仅本机可达，不扩大暴露面
	lns, lnErr := listenMain(cfg.Server.Host, cfg.Server.Port)
	closeAll := func() {
		closeLoopback()
		closePlain()
		closePprof()
		for _, ln := range lns {
			_ = ln.Close()
		}
	}
	if lnErr != nil {
		slog.Error("server error", "err", lnErr)
		closeAll()
		removePIDFile()
		slog.Info("codecombo stopped")
		return
	}

	// 信号处理：首次信号走优雅关闭；再次信号（优雅关闭被某模块卡住时）强制退出——
	// 此前二次 Ctrl+C 被 Notify 捕获后无人消费，无法产生默认终止行为，只能外部 SIGKILL
	if opts.SignalCh != nil {
		go func() {
			shuttingDown := false
			for sig := range opts.SignalCh {
				if shuttingDown {
					slog.Warn("second signal during shutdown — forcing exit", "signal", sig)
					os.Exit(1)
				}
				shuttingDown = true
				slog.Info("received signal, shutting down", "signal", sig)
				go func() {
					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					_ = srv.Shutdown(ctx)
					closeAll()
				}()
			}
		}()
	}

	// A8：向本机关机端点（POST /api/shutdown，cmdStop 优雅路径）注册真实关闭动作；
	// 同一动作注册为自更新重启钩子（ApplyUpdate 拉起更新子进程后本进程必须退出，
	// 更新子进程的 waitForProcess(pid) 才能继续——历史缺陷：只拉起不退出，更新必超时回滚）
	shutdownFn := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
		closeAll()
	}
	system.RegisterShutdown(shutdownFn)
	update.SetRestartHook(shutdownFn)

	// 页面重启（P-20261106）：真正需要重启的少数设置（监听器类）与人工兜底。
	// 按运行形态分链——能由监管者拉起的不自 spawn（防孤儿进程与端口竞争）：
	system.RegisterRestart(func() {
		time.Sleep(300 * time.Millisecond) // HTTP 202 响应先写出
		if servicectx.IsService() {
			// Windows 服务：优雅退出 + 非零退出码 = SCM failure-recovery 扳机
			//（install.ps1 已挂 actions=restart/5000，5s 内拉起）
			servicectx.RequestRestart()
			shutdownFn()
			return
		}
		if done, err := update.RestartViaSystemd(); done {
			// systemd：systemctl restart 停旧起新全托管；失败则留痕保持存活
			//（此时退出即失联）
			if err != nil {
				slog.Warn("restart: systemctl restart failed — staying up", "err", err)
			}
			return
		}
		if runtime.GOOS == "darwin" && os.Getppid() == 1 {
			// launchd 托管（KeepAlive=true）：优雅退出即被拉起，不自 spawn
			//（防与 KeepAlive 拉起实例抢端口）
			shutdownFn()
			return
		}
		// 前台/裸进程：先释放监听再以原参数 spawn 自身（新进程即时可绑）
		shutdownFn()
		if err := update.RestartSelfExe(); err != nil {
			slog.Warn("restart: respawn failed — process will exit, manual start required", "err", err)
		}
	})

	var serveErr error
	// 多监听器并发 Serve（回环双栈为 2 个，单监听为 1 个）：任一返回即取首个错误，
	// 其余由 srv.Shutdown/closeAll 统一收敛
	errCh := make(chan error, len(lns))
	for _, ln := range lns {
		if useTLS {
			go func(l net.Listener) { errCh <- srv.ServeTLS(l, certFile, keyFile) }(ln)
		} else {
			go func(l net.Listener) { errCh <- srv.Serve(l) }(ln)
		}
	}
	serveErr = <-errCh
	if serveErr != nil && serveErr != http.ErrServerClosed {
		slog.Error("server error", "err", serveErr)
	}
	closeAll()

	removePIDFile()
	slog.Info("codecombo stopped")
}

// listenMain 创建主端口监听器。Host 为回环地址（127.0.0.1/localhost/::1/空 =
// 默认回环）时双栈同时绑定 127.0.0.1 与 [::1]：Windows 下 localhost 优先解析
// ::1，仅绑 IPv4 时每个新连接需等 ::1 连接超时（实测固定 +200ms）才回退
// 127.0.0.1，浏览器、dev 代理与 e2e 的每次新建连接都在付这笔税。双栈仍仅本机
// 可达，不扩大暴露面；局域网开放（0.0.0.0/::/显式主机名）维持单监听不变
func listenMain(host string, port int) ([]net.Listener, error) {
	h := strings.ToLower(strings.TrimSpace(host))
	if h != "" && h != "127.0.0.1" && h != "localhost" && h != "::1" {
		ln, err := net.Listen("tcp", fmt.Sprintf("%s:%d", host, port))
		if err != nil {
			return nil, err
		}
		return []net.Listener{ln}, nil
	}
	l4, err4 := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	l6, err6 := net.Listen("tcp6", fmt.Sprintf("[::1]:%d", port))
	switch {
	case err4 != nil && err6 != nil:
		return nil, fmt.Errorf("loopback listen failed: ipv4=%v ipv6=%v", err4, err6)
	case err4 != nil:
		slog.Info("ipv4 loopback unavailable — serving on ::1 only", "err", err4)
		return []net.Listener{l6}, nil
	case err6 != nil:
		slog.Info("ipv6 loopback unavailable — serving on 127.0.0.1 only", "err", err6)
		return []net.Listener{l4}, nil
	}
	return []net.Listener{l4, l6}, nil
}

// loopbackPortFor 计算明文回环辅助端口（TLS 未启用返回 0）
func loopbackPortFor(useTLS bool, mainPort, override int) int {
	if !useTLS {
		return 0
	}
	if override > 0 {
		return override
	}
	return mainPort + 1
}

// schemeFor 实际监听协议（PID 文件第四行；CLI status 展示与探测共用）
func schemeFor(useTLS bool) string {
	if useTLS {
		return "https"
	}
	return "http"
}

// startLoopbackListener 启动明文回环辅助监听（仅绑 127.0.0.1）。
// 端口经 PID 文件第三行暴露给本机 CLI；启动失败只降级告警（Agent/CLI
// 回退 https + 跳过校验），不影响主服务
// startPprofListener pprof 画像监听（127.0.0.1:mainPort+2，C6）：
// net/http/pprof 注册到独立 ServeMux；绑定失败仅告警不阻断启动
// （端口被占时不影响业务，只是画像不可用）
func startPprofListener(mainPort int) (closeFn func()) {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	srv := &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", mainPort+2),
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		// 首选端口被占（旧实例/其他软件）：回退随机空闲端口，画像能力保留
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			slog.Warn("pprof listener failed to start (profiling unavailable)", "addr", srv.Addr, "err", err)
			return func() {}
		}
	}
	slog.Info("pprof listening (localhost only)", "addr", "http://"+ln.Addr().String()+"/debug/pprof/")
	go func() { _ = srv.Serve(ln) }()
	var once sync.Once
	return func() {
		once.Do(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_ = srv.Shutdown(ctx)
		})
	}
}

func startLoopbackListener(handler http.Handler, mainPort, override int) (closeFn func()) {
	port := loopbackPortFor(true, mainPort, override)
	srv := &http.Server{
		Addr:              fmt.Sprintf("127.0.0.1:%d", port),
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	ln, err := net.Listen("tcp", srv.Addr)
	if err != nil {
		attrs := []any{"addr", srv.Addr, "err", err}
		if hint := bindhint.For(err, port); hint != "" {
			attrs = append(attrs, "hint", hint)
		}
		config.SetLoopbackPort(0)
		slog.Error("loopback plain-HTTP helper failed to start — agent callbacks and local CLI must use https", attrs...)
		return func() {}
	}
	config.SetLoopbackPort(port)
	slog.Info("loopback plain-HTTP helper listening (agent callbacks + local CLI, localhost only)", "addr", srv.Addr)
	go func() { _ = srv.Serve(ln) }()
	var once sync.Once
	return func() {
		once.Do(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_ = srv.Shutdown(ctx)
		})
	}
}

// startPlainListener 启动明文伴随监听（绑定 cfg.Server.Host，局域网可达；
// 仅 TLS 启用且未显式关闭时由 Run 调用）。用途：深度检测类设备拖慢 TLS
// 的网络环境下提供可用的 http 访问面。超时语义与回环口一致（不设读写
// 超时，大文件传输不受限）；失败降级告警不影响主服务
func startPlainListener(handler http.Handler, addr string) (closeFn func()) {
	srv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		attrs := []any{"addr", addr, "err", err}
		if port := lnPort(addr); port > 0 {
			if hint := bindhint.For(err, port); hint != "" {
				attrs = append(attrs, "hint", hint)
			}
		}
		slog.Error("plain-HTTP companion failed to start — https port remains available", attrs...)
		return func() {}
	}
	slog.Warn("plain-HTTP companion listening (LAN-reachable, no TLS on this port)",
		"addr", addr,
		"hint", "credentials on this port travel unencrypted — prefer https when the network allows")
	go func() { _ = srv.Serve(ln) }()
	var once sync.Once
	return func() {
		once.Do(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_ = srv.Shutdown(ctx)
		})
	}
}

// lnPort 从 "host:port" 监听地址取端口号（解析失败返回 0）
func lnPort(addr string) int {
	_, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return 0
	}
	n := 0
	for _, c := range portStr {
		if c < '0' || c > '9' {
			return 0
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// ==================== PID 文件 ====================
// 格式与 main 的 readPID/readPIDPort 约定一致：
// "pid\nport[\nloopbackPort][\nscheme]"（无尾换行）。
// 第三行 loopbackPort 仅 TLS 启用时存在（>0），本机 CLI 据此走明文回环端口；
// 第四行 scheme 是实际监听协议（http/https）——CLI status 展示用它而非
// 重猜配置（SC_TLS env / CLI 覆盖不落盘，配置文件猜出的 scheme 会骗人）。
// 旧版本 CLI 读到多余行会被 SplitN 截断忽略，向后兼容

func writePIDFileScheme(port, loopbackPort int, scheme string) {
	content := fmt.Sprintf("%d\n%d", os.Getpid(), port)
	if loopbackPort > 0 {
		content += fmt.Sprintf("\n%d", loopbackPort)
	}
	if scheme != "" {
		content += fmt.Sprintf("\n%s", scheme)
	}
	// P-20261025-1 起新名 codecombo.pid；旧名残留启动期清理（RemoveLegacyPidFile，
	// 迁移把旧目录整体搬来时旧 pid 文件随之而来，留着会误导旧版 CLI 兜底扫描）
	_ = os.WriteFile(filepath.Join(config.DataDir(), "codecombo.pid"), []byte(content), 0644)
}

// probeDirWritable 数据目录可写性探针：实际建删一个探针文件（MkdirAll 成功
// 不代表可写——属主错误/只读挂载/沙箱/SELinux 都会让后续写入失败）
func probeDirWritable(dir string) error {
	probe := filepath.Join(dir, ".sc-write-probe")
	if err := os.WriteFile(probe, []byte("ok"), 0644); err != nil {
		return err
	}
	return os.Remove(probe)
}

// selinuxStatus 探测 SELinux 是否启用及是否 enforcing（非 Linux 一律 false, false）。
// /sys/fs/selinux 存在即启用；enforce 文件内容 "1" 为 enforcing
func selinuxStatus() (enabled, enforcing bool) {
	if runtime.GOOS != "linux" {
		return false, false
	}
	if _, err := os.Stat("/sys/fs/selinux"); err != nil {
		return false, false
	}
	b, err := os.ReadFile("/sys/fs/selinux/enforce")
	if err != nil {
		return true, false
	}
	return true, strings.TrimSpace(string(b)) == "1"
}

func removePIDFile() {
	_ = os.Remove(filepath.Join(config.DataDir(), "codecombo.pid"))
}

// cleanupOrphanKinds 删除功能已移除但数据目录残留的孤儿 kind 目录
// （历史：aiproviders / opschat_sessions 随 be5f477 删除，数据未清理——
// 持久化纪律债务 #5）。幂等：目录不存在时静默返回
func cleanupOrphanKinds(kinds ...string) {
	for _, kind := range kinds {
		dir := filepath.Join(config.DataDir(), "data", kind)
		if _, err := os.Stat(dir); err != nil {
			continue
		}
		if err := os.RemoveAll(dir); err != nil {
			slog.Warn("orphan kind cleanup failed", "kind", kind, "err", err)
			continue
		}
		slog.Info("orphan data kind removed", "kind", kind)
	}
}

// ==================== Auto-fetch ====================

// fetchFunc 单项目拉取动作（可注入以便测试并发上限与超时行为）
type fetchFunc func(ctx context.Context, path string, timeout time.Duration) error

// fetchProjectWithTimeout 在独立 goroutine 中执行 fetch，超时后放弃等待。
// 说明：git 执行层暂无 ctx 感知，超时语义是"放弃本轮等待"而非杀死底层
// git 进程——核心目标是保证整轮 auto-fetch 不被慢网络项目串行拖死
func fetchProjectWithTimeout(ctx context.Context, path string, timeout time.Duration) error {
	fctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	type fetchResult struct{ err error }
	done := make(chan fetchResult, 1)
	go func() {
		_, err := git.Fetch(path, "")
		done <- fetchResult{err}
	}()
	select {
	case r := <-done:
		return r.err
	case <-fctx.Done():
		return fctx.Err()
	}
}

// fetchProjectsConcurrent 并发拉取全部项目远端。
// 历史实现为串行 for 循环：项目一多（40+），一轮网络耗时以分钟计，且单个
// 挂起的 fetch 阻塞后面所有项目；现在并发上限 maxConc + 单项目 timeout
func fetchProjectsConcurrent(ctx context.Context, projects []config.ProjectConfig, maxConc int, timeout time.Duration, fetch fetchFunc) {
	var wg sync.WaitGroup
	sem := make(chan struct{}, maxConc)
	for _, p := range projects {
		wg.Add(1)
		go func(p config.ProjectConfig) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if err := fetch(ctx, p.Path, timeout); err != nil {
				slog.Warn("auto-fetch failed", "project", p.Name, "err", err)
			}
		}(p)
	}
	wg.Wait()
}

// autoFetchConcurrency 并发上限（与 remotehost 探测器对齐）
const autoFetchConcurrency = 4

// autoFetchTimeout 单项目拉取超时
const autoFetchTimeout = 30 * time.Second

func startAutoFetch(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			projects, err := store.Get().Project.List()
			if err != nil {
				continue
			}
			// 项目硬锁（P-20261004-3）：locked 项目跳过后台自动拉取——
			// fetch 会刷新 .git 远程跟踪引用，违背归档不可变承诺（与
			// fetch-all 批量入口同滤，静默跳过：锁是用户有意的，非故障）
			locked := make([]config.ProjectConfig, 0, len(projects))
			for _, p := range projects {
				if !p.Locked {
					locked = append(locked, p)
				}
			}
			fetchProjectsConcurrent(ctx, locked, autoFetchConcurrency, autoFetchTimeout, fetchProjectWithTimeout)
		case <-ctx.Done():
			return
		}
	}
}

// ==================== 日志 ====================

// dailyHandler 实现 slog.Handler，输出到 stderr + 按天滚动日志文件
type dailyHandler struct {
	mu      sync.Mutex
	logDir  string
	prefix  string
	curDate string
	curFile *os.File
	maxAge  int
	// maxAgeFn 留存天数动态读取口（P-20261003-123）：settings 就绪后由组合根
	// 注入一次、此后只读（写入发生在任何巡更 goroutine 启动之前，无数据竞争）。
	// 每次清理执行时取最新配置，调整 settings.logRetentionDays 次日巡更生效
	// 无需重启；未注入（启动初期 settings 未就绪的首轮兜底清理）回落 maxAge
	maxAgeFn func() int
	level    slog.Level
}

// legacyLogPrefix 旧版日志文件名前缀（P-20261025-1 标识切换前的存量文件）。
// CleanOldLogs 对新旧两个前缀同规则清理；读取侧兜底见 api/system/servicelogs.go
// 的 legacyLogPrefix（app↔api 单向依赖不可反向 import，双处字面量同名同步）
const legacyLogPrefix = "simple-coding"

// effectiveMaxAge 当前生效留存天数：优先动态读取口（越界脏值已由
// OrDefault 读取侧收敛默认），未注入回落构造默认
func (h *dailyHandler) effectiveMaxAge() int {
	if h.maxAgeFn != nil {
		return h.maxAgeFn()
	}
	return h.maxAge
}

func (h *dailyHandler) Enabled(_ context.Context, l slog.Level) bool { return l >= h.level }

func (h *dailyHandler) Handle(_ context.Context, r slog.Record) error {
	h.mu.Lock()
	defer h.mu.Unlock()

	buf := make([]byte, 0, 256)
	buf = append(buf, r.Time.Format("2006-01-02 15:04:05")...)
	buf = append(buf, " ["...)
	buf = append(buf, r.Level.String()...)
	buf = append(buf, "] "...)
	buf = append(buf, r.Message...)
	r.Attrs(func(a slog.Attr) bool {
		buf = append(buf, ' ')
		buf = append(buf, a.Key...)
		buf = append(buf, '=')
		buf = append(buf, a.Value.String()...)
		return true
	})

	line := string(buf)
	fmt.Fprintln(os.Stderr, line)

	f := h.getFile()
	if f != nil {
		fmt.Fprintln(f, line)
	}

	return nil
}

// WithAttrs 返回自身；当前不支持 slog.With() 预附加属性
func (h *dailyHandler) WithAttrs(attrs []slog.Attr) slog.Handler { return h }
func (h *dailyHandler) WithGroup(name string) slog.Handler       { return h }

func (h *dailyHandler) getFile() *os.File {
	today := time.Now().Format("2006-01-02")
	if h.curDate == today && h.curFile != nil {
		return h.curFile
	}
	if h.curFile != nil {
		h.curFile.Close()
	}
	logPath := filepath.Join(h.logDir, h.prefix+"-"+today+".log")
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to open log file: %v\n", err)
		return nil
	}
	h.curDate = today
	h.curFile = f
	return h.curFile
}

func (h *dailyHandler) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.curFile != nil {
		h.curFile.Close()
		h.curFile = nil
	}
}

func (h *dailyHandler) CleanOldLogs() {
	entries, err := os.ReadDir(h.logDir)
	if err != nil {
		return
	}
	cutoff := time.Now().AddDate(0, 0, -h.effectiveMaxAge())
	// 双前缀清理：新前缀照旧，旧前缀（标识切换前存量）同规则滚出保留期——
	// 否则旧文件永生（读侧已不产新文件，旧前缀只减不增）
	prefixes := []string{h.prefix + "-", legacyLogPrefix + "-"}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		matched := ""
		for _, p := range prefixes {
			if strings.HasPrefix(entry.Name(), p) && strings.HasSuffix(entry.Name(), ".log") {
				matched = p
				break
			}
		}
		if matched == "" {
			continue
		}
		dateStr := strings.TrimSuffix(strings.TrimPrefix(entry.Name(), matched), ".log")
		t, err := time.Parse("2006-01-02", dateStr)
		if err != nil {
			continue
		}
		if t.Before(cutoff) {
			os.Remove(filepath.Join(h.logDir, entry.Name()))
		}
	}
}

// ginLogFormatter gin 访问日志 formatter：gin 默认行尾追加 rid=<request-id>
// （P-20261003-216）。行仍经 slogWriter 桥接（RedactLogLine 脱敏照旧生效），
// 落盘后按 rid 可与响应头 X-Request-Id / 前端 errorLog 精确对齐
func ginLogFormatter(p gin.LogFormatterParams) string {
	if p.Latency > time.Minute {
		p.Latency = p.Latency.Truncate(time.Second)
	}
	rid, _ := p.Keys[middleware.GinKeyRequestID].(string)
	return fmt.Sprintf("[GIN] %v | %3d | %13v | %15s | %-7s %#v rid=%s\n%s",
		p.TimeStamp.Format("2006/01/02 - 15:04:05"),
		p.StatusCode,
		p.Latency,
		p.ClientIP,
		p.Method,
		p.Path,
		rid,
		p.ErrorMessage,
	)
}

// slogWriter 将 gin 请求日志桥接到 slog（Info 级别用于请求日志，Error 级别用于错误日志）。
// 落 slog 前过 RedactLogLine 脱敏（P-20261002-95）：gin 访问日志的路径段
// /api/share/:token（撤销/轮换/有效期，含活跃 token）与 query 里的 OAuth
// device_code 都是凭据值，gin v1.12 默认把 RawQuery 一并拼进日志行
type slogWriter struct{ level slog.Level }

func (w *slogWriter) Write(p []byte) (n int, err error) {
	msg := share.RedactLogLine(strings.TrimRight(string(p), "\n\r"))
	if w.level >= slog.LevelError {
		slog.Error("gin", "msg", msg)
	} else {
		slog.Info("gin", "msg", msg)
	}
	return len(p), nil
}
