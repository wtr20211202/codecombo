// Package errmarkers 对外稳定错误标记注册表（P-20261004-29）。
//
// 分工注记（与 server/api/shared/errors.go 相邻不合并）：errors.go 是结构化
// 错误码体系（点分 code 程序化分支，P-20261003-305 起渐进迁移）；本包是错误
// **文本标记**体系——服务端把稳定英文原文埋进 error 文本/响应 message，前端
// KNOWN_ERROR_I18N（web/src/api/http.ts）与 remoteErrors（web/src/utils/
// remoteErrors.ts）按正则子串匹配映射为本地化文案。两套并存：未迁移端点靠
// 文本标记承载人读体验，已迁移端点的 code 分支与文本映射互不替代。
//
// 动机：这条链此前纯靠注释纪律——服务端重排文案即前端正则静默失配（用户看到
// 英文原文，staleIndexLock 一键修复条等联动功能整条静默死掉）。本包把散落各
// 包的标记常量收拢为唯一事实源（origin 包保留同名别名/同值变量，调用方零改动、
// 行为零变化），并配跨端同步守卫 web/scripts/check-errmarkers.mjs
// （npm run check:errmarkers，挂 check/check:fast 尾链，沿 P-144/P-187 先例）：
// Go 声明的 marker 无前端正则匹配 = ERROR；前端正则未引用任何已声明 marker
// = WARN（存量注记见 web/scripts/errmarkers-baseline.json）。
//
// 约定：
//   - KindEmitted：服务端代码主动发射的标记。Text 常量必须被 server/ 内至少
//     一处发射点引用（守卫做引用盘点，未引用 = WARN）；含 %s/%d/%v 占位的
//     fmt 模板标记 Text 存模板原文，守卫以「占位符实例化」后的文本对前端正则
//     测试（%s→xx、%d→1、%v→err）。
//   - KindExternal：文本来自仓外系统（git 自身 / OS 网络栈 / ssh 库），仓内
//     无单一发射点，登记仅为前端正则提供对账锚——正则改丢即暴露。
//   - LocaleKey：前端映射目标 i18n 键，必须存在于 zh-CN 与 en-US 两 locale
//     （守卫校验，防拼错静默回退原文）。
//   - 改任何 Text 前先同步前端正则；守卫红即两侧失配，修一侧必须同步另一侧。
//     新增标记：const 块加一行 + Registry 加一行（守卫按行解析，勿换行书写）。
package errmarkers

// Kind 标记来源类别（注册表元数据，见包注释约定）
type Kind string

const (
	// KindEmitted 服务端代码主动发射（发射点引用注册表常量）
	KindEmitted Kind = "Emitted"
	// KindExternal 仓外系统原文（git/OS/ssh 库），前端正则的对账锚
	KindExternal Kind = "External"
)

// Marker 单条对外稳定标记：文本 + 前端映射键 + 来源类别
type Marker struct {
	// Symbol Go 常量名（KindExternal 时为描述性名），报告归因到注册点
	Symbol string
	// Text 稳定英文标记原文（对外契约，唯一事实源；fmt 模板含占位符原文）
	Text string
	// LocaleKey 前端 KNOWN_ERROR_I18N / remoteErrors 映射的 i18n 键
	LocaleKey string
	// Kind 来源类别（KindEmitted / KindExternal）
	Kind Kind
	// Note 语义注记（来源提案/联动功能）
	Note string
}

// 稳定标记文本常量——唯一事实源。origin 包以别名引用（如
// git.IndexLockStaleMarker = errmarkers.IndexLockStale），勿在包外重写字面量。
const (
	// git 层（写队列 / 遗留锁 / hunk / 冲突 / rebase / stash）
	IndexLockStale         = "stale git index lock detected"
	GitWriteBusy           = "another git write operation is still in progress"
	GitGateBusy            = "too many concurrent git operations"
	HunkDiscardConflict    = "hunk no longer applies"
	ConflictStale          = "conflict file was modified externally since it was loaded"
	RebaseAbortedPrefix    = "rebase failed (working tree restored via rebase --abort)"
	StashStagedUnsupported = "stash --staged requires git 2.35 or newer"
	StashEntryGone         = "stash entry no longer exists"
	BranchExistsTemplate   = "git branch '%s' already exists"
	ChangelistExists       = "changelist already exists"

	// 项目硬锁 / 部署 / 对比实验
	ProjectLocked          = "project.locked"
	DeployHostBusyTemplate = "deploy already in progress for this host (task %s), wait or cancel it"
	LogExpired             = "deploy log expired"
	ApplyConflict          = "compare experiment workspace changed since adoption"
	ReplaceBackupStale     = "replace backup no longer applies"

	// SSH / 认证
	HostKeyChanged       = "host key has changed"
	AuthRejectedPrefix   = "auth rejected by remote server"
	AuthenticationFailed = "authentication failed"
	AuthHeaderInvalid    = "invalid authorization header format"
	TooManyAuthFailures  = "too many authentication failures"

	// agent runtime 预检（fmt 模板，运行时名经前端正则捕获组进插值参数）
	PrecheckRuntimeMissingTemplate = "runtime %s is not installed or not in the service process PATH"
	PrecheckVersionCheckTemplate   = "runtime %s failed version quick check"

	// 克隆预检 / 排队指令
	CloneDestExists = "destination directory already exists and is not empty"
	CloneURLInvalid = "invalid clone URL"
	QueueFull       = "queue is full (max 5)"
	QueueInvalid    = "instruction is empty or too long (max 2000 chars)"

	// 冻结分享体积护栏
	FrozenTooLarge = "share too large to freeze (limit 200MB), use live mode instead"
	FrozenQuota    = "share snapshot store is full (total limit reached), revoke old frozen shares or use live mode"

	// 会话回放分享体积护栏（P-20261004-103）
	ReplayTooLarge = "recording replay too large to share (limit 200MB)"

	// 在系统中显示（headless / Linux 打开器）
	RevealNoDisplay       = "no display environment available for reveal"
	RevealXdgMissing      = "xdg-open is not available on this system (install xdg-utils)"
	RevealXdgExitTemplate = "xdg-open exited with %d — is a file manager installed?"

	// 内容搜索限流（429 响应体 error 字段即原文，P-20261004-124）
	SearchRateLimited = "search rate limited"

	// 中心更新 / 远程不可达 / 会话忙 / ws 上限
	UpdateSourceNotConfigured   = "update source not configured"
	UpdateNpmManaged            = "installed via npm — update with: npm i -g codecombo@latest"
	CenterBinaryMissingTemplate = "binary not found for %s/%s"
	RemoteUnreachable           = "remote unreachable"
	SessionBusy                 = "session busy"
	MaxWsConnections            = "max websocket connections reached"
	WrongPassphraseExport       = "wrong passphrase or corrupted export file"

	// 手动携密同步（P-20261024-3）：三道服务端硬面的稳定原文（前端
	// KNOWN_ERROR_I18N 映射 + e2e 断言锚点）。EnvelopeRejected 统一篡改/
	// 重放/配对钥不配三类失败文案（防 oracle：不给中间人区分失败原因的回声）
	CredSyncUnverified       = "credential sync requires pairing and fingerprint verification"
	CredSyncEnvelopeRejected = "credential sync envelope rejected"
	CredSyncManualOnly       = "credential sync is manual-only (scheduled sync never carries credentials)"
)

// Registry 全量对外稳定标记。前端正则表（KNOWN_ERROR_I18N / remoteErrors）
// 的对账基准——每行单行书写供守卫按行解析，Text 引用上方常量（KindExternal
// 为字面量）。新增/改动须经 npm run check:errmarkers 红绿验证。
var Registry = []Marker{
	// ── git 层 ──
	{Symbol: "IndexLockStale", Text: IndexLockStale, LocaleKey: "errors.known.staleIndexLock", Kind: KindEmitted, Note: "P-20261002-150 遗留 index.lock 检出，前端联动变更面板一键修复条"},
	{Symbol: "GitWriteBusy", Text: GitWriteBusy, LocaleKey: "errors.known.gitWriteBusy", Kind: KindEmitted, Note: "P-20261002-78 写串行队列等待 30s 超时，命令未执行"},
	{Symbol: "GitGateBusy", Text: GitGateBusy, LocaleKey: "errors.known.gitGateBusy", Kind: KindEmitted, Note: "P-20261004-125 全局并发门排队 20s 超时，命令未执行（进程总量防线，与写队列 per-repo 互斥互补）"},
	{Symbol: "HunkDiscardConflict", Text: HunkDiscardConflict, LocaleKey: "errors.known.hunkChanged", Kind: KindEmitted, Note: "P-20261003-49 hunk 逆向 apply 上下文失配，安全失败"},
	{Symbol: "ConflictStale", Text: ConflictStale, LocaleKey: "errors.known.conflictStale", Kind: KindEmitted, Note: "P-20261004-27 冲突写回 baseHash 乐观锁失配"},
	{Symbol: "RebaseAbortedPrefix", Text: RebaseAbortedPrefix, LocaleKey: "errors.known.rebaseConflictAborted", Kind: KindEmitted, Note: "P-20261003-324 交互式 rebase 失败已自动 abort 还原"},
	{Symbol: "StashStagedUnsupported", Text: StashStagedUnsupported, LocaleKey: "errors.known.stashStagedUnsupported", Kind: KindEmitted, Note: "P-20261003-119 scope=staged 需 git 2.35+ 的降级拒绝"},
	{Symbol: "StashEntryGone", Text: StashEntryGone, LocaleKey: "errors.known.stashEntryGone", Kind: KindEmitted, Note: "P-20261003-264 hash 稳定引用指向的 stash 条目已不在当前栈（drop/pop 后旧 hash 明确拒绝不错位）"},
	{Symbol: "BranchExistsTemplate", Text: BranchExistsTemplate, LocaleKey: "errors.known.branchExists", Kind: KindEmitted, Note: "P-20261003-263 stash 应用到新分支的预检拒绝（%s=分支名）"},
	{Symbol: "ChangelistExists", Text: ChangelistExists, LocaleKey: "errors.known.changelistExists", Kind: KindEmitted, Note: "P-20261007-19 变更列表同作用域重名新建拒绝"},
	{Symbol: "GitBranchExistsRace", Text: "a branch named 'xx' already exists", LocaleKey: "errors.known.branchExists", Kind: KindExternal, Note: "预检与执行间竞态时 git 自身报错原文，与前条同一正则族"},

	// ── 项目硬锁 / 部署 / 对比实验 ──
	{Symbol: "ProjectLocked", Text: ProjectLocked, LocaleKey: "errors.known.projectLocked", Kind: KindEmitted, Note: "P-20261004-3 项目硬锁；与 P-305 结构化 code project.locked 同串双契约"},
	{Symbol: "DeployHostBusyTemplate", Text: DeployHostBusyTemplate, LocaleKey: "deploy.mutex.busy", Kind: KindEmitted, Note: "P-20261003-41 同主机部署串行互斥（%s=持锁任务 ID）"},
	{Symbol: "LogExpired", Text: LogExpired, LocaleKey: "deploy.logDownload.expired", Kind: KindEmitted, Note: "P-20261003-142 部署日志 1h 内存窗外 410"},
	{Symbol: "ApplyConflict", Text: ApplyConflict, LocaleKey: "errors.known.compareApplyConflict", Kind: KindEmitted, Note: "P-20261004-72 对比实验采用落盘指纹对账失配"},
	{Symbol: "ReplaceBackupStale", Text: ReplaceBackupStale, LocaleKey: "errors.known.replaceRestoreConflict", Kind: KindEmitted, Note: "P-20261004-66 替换历史还原 apply 段失配（暂存区被推进），工作区已归暂存区态"},

	// ── SSH / 认证 ──
	{Symbol: "HostKeyChanged", Text: HostKeyChanged, LocaleKey: "errors.known.hostKeyChanged", Kind: KindEmitted, Note: "P-20261003-34 TOFU 主机指纹变更拒绝，remoteErrors 同key映射"},
	{Symbol: "AuthRejectedPrefix", Text: AuthRejectedPrefix, LocaleKey: "errors.known.authFailed", Kind: KindEmitted, Note: "ssh/ftp dial 认证被拒统一前缀（sshclient/ftpclient 双发射点）"},
	{Symbol: "AuthenticationFailed", Text: AuthenticationFailed, LocaleKey: "errors.known.authFailed", Kind: KindEmitted, Note: "TokenAuth 401 原文；实例探活也按此串识别远端 401"},
	{Symbol: "AuthHeaderInvalid", Text: AuthHeaderInvalid, LocaleKey: "errors.known.lockTokenInvalid", Kind: KindEmitted, Note: "Authorization 头形态非法"},
	{Symbol: "TooManyAuthFailures", Text: TooManyAuthFailures, LocaleKey: "errors.known.authTooMany", Kind: KindEmitted, Note: "认证失败限频 429（与 OpenSSH 同名原文共用正则）"},
	{Symbol: "UnableToAuthenticate", Text: "unable to authenticate", LocaleKey: "errors.known.authFailed", Kind: KindExternal, Note: "ssh 库底层原文，sshclient 检出后包 AuthRejectedPrefix"},

	// ── agent runtime 预检 ──
	{Symbol: "PrecheckRuntimeMissingTemplate", Text: PrecheckRuntimeMissingTemplate, LocaleKey: "agent.runtime.errorMissing", Kind: KindEmitted, Note: "P-20261003-79 运行时缺失（%s=注册名，前端捕获组插值）"},
	{Symbol: "PrecheckVersionCheckTemplate", Text: PrecheckVersionCheckTemplate, LocaleKey: "agent.runtime.errorVersionCheck", Kind: KindEmitted, Note: "P-20261003-79 版本快检失败（详情形态为该模板 + \": %v\"）"},

	// ── 克隆预检 / 排队指令 ──
	{Symbol: "CloneDestExists", Text: CloneDestExists, LocaleKey: "clone.destExists.label", Kind: KindEmitted, Note: "P-20261003-26 目标目录非空预检"},
	{Symbol: "CloneURLInvalid", Text: CloneURLInvalid, LocaleKey: "clone.urlInvalid.label", Kind: KindEmitted, Note: "P-20261003-70 克隆 URL 形态预检"},
	{Symbol: "QueueFull", Text: QueueFull, LocaleKey: "errors.known.queueFull", Kind: KindEmitted, Note: "P-20261003-248 排队指令满队 409"},
	{Symbol: "QueueInvalid", Text: QueueInvalid, LocaleKey: "errors.known.queueInvalid", Kind: KindEmitted, Note: "P-20261003-248 排队指令空/超长 400"},

	// ── 冻结分享 ──
	{Symbol: "FrozenTooLarge", Text: FrozenTooLarge, LocaleKey: "share.frozen.tooLarge", Kind: KindEmitted, Note: "P-20261003-320 冻结快照单份 200MB 护栏 413"},
	{Symbol: "FrozenQuota", Text: FrozenQuota, LocaleKey: "share.frozen.quotaFull", Kind: KindEmitted, Note: "P-20261003-320 冻结快照库总量触顶 413"},

	// ── 会话回放分享 ──
	{Symbol: "ReplayTooLarge", Text: ReplayTooLarge, LocaleKey: "share.cast.tooLarge", Kind: KindEmitted, Note: "P-20261004-103 回放 cast 快照单份 200MB 护栏 413"},

	// ── 在系统中显示 ──
	{Symbol: "RevealNoDisplay", Text: RevealNoDisplay, LocaleKey: "errors.known.noDisplay", Kind: KindEmitted, Note: "P-20261003-323 headless 501 明确语义"},
	{Symbol: "RevealXdgMissing", Text: RevealXdgMissing, LocaleKey: "errors.known.xdgOpenMissing", Kind: KindEmitted, Note: "P-20261003-323 Linux xdg-open 缺失（unix 构建分支）"},
	{Symbol: "RevealXdgExitTemplate", Text: RevealXdgExitTemplate, LocaleKey: "errors.known.xdgOpenMissing", Kind: KindEmitted, Note: "P-20261003-323 Linux 打开器退出非零（%d=退出码）"},

	// ── 内容搜索限流 ──
	{Symbol: "SearchRateLimited", Text: SearchRateLimited, LocaleKey: "errors.known.searchRateLimited", Kind: KindEmitted, Note: "P-20261004-124 内容搜索限流 429（git grep 子进程风暴防线），与 code search.rate_limited 成对附挂"},

	// ── 中心更新 / 远程 / 会话 / ws ──
	{Symbol: "UpdateSourceNotConfigured", Text: UpdateSourceNotConfigured, LocaleKey: "errors.known.centerNoUpdateSource", Kind: KindEmitted, Note: "从中心更新：中心未配置更新源 404（update/api 双发射点）"},
	{Symbol: "UpdateNpmManaged", Text: UpdateNpmManaged, LocaleKey: "errors.known.updateNpmManaged", Kind: KindEmitted, Note: "npm 分发形态拒绝自更新 409（P-20261102-2：node_modules 归 npm 管，防版本记账漂移），update api 单发射点"},
	{Symbol: "CenterBinaryMissingTemplate", Text: CenterBinaryMissingTemplate, LocaleKey: "errors.known.centerBinaryMissing", Kind: KindEmitted, Note: "从中心更新：更新源无该平台包 404"},
	{Symbol: "RemoteUnreachable", Text: RemoteUnreachable, LocaleKey: "errors.known.netUnreachable", Kind: KindEmitted, Note: "对端实例/代理不可达稳定前缀（dispatch/proxy 双发射点）"},
	{Symbol: "SessionBusy", Text: SessionBusy, LocaleKey: "errors.known.sessionBusy", Kind: KindEmitted, Note: "远程主机终端会话回复中 409"},
	{Symbol: "MaxWsConnections", Text: MaxWsConnections, LocaleKey: "errors.known.wsLimit", Kind: KindEmitted, Note: "ws 连接数上限 503"},
	{Symbol: "WrongPassphraseExport", Text: WrongPassphraseExport, LocaleKey: "errors.known.wrongPassphrase", Kind: KindEmitted, Note: "凭据导出文件口令解密失败 400（handler 侧对外原文）"},
	{Symbol: "CredSyncUnverified", Text: CredSyncUnverified, LocaleKey: "errors.known.credSyncUnverified", Kind: KindEmitted, Note: "P-20261024-3 携密同步未完成配对/指纹短码核对（428 前置仪式面）"},
	{Symbol: "CredSyncEnvelopeRejected", Text: CredSyncEnvelopeRejected, LocaleKey: "errors.known.credSyncEnvelope", Kind: KindEmitted, Note: "P-20261024-3 携密信封拒绝（篡改/重放/配对钥不配统一文案防 oracle）"},
	{Symbol: "CredSyncManualOnly", Text: CredSyncManualOnly, LocaleKey: "errors.known.credSyncManualOnly", Kind: KindEmitted, Note: "P-20261024-3 定时路径携密服务端硬拒（红线守卫，配置漂移也打不破）"},

	// ── 仓外原文（OS 网络栈 / ssh 库，remoteErrors 兜底映射） ──
	{Symbol: "ConnRefused", Text: "connection refused", LocaleKey: "errors.known.connRefused", Kind: KindExternal, Note: "OS 网络栈原文，两表同 key 映射"},
	{Symbol: "NoRouteToHost", Text: "no route to host", LocaleKey: "errors.known.netUnreachable", Kind: KindExternal, Note: "OS 网络栈原文"},
	{Symbol: "IOTimeout", Text: "i/o timeout", LocaleKey: "errors.known.netUnreachable", Kind: KindExternal, Note: "OS 网络栈原文"},
	{Symbol: "PermissionDenied", Text: "permission denied", LocaleKey: "errors.known.permissionDenied", Kind: KindExternal, Note: "ssh/OS 原文，remoteErrors 映射"},
	{Symbol: "NoSupportedMethods", Text: "no supported methods remain", LocaleKey: "errors.known.authFailed", Kind: KindExternal, Note: "ssh 库认证协商失败原文，remoteErrors 映射"},
}
