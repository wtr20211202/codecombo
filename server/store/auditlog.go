package store

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"sync/atomic"
	"time"

	"codecombo/server/config"
	"codecombo/server/mask"

	"github.com/google/uuid"
)

// 审计结果常量（success = 动作成功；failure = 动作失败，如密码错；
// denied = 未进入动作即被拒，如限流命中）
const (
	AuditResultSuccess = "success"
	AuditResultFailure = "failure"
	AuditResultDenied  = "denied"
)

// 审计动作常量（kind.action 点分式；前端 i18n audit.action.<同 key> 一一对应）。
// 只记动作与元数据（名称/数量/host 等），绝不记内容（密码/令牌值/密钥材料）
const (
	AuditUnlock              = "lock.unlock"              // 解锁成功/失败（含限流命中）
	AuditLockSetup           = "lock.setup"               // 首次设置密码
	AuditLockConfig          = "lock.config"              // 锁定配置修改
	AuditLockPassword        = "lock.password"            // 锁定密码修改
	AuditTokenCreate         = "token.create"             // API token 签发
	AuditTokenRevoke         = "token.revoke"             // API token 撤销
	AuditAgentRotated        = "agenttoken.rotate"        // agent token 轮换
	AuditAgentRevoke         = "agenttoken.revoke"        // agent token 撤销
	AuditCredSave            = "credential.save"          // Git 凭据新增/更新
	AuditCredDelete          = "credential.delete"        // Git 凭据删除
	AuditSSHKeyGenerate      = "sshkey.generate"          // SSH key 生成
	AuditSSHKeyImport        = "sshkey.import"            // SSH key 导入
	AuditSSHKeyDelete        = "sshkey.delete"            // SSH key 删除
	AuditHostCreate          = "remotehost.create"        // 远程主机新增
	AuditHostUpdate          = "remotehost.update"        // 远程主机更新
	AuditHostDelete          = "remotehost.delete"        // 远程主机删除
	AuditHostExport          = "remotehost.export"        // 远程主机凭据导出
	AuditHostImport          = "remotehost.import"        // 远程主机凭据导入
	AuditHostTunnel          = "remotehost.tunnel"        // SSH 隧道开关（远端端口本地转发）
	AuditHostKeyReset        = "hostkey.reset"            // SSH 主机指纹重置（合法迁移重新 TOFU）
	AuditHostKeyMismatch     = "hostkey.mismatch"         // SSH 主机密钥变更拒绝（可能中间人）
	AuditShareCreate         = "share.create"             // 分享创建
	AuditShareView           = "share.view"               // 分享访客访问留痕（P-20261003-257，出域访问审计链）
	AuditShareRevoke         = "share.revoke"             // 分享撤销
	AuditShareRotate         = "share.rotate"             // 分享短链轮换（泄露应对）
	AuditShareRefresh        = "share.refresh"            // 冻结分享原地刷新（保 token 换内容，P-20261005-177）
	AuditShareExpiry         = "share.expiry"             // 分享有效期调整（opt-in TTL）
	AuditSharePassphrase     = "share.passphrase"         // 分享访问口令门设置/更换/移除（P-20261006-25）
	AuditShareMsg            = "share.msg"                // 访客留言管理（单删/清空，P-20261006-13）
	AuditShareRetiredHit     = "share.retiredHit"         // 退役短链仍被访问的外泄观测（P-20261008-2；Detail 记展示名/退役 token/累计命中元数据）
	AuditShareDrop           = "share.drop"               // 访客协作素材上行（P-20261024-1；Detail 记分享/文件名/大小/昵称元数据，内容不入账）
	AuditShareCollab         = "share.collab"             // 协作通道开关（P-20261024-1 行内动作；Detail 记 on/off）
	AuditShareDropConsume    = "share.drop_consume"       // 协作素材标记已消费（交给会话即标，TTL 消费语义的落盘点）
	AuditShareDirectGrant    = "share.direct.grant"       // 直通输入权授予（P-20261024-1 握手批准；Detail 记 visitorId 摘要/会话/时效元数据）
	AuditShareDirectRevoke   = "share.direct.revoke"      // 直通输入权收回（owner 一键/超时/关闭级联共用；Detail 记缘由元数据）
	AuditShareDirectInput    = "share.direct.input"       // 直通输入批次（P-20261024-1；全量批次入账只记长度/visitorId 摘要元数据，文本不入账）
	AuditShareWritable       = "share.writable"           // 可写分享开关（P-20261106-8 单条/批量动作；Detail 记 on/off/批量摘要——泄露半径抬升到 shell 面，开/关全程留痕）
	AuditShareWritableInput  = "share.writableInput"      // 可写分享访客输入批次（P-20261106-8；quickdrop 同口径只记长度/visitorId 摘要/IP 元数据，文本不入账；camelCase 扁平键沿 retiredHit 先例——嵌套点分键会与可写开关动作的 locale 树冲突）
	AuditShareWritablePaste  = "share.writablePaste"      // 可写分享粘贴审批（P-20261106-8；Detail 记批准/拒绝/超时决策与模式摘要元数据，粘贴块不入账）
	AuditWorkspaceExport     = "workspace.export"         // 工作区状态备份导出
	AuditClaudeExport        = "claude.export"            // Claude 会话导出 Markdown（数据出域）
	AuditClaudeBatchZip      = "claude.export_batch"      // Claude 会话批量导出 zip（多选归档，数据出域）
	AuditClaudeHide          = "claude.hide"              // Claude 会话隐藏（索引层清理，文件零触碰）
	AuditClaudeUnhide        = "claude.unhide"            // Claude 会话恢复显示
	AuditFileDelete          = "file.delete"              // 项目文件删除
	AuditFileRename          = "file.rename"              // 项目文件重命名
	AuditFileDuplicate       = "file.duplicate"           // 项目文件创建副本（P-20261004-135）
	AuditFileCopy            = "file.copy"                // 项目文件/目录批量复制（batch copy 形态，P-20261023-2）
	AuditFileDirArchive      = "file.dirarchive"          // 项目目录打包下载（zip 数据出域）
	AuditFileBatchArchive    = "file.batcharchive"        // 项目文件多选批量归档下载（zip 数据出域，P-20261003-250）
	AuditFileRestore         = "file.restore"             // 回收站恢复（P-20261003-304）
	AuditFilePurge           = "file.purge"               // 回收站彻底删除（不可恢复，P-20261003-304）
	AuditNotesDelete         = "notes.delete"             // 笔记软删进回收站（P-20261107-2；P-20261108-3 单库化后即全局笔记库，agent 通道同样只软删可恢复）
	AuditNotesRestore        = "notes.restore"            // 笔记从回收站恢复（全局笔记库，幂等）
	AuditNotesPurge          = "notes.purge"              // 笔记彻底删除（全局笔记库，不可恢复；仅人侧，agent 令牌硬拒）
	AuditNotesMigrated       = "notes.migrated"           // 旧项目笔记并入全局笔记库（P-20261108-3 单库化迁移：每轮一条汇总，Detail 记迁入/滞留计数与触发入口，不逐篇）
	AuditFileSensitiveRead   = "file.sensitive_read"      // 敏感文件读取观测（纯观测不拦截，P-20261003-315）
	AuditFileReplace         = "file.replace"             // 项目批量替换执行（P-20261004-114，只记文件数/处数/备份名元数据）
	AuditFileReplaceRestore  = "file.replace_restore"     // 批量替换历史一键还原（P-20261004-66，只记文件数/历史条目元数据）
	AuditHostFileWrite       = "remotehost.file.write"    // 远程文件编辑器保存回写（跨机写入，留痕）
	AuditProjectDelete       = "project.delete"           // 项目删除（P-20261003-304 顺带补记）
	AuditProjectLock         = "project.lock"             // 项目硬锁上锁（P-20261004-3）
	AuditProjectUnlock       = "project.unlock"           // 项目硬锁解锁（P-20261004-3）
	AuditProjectFileExternal = "project.file.external"    // 敏感文件工作台外写入观测（P-20261005-15，只记项目+路径元数据内容永不如账）
	AuditGitRebase           = "git.rebase"               // 交互式 rebase 历史改写（重排/squash/drop/reword）
	AuditGitMerge            = "git.merge"                // 分支合并（默认/压平 squash，P-20261007-18）
	AuditGitChangelistCreate = "git.changelist.create"    // 变更列表创建（P-20261007-19）
	AuditGitChangelistDelete = "git.changelist.delete"    // 变更列表删除（P-20261007-19）
	AuditGitChangelistShelve = "git.changelist.shelve"    // 变更列表搁置（stash --cached 同链，P-20261007-19）
	AuditLogExport           = "audit.export"             // 审计日志 CSV 导出（窗口全量出域留档）
	AuditLogArchive          = "audit.archive"            // 审计窗口滚动自动归档（过期前转 CSV 落 artifacts，P-20261003-277）
	AuditApprovalExport      = "approval.export"          // 审批裁决历史 CSV 导出（P-20261003-247，裁决留档出域）
	AuditApprovalMode        = "approval.mode"            // 审批档位变更（P-20261005-162 三写点：设置页 PUT / 审批卡 resolve / 24h 到期巡检回 ask——安全姿态变化可追认）
	AuditAgentChainTrigger   = "agentchain.trigger"       // 会话接续链自动拉起下一棒（P-20261004-38）
	AuditOpsMessageSend      = "opsmessage.send"          // 会话间定向消息投递（P-20261004-68，仅 from/to 元数据不记正文）
	AuditCompareExpApply     = "compareexp.apply"         // 对比实验采用落盘（回滚/删除工作区文件，P-20261004-72）
	AuditTerminalQueueSend   = "terminal.queue.send"      // 终端指令队列逐条发送（摘要过 mask；P-20261004-144 起收编字面量为常量，纳入前端 audit.action i18n 对账）
	AuditTerminalBroadcast   = "terminal.broadcast"       // 多终端广播输入（P-20261005-234；targets/written/missing/failed 计数元数据，data 摘要保守截断+过 mask——审批管事前、审计管事后，写侧底账与 queue.send 对称）
	AuditTerminalExport      = "terminal.export"          // 终端会话输出留档导出（P-20261005-186；滚回常含命令回显的凭据/token 形态，敏感度与 claude.export 同族——只记会话名/id/字节量，内容不入账）
	AuditTerminalInputLock   = "terminal.input_lock"      // 接管会话服务端只读闸翻转（P-20261008-17；解锁=放开对用户 tmux 会话的写入，与接管审计同族的安全动作底账——只记会话 id/名称/翻转后状态元数据，agent 令牌解锁另经 AgentGuard 审批）
	AuditPatchExport         = "patch.export"             // Git 补丁导出（P-20261005-186；POST patch/export 与 GET .patch 下载两端口径同账——补丁 = 提交/未提交变更全量内容出域，只记项目名/scope 元数据）
	AuditQuickdropDrop       = "quickdrop.drop"           // 快投递到达入账（P-20261006-51；只记来源 IP/字节量/条目 id 元数据，正文不入账——P-13 纪律同款）
	AuditQuickdropToken      = "quickdrop.token"          // 快投递凭据生成/轮换/撤销（管理动作留痕）
	AuditHookTokenRotate     = "hook.token.rotate"        // 入站 Hook 凭据签发/轮换（P-20261003-23；旧值立即失效，只记动作不记明文）
	AuditHookTokenRevoke     = "hook.token.revoke"        // 入站 Hook 凭据销毁（入站随即全部 401）
	AuditInstanceDispatch    = "instance.dispatch"        // 联邦派发：中心在从实例创建 agent 会话（P-20261004-101，跨实例操作可溯）
	AuditRunbookRun          = "runbook.run"              // 运行书服务端执行（P-20261004-108；仅书/会话/步数元数据，参数值与命令原文不入账）
	AuditFleetRunbookExecute = "fleet.runbook.execute"    // 舰队运行书执行/中止/重试（P-20261005-147；Detail op= 区分，仅书/目标数/格元数据，参数值与命令原文不入账）
	AuditLogPrune            = "audit.prune"              // 审计容量超限自动裁剪摘要（P-20261004-80，系统动作无请求方 IP）
	AuditDeployLogArchive    = "deploy.log.archive"       // 部署日志终态快照留档落盘（P-20261007-8，系统动作；Detail 只记 task/lines 元数据）
	AuditAgentGuardAllow     = "agentguard.allow"         // AgentGuard 高危面 allow 直放行（P-20261006-45 统一审计切面：规则命中与全局档位短路出口，裁决维度）
	AuditAgentGuardDeny      = "agentguard.deny"          // AgentGuard 审批规则 deny 拒绝（P-20261006-45：denied 审批记录之外的审计台账留痕）
	AuditAgentGuardPass      = "agentguard.approval_pass" // AgentGuard 审批通过重试放行（P-20261006-45：X-Approval-ID 一次性消费点）
	AuditCSPViolation        = "security.csp_violation"   // CSP Report-Only 违规聚合观察（P-20261007-6；Detail 只记 directive/blocked 源与计数——document-uri/策略原文/script-sample 不入账）
)

// 多实例项目同步（P-20261023-1）：批量搬运项目与上下文的跨实例写面入账。
// 独立 const 块同上——保持既有常量对齐 diff 不被长名字扰动。
// Detail 只记单元键（跨实例稳定键，非本机绝对路径——路径脱敏 P-203 链同款）
// 与单元数/字节数/冲突数元数据，凭据/令牌/文件内容永不入账。
const (
	AuditSyncPull = "sync.pull" // 从对端拉取单元落地本机（单元数/字节/冲突计数元数据）
	AuditSyncPush = "sync.push" // 推送本端单元到对端（对端结果聚合元数据）
)

// 手动携密同步（P-20261024-3）：凭据档出域/入域双端各入一账。Detail 只记
// 计数元数据（git/sshHosts/sshKeys/deploy/agentToken 枚数、pairFp 短指纹、
// staged 标记）——凭据明文与配对码绝不入账（migration 同红线）。
const (
	AuditSyncCred     = "sync.cred.ctrl" // 控制面（配对轮换/录入/解除/指纹核对确认；.ctrl 段避开与 sync.cred.send/recv 词条树的前缀冲突）
	AuditSyncCredSend = "sync.cred.send" // 发送侧（push 发出 / pull 被对端拉取时服务）
	AuditSyncCredRecv = "sync.cred.recv" // 接收侧（push 对端落位 / pull 发起端落地）
)

// 换机迁移配置包（P-20261003-147）：整机凭据/令牌/设置的批量出域与批量写面
// 入账。Detail 只记模式/块清单/计数元数据（mode/blocks/units/imported）——
// 口令与一切凭据明文绝不入账（remotehost 导出同红线）。
const (
	AuditMigrationExport = "migration.export" // 配置包导出（模式+块清单+单元数元数据）
	AuditMigrationImport = "migration.import" // 配置包导入应用（逐块计数+回滚标记元数据）
)

// 远程接入（SSH 反向隧道，P-20261019-11）：公网入口启停/失败与 TLS 未启用
// 显式确认——把「实例被暴露到任意网络」的裁决与结果留在安全底账。独立
// const 块保持上方既有常量的对齐 diff 不被长名字扰动。
const (
	AuditRemoteAccessStart       = "remoteaccess.tunnel.start" // 启用/切换中继成功
	AuditRemoteAccessStop        = "remoteaccess.tunnel.stop"  // 停止中继（含幂等停止）
	AuditRemoteAccessFail        = "remoteaccess.tunnel.fail"  // 首次建立失败/重连失败
	AuditRemoteAccessTLSInsecure = "remoteaccess.tls_insecure" // TLS 未启用下显式确认暴露风险
)

// 外部 tmux 会话接管与显式终结（P-20261008-16，P-189 落地的安全面收口）：
// 对外部进程的强操作入账——接管=拿走一个用户自起 tmux 会话的全部 IO 视野，
// kill=终止外部进程（多用户共用服务器形态下「谁接管/终结了那个 tmux」是真实
// 审计问题）。close 普通分流=解除接管是非破坏性语义（tmux 会话与进程原样
// 存活可再接管），不入账。独立 const 块同上——保持既有常量对齐 diff 不被
// 长名字扰动。
const (
	AuditTerminalExternalTakeover = "terminal.external.takeover" // 外部 tmux 会话接管（Detail 只记显示名+tmux 会话名元数据）
	AuditTerminalExternalKill     = "terminal.external.kill"     // 外部 tmux 会话显式终结（kill-session 不可逆；Detail 只记会话名元数据）
)

// 导出族记账对账清单（P-20261005-186）：「内容/附件直出的端点必须入账」是
// 出域记账对称性纪律——新增导出端点须同族落常量+入账，并回填本清单防漂移。
// 逐端点核对（写入方 → 动作常量）：
//   - 会话单导 md + jsonl 两分支同入账（api/terminal/claude_sessions.go → claude.export）
//   - 会话批量 zip（api/terminal/claude_sessions_batch.go → claude.export_batch）
//   - 终端会话输出留档 txt（api/terminal/terminal_export.go → terminal.export）
//   - Git 补丁导出 POST patch/export + GET .patch 附件下载（api/gitops/patch.go → patch.export）
//   - 目录打包 zip / 多选批量归档 zip（api/files/archive.go / archive_batch.go → file.dirarchive / file.batcharchive）
//   - 工作区状态备份（api/system/ui_state.go → workspace.export）
//   - 远程主机凭据导出（api/remote/remotehost.go → remotehost.export）
//   - 审计 CSV / 裁决历史 CSV（api/system/audit.go / api/ai/opsconfirm_export.go → audit.export / approval.export）
// 边界注记：单文件下载 GET file/download 是预览同族的例行读取面（高频逐次
// 入账会把台账刷成噪声，P-54 显式导出才入账的取舍同 ui_state 导出端点注释），
// 其敏感面由 file.sensitive_read 观测兜底；分享访客面走 share.view 留痕。

// AuditEvent 安全事件审计条目：只记动作与元数据，绝不记内容
// （不含密码/令牌值/密钥材料——Detail 只放名称/host/数量等摘要）
type AuditEvent struct {
	ID     string    `json:"id"`
	Time   time.Time `json:"time"`
	Action string    `json:"action"`
	Result string    `json:"result"`
	IP     string    `json:"ip,omitempty"`
	// Rid 请求关联 ID（P-20261006-53，middleware.RequestID 同款短码）：审计是
	// 「谁在何时做了什么」的权威记录，rid 让审计条目与访问日志/响应头/前端
	// 错误条三方对齐——排障从审计条目直跳同请求的日志上下文，agent 修复链
	// 也可据 rid 检索后端日志（errorLog 交付智能体同款）。结构化字段而非拼进
	// Detail：Detail 是语言中立摘要 + 入账脱敏面，rid 混入会被 mask 管线无关
	// 扫描且列化展示/检索都要再解析。gin handler 写入方经 middleware.AuditAppend
	// 中央口自动注入；无请求上下文的写入方（后台任务/巡检）留零值不填。
	// json 可选 + omitempty：存量记录无该键零值读回，旧消费者忽略新键，零迁移
	Rid string `json:"rid,omitempty"`
	// Detail 动作摘要（名称/host/数量等语言中立元数据）；不含任何秘密值
	Detail string `json:"detail,omitempty"`
}

// AuditLogStore 安全事件审计日志（append-only）：事件只增不改不删（保留
// 策略统一裁剪）。Append 尽力而为——写失败仅记日志，绝不向上传播，审计
// 不得阻断业务路径；失败不静默于日志：WriteFailures 计数让断链可见
// （P-20261003-205，best-effort 语义不变）。
//
// 双写入口径（P-20261006-53）：gin handler 的写入一律走
// middleware.AuditAppend(c, e) 中央口（自动注入请求关联 ID 到 Rid 字段）；
// 裸 Append 仅限无请求上下文的写入方（后台任务/巡检/SSH 回调等），此类
// 条目 Rid 留零值——两口的适用面在各自身上注释明示，新增审计点先看调用
// 现场有没有 *gin.Context 再选口
type AuditLogStore interface {
	Append(e AuditEvent)
	// List 按时间倒序分页（limit<=0 视为默认页大小，offset 越界返回空页）
	List(limit, offset int) ([]AuditEvent, int, error)
	// ListCursor 键集游标分页（P-20261003-223）：按 (Time, ID) 复合键倒序，
	// 返回严格旧于锚点 (afterTime, afterID) 的至多 limit 条；afterTime 零值 =
	// 从头取。游标锚在条目本身而非位置——翻页间隙新增的更新事件不会移动后续
	// 窗口（offset 分页的重复/漏读形态由此根治），深翻也不随 offset 线性多扫。
	// limit<=0 视为默认页大小；total 恒为全量（前端「共 N 条」口径同 List）
	ListCursor(limit int, afterTime time.Time, afterID string) ([]AuditEvent, int, error)
	// CleanupBefore 删除 Time 早于 before 的条目，返回删除数。
	// append 型 kind 必须带保留策略（持久化纪律）
	CleanupBefore(before time.Time) (int, error)
	// EnforceMaxEntries 条数上限第二道闸（P-20261004-80）：条数超过 max 时按
	// 时间序删最旧至恰好 max 条，返回删除数。保留语义由此显式为
	// 「时间窗 AND 条数上限」——超量时窗口内更早的条目也走（诚实边界：有效
	// 保留 = min(时间窗, 最新 N 条)，审计面板顶部有对应弱提示）。max<=0 =
	// 闸门关闭不裁剪（防调用方传脏值清库）。条数代理字节：file-per-doc 一条
	// 一个小 JSON 文件，条数上限即文件数与磁盘字节的近似上界（不逐文件称重，
	// 巡更成本换近似保证的取舍）。超量清理自身入账一条 audit.prune 摘要——
	// 防清库无痕的自我保护
	EnforceMaxEntries(max int) (int, error)
	// WriteFailures 审计写失败可见性计数：本进程生命周期内 Append 失败的
	// 累计条数 + 最近一次失败时间（零值 = 从未失败）。内存态，重启清零；
	// 消费方是健康摘要与审计面板的「审计写失败 N 条」警示
	WriteFailures() (count int64, last time.Time)
}

// auditLogKind 文档存储 kind 名
const auditLogKind = "auditlog"

// auditMask 脱敏替换文本。审计不沿用 terminal_history 的「命中整条跳过」语义：
// 跳过丢失「发生过什么」，审计要求留痕——值段原地替换保留「发生但不带值」
const auditMask = "***"

// auditMaskAssignRe 凭据赋值形态：敏感键名（词表与 terminal_history 的
// sensitiveCmdRe 同源 sensitiveKeyPat，勿分叉）后接 =/: 的取值段——键名与
// 分隔符保留（$1），值（双引号/单引号/裸词三形态）整段替换。键名侧起始边界
// 用 (^|[^A-Za-z0-9]) 而非 \b 或 mask 包模式②的 [^A-Za-z0-9_]：DB_PASSWORD/
// MY_TOKEN 这类下划线复合 env 形态里 \b 在 `_`→字母间不成立、`_` 本身又是
// 键名内分隔符——按字母数字定边界才能罩住最典型的泄露形态；字母数字紧邻
// （xpassword=）不算键名起点防误吞。\w* 后缀吞并 token123/API_KEY_2 变体
// （与 terminal 同口径）；值段在空白/逗号/分号/引号处截断。路径类正常文本
// （file=/x/token.txt——token 后无 =/:）不构成赋值形态，零误伤
var auditMaskAssignRe = regexp.MustCompile(
	`(?i)((^|[^A-Za-z0-9])(?:` + sensitiveKeyPat + `)\w*[ \t]*[=:][ \t]*)("[^"]*"|'[^']*'|[^\s"',;]+)`)

// auditMaskValueRe 裸凭据值形态：不带键名直接出现的定长云密钥（词表同源
// sensitiveValuePat）——无论是否在赋值右侧都整段替换
var auditMaskValueRe = regexp.MustCompile(`\b(?:` + sensitiveValuePat + `)\b`)

// MaskAuditDetail 审计 Detail 入账脱敏（Append 层统一守卫，全部现存与未来
// 写入方单点覆盖）：命中凭据赋值形态/裸云密钥时值段替换为 ***，其余原样
// 保留；链尾并入自定义敏感模式（P-20261006-11，mask 包注册表——用户表达
// 的项目自有 secret 形态，命中段整段替换，空列表零变化）。写入纪律仍是
// 源头禁带（Detail 只放名称/host/计数元数据），本函数是兜底不是白名单。
// 导出供测试与未来 API 层预检复用。量级：Append 是人操作级低频写路径，
// 两次小正则 + 自定义清单（≤32 条）单趟扫描成本可忽略
func MaskAuditDetail(detail string) string {
	detail = auditMaskAssignRe.ReplaceAllString(detail, "${1}"+auditMask)
	detail = auditMaskValueRe.ReplaceAllString(detail, auditMask)
	return mask.MaskCustom(detail)
}

// AuditRetention 审计保留窗口的默认值：30 天足够回答「昨晚是不是有人在试我
// 密码」，更久的历史由外部系统日志承担（与 deploytasks/agentapproval 同窗）。
// P-20261003-123 起保留期可经 settings.auditRetentionDays 调整（合规留档调长 /
// 磁盘紧张调短）——实际裁剪点（system 模块每日 ticker）与导出窗口上限读配置
// 生效值，本常量降级为「默认值 + 测试基准」，与 config.DefaultAuditRetentionDays
// 单源绑定防漂移
const AuditRetention = time.Duration(config.DefaultAuditRetentionDays) * 24 * time.Hour

// MaxAuditEntries 审计条数上限第二道闸的阈值（P-20261004-80）：时间窗之外的
// 第二道保留闸。高频审计源（暴力解锁逐条失败、agent 循环触发审计操作）可在
// 30 天窗口内无界增长——磁盘水位告警是事后感知，容量闸是事前防线，安全审计
// 面自身不能成为磁盘耗尽面。10 万条起步：一条数百字节小 JSON，量级在几十 MB，
// 磁盘影响可控；常量可调不进 settings——容量闸是基础设施自保参数而非日常
// 运维调参面（保留天数可配是合规诉求，条数封顶没有）
const MaxAuditEntries = 100000

// auditListDefault List 未指定 limit 时的默认页大小
const auditListDefault = 100

type auditLogRepo struct {
	doc DocumentStore
	// 写失败可见性计数（P-20261003-205）：Append 尽力而为语义下失败不向上
	// 传播，但审计静默丢失 = 审计链断裂不可知（合规场景致命）——内存累计 +
	// 最近失败时间让断裂可被健康面看见。atomic 而非互斥锁：Append 来自各
	// 请求 handler 天然并发，而写是人操作级低频、读是 30s 轮询级，无锁竞争
	// 热点，原子量足够且无死锁面。重启清零：新进程没有「它的」历史可断
	failCount atomic.Int64
	// lastFailUnix 最近一次失败时刻（UnixNano，0 = 从未失败）。time.Time 不
	// 保证原子可读写，捎带存整数、转换收在 WriteFailures/recordWriteFail 两口
	lastFailUnix atomic.Int64
}

// NewAuditLogRepo 构造审计仓储（导出供 store_test 注入独立 DocumentStore，
// 同 NewCredentialRepo 惯例）
func NewAuditLogRepo(doc DocumentStore) AuditLogStore { return &auditLogRepo{doc: doc} }

// Append 实现 AuditLogStore.Append（尽力而为：失败静默记日志，同时计数——
// 断链不向上传播但必须可见）
func (r *auditLogRepo) Append(e AuditEvent) {
	if e.ID == "" {
		e.ID = uuid.NewString()
	}
	if e.Time.IsZero() {
		e.Time = time.Now()
	}
	// 入账前统一脱敏（P-20261005-203）：Detail 是事件里唯一自由文本面，全部
	// 写入方只经这一条写盘通道——兜底在此单点生效，调用方无需各自记得 mask，
	// 下一个带命令原文的写入方也不会把凭据赋值形态明文写进底账
	e.Detail = MaskAuditDetail(e.Detail)
	data, err := json.Marshal(e)
	if err != nil {
		r.recordWriteFail()
		slog.Warn("audit event marshal failed", "action", e.Action, "err", err)
		return
	}
	if err := r.doc.Create(auditLogKind, e.ID, data); err != nil {
		r.recordWriteFail()
		slog.Warn("audit event persist failed", "action", e.Action, "err", err)
	}
}

// recordWriteFail 记一次写失败（累计 +1、刷新最近失败时刻）
func (r *auditLogRepo) recordWriteFail() {
	r.failCount.Add(1)
	r.lastFailUnix.Store(time.Now().UnixNano())
}

// WriteFailures 实现 AuditLogStore.WriteFailures
func (r *auditLogRepo) WriteFailures() (int64, time.Time) {
	last := time.Time{}
	if ns := r.lastFailUnix.Load(); ns != 0 {
		last = time.Unix(0, ns)
	}
	return r.failCount.Load(), last
}

// newerThan 复合序比较：a 是否排在 b 之前（更新一侧）。Time 为主键（新在前），
// 同刻以 ID 降序破平——比较器因此是全序：sort.Slice 对同刻事件不再给出随调用
// 漂移的相对次序（offset 分页两次查询间同刻条目换位的隐患随之消除），且键集
// 谓词（ListCursor）与排序共用这一定义，游标语义才能成立
func newerThan(a, b AuditEvent) bool {
	if !a.Time.Equal(b.Time) {
		return a.Time.After(b.Time)
	}
	return a.ID > b.ID
}

// loadSorted 全目录读取 + 复合序倒排。审计写入低频（人操作级）+ 保留窗口封顶
// 数据量（默认 30 天，可配），全读成本可忽略；无缓存——审计要求所见即所写
// （写入后立即可查）。List 与 ListCursor 共用此读面
func (r *auditLogRepo) loadSorted() ([]AuditEvent, error) {
	keys, _, err := r.doc.List(auditLogKind, ListOpts{})
	if err != nil {
		return nil, err
	}
	events := make([]AuditEvent, 0, len(keys))
	for _, k := range keys {
		data, err := r.doc.Get(auditLogKind, k)
		if err != nil {
			continue
		}
		var e AuditEvent
		if json.Unmarshal(data, &e) != nil {
			continue
		}
		events = append(events, e)
	}
	sort.Slice(events, func(i, j int) bool { return newerThan(events[i], events[j]) })
	return events, nil
}

// List 实现 AuditLogStore.List：倒序全序切片分页
func (r *auditLogRepo) List(limit, offset int) ([]AuditEvent, int, error) {
	events, err := r.loadSorted()
	if err != nil {
		return nil, 0, err
	}
	if limit <= 0 {
		limit = auditListDefault
	}
	if offset < 0 {
		offset = 0
	}
	if offset >= len(events) {
		return []AuditEvent{}, len(events), nil
	}
	end := offset + limit
	if end > len(events) {
		end = len(events)
	}
	return events[offset:end], len(events), nil
}

// ListCursor 实现 AuditLogStore.ListCursor：倒序全序里取严格旧于锚点的页。
// 同刻条目按 ID 破平，锚点条目自身与其同刻更「新」（ID 更大）一侧都排除在
// 页外——它们已在上一页；窗口因此不重，（Time, ID）在事件全域无空隙故不漏。
// 量级注记：读取面本就按保留窗口封顶（loadSorted 全量），键集谓词只是其上的
// 收窄，不引入新量级成本
func (r *auditLogRepo) ListCursor(limit int, afterTime time.Time, afterID string) ([]AuditEvent, int, error) {
	events, err := r.loadSorted()
	if err != nil {
		return nil, 0, err
	}
	total := len(events)
	if limit <= 0 {
		limit = auditListDefault
	}
	page := make([]AuditEvent, 0, limit)
	for _, e := range events {
		if afterTime.IsZero() ||
			e.Time.Before(afterTime) ||
			(e.Time.Equal(afterTime) && e.ID < afterID) {
			page = append(page, e)
			if len(page) == limit {
				break
			}
		}
	}
	return page, total, nil
}

// CleanupBefore 实现 AuditLogStore.CleanupBefore
func (r *auditLogRepo) CleanupBefore(before time.Time) (int, error) {
	keys, _, err := r.doc.List(auditLogKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, k := range keys {
		data, err := r.doc.Get(auditLogKind, k)
		if err != nil {
			continue
		}
		var e AuditEvent
		if json.Unmarshal(data, &e) != nil || e.Time.After(before) {
			continue
		}
		if r.doc.Delete(auditLogKind, k) == nil {
			removed++
		}
	}
	return removed, nil
}

// EnforceMaxEntries 实现 AuditLogStore.EnforceMaxEntries（P-20261004-80）。
// 量级注记：常规路径（未超限）只花一次目录列举即短路返回——这是每日巡更的
// 常态；超限才逐条读时间按 (Time, ID) 复合序倒排（与 List/ListCursor 同一
// 比较器，「最旧」全仓只有一个定义），删到恰好 max 条。O(N) 小文件读只在
// 超限日发生，每日一次的巡更点位可承受；不放 Append 惰性剪枝（inbox 环形
// 20 条同款思路在这里不成立）——Append 在请求路径上，逐条全目录扫描是
// N+1 反模式。坏条目与 CleanupBefore 同口径跳过不删（不借机清垃圾）。
// 并发注记：删除集取自读取时刻的键清单，巡更期间新 Append 的事件键不在集内
// 不会被误删；与时间窗清理先后执行互不依赖（filestore 锁既有惯例保单文档一致性）
func (r *auditLogRepo) EnforceMaxEntries(max int) (int, error) {
	if max <= 0 {
		return 0, nil
	}
	keys, _, err := r.doc.List(auditLogKind, ListOpts{})
	if err != nil {
		return 0, err
	}
	if len(keys) <= max {
		return 0, nil
	}
	type keyedEvent struct {
		key string
		e   AuditEvent
	}
	events := make([]keyedEvent, 0, len(keys))
	for _, k := range keys {
		data, err := r.doc.Get(auditLogKind, k)
		if err != nil {
			continue
		}
		var e AuditEvent
		if json.Unmarshal(data, &e) != nil {
			continue
		}
		events = append(events, keyedEvent{key: k, e: e})
	}
	if len(events) <= max {
		return 0, nil
	}
	sort.Slice(events, func(i, j int) bool { return newerThan(events[i].e, events[j].e) })
	removed := 0
	for _, ke := range events[max:] {
		if r.doc.Delete(auditLogKind, ke.key) == nil {
			removed++
		}
	}
	if removed > 0 {
		// 防清库无痕的自我保护：超量清理自身留一条摘要（语言中立元数据）。
		// 删除后追加——本条落在最新一侧，不会被本轮已定的删除集波及，下一轮
		// 巡更时它也是最年轻条目、同口径裁剪天然轮不到
		r.Append(AuditEvent{
			Action: AuditLogPrune,
			Result: AuditResultSuccess,
			Detail: fmt.Sprintf("pruned=%d max=%d", removed, max),
		})
	}
	return removed, nil
}
