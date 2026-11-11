package api

import (
	"net/http"
	"time"

	"codecombo/server/api/agentchain"
	"codecombo/server/api/agentcron"
	"codecombo/server/api/ai"
	"codecombo/server/api/compareexp"
	"codecombo/server/api/creds"
	"codecombo/server/api/deploy"
	"codecombo/server/api/files"
	"codecombo/server/api/gitops"
	helpAPI "codecombo/server/api/help"
	hookapi "codecombo/server/api/hooks"
	licenseAPI "codecombo/server/api/license"
	"codecombo/server/api/notify"
	"codecombo/server/api/opschannel"
	"codecombo/server/api/opsmessage"
	"codecombo/server/api/project"
	"codecombo/server/api/quickdrop"
	recordingapi "codecombo/server/api/recording"
	"codecombo/server/api/remote"
	"codecombo/server/api/remoteaccess"
	reportapi "codecombo/server/api/report"
	shareapi "codecombo/server/api/share"
	syncapi "codecombo/server/api/sync"
	"codecombo/server/api/system"
	"codecombo/server/api/terminal"
	tools2 "codecombo/server/api/tools"
	"codecombo/server/api/watchapi"
	whatsnew "codecombo/server/api/whatsnew"
	mw "codecombo/server/middleware"
	"codecombo/server/preview"
	"codecombo/server/proxy"
	sharecore "codecombo/server/share"

	"github.com/gin-gonic/gin"
)

// RequireTokenAuth 强制 Token 认证中间件
var RequireTokenAuth = mw.RequireTokenAuthMiddleware

// RegisterRoutes 注册全部路由并返回收口快照：实际注册的路由路径全集
// （RouteTable，P-20261003-153）。组合根据此推导填充模块发现清单
// （Manifest.Routes），路由注册与清单声明不再两处写。
// 返回值对既有调用方无感（可忽略）。
// dev 为可选开关（P-20261007-6）：仅影响 CSP Report-Only 的 dev 分支
// （script-src 放行 'unsafe-eval'），既有测试/调用方无参形态语义不变。
func RegisterRoutes(r *gin.Engine, dev ...bool) RouteTable {
	// 请求关联 ID（P-20261003-216）注册在全局第一顺位：后续任何中间件
	// abort（423/401）或 panic 恢复的响应都带 X-Request-Id（含代理路由）
	r.Use(mw.RequestID())
	r.Use(mw.CORS())
	r.Use(mw.Metrics())
	// 安全响应头基线（P-20261002-42）+ CSP Report-Only 观察期（P-20261007-6）。
	// 此处 Use 先于 app.go 的 NoRoute 注册执行，SPA 静态响应（含锁屏页）同样带头
	r.Use(mw.SecurityHeaders(dev...))

	// lock 公开组（豁免 LockMiddleware）
	// state: 前端引导屏查询锁状态；unlock: 提交密码换取 token
	// setup: 首次安装设置密码（仅无配置时可用，安全 backlog A3）
	lockPublic := r.Group("/api/lock")
	{
		lockHandler := system.NewLockHandler()
		lockPublic.GET("/state", lockHandler.GetState)
		lockPublic.POST("/unlock", lockHandler.Unlock)
		lockPublic.POST("/setup", lockHandler.Setup)
	}

	// 本机优雅停机（A8）：豁免 LockMiddleware——锁定态下 cmdStop 也必须能关服务；
	// 端点自身有回环 + 自定义头双约束（见 system.Shutdown）
	r.POST("/api/shutdown", system.Shutdown)

	// 本机优雅重启（P-20261106 页面重启链）：同 shutdown 豁免锁保护组
	//（锁定态下也要能重启（A8））；授权双路（P-20261109-11）= 回环 OR 有效锁
	// 凭据（mw.ValidateLockCredential，校验器与锁中间件同一套）——LAN/https
	// 部署形态解锁后可重启；X-SC-Restart 头保持防任意网页 CSRF 重启
	//（自定义头跨源需预检被 CORS 拒）。shutdown 保持 loopback-only 不动：
	// 重启可恢复、停机是终局（刻意不对称，见 system.Restart/Shutdown 注）
	r.POST("/api/restart", system.Restart)

	// 快投递（P-20261006-51）：手机/脚本 → 工作台的最轻投递通道。公开路由
	// 刻意不入 api 组——投递凭据（scd_ token）即门禁，锁定态/解锁 token 不
	// 挡投递（外发投递原语与 webhook 推送同级的入站面）；无效凭据恒 404
	// （与路由不存在同形，不暴露端点存在性）。限流按客户端 IP 维度
	// （RateLimitMiddleware 固定窗口，/api/clip 同款惯例）防投递风暴
	r.POST("/api/quickdrop", mw.RateLimitMiddleware(30, func(c *gin.Context) string {
		return c.ClientIP()
	}), quickdrop.PostDrop)
	// 访客投递页（零依赖单页）：GET 渲染 / POST 表单提交（PRG），同一凭据门
	r.GET("/drop/:token", mw.RateLimitMiddleware(60, func(c *gin.Context) string {
		return c.ClientIP()
	}), quickdrop.GetDropPage)
	r.POST("/drop/:token", mw.RateLimitMiddleware(30, func(c *gin.Context) string {
		return c.ClientIP()
	}), quickdrop.PostDropForm)

	// CSP 违规报告收集（P-20261007-6）：浏览器按 CSP 规范自动 POST 报告，不带
	// 任何应用凭据（锁屏页同样产生报告），故必须公开——与 /api/quickdrop 同级
	// 的「无凭据入站面」；按客户端 IP 限流防报告风暴，端点只做聚合入审计，
	// 不执行任何业务动作、不暴露报告内容（见 system.CollectCSPReport）
	r.POST("/api/csp-report", mw.RateLimitMiddleware(120, func(c *gin.Context) string {
		return c.ClientIP()
	}), system.CollectCSPReport)
	// 入站事件 Hook（P-20261003-23）：外部事件 → 通知中心 + panel 直达动作。
	// 公开路由同 quickdrop 语义（独立 sch_ 凭据即门禁，锁定态不挡）；header
	// X-Hook-Token 载体优先，URL 段载体兼容——URL 凭据由 share.RedactLogLine
	// 在访问日志里打码（P-95）。限流 60 条/分钟：有效凭据按 token 哈希分桶，
	// 无效凭据按 IP（hooks.RateLimitKey），超限 429。
	// 两个载体共用同一个中间件实例（= 同一个限流器）：换载体不能绕过配额
	hookRateLimit := mw.RateLimitMiddleware(60, hookapi.RateLimitKey)
	r.POST("/api/hooks/:token", hookRateLimit, hookapi.PostHook)
	// header-only 形态：凭据完全不出现在 URL 里（推荐脚本/CI 集成的方式）
	r.POST("/api/hooks", hookRateLimit, hookapi.PostHook)

	// 分享访客面同源入口（P-20261020-2）：/s/* 整段 + 访客页依赖的三个
	// vendored 资产名直通 server/share 的 Service.Handler。
	//   - 匿名边界：注册在 api 组（LockMiddleware/TokenAuthMiddleware）之前，
	//     与分享子服务独立监听同一语义——分享 token（+ 可选口令门）是唯一
	//     门禁；锁定态不影响访客打开链接。不新增 agent 权限面。
	//   - /assets/* 只挂三个精确名，绝不整段代理：主应用 Vite 产物同住该前缀，
	//     整段会让 SPA 静态件 404（见 share.AssetNames 白名单单一事实源）。
	//   - 反代/内置 SSH 隧道只转发主端口时，分享链接不再依赖第二端口。
	// 方法面与分享服务自身契约一致：/s/* 只需 GET（页面/子资源/SSE）与
	// POST（口令验证/访客留言）；其余方法在子服务上是 405，主引擎不登记
	// 以避免无意义的方法矩阵（访客面没有写内容端点）。
	r.GET("/s/*path", serveShareSameOrigin)
	r.POST("/s/*path", serveShareSameOrigin)
	for _, name := range sharecore.AssetNames() {
		r.GET("/assets/"+name, serveShareSameOrigin)
	}

	api := r.Group("/api")
	// LockCSRF（P-20261019-2 ④）：解锁令牌 cookie 载体引入的环境凭据 CSRF 面，
	// 写方法按源校验，挂锁中间件之前——锁关闭时同源校验对合法流量恒真
	api.Use(mw.LockCSRF(), mw.LockMiddlewareWithCookie(), mw.TokenAuthMiddleware(), mw.AgentGuard())
	{
		// 模块发现：内置能力面清单（未来前端插件据此动态加载）
		api.GET("/modules", HandleListModules)

		// 令牌自校验（P-20261004-15）：agent 脚本/新会话引导第一步——一次调用
		// 回答「我是谁（tokenKind）、令牌有效吗（无效 401 区分令牌族）、我能
		// 干什么（capabilities 沿 /api/meta 注册表）」；agent 令牌/解锁令牌均可
		api.GET("/whoami", HandleWhoami)

		// 版本更新内容（P-20261007-17）：嵌入文档（docs/whatsnew.md）全文+切分
		// 段落+buildVersion，token 门只读——前端升级弹层/帮助中心「更新内容」节
		// 与智能体版本确认共用（发现面白名单豁免：文档面同 /api/help 先例）
		api.GET("/whats-new", whatsnew.HandleWhatsNew)

		// lock 鉴权路由（需 unlock token，受 LockMiddleware 保护）
		lockHandler := system.NewLockHandler()
		api.POST("/lock/lock", lockHandler.Lock)
		api.GET("/lock/config", lockHandler.GetConfig)
		api.PUT("/lock/config", lockHandler.UpdateConfig)
		api.PUT("/lock/password", lockHandler.UpdatePassword)

		// 实例管理
		{
			inst := api.Group("/instances")
			inst.GET("", system.ListInstances)
			inst.POST("", system.AddInstance)
			// 实例族总览（P-20261003-56）：claim 聚合 + 逐实例探活 + 残留清理；
			// 静态段 /fleet 与 DELETE /:id 同树共存（gin 静态优先，remotehosts 同款）
			inst.GET("/fleet", system.InstanceFleet)
			inst.DELETE("/fleet/:instanceId", system.CleanFleetResidual)
			// 联邦派发进度回流（P-20261004-131）：派发寻址账清单/移除——前端
			// useFleetTaskBackflow 轮询对端 /agent-tasks 的寻址依据；静态段与
			// /:id 同树共存（gin 静态优先，/fleet 同款）
			inst.GET("/dispatched", system.ListDispatched)
			inst.DELETE("/dispatched/:recordId", system.DeleteDispatched)
			inst.DELETE("/:id", system.RemoveInstance)
			inst.PUT("/:id", system.UpdateInstance)
			inst.POST("/check-batch", system.CheckAllInstances)
			inst.POST("/probe", system.ProbeInstance)
			inst.POST("/:id/check", system.CheckInstance)
			// 联邦会话派发（P-20261004-101）：中心握从实例令牌转发创建 agent
			// 会话（对端 POST /api/terminals 普通端点），失败原文透传
			inst.POST("/:id/dispatch", system.DispatchSession)
			// 联邦活动热力（P-20261004-98）：并发拉取各注册实例 activity 端点
			// 的对比矩阵（失败隔离行 + 5 分钟缓存）；静态段与 /:id 同树共存
			//（gin 静态优先，/fleet 同款）
			inst.GET("/activity-matrix", system.InstanceActivityMatrix)
		}

		// 许可授权
		{
			lic := api.Group("/license")
			lic.GET("/status", licenseAPI.GetLicenseStatus)
			lic.POST("/activate", licenseAPI.ActivateLicense)
			lic.DELETE("", licenseAPI.DeactivateLicense)
		}

		// Token 管理
		{
			tok := api.Group("/tokens")
			tok.GET("", system.ListTokens)
			tok.POST("", system.CreateToken)
			tok.DELETE("/:id", system.DeleteToken)
		}

		// Agent Token 管理（sca_，终端内智能体调用本系统 API 的长效令牌）
		{
			at := api.Group("/agent-token")
			at.GET("", system.GetAgentToken)
			at.POST("/reveal", system.RevealAgentToken)
			at.POST("/rotate", system.RotateAgentToken)
			at.DELETE("", system.RevokeAgentToken)
		}

		// 入站 Hook 凭据管理（sch_，外部事件 POST /api/hooks 的函数级凭据）：
		// 与 Agent Token 同域独立权限（泄露只影响通知噪音，P-20261003-23）。
		// 签发/轮换/销毁均入审计；销毁后入站全部 401
		{
			ht := api.Group("/hook-token")
			ht.GET("", hookapi.GetHookToken)
			ht.POST("/rotate", hookapi.RotateHookToken)
			ht.DELETE("", hookapi.RevokeHookToken)
		}

		// 设置
		api.GET("/settings", system.GetSettings)
		api.PUT("/settings", system.UpdateSettings)
		// 自定义智能体运行时（任意 CLI 智能体工具自取注册名接入，增删改即时生效）
		api.POST("/settings/custom-agents", system.CreateCustomAgent)
		api.PUT("/settings/custom-agents/:name", system.UpdateCustomAgent)
		api.DELETE("/settings/custom-agents/:name", system.DeleteCustomAgent)
		// 审批分类规则命中测试（P-20261003-35）：输入 op 样例按当前已保存规则裁决
		api.POST("/settings/approval-rules/test", system.TestApprovalRule)

		// 安全事件审计日志（只读，时间倒序分页；管理面鉴权由组中间件承担）
		api.GET("/audit", system.ListAudit)
		// 审计窗口 CSV 导出（P-20261003-66）：当前窗口全量转 CSV 附件下载，
		// 鉴权同 List 面（组中间件同域），导出动作同路入账
		api.GET("/audit/export", system.ExportAudit)
		// 审计保留巡更手动触发（P-20261003-277）：过期前转 CSV 归档 + 时间窗
		// 清理 + 容量闸 + 归档文件清账，与每日 ticker 同一入口；鉴权同 List 面
		api.POST("/audit/archive", system.TriggerAuditArchive)

		// 数据出域面总览（P-20261003-20）：webhook/分享/agent token/远程主机
		// 四处出域口的只读聚合（URL 脱敏、token 不回显）；管理面鉴权由组中间件承担
		api.GET("/system/egress-overview", system.EgressOverview)

		// 入口面总览（P-20261004-11）：锁定/agent token/TLS 与回环辅助口/分享/
		// 远程主机五处入口面的只读聚合（失败计数只出聚合、token 只出 Meta）；
		// 与 egress 同款管理面鉴权由组中间件承担
		api.GET("/system/ingress-overview", system.IngressOverview)

		// 实例健康摘要（P-20261003-28）：metrics 自省四项 JSON 直取（uptime/
		// heapAlloc/goroutines/wsClients），值班大屏健康卡消费；同 /api/metrics
		// 门控面——系统元数据鉴权由组中间件承担
		api.GET("/system/health", system.InstanceHealth)

		// 本机网络地址清单（P-20261019-10）：二维码接力在回环入口下自动改用
		// 局域网候选；只返回 ip/family/iface/private，不含 MAC/主机名
		api.GET("/system/network", system.NetworkAddresses)

		// Scheduler 后台任务清单（P-20261003-276）：内核调度器托管任务的注册
		// 快照（任务名/间隔/上次运行），只读刻意不提供启停；健康卡折叠清单
		// 联动消费，门控面同 /api/system/health
		api.GET("/system/scheduler", system.SchedulerJobs)

		// 服务自身运行日志查看器（P-20261008-15）：DataDir/logs/ 按日滚动文件
		// 的只读尾部窗口（倒读/过滤/敏感值遮蔽默认开）+ 可用日期清单——服务
		// 异常免登机 tail 的应用内排障入口；agent 自诊断原语（手册 server-logs
		// 节）。管理面鉴权由组中间件承担，写侧零改动
		api.GET("/system/logs", system.ServiceLogs)
		api.GET("/system/logs/dates", system.ServiceLogDates)

		// 本机环境体检（P-20261003-317）：聚合既有环境信号为一张只读体检单
		//（git/git-lfs/tmux/agent 运行时/端口注册表/buildInfo/数据盘水位，
		// 各条目 {item,status,detail,hint}），新人配置检查与 issue 附环境一键化；
		// agent 排障自查原语（ops 手册 selfcheck 节）
		api.GET("/selfcheck", system.SelfCheck)

		// 开工检查单晨报（P-20261005-219）：聚合跨天连续性信号为一张只读晨报
		//（未推送提交 ahead 计数/运行中 agent 会话/未读通知与待审批，三源并行
		// 各自降级缺席），首页横幅卡与 agent 晨间巡检人机同源（ops 手册
		// morning-brief 节）
		api.GET("/morning-brief", system.GetMorningBrief)

		// UI 状态持久化
		api.GET("/ui-state", system.GetUIState)
		api.PUT("/ui-state", system.UpdateUIState)
		// 键级补丁写（P-20261002-8）：只携带变更键，服务端读-合并-写原子合并；
		// 与 PUT 同语义，迁移期共存（前端已全量切 PATCH，PUT 保留给既有调用方）
		api.PATCH("/ui-state", system.PatchUIState)
		// 工作区状态备份导出（载荷同 /ui-state；独立端点承载审计埋点）
		api.GET("/ui-state/export", system.ExportUIState)

		// 用户 UI 现场（P-20261004-52）：前端聚合上报「用户此刻在看什么」
		//（显著变化去抖 2s + 60s 心跳），agent 经 GET 读取「看着问」——
		// 上报/读取语义与隐私边界见 server/api/system/uisnap.go 与手册「用户现场」节
		api.POST("/ui/snapshot", system.PostUISnapshot)
		api.GET("/ui/snapshot", system.GetUISnapshot)

		// 命令片段库（C2）
		api.GET("/snippets", system.ListSnippets)
		api.POST("/snippets", system.CreateSnippet)
		api.PUT("/snippets/:id", system.UpdateSnippet)
		api.DELETE("/snippets/:id", system.DeleteSnippet)

		// 运行书（P-20261003-24）：多步运维序列逐步发送
		api.GET("/runbooks", system.ListRunbooks)
		api.POST("/runbooks", system.CreateRunbook)
		api.PUT("/runbooks/:id", system.UpdateRunbook)
		api.DELETE("/runbooks/:id", system.DeleteRunbook)
		// 运行书服务端执行（P-20261004-108）：params 插值 → 逐步写终端 →
		// OSC 133 D 帧等退出码 → task.progress 逐步进度（运行书从 UI-only 变
		// 协议公民，agentcron/链/派发可组合）。静态段 /runbooks/:id 与子路径
		// 同树共存（gin 静态优先，fleet/export 同款先例）
		api.POST("/runbooks/:id/run", system.RunRunbook)
		// 舰队运行书执行（P-20261005-147）：按序对 N 台会话执行一组命令——
		// 每步广播写全目标 + 并发等各目标 OSC 133 终态聚合（矩阵），
		// onFailure 停/续；中止（\x03 广播未完成目标）与失败步单台重试
		// 同族挂靠。详见 server/api/system/runbookfleet.go 头注与 ops 手册
		api.POST("/runbooks/:id/fleet-run", system.RunFleetRunbook)
		api.POST("/runbooks/:id/fleet-abort", system.FleetAbort)
		api.POST("/runbooks/:id/fleet-retry", system.FleetRetry)

		// 输出哨兵（P-20261004-8）：终端输出模式订阅（命中正则入通知中心）
		api.GET("/sentinels", system.ListSentinels)
		api.POST("/sentinels", system.CreateSentinel)
		// 服务端真跑（P-20261004-107）：生产同路径滑窗引擎试跑样例，规则不落库
		// 不触通知——静态段与 :id 族同树共存（gin 静态优先，runbook fleet 同款）
		api.POST("/sentinels/test", system.TestSentinels)
		api.PUT("/sentinels/:id", system.UpdateSentinel)
		api.DELETE("/sentinels/:id", system.DeleteSentinel)

		// 跨设备剪贴板中继（P-20261002-32）：内存单槽 + TTL 5 分钟 + 读取即焚，
		// 写入成功广播 clipboard.arrived（详见 server/api/system/clip.go）；
		// POST 挂 RateLimitMiddleware（每 IP 每分钟 30 次，oauth poll 同款惯例）
		// 防广播风暴——广播扇出到全部 ops-channel 客户端，写入是放大面
		api.POST("/clip", mw.RateLimitMiddleware(30, func(c *gin.Context) string {
			return c.ClientIP()
		}), system.PostClip)
		api.GET("/clip", system.GetClip)

		// Git Config
		api.GET("/projects/:id/git-config", system.GetGitConfig)
		api.PUT("/projects/:id/git-config", mw.ProjectHardLock(), system.SetGitConfig)

		// 提交模板
		api.GET("/commit-templates", project.GetCommitTemplates)
		api.POST("/commit-templates", project.CreateCommitTemplate)
		api.DELETE("/commit-templates/:name", project.DeleteCommitTemplate)

		// Changelist
		api.GET("/changelists", project.GetChangelists)
		api.POST("/changelists", project.CreateChangelist)
		api.DELETE("/changelists/:name", project.DeleteChangelist)
		api.PUT("/changelists/active", project.SetActiveChangelist)
		api.PUT("/changelists/move-file", project.MoveFileToChangelist)

		// Shelve
		api.POST("/projects/:id/shelve", mw.ProjectHardLock(), project.ShelveFiles)

		// 克隆仓库（异步任务）
		api.POST("/clone", gitops.CloneRepo)
		// 克隆前远端分支预取（P-20261003-93）：ls-remote --heads，凭据注入语义
		// 同克隆；失败 502 稳定标记，前端只提示不阻断克隆
		api.POST("/clone/branches", gitops.ListCloneBranches)
		api.POST("/clone/:taskId/cancel", gitops.CancelClone)

		// Git HTTPS 凭据管理
		cred := api.Group("/credentials")
		{
			cred.GET("", creds.ListGitCredentials)
			cred.POST("", creds.SaveGitCredential)
			cred.DELETE("/:id", creds.DeleteGitCredential)
			// 测试凭据是否仍有效：调平台 /user 端点探测，401 自动标 expired
			cred.POST("/:id/test", creds.TestGitCredential)
		}

		// SSH Key 管理
		sshKey := api.Group("/sshkeys")
		{
			sshKey.GET("", creds.ListSshKeys)
			sshKey.POST("/generate", creds.GenerateSshKey)
			sshKey.POST("/import", creds.ImportSshKey)
			sshKey.DELETE("/:id", creds.DeleteSshKey)
			sshKey.GET("/:id/pub", creds.GetSshKeyPub)
		}

		// OAuth Device Flow API（Start/Poll/Refresh/Revoke）
		// Poll 端点用 RateLimitMiddleware（每分钟 30 次，按 device_code 限流）防止 poll storm
		oauth := api.Group("/oauth")
		{
			oauth.POST("/start", creds.OAuthStart)
			oauth.GET("/poll", mw.RateLimitMiddleware(30, func(c *gin.Context) string {
				return c.Query("device_code")
			}), creds.OAuthPoll)
			oauth.POST("/refresh/:id", creds.OAuthRefresh)
			oauth.DELETE("/revoke/:id", creds.OAuthRevoke)
		}

		// OAuth Client 配置 API（Device Flow 的 client_id / 可选 secret）
		oauthClient := api.Group("/oauth-clients")
		{
			oauthClient.GET("", creds.ListOAuthClients)
			oauthClient.POST("", creds.SaveOAuthClient)
			oauthClient.DELETE("/:platform/:host", creds.DeleteOAuthClient)
		}

		// 远程主机凭据 + 部署配置 + 部署任务
		remoteHost := api.Group("/remotehosts")
		{
			remoteHost.GET("", remote.ListRemoteHosts)
			remoteHost.POST("", remote.CreateRemoteHost)
			// 在线状态批量查询（TCP 端口级探测缓存）；静态段 :id 之前注册无 gin 冲突
			remoteHost.GET("/status", remote.GetRemoteHostsStatus)
			// 各主机最近诊断趋势摘要（列表悬停展示）；静态段同上
			remoteHost.GET("/diaghist", remote.GetDiagHistSummary)
			// 跨主机聚合列远程终端会话（P-20261005-11 广播远程目标的取数原语，
			// 广播 popover「远程主机」分组与 agent 舰队巡检共用）；静态段 /:id 之前
			remoteHost.GET("/terminals", remote.ListAllRemoteTerminals)
			// 批量诊断扇出（P-20261004-58）：多主机并行跑单主机只读命令集
			// （并发限流），逐台结构化摘要供横向对比表；静态段注册在 /:id 之前
			remoteHost.POST("/diagnose-batch", remote.DiagnoseRemoteHostsBatch)
			// 导出走 POST：口令在请求体，避免 query 进入访问日志
			remoteHost.POST("/export", remote.ExportRemoteHosts)
			remoteHost.POST("/import", remote.ImportRemoteHosts)
			// 未保存表单参数直测连通性（新增/编辑弹窗「测试连接」）；静态段与 /:id 同级已有先例
			remoteHost.POST("/test", deploy.TestRemoteHostConnectionByParams)
			remoteHost.PUT("/:id", remote.UpdateRemoteHost)
			remoteHost.DELETE("/:id", remote.DeleteRemoteHost)
			remoteHost.POST("/:id/test", deploy.TestRemoteHostConnection)
			remoteHost.POST("/:id/duplicate", remote.DuplicateRemoteHost)
			// SSH 主机密钥 TOFU 指纹（P-20261003-34）：查看钉扎 + 重置（合法迁移重新首录）
			remoteHost.GET("/:id/hostkey", remote.GetRemoteHostKey)
			remoteHost.POST("/:id/hostkey/reset", remote.ResetRemoteHostKey)
			remoteHost.POST("/:id/diagnose", remote.DiagnoseRemoteHost)
			remoteHost.POST("/:id/exec", remote.RemoteHostExec)
			// 本地-远端同项目 Git 对照（P-20261004-34，只读单往返）：
			// 远端 HEAD/分支/脏文件数 vs 本地项目并排 + behind 提示；
			// 远端路径记忆读写分立（GET 纯读，PUT 显式记忆，读零写盘副作用）
			remoteHost.GET("/:id/git-compare", remote.GitCompareRemoteHost)
			remoteHost.PUT("/:id/git-compare-path", remote.SaveGitComparePath)
			// 远程主机终端（REST）；WS 见 /ws/remote-terminal/:id（:id 为 sessionId）
			remoteHost.GET("/:id/terminals", remote.ListRemoteTerminals)
			remoteHost.POST("/:id/terminals", remote.CreateRemoteTerminal)
			// 远端 tmux 版本地板探测（P-20261109-7 A2，只读；静态段先于 :sid 动态段）
			remoteHost.GET("/:id/terminals/tmux-floor", remote.GetRemoteTmuxFloor)
			remoteHost.DELETE("/:id/terminals/:sid", remote.DeleteRemoteTerminal)
			remoteHost.PUT("/:id/terminals/:sid/resize", remote.ResizeRemoteTerminal)
			// 权威重绘（远端 tmux refresh-client；原生 shell 会话 no-op）
			remoteHost.PUT("/:id/terminals/:sid/redraw", remote.RedrawRemoteTerminal)
			remoteHost.GET("/:id/terminals/:sid/scrollback", remote.GetRemoteScrollback)
			remoteHost.POST("/:id/paste-image", remote.UploadRemotePasteImage)
			// SSH 本地转发隧道（P-20261004-5）：远端回环端口 → 实例本机临时口
			//（预览面板联动 preview.port 带 hostId；同 (host,remotePort) 幂等）
			remoteHost.GET("/:id/tunnels", remote.ListTunnels)
			remoteHost.POST("/:id/tunnels", remote.OpenTunnel)
			remoteHost.DELETE("/:id/tunnels/:localPort", remote.CloseTunnel)
			// 远程文件管理（SFTP/FTP 浏览/下载/上传/互传）
			remoteHost.GET("/:id/files/list", remote.ListRemoteFiles)
			// 编辑器读写（VS Code Remote 式，仅 SSH 主机；二进制 415/超大 413/
			// baseHash 冲突 409，语义对齐本地编辑器读写）
			remoteHost.GET("/:id/files/content", remote.ReadRemoteFileContent)
			remoteHost.PUT("/:id/files/content", remote.WriteRemoteFileContent)
			remoteHost.GET("/:id/files/download", remote.DownloadRemoteFile)
			remoteHost.GET("/:id/files/archive", remote.DownloadRemoteFilesAsZip)
			remoteHost.POST("/:id/files/upload", remote.UploadRemoteFile)
			remoteHost.POST("/:id/files/mkdir", remote.MkdirRemoteFile)
			remoteHost.POST("/:id/files/rename", remote.RenameRemoteFile)
			remoteHost.POST("/:id/files/delete", remote.DeleteRemoteFiles)
			remoteHost.POST("/:id/files/transfer", remote.TransferRemoteFiles)
		}

		// 远程接入（SSH 反向隧道 P-20261019-11）：实例主动连用户 VPS 中继，
		// 把主服务呈现在任意网络。档案 CRUD 走 settings，这里只做运行期
		// 状态/启停/预检/主机指纹重置（单活：POST action=start|stop）
		remoteAccess := api.Group("/remoteaccess")
		{
			remoteAccess.GET("/tunnel", remoteaccess.Status)
			remoteAccess.POST("/tunnel", remoteaccess.Control)
			remoteAccess.POST("/tunnel/test", remoteaccess.Test)
			remoteAccess.POST("/tunnel/hostkey/reset", remoteaccess.ResetHostKey)
		}

		// AI 原生操作入口：操作手册 + 智能操作通道发布端点
		// （手册为只读文档，挂载在 /api 组外以便浏览器新窗口直接打开；ops-notify 仍需解锁 token）
		api.POST("/ops-notify", ai.OpsNotify)

		// 智能体操作审批（B4 约定式）：Agent 请求确认/轮询状态 + 用户裁决
		// （export 裁决历史 CSV 导出 P-20261003-247，静态段 :id 之前注册无 gin 冲突）
		api.POST("/ops-confirm", ai.CreateAgentApproval)
		api.GET("/ops-confirm/export", ai.ExportAgentApprovals)
		api.GET("/ops-confirm/:id", ai.GetAgentApproval)
		api.POST("/ops-confirm/:id/resolve", ai.ResolveAgentApproval)
		api.GET("/ops-confirm", ai.ListAgentApprovals)
		api.GET("/agent-tasks", ai.ListAgentTasks)
		// 各会话最近一条 task.progress 瞬态快照（P-20261004-120）：前端挂载补账
		//（刷新后悬浮球/进度卡/监控卡即时回填）与 agent「全舰队在跑什么」巡检
		// 共用的监控原语；鉴权面与 ops-confirm 同级（token 门只读）
		api.GET("/ops-tasks/active", ai.ActiveOpsTasks)

		// 审批窗口过程实况录制（P-20261001-15）：元数据索引 + cast 回放源
		//（写盘前已遮蔽；只读面 + 显式单条删除，录制默认关）
		api.GET("/recordings", recordingapi.ListRecordings)
		api.GET("/recordings/:id", recordingapi.GetRecording)
		api.GET("/recordings/:id/cast", recordingapi.GetRecordingCast)
		api.DELETE("/recordings/:id", recordingapi.DeleteRecording)

		// 智能体结构化提问（P-20261001-27）：Agent 发起提问/轮询答案 + 用户作答
		// （鉴权面与 ops-notify/ops-confirm 同级——agent 令牌可调，非高危不进 AgentGuard）
		api.POST("/ops-ask", ai.CreateAgentAsk)
		api.GET("/ops-ask/:id", ai.GetAgentAsk)
		api.POST("/ops-ask/:id/answer", ai.AnswerAgentAsk)
		api.GET("/ops-ask", ai.ListAgentAsks)

		// 会话间定向消息（P-20261004-68）：agent 令牌可调（ops-notify 同鉴权面
		// + 同款会话维度限流惯例）；投递目标须在册（404 明确退回），拉取即读
		api.POST("/ops-message", opsmessage.SendMessage)
		api.GET("/ops-message", opsmessage.GetInbox)

		// 注：会话式 AI 助手（/api/agent-chat/*）与 AI 提供商配置（/api/ai/providers/*）
		// 已随定位调整移除——不自研助手/应用内 LLM，转为管理环境内成熟智能体框架。

		deployCfg := api.Group("/deploy-config")
		{
			deployCfg.GET("", deploy.GetDeployConfig)
			deployCfg.PUT("", deploy.UpdateDeployConfig)
		}

		deployGroup := api.Group("/deploy")
		{
			deployGroup.GET("/deployers", deploy.ListDeployers)
			deployGroup.GET("/binaries", deploy.ScanBinaries)
			deployGroup.GET("/tasks", deploy.ListDeployTasks)
			deployGroup.POST("", deploy.TriggerDeploy)
			deployGroup.GET("/:taskId", deploy.GetDeployTask)
			deployGroup.GET("/:taskId/log", deploy.GetDeployTaskLog)
			deployGroup.POST("/:taskId/cancel", deploy.CancelDeployTask)
		}
		// 项目管理
		api.GET("/projects", project.ListProjects)
		api.POST("/projects", project.AddProject)
		api.GET("/projects/:id", project.GetProject)
		api.PUT("/projects/:id", project.RelocateProject)
		// 冻结/解冻（P-20261003-9）：布尔开关走既有 Update 链，PUT 子资源先例
		// 同 /projects/:id/git-config
		api.PUT("/projects/:id/frozen", project.SetProjectFrozen)
		// 硬锁锁定/解锁（P-20261004-3）：locked 归档不可变档开关，双向审计；
		// 本端点自身不挂 ProjectHardLock 守卫——它是唯一解锁路径
		api.PUT("/projects/:id/locked", project.SetProjectLocked)
		api.DELETE("/projects/:id", project.DeleteProject)
		api.GET("/browse", project.BrowseDirectory)

		// 文件分享管理（短链创建/列表/轮换/撤销 + 子服务状态；
		// 访客面预览/下载在独立端口子服务，见 server/share）
		shareGroup := api.Group("/share")
		{
			shareGroup.GET("", shareapi.ListShares)
			shareGroup.POST("", shareapi.CreateShare)
			// 文本片段分享（排障贴短链：不绑项目、落库、24h 自动过期）
			shareGroup.POST("/snippet", shareapi.CreateSnippet)
			// 终端只读直播分享（P-20261003-306：token→会话，访客看遮蔽化
			// 只读输出流，无输入端点；默认 30 分钟 TTL）
			shareGroup.POST("/terminal", shareapi.CreateTerminalLive)
			// 终端输出时点冻结快照分享（P-20261005-205：创建时刻 scrollback
			// 定格单文件快照，会话继续跑内容不更新，默认 30 天 TTL）
			shareGroup.POST("/terminal-frozen", shareapi.CreateTerminalFrozen)
			// 会话回放分享（P-20261004-103：录制 cast 快照 + 只读回放访客页，
			// 默认 1 小时 TTL；访客面在独立端口子服务见 server/share）
			shareGroup.POST("/cast", shareapi.CreateCast)
			// 会话回放只读分享（P-20261003-77：Claude 会话时间线快照，含思考块/
			// 工具详情，默认 24h TTL；访客面在独立端口子服务见 server/share）
			shareGroup.POST("/session", shareapi.CreateSessionShare)
			shareGroup.GET("/status", shareapi.GetShareStatus)
			shareGroup.DELETE("/:token", shareapi.DeleteShare)
			// 短链轮换（泄露应对一步化：旧链立即失效、新链即刻可用）
			shareGroup.POST("/:token/rotate", shareapi.RotateShare)
			// 冻结分享原地刷新（P-20261005-177：保 token 重拷当前内容，与
			// rotate 换链语义正交并存；护栏拒绝保旧副本，刷新即 TTL 重置）
			shareGroup.POST("/:token/refresh", shareapi.RefreshShare)
			// 有效期调整（opt-in TTL：expiresAt 绝对时点/null=恢复永久）
			shareGroup.POST("/:token/expiry", shareapi.SetShareExpiry)
			// 访问口令门设置/更换/移除（P-20261006-25：passphrase 空=移除，
			// rotate=true 联动轮换短链）
			shareGroup.POST("/:token/passphrase", shareapi.SetSharePassphrase)
			// 访客留言板主人侧（P-20261006-13）：列表（agent 巡检读回流）+
			// 单删/清空（垃圾出清）；写入在访客子服务 POST /s/{token}/messages
			shareGroup.GET("/:token/messages", shareapi.ListShareMessages)
			shareGroup.DELETE("/:token/messages", shareapi.ClearShareMessages)
			shareGroup.DELETE("/:token/messages/:mid", shareapi.DeleteShareMessage)
			// 协作通道管理面（P-20261024-1，动作化行内端点——分享无编辑面）：
			// 开关族（collab/direct-input）+ 收件清单与消费语义（drops/consume）
			// + 直通握手 owner 半边（approve/revoke/status）。写入面在访客
			// 子服务 /s/{token}/drop 与 /s/{token}/direct/*（开关缺省关，
			// 关闭恒 404）
			shareGroup.POST("/:token/collab", shareapi.SetShareCollab)
			shareGroup.POST("/:token/direct-input", shareapi.SetShareDirectInput)
			shareGroup.GET("/:token/drops", shareapi.ListShareDrops)
			shareGroup.POST("/:token/drops/:id/consume", shareapi.ConsumeShareDrop)
			shareGroup.DELETE("/:token/drops/:id", shareapi.DeleteShareDrop)
			shareGroup.POST("/:token/direct/approve", shareapi.ApproveShareDirect)
			shareGroup.POST("/:token/direct/revoke", shareapi.RevokeShareDirect)
			shareGroup.GET("/:token/direct", shareapi.GetShareDirect)
			// 可写分享管理面（P-20261106-8，动作化行内端点同族）：单条开关
			// （口令门强制在此）+ 批量开关（管理列表多选）+ 粘贴审批决策。
			// 写入面在访客子服务 GET /s/{token}/termws（WS 上行桥，开关缺省
			// 关，关闭恒 404；升级握手同过 gateGuard）
			shareGroup.POST("/writable/batch", shareapi.BatchShareWritable)
			shareGroup.POST("/:token/writable", shareapi.SetShareWritable)
			shareGroup.POST("/:token/paste/:pid/decision", shareapi.DecideSharePasteReview)
		}

		// 快投递管理面（P-20261006-51）：收件箱清单/摘除 + 投递凭据生命周期
		//（生成即轮换/撤销）。静态段 /token 先于 :id 动态段登记（gin 静态优先，
		// fleet/export 同款先例）；前端消费面在 设置·分享区快投递卡 + 通知行内动作
		qd := api.Group("/quickdrop")
		{
			qd.GET("", quickdrop.ListDrops)
			qd.POST("/token", quickdrop.CreateDropToken)
			qd.GET("/token", quickdrop.GetDropToken)
			qd.DELETE("/token", quickdrop.RevokeDropToken)
			qd.DELETE("/:id", quickdrop.DeleteDrop)
		}

		// 仓库状态
		api.GET("/projects/:id/status", project.GetProjectStatus)
		api.GET("/projects/:id/ahead-behind", project.GetAheadBehind)
		// 全项目 ahead/behind 批量查询（首页/项目页一次请求替代 N 次扇出；
		// 不能挂在 /projects/ahead-behind——与 /projects/:id 通配符冲突）
		api.GET("/ahead-behind", project.ListAllAheadBehind)
		// 一键全部拉取（P-20261002-41）：并发池逐项目调既有 fetch，失败隔离逐项
		// 报告（同 ahead-behind 独立路径先例——/projects/fetch-all 与 :id 通配符冲突）
		api.POST("/fetch-all", project.FetchAllProjects)
		// 终端命令历史（OSC 133 E/D 事件链路的查询/清理）
		api.POST("/projects/:id/terminal-history", terminal.RecordTerminalHistory)
		api.GET("/projects/:id/terminal-history", terminal.ListTerminalHistory)
		api.DELETE("/projects/:id/terminal-history", terminal.ClearTerminalHistory)
		api.DELETE("/projects/:id/terminal-history/:idx", terminal.DeleteTerminalHistoryEntry)
		// 跨项目命令历史检索（P-20261004-2）：全局聚合面独立路径，与 ahead-behind /
		// search/projects 同款规避 /projects/:id 通配符冲突
		api.GET("/terminal-history/search", terminal.SearchTerminalHistoryGlobal)
		api.GET("/projects/:id/file-tree", gitops.ListFileTree)
		api.GET("/projects/:id/file-list", gitops.ListFlatFiles)
		// 内容搜索限流（P-20261004-124）：每查询起 rg/git grep 子进程，零限流时
		// 失控循环 = 子进程风暴；按项目 id 维度每分钟 30 次（人为检索远低于此），
		// 超限 429 带稳定标记 search.rate_limited + system:rate-limited 回告
		api.GET("/projects/:id/search", gitops.SearchProjectRateLimit(), gitops.SearchProjectFiles)
		// TODO/FIXME 标记聚合（P-20261002-25）：复用内容搜索后端，按文件分组
		api.GET("/projects/:id/todos", gitops.ProjectTodos)
		// 笔记库（P-20261107-5 独立化 → P-20261108-3 单库化）：项目无关的唯一
		// notepad 库，/api/notes 族（保留哨兵 _global 作用域）。原项目族
		// /projects/:id/notes（兼容 shim）与 /projects/:id/notes-multi 七端点随
		// 「全局库|项目库」双源切换一并退役，存量项目篇经迁移并入本库。挂 api 组
		// 继承 LockCSRF+锁门+TokenAuth+AgentGuard 四件套（复审#2 钉死，挂错组即绕锁门）
		api.GET("/notes", project.ListGlobalNotes)
		api.POST("/notes", project.CreateGlobalNote)
		// 单库化迁移续迁（P-20261108-3）：滞留计数只读 + 手动续迁（满额中止后
		// 腾出空间再续）。静态段与 /:noteId 动态段同树共存（gin 静态优先，
		// /fleet 同款；笔记 id 恒为 uuid/default，不与 migration 撞名）
		api.GET("/notes/migration", project.GetNotesMigration)
		api.POST("/notes/migration", project.PostNotesMigration)
		api.GET("/notes/:noteId", project.GetGlobalNote)
		api.PUT("/notes/:noteId", project.PutGlobalNote)
		api.DELETE("/notes/:noteId", project.DeleteGlobalNote)
		api.POST("/notes/:noteId/restore", project.RestoreGlobalNote)
		api.GET("/notes/:noteId/export", project.ExportGlobalNote)
		// 跨项目批量内容搜索（并发池 4，结果按项目分组；不能挂在
		// /projects/search——与 /projects/:id 通配符冲突，与 ahead-behind 同款独立路径）。
		// 限流同上（P-20261004-124），按客户端 IP 维度：单请求扇出至多 50 项目，
		// ids 组合做 key 会被「滑窗换组合」循环绕开（gitops.BatchSearchRateLimit 注）
		api.GET("/search/projects", gitops.BatchSearchRateLimit(), gitops.SearchProjectsContent)
		api.GET("/projects/:id/branches", gitops.ListBranches)
		api.GET("/projects/:id/tags", gitops.ListTags)
		api.GET("/projects/:id/remotes", gitops.ListRemotes)

		// 提交操作
		api.POST("/projects/:id/stage", mw.ProjectHardLock(), gitops.StageFiles)
		api.POST("/projects/:id/unstage", mw.ProjectHardLock(), gitops.UnstageFiles)
		api.POST("/projects/:id/commit", mw.ProjectHardLock(), gitops.CreateCommit)
		api.POST("/projects/:id/commit/amend-message", mw.ProjectHardLock(), gitops.AmendCommitMessage)
		// 拆分建议逐组执行（P-20261003-278）：确认弹层预览后的安全自动化——
		// 逐组 stage+commit 循环与失败中断报告在 git.ExecuteCommitSplit（写队列域）
		api.POST("/projects/:id/commit-split-execute", mw.ProjectHardLock(), gitops.ExecuteCommitSplit)
		api.POST("/projects/:id/rollback", mw.ProjectHardLock(), gitops.RollbackFiles)
		// commit.template 模板内容（提交框初始化空态预填，P-20261003-172；只读面）
		api.GET("/projects/:id/commit-template", gitops.GetCommitTemplate)

		// 差异查看
		api.GET("/projects/:id/diff", gitops.GetDiff)
		api.GET("/projects/:id/file/diff", gitops.GetFileDiff)
		api.GET("/projects/:id/diff/:commit", gitops.GetCommitDiff)
		api.GET("/projects/:id/blame", gitops.GetBlame)
		api.GET("/projects/:id/file/hunks", gitops.GetFileHunks)
		// 工作区逐文件行数统计（P-20261003-219 变更树「复制变更摘要」数据面，
		// 只读面；按需取数不并入 status 热路径）
		api.GET("/projects/:id/numstat", gitops.GetNumstat)
		api.POST("/projects/:id/hunk/stage", mw.ProjectHardLock(), gitops.StageHunk)
		api.POST("/projects/:id/hunk/unstage", mw.ProjectHardLock(), gitops.UnstageHunk)
		api.POST("/projects/:id/hunk/discard", mw.ProjectHardLock(), gitops.DiscardHunk)

		// 分支对比
		api.GET("/projects/:id/branch-diff", gitops.GetBranchDiff)
		api.GET("/projects/:id/branch-file-diff", gitops.GetBranchFileDiff)

		// 历史记录
		api.GET("/projects/:id/log", gitops.GetLog)
		api.GET("/projects/:id/log/search", gitops.SearchLog)
		api.GET("/projects/:id/log/recent-messages", gitops.GetRecentMessages)
		api.GET("/projects/:id/log/file", gitops.GetFileLog)
		api.GET("/projects/:id/log/directory", gitops.GetDirectoryLog)
		api.GET("/projects/:id/commit/:commit/files", gitops.GetCommitFiles)
		// 提交信息改写（HEAD amend / 历史中段 rebase reword；已推送需确认）
		api.GET("/projects/:id/commit/:commit/pushed", gitops.GetCommitPushed)
		api.POST("/projects/:id/commit/:commit/reword", mw.ProjectHardLock(), gitops.RewordCommitMessage)

		// 浏览版本快照
		api.GET("/projects/:id/tree", gitops.ListTreeAtRef)
		api.GET("/projects/:id/blob", gitops.ShowFileAtRef)

		// 分支操作
		api.POST("/projects/:id/branches", mw.ProjectHardLock(), gitops.CreateBranch)
		api.POST("/projects/:id/checkout", mw.ProjectHardLock(), gitops.CheckoutBranch)
		api.POST("/projects/:id/checkout-update", mw.ProjectHardLock(), gitops.CheckoutAndUpdateBranch)
		api.DELETE("/projects/:id/branches", mw.ProjectHardLock(), gitops.DeleteBranch)
		api.POST("/projects/:id/merge", mw.ProjectHardLock(), gitops.MergeBranch)
		// merge 预演（P-20261005-174）：merge-tree 只读原语不动工作区，GET 读面
		// 不加硬锁不入审计；git <2.38 时端点 501 诚实降级（入口由 branches 列表
		// 顺带的 mergePreviewSupported 隐藏）
		api.GET("/projects/:id/merge-preview", gitops.MergePreviewBranch)
		api.POST("/projects/:id/rebase", mw.ProjectHardLock(), gitops.RebaseBranch)

		// Interactive Rebase
		api.GET("/projects/:id/rebase/todo", gitops.GetRebaseTodo)
		api.POST("/projects/:id/rebase/interactive", mw.ProjectHardLock(), gitops.InteractiveRebase)
		api.POST("/projects/:id/rebase/abort", mw.ProjectHardLock(), gitops.AbortRebase)
		api.POST("/projects/:id/rebase/continue", mw.ProjectHardLock(), gitops.ContinueRebase)

		// 冲突解决
		api.GET("/projects/:id/conflicts", gitops.GetConflictFiles)
		api.GET("/projects/:id/conflicts/content", gitops.GetConflictContent)
		api.GET("/projects/:id/conflicts/parsed", gitops.GetConflictParsed)
		api.POST("/projects/:id/conflicts/resolve", mw.ProjectHardLock(), gitops.ResolveConflict)
		api.POST("/projects/:id/conflicts/resolve-content", mw.ProjectHardLock(), gitops.ResolveConflictWithContent)

		// 远程仓库管理
		api.POST("/projects/:id/remotes", mw.ProjectHardLock(), gitops.AddRemote)
		api.DELETE("/projects/:id/remotes/:name", mw.ProjectHardLock(), gitops.RemoveRemote)

		// 远程操作
		api.POST("/projects/:id/fetch", mw.ProjectHardLock(), gitops.FetchRemote)
		api.POST("/projects/:id/pull", mw.ProjectHardLock(), gitops.PullRemote)
		api.POST("/projects/:id/push", mw.ProjectHardLock(), gitops.PushRemote)
		api.GET("/projects/:id/remote-branch-exists", gitops.CheckRemoteBranch)

		// index.lock 遗留锁一键清理（P-20261002-150）：写命令失败检出遗留锁后的
		// 恢复入口；mtime 双重校验防误删活锁在 git.CleanStaleIndexLock 内
		api.POST("/projects/:id/index-lock/cleanup", mw.ProjectHardLock(), gitops.CleanIndexLock)

		// .gitignore
		api.GET("/projects/:id/gitignore", project.GetGitignore)
		api.PUT("/projects/:id/gitignore", mw.ProjectHardLock(), project.UpdateGitignore)
		api.POST("/projects/:id/gitignore/rule", mw.ProjectHardLock(), project.AddGitignoreRule)

		// git exclude（本地排除，不修改 .gitignore）
		api.POST("/projects/:id/git-exclude/rule", mw.ProjectHardLock(), project.AddGitExcludeRule)

		// .gitattributes
		api.GET("/projects/:id/gitattributes", project.GetGitAttributes)
		api.PUT("/projects/:id/gitattributes", mw.ProjectHardLock(), project.UpdateGitAttributes)
		api.POST("/projects/:id/gitattributes/rule", mw.ProjectHardLock(), project.AddGitAttributesRule)

		// Stash
		api.GET("/projects/:id/stashes", gitops.ListStashes)
		api.GET("/projects/:id/stashes/:index/diff", gitops.StashDiff)
		api.POST("/projects/:id/stash", mw.ProjectHardLock(), gitops.CreateStash)
		api.POST("/projects/:id/stash/pop", mw.ProjectHardLock(), gitops.StashPop)
		api.POST("/projects/:id/stash/apply", mw.ProjectHardLock(), gitops.StashApply)
		// 应用到新分支（P-20261003-263 实验性应用）：git stash branch 原子链
		api.POST("/projects/:id/stash/branch", mw.ProjectHardLock(), gitops.StashBranch)
		api.DELETE("/projects/:id/stash/:index", mw.ProjectHardLock(), gitops.DeleteStash)

		// 标签
		api.POST("/projects/:id/tags", mw.ProjectHardLock(), gitops.CreateTag)
		api.DELETE("/projects/:id/tags", mw.ProjectHardLock(), gitops.DeleteTag)

		// Reflog
		api.GET("/projects/:id/reflog", gitops.GetReflog)
		api.GET("/projects/:id/reflog/:hash/diff", gitops.GetReflogDiff)
		api.POST("/projects/:id/reflog/reset", mw.ProjectHardLock(), gitops.ResetToReflog)

		// 高级操作
		api.POST("/projects/:id/cherry-pick", mw.ProjectHardLock(), gitops.CherryPick)
		api.POST("/projects/:id/revert", mw.ProjectHardLock(), gitops.RevertCommit)
		api.POST("/projects/:id/reset", mw.ProjectHardLock(), gitops.ResetRepo)
		api.POST("/projects/:id/squash", mw.ProjectHardLock(), gitops.SquashCommits)
		api.POST("/projects/:id/drop-commit", mw.ProjectHardLock(), gitops.DropCommit)
		api.POST("/projects/:id/extract", mw.ProjectHardLock(), gitops.ExtractChanges)

		// Patch
		api.POST("/projects/:id/patch/export", gitops.ExportPatch)
		api.POST("/projects/:id/patch/import", mw.ProjectHardLock(), gitops.ImportPatch)
		api.POST("/projects/:id/patch/check", gitops.CheckPatch)
		// 未提交变更导出 .patch 下载（P-20261003-72，scope=worktree|staged|head）
		api.GET("/projects/:id/patch", gitops.DownloadPatch)

		// Submodule
		api.GET("/projects/:id/submodules", gitops.ListSubmodules)
		api.POST("/projects/:id/submodules", mw.ProjectHardLock(), gitops.AddSubmodule)
		api.POST("/projects/:id/submodules/update", mw.ProjectHardLock(), gitops.UpdateSubmodules)
		api.DELETE("/projects/:id/submodules", mw.ProjectHardLock(), gitops.RemoveSubmodule)

		// GPG
		api.GET("/projects/:id/gpg", gitops.GetGpgStatus)
		api.POST("/projects/:id/gpg/toggle", mw.ProjectHardLock(), gitops.ToggleGpgSign)

		// LFS
		api.GET("/projects/:id/lfs", gitops.GetLfsStatus)
		api.POST("/projects/:id/lfs/install", mw.ProjectHardLock(), gitops.LfsInstall)
		api.POST("/projects/:id/lfs/track", mw.ProjectHardLock(), gitops.LfsTrack)
		api.POST("/projects/:id/lfs/untrack", mw.ProjectHardLock(), gitops.LfsUntrack)
		api.POST("/projects/:id/lfs/pull", mw.ProjectHardLock(), gitops.LfsPull)
		api.POST("/projects/:id/lfs/push", mw.ProjectHardLock(), gitops.LfsPush)

		// Hooks
		api.GET("/projects/:id/hooks", gitops.ListHooks)
		api.GET("/projects/:id/hooks/:name", gitops.GetHookContent)
		api.PUT("/projects/:id/hooks/:name", mw.ProjectHardLock(), gitops.UpdateHook)

		// PR 集成
		api.POST("/projects/:id/create-pr", mw.ProjectHardLock(), gitops.CreatePullRequest)

		// Worktree
		api.GET("/projects/:id/worktrees", gitops.ListWorktrees)
		api.POST("/projects/:id/worktrees", mw.ProjectHardLock(), gitops.AddWorktree)
		api.DELETE("/projects/:id/worktrees", mw.ProjectHardLock(), gitops.RemoveWorktree)
		api.POST("/projects/:id/worktrees/prune", mw.ProjectHardLock(), gitops.PruneWorktrees)
		api.POST("/projects/:id/worktrees/move", mw.ProjectHardLock(), gitops.MoveWorktree)
		api.POST("/projects/:id/worktrees/lock", mw.ProjectHardLock(), gitops.LockWorktree)
		api.POST("/projects/:id/worktrees/unlock", mw.ProjectHardLock(), gitops.UnlockWorktree)

		// 分支重命名
		api.POST("/projects/:id/branches/rename", mw.ProjectHardLock(), gitops.RenameBranch)
		// 设置上游跟踪分支
		api.POST("/projects/:id/branches/set-upstream", mw.ProjectHardLock(), gitops.SetUpstream)

		// 文件操作
		// 文件管理：策略查询先行（text/too-large/binary 分级），读写类路由沿用原语义。
		// 读取面端点（策略/内容/下载/规模）挂 no-store（P-20261002-121）：文件内容
		// 是私有内容，不落浏览器/共享代理缓存；写入类路由无内容外发不挂
		api.GET("/projects/:id/file-policy", mw.NoStore(), files.GetFilePolicy)
		api.GET("/projects/:id/file", mw.NoStore(), files.ReadFile)
		api.GET("/projects/:id/file/download", mw.NoStore(), files.DownloadFile)
		// 本地目录打包下载（P-20261002-115）：目录流式 zip（护栏对齐远程归档端点），
		// 私有内容成包外发，与下载/规模同族读取面挂 no-store；probe=1 返回 JSON
		api.GET("/projects/:id/dir-archive", mw.NoStore(), files.DownloadDirArchive)
		// 多选批量归档下载（P-20261003-250）：选择项集合（文件/目录混合）流式
		// zip，打包语义与出域防线同 dir-archive；probe=1 返回 JSON
		api.GET("/projects/:id/files-archive", mw.NoStore(), files.DownloadFilesArchive)
		// 删除确认的递归规模统计（P-20261002-137）：目录删除前查「N 文件/M 目录/
		// X MB」知情确认；随内容实时变，陈旧缓存的确认数据比没有更糟，同挂 no-store
		api.GET("/projects/:id/file/stat", mw.NoStore(), files.StatFile)
		api.PUT("/projects/:id/file", mw.ProjectHardLock(), files.WriteFile)
		api.POST("/projects/:id/file/create", mw.ProjectHardLock(), files.CreateFile)
		api.POST("/projects/:id/file/mkdir", mw.ProjectHardLock(), files.CreateDir)
		api.POST("/projects/:id/file/rename", mw.ProjectHardLock(), files.RenameFile)
		api.POST("/projects/:id/file/delete", mw.ProjectHardLock(), files.DeleteFile)
		api.POST("/projects/:id/file/upload", mw.ProjectHardLock(), files.UploadFiles)
		// 文件批量操作（P-20261006-39）：move/delete/rename 三形态单请求收口
		// （逐条结构化结果、失败不中断批次、单批 ≤200）。写族挂硬锁同单文件
		// 面；agent 令牌走 AgentGuard 高危审批（guardedRoutes「批量文件操作」，
		// op 按 action 细化，一次审批覆盖整批）
		api.POST("/projects/:id/files/batch", mw.ProjectHardLock(), files.BatchFiles)
		// 创建副本（P-20261004-135）：同目录 <stem>-copyN.<ext> 复制（文件字节级/
		// 目录递归整树），变体文件「读→建→写」三步变一步。写族挂硬锁同单文件面；
		// 不入 AgentGuard 高危表（与 file/create 同为纯增量写面，敏感目标由
		// P-235 敏感写入路径闸在 handler 内设防）
		api.POST("/projects/:id/files/duplicate", mw.ProjectHardLock(), files.DuplicateFile)

		// 本地文件历史（P-20261002-130）：版本列表/单版内容/恢复。挂文件组
		// 同一鉴权面；内容为私有文件内容，两个读取端点随读取面挂 no-store
		api.GET("/projects/:id/file/history", mw.NoStore(), files.FileHistoryList)
		api.GET("/projects/:id/file/history/content", mw.NoStore(), files.FileHistoryContent)
		api.POST("/projects/:id/file/history/restore", mw.ProjectHardLock(), files.FileHistoryRestore)

		// 文件改动来源归因（P-20261005-170）：watcher 事件 × OSC133 命令窗的
		// 对账账面只读口（判定与入账在 fsattr 模块）。账面随事件实时追加挂
		// no-store；纯读面不挂硬锁
		api.GET("/projects/:id/fs-attribution", mw.NoStore(), files.FSAttributionList)

		// 项目环境画像（P-20261007-14）：dev 端口注册表 × 输出哨兵规则 × 部署
		// 目标摘要的按项目只读聚合（「这个项目跑起来需要什么」一页简历）。快照
		// 随观测实时变挂 no-store；纯读面不挂硬锁、无 AgentGuard（源级降级与
		// 脱敏边界见 server/api/project/envprofile.go 头注与 ops 手册 env-profile 节）
		api.GET("/projects/:id/env-profile", mw.NoStore(), project.GetEnvProfile)

		// 回收站（P-20261003-304）：删除先入站，列表/恢复/彻底删。列表读面挂
		// no-store（条目随删除/恢复/清账实时变，陈旧缓存点了必 404）；恢复与
		// 彻底删都是项目树写动作，随写族挂 ProjectHardLock
		api.GET("/projects/:id/trash", mw.NoStore(), files.TrashList)
		api.POST("/projects/:id/trash/:entryId/restore", mw.ProjectHardLock(), files.TrashRestore)
		api.DELETE("/projects/:id/trash/:entryId", mw.ProjectHardLock(), files.TrashPurge)

		// 批量替换（P-20261004-114）：agent 批量编辑原语。preview 纯读（grep+
		// 行对照，不写盘）不挂硬锁随读面放行；execute 是批量写 N 文件的裁决
		// 关口——硬锁（写族）+ AgentGuard 高危审批（agentguard guardedRoutes
		// 「批量替换」）双挂；backups 备份清单/内容为读面（no-store 同族）
		api.POST("/projects/:id/replace/preview", files.PreviewReplace)
		api.POST("/projects/:id/replace", mw.ProjectHardLock(), files.ReplaceInProject)
		api.GET("/projects/:id/replace/backups", mw.NoStore(), files.ListReplaceBackups)

		// 替换历史与一键还原（P-20261004-66）：历史闭环的产品内承载。history
		// 是读面（no-store：留档随执行实时变）随族放行；restore 改写工作区
		// （checkout+apply 重建替换前现场）——硬锁 + AgentGuard「批量替换还原」
		// 双挂，与 execute 同为裁决关口
		api.GET("/projects/:id/replace/history", mw.NoStore(), files.ReplaceHistoryList)
		api.POST("/projects/:id/replace/history/:hid/restore", mw.ProjectHardLock(), files.RestoreReplaceHistory)

		// 在系统资源管理器中显示（P-20261003-323）：路径白名单校验后按平台 exec
		// 宿主文件管理器（explorer /select、open -R、xdg-open 退化目录语义）定位
		// 目标。只读面（不落盘不触仓库）不挂 ProjectHardLock——硬锁守卫对账放行
		// 见 router_projectlock_test.go allowlist；headless 实例 501 明确语义
		api.POST("/projects/:id/reveal", files.RevealFile)

		// 任务运行器：扫描 manifest 返回所有可用任务
		api.GET("/projects/:id/tasks", gitops.ListTasks)

		// 通知中心（全局，不绑定项目）
		notif := api.Group("/notifications")
		{
			notif.GET("", notify.ListNotifications)
			notif.POST("", notify.AddNotification)
			notif.POST("/read-all", notify.ReadAllNotifications)
			notif.POST("/read/:id", notify.ReadOneNotification)
			notif.POST("/dismiss/:id", notify.DismissNotification)
			notif.POST("/dismiss-batch", notify.DismissNotificationsBatch)
			// 稍后提醒打标/取消（P-20261003-36；到点重挂在 notify 模块分钟巡检）
			notif.POST("/snooze/:id", notify.SnoozeNotification)
			notif.POST("/clear", notify.ClearNotifications)
			notif.GET("/prefs", notify.GetNotificationPrefs)
			notif.PUT("/prefs", notify.UpdateNotificationPrefs)
			// 外发推送测试（P-20261002-31）：走已保存偏好同步发一条测试消息
			notif.POST("/webhook-test", notify.TestWebhookPush)
		}

		// 日报存档（P-20261003-4）：14 天日报回看——列表 + 单日详情两只读口，
		// 手动触发口补跑/重发（写面在 server/report 发报链，本组只读为主）
		// + 实例活动序列（P-20261003-37，值班大屏热力图消费）
		reports := api.Group("/reports")
		{
			reports.GET("/daily", reportapi.ListDailyReports)
			reports.GET("/daily/:date", reportapi.DailyReportDetail)
			reports.POST("/daily/run", reportapi.RunDailyReport)
			reports.GET("/activity", reportapi.ListActivity)
		}

		// 文件监听降级兜底（P-20261003-140）：inotify 配额耗尽轮询扫描的
		// 状态读取与手动开关（自动启用在 watch 模块配额耗尽钩子内，经此
		// 亦可手动切换；控制面由组合根注入的 watchapi.Control 承载）
		api.GET("/watch/fallback", watchapi.GetFallback)
		api.POST("/watch/fallback", watchapi.SetFallback)
		// 跨项目实时变更流（P-20261003-232）：内核总线 file.changed 全局广播的
		// 只读内存快照（环形缓冲，前端轮询聚合时间线；纯观测面无写操作）
		api.GET("/watch/activity", watchapi.GetActivity)
	}

	// WebSocket
	r.GET("/ws/projects/:id", mw.WithWSLockAuth(HandleWebSocket))
	r.GET("/ws/notifications", mw.WithWSLockAuth(notify.HandleNotificationWS))
	r.GET("/ws/ops-channel", mw.WithWSLockAuth(opschannel.HandleWS))
	// AI 操作手册：公开只读文档（无敏感数据），浏览器/Agent 可直接 GET
	r.GET("/ops-manual", ai.GetOpsManual)
	// 帮助中心：公开只读（前端帮助中心 UI 与智能体查询共用一份数据源，
	// 经 agentops 手册分节对 AI 开放——同 ops-manual 免 token 先例）
	r.GET("/api/help", helpAPI.Get)
	// 能力探测端点（P-20261004-4）：公开只读版本+能力清单（同 ops-manual 免
	// token 先例）——多实例异版本部署下，前端与 Agent 对旧实例先探测再降级
	r.GET("/api/meta", HandleMeta)
	r.GET("/ws/clone/:taskId", mw.WithWSLockAuth(gitops.CloneProgressWS))
	r.GET("/ws/deploy/:taskId", mw.WithWSLockAuth(deploy.DeployProgressWS))

	// 终端
	api.POST("/terminals", terminal.CreateTerminal)
	api.GET("/terminals", terminal.ListTerminals)
	// 多终端广播输入（P-20261003-288）：舰队式批量输入；向终端写入=任意命令
	// 执行面，agent 令牌调用经 AgentGuard 高危审批（guardedRoutes 同表登记）
	api.POST("/terminals/broadcast-write", terminal.BroadcastWrite)
	api.GET("/agent-runtimes", terminal.ListAgentRuntimes)
	// 定时智能体任务（P-20261002-43）：到点经 agent 终端通道自动发起
	crons := api.Group("/agent-crons")
	{
		crons.GET("", agentcron.ListCrons)
		crons.POST("", agentcron.CreateCron)
		crons.PUT("/:id", agentcron.UpdateCron)
		crons.DELETE("/:id", agentcron.DeleteCron)
		crons.POST("/:id/run", agentcron.RunCron)
	}

	// 多实例项目与上下文同步（P-20261023-1）：manifest/plan 四态判定/拉取/
	// 推送/轻投递/账本/定时任务。units 两端点是对端面（对端实例令牌经既有
	// TokenAuth 放行）；push 入 AgentGuard 高危表（批量写对端文件系统）
	syncGroup := api.Group("/sync")
	{
		syncGroup.GET("/manifest", syncapi.GetManifest)
		syncGroup.POST("/plan", syncapi.PostPlan)
		syncGroup.POST("/pull", syncapi.PostPull)
		// push = 批量写对端文件系统的裁决关口（AgentGuard 高危表同表登记）
		syncGroup.POST("/push", syncapi.PostPush)
		syncGroup.POST("/deliver", syncapi.PostDeliver)
		// 对端面（实例间调用）：zip 打包/落位。TokenAuth 下实例令牌与解锁
		// 令牌同权（代理链同款鉴权语义）
		syncGroup.GET("/units", syncapi.GetUnitsZip)
		syncGroup.POST("/units", syncapi.PostUnitsZip)
		// 进度快照与账本（读面；账本条目清理是重置基线的维护口）
		syncGroup.GET("/progress", syncapi.GetProgress)
		syncGroup.GET("/ledger", syncapi.GetLedger)
		syncGroup.DELETE("/ledger", syncapi.DeleteLedger)
		// 定时同步任务（调度执行在 sync 模块分钟巡检）
		syncGroup.GET("/crons", syncapi.ListSyncCrons)
		syncGroup.POST("/crons", syncapi.CreateSyncCron)
		syncGroup.PUT("/crons/:id", syncapi.UpdateSyncCron)
		syncGroup.DELETE("/crons/:id", syncapi.DeleteSyncCron)
		syncGroup.POST("/crons/:id/run", syncapi.RunSyncCron)
		// 手动携密同步（P-20261024-3）：配对密钥管理 + 首次指纹核对确认 +
		// 接收端暂存清单/终审 + 本机证书指纹。凭据档传输本体走 units 对端面
		//（mode=cred / keys=credentials&cred=1）——发起面是 push/pull 的
		// includeCredentials 开关（cron/自动化源服务端硬拒）
		syncGroup.GET("/pairing", syncapi.GetPairingStatus)
		syncGroup.POST("/pairing/:instanceId/generate", syncapi.GeneratePairing)
		syncGroup.PUT("/pairing/:instanceId", syncapi.SetPairing)
		syncGroup.DELETE("/pairing/:instanceId", syncapi.ClearPairing)
		syncGroup.POST("/credentials/verify", syncapi.PostCredVerify)
		syncGroup.GET("/credentials/staged", syncapi.ListCredStaged)
		syncGroup.POST("/credentials/staged/:ticket/resolve", syncapi.ResolveCredStaged)
		syncGroup.GET("/credentials/certinfo", syncapi.GetLocalCertInfo)
	}

	// 换机迁移——实例配置包导出/导入（P-20261003-147）：单包单口令整机迁移
	//（配置四块 + 可选内容全量包，双模 .scpkg）。实现落 sync 包（打包/落位
	// 引擎同源复用 packUnitsInto/landZipReader），端点族独立 /api/migration。
	// 管理面鉴权由组中间件承担；apply 入 AgentGuard 高危表（批量写凭据/
	// 实例/设置 = 高价值变更面），导出/导入均审计入账仅元数据
	{
		api.POST("/migration/export", syncapi.PostMigrationExport)
		api.POST("/migration/import/preview", syncapi.PostMigrationImportPreview)
		api.POST("/migration/import/apply", syncapi.PostMigrationImportApply)
	}
	// 对比实验（P-20261003-46）：双 agent 同题竞写——双开发起/完成监听/
	// 产出并集三分类/采用标注；落盘二阶段（P-20261004-72）mode=apply + 备份查询
	cmpExp := api.Group("/compare-experiments")
	{
		cmpExp.POST("", compareexp.CreateExperiment)
		cmpExp.GET("", compareexp.ListExperiments)
		cmpExp.GET("/:id", compareexp.GetExperiment)
		cmpExp.POST("/:id/adopt", compareexp.AdoptExperiment)
		cmpExp.DELETE("/:id", compareexp.DeleteExperiment)
		cmpExp.GET("/:id/filediff", compareexp.GetExperimentFileDiff)
		cmpExp.GET("/:id/applies", compareexp.ListExpApplies)
		cmpExp.GET("/:id/applies/:aid/patch", compareexp.GetExpApplyPatch)
	}
	// 会话接续链（P-20261004-38）：事件触发的 agent 串行接力——链源会话完成
	// 链终态命中链定义即自动拉起下一棒（CRUD 管理面；触发引擎挂 opschannel
	// 观察者，三道节制闸见 server/api/agentchain/trigger.go）
	chains := api.Group("/agent-chains")
	{
		chains.POST("", agentchain.CreateChain)
		chains.GET("", agentchain.ListChains)
		chains.DELETE("/:id", agentchain.DeleteChain)
	}
	api.GET("/terminals/:id/activity", terminal.GetTerminalActivity)
	// 审阅基线标记（P-20261003-217）：当前时点记为会话阶段审阅基线，产出视图
	// activity?since= 切换 diff 范围——只写会话元数据，不入项目硬锁写族
	api.POST("/terminals/:id/review-mark", terminal.MarkReviewBaseline)
	// 敏感标记（P-20261003-155）：人工策展的安全标注，导出/分享出域命中时
	// warnings+override 二次确认——同上只写会话元数据，不入项目硬锁写族
	api.POST("/terminals/:id/sensitive", terminal.SetSessionSensitive)
	api.DELETE("/terminals/:id", terminal.CloseTerminal)
	api.PUT("/terminals/:id/rename", terminal.RenameTerminal)
	api.PUT("/terminals/:id/resize", terminal.ResizeTerminal)
	api.PUT("/terminals/:id/redraw", terminal.RedrawTerminal)
	api.GET("/terminals/:id/scrollback", terminal.GetTerminalScrollback)
	// 运行中会话的指令队列（P-20261003-248）：排队入尾（busy 判定：idle 即发 /
	// running 等回执 / missing 降级只存）+ 整表替换编辑口；批量读在下方静态段。
	// 排队=延迟的终端输入（完成回执驱动写 PTY），agent 令牌调用经 AgentGuard
	// 高危审批（guardedRoutes 同表登记，broadcast-write 同款理由）
	api.POST("/terminals/:id/queue", terminal.EnqueueTerminalQueue)
	api.PUT("/terminals/:id/queue", terminal.ReplaceTerminalQueue)
	// 服务端只读闸翻转（P-20261008-17）：接管会话默认只读的前端锁服务端镜像。
	// 解锁 = 放开对用户 tmux 会话的写入——agent 令牌经 AgentGuard 审批（同表
	// 登记，locked=true 加固方向 body 感知直放行），动作入 terminal.input_lock 审计
	api.PUT("/terminals/:id/input-lock", terminal.SetTerminalInputLock)
	// 会话输出整体留档导出（P-20261003-100）：scrollback 读取链剥 ANSI 直出 txt 附件；
	// 出域敏感闸（P-20261004-113）：内容扫描/会话标记命中回 warnings，confirm/override 二段确认
	api.GET("/terminals/:id/export", terminal.GetTerminalExport)
	// 失败会话一键验尸（P-20261004-60）：退出码+末命令+输出尾部的聚合报告，
	// JSON / Accept:text/markdown 双形态（agent 程序化自析原语）；敏感标记
	// 出域闸门 warnings+override 同导出契约。只读面，不入硬锁写族
	api.GET("/terminals/:id/postmortem", terminal.GetTerminalPostmortem)
	// 跨会话输出检索（P-20261003-290）：「哪个会话打印过 X」——静态段先于
	// :id 动态段登记（与 tmux-info / claude/sessions/search 同款 gin 静态+参数
	// 共存先例）。搜索族限流（P-20261005-158）：CPU 密集内存扫描的防风暴底线，
	// 会话/令牌/IP 维度 30 次/分钟，超限 429 + search.rate_limited + Retry-After
	// （gitops.SearchRateLimit 单一实现，与内容搜索限流同源）
	api.GET("/terminals/search", terminal.SearchOutputRateLimit(), terminal.SearchTerminalOutput)
	// 排队指令批量读（P-20261003-248）：侧栏徽标+面板单一取数口（免逐会话 N+1），
	// 只回存有排队指令的在册会话；静态段先于 :id 动态段登记（同上先例）
	api.GET("/terminals/queues", terminal.GetTerminalQueues)
	// 端口注册表查询（P-20261003-293）：dev 端口探测/上报两路信号的「端口→会话」
	// 登记面，agent 选自由端口原语 + 前端「端口占用一览」浮层同源。只读无守卫
	api.GET("/terminals/ports", terminal.ListDevPorts)
	// OSC 133 运行态计数（P-20261004-63）：服务端权威的「多少会话命令在跑」
	// 跨设备真值（Agent Token 轮换/撤销警示行改读此口 + agent 自查原语）。
	// 拉取式不广播（高频流 MVP 注记，见 terminal/oscstate.go 头注）
	api.GET("/terminals/running-count", terminal.GetRunningCount)

	// 外部 tmux 会话列举（P-20261005-189）：服务器上用户默认 socket 的既有
	// tmux 会话（自建会话住专属 socket 不在列）——接管入口的数据面 + agent
	// 巡检「服务器遗留 tmux 任务」的发现原语。只读无守卫；静态段先于 :id
	// 动态段登记（与 search/queues 同款先例）
	api.GET("/terminals/external-sessions", terminal.ListExternalTmuxSessions)

	// shell 候选探测（P-20261004-57）：设置页「默认 shell」下拉与会话创建对话
	// 框「高级 · shell」共用的候选来源，附当前生效默认 shell。只读无守卫
	//（静态段先于 :id 动态段，与 search/queues 同款先例）
	api.GET("/terminals/shell-candidates", terminal.ListShellCandidates)
	api.GET("/terminals/tmux-info", terminal.GetTmuxInfo)
	api.POST("/terminals/tmux-install", terminal.InstallTmux)
	api.POST("/terminals/paste-image", terminal.UploadPasteImage)
	// 高危命令影响面预览（P-20261005-191）：命令串 → 结构化判定（模式表 +
	// rm glob 展开/git status 动态计数）——前端粘贴链/palette 直达插入链的
	// 确认卡数据源 + agent 执行前自检原语。只读面（读元数据不执行不入硬锁）；
	// 静态段先于 :id 动态段登记（与 search/queues 同款先例）
	api.POST("/terminals/command-preview", terminal.PreviewCommand)
	// 舰队并行 agent 任务（P-20261003-291）：多项目批量发起 agent 会话编队
	//（≤20 顺序创建，单项目失败逐条回告跳过；token 门与单开会话同级）
	api.POST("/terminals/bulk-agent", terminal.BulkCreateAgentTerminals)
	// Claude Code 本地会话列表（只读扫描 ~/.claude/projects；项目级/全局 + 搜索）
	api.GET("/claude/sessions", terminal.ListClaudeSessions)
	// 会话时间窗溯源（P-20261007-11）：任意时刻 → 该项目当时活跃的 Claude
	// 会话（transcript 时间窗匹配+接近度排序）——前端 blame 悬停溯源区与
	// agent 排障自查（手册 terminal 节登记）共用；项目级只读面挂 projects 路径
	api.GET("/projects/:id/sessions-at", terminal.GetClaudeSessionsAt)
	// 会话策展 upsert（P-20261003-67）：星标/备注部分更新（静态段先于 :id 动态段）
	api.POST("/claude/sessions/curation", terminal.SetClaudeSessionCuration)
	// 会话历史全文搜索（P-20261003-19）：跨 transcripts 命中带上下文（敏感遮蔽）
	api.GET("/claude/sessions/search", terminal.SearchClaudeSessions)
	// 单会话回放时间线（transcript 直读解析，尾部窗口分页）
	api.GET("/claude/sessions/:id/timeline", terminal.GetClaudeSessionTimeline)
	// 会话回放导出 Markdown/JSONL（P-20261003-44）：知识出站（审计入账 claude.export）；
	// 出域敏感扫描（P-20261004-113）：命中回 warnings，confirm=1 二段确认后出附件
	api.GET("/claude/sessions/:id/export", terminal.GetClaudeSessionExport)
	// 会话批量导出 zip（P-20261003-165）：多选归档打包（每会话一 md/JSONL 条目 +
	// MANIFEST 清单，≤50/批；POST 承载 ids，静态段与 GET :id 动态段不同方法树共存）
	api.POST("/claude/sessions/export-archive", terminal.BatchExportClaudeSessions)

	// 工具集成：dsh（DeepSeek Harness）Web UI 状态/反代地址/一键启动 +
	// 外部 dsh 目标管理（多目标 cookie 路由）
	tools := api.Group("/tools")
	{
		tools.GET("/dsh/status", tools2.DshStatus)
		tools.GET("/dsh/url", tools2.DshProxyURL)
		tools.POST("/dsh/launch", tools2.DshLaunch)
		tools.GET("/dsh/targets", tools2.DshTargetsList)
		tools.POST("/dsh/targets", tools2.DshTargetCreate)
		tools.PUT("/dsh/targets/:id", tools2.DshTargetUpdate)
		tools.DELETE("/dsh/targets/:id", tools2.DshTargetDelete)
		tools.GET("/dsh/versions", tools2.DshVersions)
		tools.GET("/dsh/changelog", tools2.DshChangelog)
		tools.POST("/dsh/upgrade/prepare", tools2.DshUpgradePrepare)
		tools.POST("/dsh/upgrade/install", tools2.DshUpgradeInstall)
		tools.POST("/dsh/upgrade/restart", tools2.DshUpgradeRestart)
		tools.POST("/dsh/restart", tools2.DshRestart)
		tools.POST("/dsh/rollback", tools2.DshRollback)
	}
	r.GET("/ws/terminal/:id", mw.WithWSLockAuth(terminal.HandleTerminalWS))
	r.GET("/ws/remote-terminal/:id", mw.WithWSLockAuth(remote.RemoteTerminalWS))

	// 更新管理
	api.GET("/updates/check", system.CheckUpdate)
	api.POST("/updates/apply", RequireTokenAuth(), system.ApplyUpdate)
	api.GET("/updates/status", system.GetUpdateStatus)
	// 出站档位只读透出（P-20261110-1 S6）：与 /updates/status、/settings 同鉴权姿态
	api.GET("/updates/proxy-status", system.GetUpdateProxyStatus)
	api.DELETE("/updates/status", system.DeleteUpdateStatus)
	api.GET("/updates/serve-binary", RequireTokenAuth(), system.ServeBinary)
	api.POST("/updates/apply-from-center", RequireTokenAuth(), system.ApplyUpdateFromCenter)

	// 代理路由（独立前缀，避免与 /api 冲突）——受全局锁保护：
	// 锁中间件对有效 sc_ access token 放行，保留中心实例代远程实例
	// 调用的机器间语义；锁开启时无凭证请求一律 423（修复安全 backlog A1）。
	// 与 /api 同挂 cookie 载体形态 + CSRF 写防护（P-20261019-2：浏览器侧
	// 令牌在 HttpOnly cookie，远程代理请求由浏览器自动携带）
	proxyAPI := r.Group("", mw.LockCSRF(), mw.LockMiddlewareWithCookie())
	proxyAPI.Any("/proxy/:instanceId/*path", proxy.ProxyHandler)
	r.GET("/ws/proxy/:instanceId/*path", mw.WithWSLockAuth(proxy.ProxyWSHandler))

	// 端口预览回环反代（独立前缀）：把本机回环端口（dev server 等）经 Web 面
	// 暴露给任意访问设备。预览的是本机监听服务，权限等同管理面——与 /api 同级
	// 挂锁保护；cookie 载体承载 iframe 导航与 iframe 内第三方 WS（这两类
	// 请求无法携带 X-Lock-Token 头/子协议，校验器与头载体同一套）。
	// P-20261019-2 起该组与 /api 统一为 WithCookie 形态 + LockCSRF 写防护：
	// 预览页面 JS 与主应用同源（反代所致），无 CSRF 校验时可用环境 cookie
	// 直写管理 API——写方法按源校验把这一面关掉（读面由 CORS 同源开关闭合）
	previewAPI := r.Group("", mw.LockCSRF(), mw.LockMiddlewareWithCookie())
	previewAPI.Any("/preview/:port/*path", preview.Handler)

	// 健康检查（不受任何中间件保护）
	r.GET("/api/health", system.HealthCheck)

	// 指标出口（Prometheus 文本格式；受全局锁保护——路由名/计数属系统元数据）。
	// cookie 载体形态与 /api 对齐（P-20261019-2）：浏览器侧无头载体可用
	r.GET("/api/metrics", mw.LockCSRF(), mw.LockMiddlewareWithCookie(), HandleMetrics)

	// 收口快照（P-20261003-153）：全部注册完成后的真实路由表
	return BuildRouteTable(r)
}

// serveShareSameOrigin 主应用同源分享访客面（P-20261020-2）：把 /s/* 与
// vendored 资产精确路由直通分享子服务 Handler。
//
// 头处理：分享服务自带 enforcing CSP（script/style 仅内联 + 同源资产）、
// no-store、no-referrer 与 X-Frame-Options: DENY；主应用全局 SecurityHeaders
// 在链前写入的 CSP Report-Only / Reporting-Endpoints 对访客页没有意义（内联
// 脚本会批量产生误报），这里剥除，其余头由分享服务自身 Set 覆盖。
//
// IP 边界：c.ClientIP() 已按 server.trustedProxies 解析（P-20261020-1，默认
// 空=不信任任何转发头）；解析结果经进程内上下文注入，访客审计与口令门
// 限流（server/share/clientIPOf）据此归属，不接受请求头直传。
//
// 超时：访客面含长连接（终端直播 /s/<token>/stream 的 SSE）与大文件流式取件
// （目录 zip、raw/video Range）。分享子服务的 http.Server 刻意 WriteTimeout=0，
// 主引擎全局 WriteTimeout 60s 会在同源形态下截断这两类响应——这里显式清除
// 本请求的写期限（ResponseController 沿 gin writer 的 Unwrap 落到连接层）。
func serveShareSameOrigin(c *gin.Context) {
	h := sharecore.SameOriginHandler()
	if h == nil {
		// 子服务未就绪（监听失败/模块未启动）：明确 503，不落到 SPA index
		c.String(http.StatusServiceUnavailable, "share service unavailable")
		return
	}
	c.Writer.Header().Del(mw.HeaderCSPReportOnly)
	c.Writer.Header().Del(mw.HeaderReportingEndpoints)
	// 不支持 SetWriteDeadline 的 writer（测试 httptest/中间层包装）返回错误，
	// 忽略即可——语义退化为服务端默认期限，不影响内容与头
	_ = http.NewResponseController(c.Writer).SetWriteDeadline(time.Time{})
	ctx := sharecore.WithClientIP(c.Request.Context(), c.ClientIP())
	h.ServeHTTP(c.Writer, c.Request.WithContext(ctx))
}
