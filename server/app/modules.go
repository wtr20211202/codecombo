package app

import (
	"log/slog"
	"sort"
	"time"

	"codecombo/server/api"
	"codecombo/server/api/agentchain"
	"codecombo/server/api/agentcron"
	"codecombo/server/api/ai"
	"codecombo/server/api/compareexp"
	"codecombo/server/api/files"
	"codecombo/server/api/opschannel"
	"codecombo/server/api/opsmessage"
	"codecombo/server/api/project"
	"codecombo/server/api/quickdrop"
	"codecombo/server/api/remote"
	"codecombo/server/api/remoteaccess"
	shareapi "codecombo/server/api/share"
	syncapi "codecombo/server/api/sync"
	"codecombo/server/api/system"
	terminalapi "codecombo/server/api/terminal"
	"codecombo/server/api/watchapi"
	"codecombo/server/claims"
	"codecombo/server/config"
	"codecombo/server/deploy"
	"codecombo/server/fsattr"
	"codecombo/server/git"
	"codecombo/server/kernel"
	"codecombo/server/notification"
	"codecombo/server/recording"
	"codecombo/server/remoteterminal"
	"codecombo/server/report"
	"codecombo/server/store"
	"codecombo/server/terminal"
	"codecombo/server/update"
	"codecombo/server/watch"
)

// registration 模块注册项：模块实例 + 发现清单（/api/modules 载荷）
type registration struct {
	module   kernel.Module
	manifest kernel.Manifest
}

// runtimeInfo 组合根解析出的运行期信息（CLI 覆盖只存在于组合根，
// 需要它的模块经此声明式注入，而非各自重读配置/环境变量）
type runtimeInfo struct {
	Version   string
	Commit    string
	BuildTime string
	TLSOn     bool
	CertFile  string
	KeyFile   string
}

// manifestRoutes 组装模块发现清单（P-20261003-153）：路由能力族在 api 注册面
// 声明（api/routefamily.go 的 moduleRouteFamilies），此处按真实路由表
// （RegisterRoutes 收口快照）推导填充——组合根不再手工维护 Routes，
// 既有族内新增端点自动进 /api/modules。extras 是推导覆盖不了的显式条目
// （历史兼容面 / 外部子服务面），逐条注明理由。推导未命中的声明族启动期
// warn 后丢弃（笔误由 discovery_conformance_test.go 对账门禁拦截）
func manifestRoutes(routes api.RouteTable, module string, extras ...string) []string {
	matched, unmatched := api.DeriveRouteFamilies(routes, module)
	for _, f := range unmatched {
		slog.Warn("module route family matches no registered route, dropped from manifest", "module", module, "family", f)
	}
	out := append(matched, extras...)
	sort.Strings(out)
	// 去重（声明表理论不含重复，防御性收敛，保 /api/modules 载荷干净）
	dedup := make([]string, 0, len(out))
	for i, e := range out {
		if i == 0 || e != out[i-1] {
			dedup = append(dedup, e)
		}
	}
	if len(dedup) == 0 {
		return nil
	}
	return dedup
}

// builtinModules 内置模块注册清单（roadmap M2.3 装配顺序声明化）。
//
// 新增模块：向本列表追加一项即可。启动/停止顺序由 DependsOn 拓扑排序决定，
// 列表顺序仅影响同层稳定序——组合根不再承担「先装 A 才能装 B」的顺序知识。
// 内核注册表即 /api/modules 的唯一清单源（静态声明清单已删除），
// 未来插件按同一 manifest 契约经此注册表动态并入。
//
// Manifest.Routes 自 P-20261003-153 起由 manifestRoutes 按真实路由表推导
// 填充（族声明在 api/routefamily.go），本文件只手工声明 Topics/Capabilities
// （语义宽的事件面/探测面，不做推导注记）与带理由的 extras。
func builtinModules(cfg *config.Config, rt runtimeInfo, routes api.RouteTable) []registration {
	// watch 模块实例先构再注册：降级兜底控制面（P-20261003-140）经组合根
	// 装配给 api 桥——api 层不 import watch 包，模块方法隐式满足 watchapi.Control
	watchModule := watch.NewModule()
	watchapi.SetFallbackControl(watchModule)
	return []registration{
		{watchModule, kernel.Manifest{
			Name:   "watch",
			Title:  "文件监听",
			Topics: []string{"file.changed"},
			// 降级兜底手动开关（P-20261003-140）：状态读取 + 手动切换
			Routes:       manifestRoutes(routes, "watch"),
			Capabilities: []string{"watch-fallback"},
		}},
		// 文件改动来源归因（P-20261005-170）：file.changed 的纯消费方——watcher
		// 命中事件 × OSC133 命令窗时间关联 + 编辑器 API 写标记，事件发生当时
		// 判定入账（车道 1 kind fsattribution）；查询面 GET /api/projects/:id/
		// fs-attribution 在 api/files（读 store，不经本模块）
		{fsattr.NewModule(), kernel.Manifest{
			Name:   "fsattr",
			Title:  "文件改动归因",
			Topics: []string{"file.changed"},
		}},
		{notification.NewModule(func() notification.Prefs {
			// webhook 外发推送偏好读取口（构造注入：notification 不能反向
			// import store；本清单在 store.SetDefault 之后构造，与 report
			// 模块读 store 同一时序假设）
			return store.Get().Notification.GetPrefs()
		}, func(now time.Time) []notification.Notification {
			// 稍后提醒到期重挂扫描口（P-20261003-36，同上不能反向 import）
			return store.Get().Notification.RemountDue(now)
		}), kernel.Manifest{
			Name:   "notify",
			Title:  "通知中心",
			Routes: manifestRoutes(routes, "notify"),
			Topics: []string{notification.TopicNew, notification.TopicApprovalPending},
		}},
		{system.NewModule(rt.Version, rt.Commit, rt.BuildTime), kernel.Manifest{
			Name:   "system",
			Title:  "系统与实例",
			Routes: manifestRoutes(routes, "system"),
			// clipboard.arrived：跨设备剪贴板中继广播（P-20261002-32），端点同族 /api/clip；
			// task.progress：运行书服务端执行逐步进度（P-20261004-108），端点同族 /api/runbooks
			Topics: []string{opschannel.EventSettingsChanged, opschannel.EventClipboardArrived, opschannel.EventTaskProgress},
		}},
		{project.NewModule(), kernel.Manifest{
			Name:   "project",
			Title:  "项目管理",
			Routes: manifestRoutes(routes, "project"),
			Topics: []string{opschannel.EventProjectsChanged, project.TopicProjectAdded, project.TopicProjectRemoved},
			// 能力项（P-20261004-4）：独立路径端点家族（发现面白名单同源——
			// 旧对端 404 回退的协议化探测点，前端 stores/meta hasCap 消费）
			Capabilities: []string{"ahead-behind-all", "fetch-all", "notes"},
		}},
		{files.NewModule(), kernel.Manifest{
			Name:   "files",
			Title:  "文件管理",
			Routes: manifestRoutes(routes, "files"),
			// file.selfwrite（P-20261005-15）：工作台写入标记事件，watch 模块
			// 订阅以过滤敏感外部写入观测的 API 写自环；fs-attribution（P-20261005-170）：
			// 文件改动来源归因查询端点，agent 对账原语
			Topics:       []string{files.TopicFileSelfWrite},
			Capabilities: []string{"file-history", "fs-attribution"},
		}},
		{update.NewModule(rt.Version), kernel.Manifest{
			Name:   "update",
			Title:  "应用更新",
			Routes: manifestRoutes(routes, "update"),
		}},
		{deploy.NewModule(), kernel.Manifest{
			Name:   "deploy",
			Title:  "远程部署",
			Routes: manifestRoutes(routes, "deploy"),
		}},
		{terminal.NewModule(), kernel.Manifest{
			Name:   "terminal",
			Title:  "终端",
			Routes: manifestRoutes(routes, "terminal"),
			// TUI git 写活动定向广播（P-20261004-81）：readLoop 输出嗅探命中经
			// 会话 ProjectID 归属发布（busbridge 桥接项目 WS）
			Topics: []string{terminal.TopicGitActivity},
			// 舰队批量发起（P-20261003-291）：旧对端无此端点时 Agent 降级为
			// 逐项目 POST /api/terminals 的探测点
			Capabilities: []string{"bulk-agent"},
		}},
		{git.NewModule(), kernel.Manifest{
			Name:   "git",
			Title:  "Git 工作台",
			Routes: manifestRoutes(routes, "git"),
			Topics: []string{"git.command", "branch.changed", "log.changed"},
			// 扁平文件清单单请求端点（旧对端回退 BFS 慢路径的探测点，P-20261004-4）；
			// merge-preview 合并预演（P-20261005-174）：agent 合并前自检原语（预演
			// 干净→自动合、冲突→上报不硬闯）——声明的是端点族存在性；对端本机
			// git 版本位（<2.38 时端点 501）由 GET /branches 顺带的
			// mergePreviewSupported 运行期下发
			Capabilities: []string{"flat-file-list", "merge-preview"},
		}},
		// 生产 Dialer 依赖 api 层 SSH 凭据解析（remoteterminal 不能反向 import），
		// 故在注册清单构造时声明式传入
		{remoteterminal.NewModule(remote.NewRemoteTerminalDialer()), kernel.Manifest{
			Name:  "remoteterminal",
			Title: "远程终端",
		}},
		{remote.NewModule(), kernel.Manifest{
			Name:   "remote",
			Title:  "远程主机",
			Routes: manifestRoutes(routes, "remote"),
		}},
		// 远程接入（P-20261019-11）：用户自带 VPS 中继的 SSH 反向隧道——
		// 实例主动连出、远端请求监听，把主服务呈现在任意手机网络。
		// 状态迁移广播 remoteaccess.status（agent 免轮询感知公网入口存活）
		{remoteaccess.NewModule(), kernel.Manifest{
			Name:   "remoteaccess",
			Title:  "远程接入",
			Routes: manifestRoutes(routes, "remoteaccess"),
			Topics: []string{opschannel.EventRemoteAccessStatus},
		}},
		{terminalapi.NewModule(), kernel.Manifest{
			Name:  "paste-cleaner",
			Title: "粘贴图片清理",
		}},
		// 审批窗口过程实况录制（P-20261001-15）：消费 opschannel 审批事件，
		// 录制窗口起止联动（全局设置默认关）
		{recording.NewModule(), kernel.Manifest{
			Name:   "recording",
			Title:  "审批过程实况",
			Routes: manifestRoutes(routes, "recording"),
			Topics: []string{opschannel.EventApprovalPending, opschannel.EventApprovalResolved},
		}},
		{ai.NewModule(), kernel.Manifest{
			Name:  "ai",
			Title: "AI 助手",
			// agent↔用户 双向通道面：notify（前端联动）/ ask（提问-轮询答案，
			// P-20261001-27）/ confirm（审批）。extra /api/agent-chat：端点已随
			// 定位调整移除，条目保留供历史发现面兼容（对账白名单豁免）
			Routes: manifestRoutes(routes, "ai", "/api/agent-chat"),
			Topics: []string{opschannel.EventTaskProgress, opschannel.EventNavigate, opschannel.EventNotify, opschannel.EventPanel, opschannel.EventInputRequest, opschannel.EventInputResolved, opschannel.EventLocateInTree},
			// 原子呈现能力注册表（P-20261022-3）：agent 先探测本族项再依赖
			// 「动词.目标」原语与人类深链表——旧实例（未声明）手册缺四形态/
			// 深链表/locate-in-tree 条目，agent 按既有降级约定回退 path 首形态。
			// 对账映射指向 /ops-manual（注册表渲染的唯一读出端点），见
			// meta_conformance_test capabilityRoutes
			Capabilities: []string{"ops.present-atoms"},
		}},
		// 今日日报（P-20261001-30）：每日定时聚合当日事实入通知中心并落档
		//（P-20261003-4 起 14 天存档带两只读回看口与一个手动触发口；仍只读
		// 既有数据面聚合，经 store 通知出站口触达前端）
		{report.NewModule(), kernel.Manifest{
			Name:   "report",
			Title:  "今日日报",
			Routes: manifestRoutes(routes, "report"),
		}},
		// 跨实例同目录双开检测（P-20261003-3）：项目 .git 内 claim 文件 +
		// 启动全量 claim + 心跳续期 + 退出清理；发现他实例存活 claim 入账
		// 通知中心（同 report 无路由无事件，经 store 出站口触达前端）
		{claims.NewModule(cfg.Server.Port), kernel.Manifest{
			Name:  "claims",
			Title: "双开检测",
		}},
		// 定时智能体任务（P-20261002-43）：分钟级巡检到期任务，经既有 agent
		// 终端创建通道到点自动发起（api 同层复用 LaunchAgentSession，CRUD 路由
		// 在 /api/agent-crons）；接力降级广播 task.relaySkipped（P-20261005-207）
		{agentcron.NewModule(), kernel.Manifest{
			Name:   "agentcron",
			Title:  "定时任务",
			Routes: manifestRoutes(routes, "agentcron"),
			Topics: []string{opschannel.EventTaskRelaySkipped},
		}},
		// 多实例项目与上下文同步（P-20261023-1）：manifest/plan/pull/push 端点族
		// + 同步账本 + 定时同步巡检 + sync.progress 进度广播。capability "sync"
		// 是对端能力探测点（/api/meta capabilities——旧对端未声明即「需升级」
		// 降级文案，先探测再降级既有约定）。TLS 运行态注入供携密核对仪式的
		// certinfo 端点（P-20261024-3，share 模块同款组合根传递）
		{syncapi.NewModule(cfg, rt.TLSOn, rt.CertFile), kernel.Manifest{
			Name:         "sync",
			Title:        "多实例同步",
			Routes:       manifestRoutes(routes, "sync"),
			Topics:       []string{"sync.progress"},
			Capabilities: []string{"sync"},
		}},
		// 对比实验（P-20261003-46）：双 agent 同题竞写——双开发起（复用
		// LaunchAgentSession）+ 完成监听（复用完成链观察者）+ 产出并集三分类 +
		// 采用标注；回执落位广播 experiment.changed（P-20261004-33）
		{compareexp.NewModule(), kernel.Manifest{
			Name:   "compareexp",
			Title:  "对比实验",
			Routes: manifestRoutes(routes, "compareexp"),
			Topics: []string{opschannel.EventTaskProgress, opschannel.EventExperimentChanged},
		}},
		// 会话接续链（P-20261004-38）：事件触发的 agent 串行接力——链源会话
		// 完成链终态命中链定义即自动拉起下一棒（LaunchAgentSession 同层复用，
		// CRUD 路由在 /api/agent-chains；触发成功广播 chain.triggered）
		{agentchain.NewModule(), kernel.Manifest{
			Name:   "agentchain",
			Title:  "会话接续链",
			Routes: manifestRoutes(routes, "agentchain"),
			Topics: []string{opschannel.EventTaskProgress, opschannel.EventChainTriggered},
		}},
		// 会话间定向消息（P-20261004-68）：agent↔agent 定向通信——投递/拉取
		// 端点（/api/ops-message，POST 直驱广播 terminal.message，GET 拉取即读
		// 广播 terminal.message.read）+ 收件箱 TTL 小时级巡检
		{opsmessage.NewModule(), kernel.Manifest{
			Name:   "opsmessage",
			Title:  "会话间定向消息",
			Routes: manifestRoutes(routes, "opsmessage"),
			Topics: []string{opschannel.EventTerminalMessage, opschannel.EventTerminalMessageRead},
		}},
		// 文件分享：独立端口子服务（匿名访客的预览/下载）+ /api/share 管理面。
		// 传输配置沿用主服务已解析的 TLS 结果；启动失败降级告警不阻断主服务
		{shareapi.NewModule(cfg, rt.TLSOn, rt.CertFile, rt.KeyFile), kernel.Manifest{
			Name:  "share",
			Title: "文件分享",
			// extra /s/:token：访客短链子服务独立端口自起监听（server/share），
			// 不在主引擎路由表，推导覆盖不了（对账白名单豁免）
			Routes: manifestRoutes(routes, "share", "/s/:token"),
		}},
		// 快投递（P-20261006-51）：手机/脚本 → 工作台的投递原语与收件箱
		// 保留策略巡检（端点公开注册、凭据即门禁）
		{quickdrop.NewModule(), kernel.Manifest{
			Name:   "quickdrop",
			Title:  "快投递",
			Routes: manifestRoutes(routes, "quickdrop"),
		}},
		{newRuntimeOpsModule(cfg), kernel.Manifest{
			Name:  "runtime-ops",
			Title: "进程运维",
		}},
	}
}

// registerAll 按声明清单注册全部模块。单个注册失败降级为日志告警
// （内核功能缺失不阻断服务启动，与历史 watch 注册降级语义一致）
func registerAll(k *kernel.StdKernel, regs []registration) {
	for _, r := range regs {
		if err := k.Register(r.module, r.manifest); err != nil {
			slog.Warn("kernel register module failed", "module", r.manifest.Name, "err", err)
		}
	}
}
