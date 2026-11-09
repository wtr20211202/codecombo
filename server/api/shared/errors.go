package shared

import (
	"log/slog"
	"net/http"

	"github.com/gin-gonic/gin"
)

var devMode = true // 默认开发模式（本地工具不脱敏）

// SetDevMode 设置开发模式标志
func SetDevMode(v bool) { devMode = v }

// ── 稳定错误码注册表（P-20261003-305） ──
//
// 错误响应从「解析人类可读 message」升级为「按 code 程序化分支」：agent 捕获
// code 即可自纠（ops.approval_required → 轮询重试 / files.path_outside_root →
// 换项目相对写法 / files.payload_too_large → 拆分写入）。码为点分式 <域>.<错误>
// （audit 事件 action 同款先例）；code 是 HTTP status 的唯一事实源（errCodeStatus
// 绑定），迁移端点只给 code、status 由注册表派生，双源漂移不可能发生。
//
// 兼容约定（增量不破坏）：
//   - 未迁移端点响应无 code 字段，agent 按旧降级路径（HTTP status + message）；
//   - 既有 status 一律不变（兼容优先，不为凑码改变行为）——已迁移端点的 status
//     由注册表派生且必须与迁移前一致（shared/errors_test.go 全表断言防漂移）。
//
// 新增错误码：在 ErrCode 常量与 errCodeStatus 各加一行（同文件同 PR；漏登记会
// 被 StatusFor 的防御性回退 500 即时暴露），并同步 ops 手册「错误码对照」分节
// （agentops 内置分节，errors_manual_test.go 对账守门）。

// ErrCode 稳定机器可读错误码（点分式 <域>.<错误>，audit 事件 action 同款先例）
type ErrCode string

// 首批四域：projects（文件端点公共前置）/ files（读写路径高频错误面）/
// ops（ops-notify 载荷校验 + AgentGuard 审批 + ops-confirm 危险操作确认）。
// 第二批（P-20261005-160）：git / clone / deploy / remote / terminal 三高误域
// 收编——迁移以 P-29 errmarkers 登记表为蓝本「成对附挂」（marker 文本常量保留
// 不回退，前端 KNOWN_ERROR_I18N/remoteErrors 正则过渡层零破坏；code 供 agent
// 按结构化分支自纠），其余域渐进迁移，迁移前保持无 code 旧形态。
const (
	// projects 域
	CodeProjectsNotFound ErrCode = "projects.not_found"
	// CodeProjectLocked 项目硬锁 403（P-20261004-3）。码值与既有稳定关键字
	// ProjectLockedMarker（middleware/projectlock.go）同串：前端 KNOWN_ERROR_I18N
	// 与旧 agent 的关键字子串识别契约、新 code 分支契约共用同一字符串，文案中
	// 关键字永不回退；域名段取单数 project 与 audit 事件 project.lock/unlock 同款
	CodeProjectLocked ErrCode = "project.locked"

	// files 域
	CodeFilesPathRequired         ErrCode = "files.path_required"          // 缺 path 参数（补字段重发）
	CodeFilesPayloadInvalid       ErrCode = "files.payload_invalid"        // 请求体解析失败/载荷非法
	CodeFilesPayloadTooLarge      ErrCode = "files.payload_too_large"      // 请求体超上限（拆分写入）
	CodeFilesPathOutsideRoot      ErrCode = "files.path_outside_root"      // 路径越出项目根（改项目相对路径）
	CodeFilesNameInvalid          ErrCode = "files.name_invalid"           // 跨平台不兼容文件名（换名）
	CodeFilesConflict             ErrCode = "files.conflict"               // 目标已存在/外部已修改（先读后写）
	CodeFilesNotFound             ErrCode = "files.not_found"              // 文件不存在（确认路径或先创建）
	CodeFilesFileTooLarge         ErrCode = "files.file_too_large"         // 文件过大无法整读（部分预览/分段读）
	CodeFilesBinaryNotPreviewable ErrCode = "files.binary_not_previewable" // 二进制不进文本预览
	// CodeFilesSensitiveConfirmRequired 批量替换命中敏感文件未确认（P-20261004-114）：
	// 409 携 sensitiveHits 清单——核对后带 confirmSensitive=true 重发（dir-archive
	// override=1 同流：先看清单再显式放行）
	CodeFilesSensitiveConfirmRequired ErrCode = "files.sensitive_confirm_required"

	// ops 域
	CodeOpsPayloadInvalid      ErrCode = "ops.payload_invalid"       // 请求体解析失败
	CodeOpsEventTypeInvalid    ErrCode = "ops.event_type_invalid"    // type 空/超长/system: 保留前缀
	CodeOpsEventPayloadInvalid ErrCode = "ops.event_payload_invalid" // 内置事件载荷校验失败
	// CodeOpsPayloadTooLarge ops-notify 请求体超 64KB 封顶（LimitBody，P-20261004-130）：
	// 精简载荷重发——通知是短文本语义，单条巨型载荷是广播面 JSON marshal 内存放大
	CodeOpsPayloadTooLarge        ErrCode = "ops.payload_too_large"
	CodeOpsApprovalRequired       ErrCode = "ops.approval_required"        // 428 高危操作待审批：轮询后携 X-Approval-ID 重试
	CodeOpsApprovalDenied         ErrCode = "ops.approval_denied"          // 403 审批规则 deny：不可放行，勿重试
	CodeOpsConfirmOpInvalid       ErrCode = "ops.confirm_op_invalid"       // op 空/超长
	CodeOpsConfirmFieldTooLong    ErrCode = "ops.confirm_field_too_long"   // target/detail/sessionId 超长
	CodeOpsConfirmImpactInvalid   ErrCode = "ops.confirm_impact_invalid"   // impact 影响面载荷非法（kind 枚举外/summary 空/commands 超 5 条）
	CodeOpsConfirmNotFound        ErrCode = "ops.confirm_not_found"        // 审批不存在
	CodeOpsConfirmAlreadyResolved ErrCode = "ops.confirm_already_resolved" // 已裁决（幂等拒绝，勿重复裁决）
	// CodeOpsConfirmHorizonInvalid 放行时限档位非法（P-20261003-316）：horizon
	// 非白名单（session|24h|always）或 session 档缺会话归属（审批记录无 sessionId）
	CodeOpsConfirmHorizonInvalid ErrCode = "ops.confirm_horizon_invalid"
	// CodeOpsConfirmStatusInvalid 审批列表 status 过滤参数非法（P-20261003-254）：
	// 非 pending|allowed|denied（静默回全量会让调用方误读列表语义）
	CodeOpsConfirmStatusInvalid ErrCode = "ops.confirm_status_invalid"
	// CodeOpsMessagePayloadInvalid 定向消息载荷非法（P-20261004-68）：to/body
	// 缺失或超上限，或缺 X-Session-ID 发送方头
	CodeOpsMessagePayloadInvalid ErrCode = "ops.message_payload_invalid"
	// CodeOpsMessageTargetNotFound 定向消息目标会话不在册（P-20261004-68）：
	// 打错地址/目标已关闭——GET /api/terminals 核对后重发
	CodeOpsMessageTargetNotFound ErrCode = "ops.message_target_not_found"

	// ui 域（用户 UI 现场上报 P-20261004-52）
	// CodeUIPayloadInvalid 快照上报载荷非法（JSON 解析失败/字段超上界）
	CodeUIPayloadInvalid ErrCode = "ui.payload_invalid"
	// CodeUINoLiveSnapshot 无在报现场（开关关/TTL 10 分钟过期/从未上报三类同
	// 收敛——「没有现场」对读取语义不区分原因，agent 直接走无现场降级路径）
	CodeUINoLiveSnapshot ErrCode = "ui.snapshot_unavailable"

	// runbook 域（运行书服务端执行 P-20261004-108）
	// CodeRunbookPayloadInvalid 请求体非法（JSON 解析失败/onFailure 非法枚举）
	CodeRunbookPayloadInvalid ErrCode = "runbook.payload_invalid"
	// CodeRunbookParamsMissing 占位符参数缺失/空白：响应附 missing 清单（按步骤
	// 出现序）——补齐后重发，占位符残片不会进终端
	CodeRunbookParamsMissing ErrCode = "runbook.params_missing"
	// CodeRunbookBusy 同书已有一次执行在途（同 book 串行互斥）：等在途 run
	// 返回后再发起，或改跑其他书
	CodeRunbookBusy ErrCode = "runbook.busy"
	// CodeRunbookTargetNotFound 显式 targetSessionId 不在册：GET /api/terminals
	// 核对 id，或缺省让服务端新建独立执行现场
	CodeRunbookTargetNotFound ErrCode = "runbook.target_not_found"

	// fleet 域（舰队运行书执行 P-20261005-147，端点族 /api/runbooks/:id/fleet-*）
	// CodeFleetTargetsRequired 舰队执行缺 targetIds：补目标会话清单重发
	CodeFleetTargetsRequired ErrCode = "fleet.targets_required"
	// CodeFleetTargetsTooMany 目标数超两会话上限之和（本地+远程）：分批编排
	CodeFleetTargetsTooMany ErrCode = "fleet.targets_too_many"
	// CodeFleetTargetsNotFound 部分 targetIds 不在册：响应附 missing 清单——
	// GET /api/terminals（本地+远程聚合 GET /api/remotehosts/terminals）核对后
	// 重发；编排目标集开跑前必须完整可解析
	CodeFleetTargetsNotFound ErrCode = "fleet.targets_not_found"
	// CodeFleetRunNotFound runId 不在册（终态保留窗 1h 已过 / 服务重启）：
	// 重新发起舰队执行，勿对过期 run 中止/重试
	CodeFleetRunNotFound ErrCode = "fleet.run_not_found"
	// CodeFleetRunBusy run 仍在跑（retry 拒绝运行中 run / 已有单格重试在途）：
	// 等终态（task.progress fleet final 事件或响应）后再操作
	CodeFleetRunBusy ErrCode = "fleet.run_busy"
	// CodeFleetCellNotRetryable 该格不可单台重试（仅 failed|aborted 可重；
	// done 重试防双跑，skipped 是未发送——补跑走重跑全书）
	CodeFleetCellNotRetryable ErrCode = "fleet.cell_not_retryable"

	// ── 第二批（P-20261005-160）：git / clone / deploy / remote / terminal ──
	// git 域错误码与 P-29 errmarkers 文本标记成对附挂（marker 常量保留在错误
	// 文本中，前端正则映射与 agent code 分支双轨并存）

	// CodeGitIndexLockStale git 写命令失败且检出遗留 index.lock（errmarkers.
	// IndexLockStale 同现）：POST /projects/:id/index-lock/cleanup 一键清理后
	// 重试原命令。注意绑定 500——既有写命令失败路径就是 500（兼容优先不改
	// status），是「5xx 携 code 且可自纠」的显式例外（手册对照表注记）
	CodeGitIndexLockStale ErrCode = "git.index_lock_stale"
	// CodeGitWriteBusy 写串行队列等待 30s 超时（errmarkers.GitWriteBusy 同现）：
	// 命令未执行，稍候重发；持续命中说明有长写任务占队
	CodeGitWriteBusy ErrCode = "git.write_busy"
	// CodeGitIndexLockFresh 清理端点拒绝删「锁龄未达阈值」的活锁（git.
	// ErrIndexLockFresh）：正在写入的锁不可删——等几秒重试清理，或人工排查
	// 持锁进程
	CodeGitIndexLockFresh ErrCode = "git.index_lock_fresh"
	// CodeGitHunkConflict hunk 逆向 apply 上下文失配（errmarkers.HunkDiscardConflict
	// 同现，errors.Is git.ErrHunkDiscardConflict）：变更块已被再改，重拉 diff
	// 后基于新内容重新决策，勿盲目重试
	CodeGitHunkConflict ErrCode = "git.hunk_conflict"
	// CodeGitConflictStale 冲突文件写回 baseHash 乐观锁失配（git.ConflictStaleError，
	// 响应附 currentContent）：他人/其他会话窗口期改了冲突文件——重读现状再定
	CodeGitConflictStale ErrCode = "git.conflict_stale"

	// clone 域（克隆预检，marker 常量 errmarkers.CloneDestExists/CloneURLInvalid）
	// CodeCloneDestExists 目标目录存在且非空：换目录或清空后重发（git 语义允许
	// 克隆进空目录，空目录放行不报）
	CodeCloneDestExists ErrCode = "clone.dest_exists"
	// CodeCloneURLInvalid 克隆 URL 形态非法（含空白/全角字符/无法识别的形态）：
	// 修正 URL 重发（前端 cloneUrl.ts 同规则行内拦截）
	CodeCloneURLInvalid ErrCode = "clone.url_invalid"

	// deploy 域（部署触发）
	// CodeDeployHostBusy 同主机已有在途部署任务且本次 NoWait 拒绝（errmarkers.
	// DeployHostBusyTemplate 实例化，句中含持锁任务 id）：GET /api/deploy/tasks
	// 核对在途任务——等它结束或先取消，勿重复触发
	CodeDeployHostBusy ErrCode = "deploy.host_busy"

	// remote 域（远程主机 SSH 通道，remoteErrors.ts 第二张正则表的服务端源头）
	// CodeRemoteAuthFailed SSH 认证被拒（errmarkers.AuthRejectedPrefix 同现）：
	// 凭据失效/权限不足——核对凭据与账号，勿原样重试（连续失败可能触发对端
	// fail2ban 类限频）
	CodeRemoteAuthFailed ErrCode = "remote.auth_failed"
	// CodeRemoteHostKeyChanged 主机指纹与 TOFU 钉扎不符（errmarkers.HostKeyChanged
	// 同现）：主机重装/指纹轮换或中间人——与用户核对后重置指纹再连，勿静默重试
	CodeRemoteHostKeyChanged ErrCode = "remote.host_key_changed"

	// remoteaccess 域（远程接入 SSH 反向隧道 P-20261019-11）
	// CodeRemoteAccessProfileNotFound 档案 id 不存在：GET /settings 核对
	// remoteAccess.profiles 后重发
	CodeRemoteAccessProfileNotFound ErrCode = "remoteaccess.profile_not_found"
	// CodeRemoteAccessConfigInvalid 远程接入配置校验失败（settings 写路径/测试
	// 连接内联档案）：按 message 修正字段后重发
	CodeRemoteAccessConfigInvalid ErrCode = "remoteaccess.config_invalid"
	// CodeRemoteAccessPayloadInvalid 控制端点请求体非法：action 仅 start|stop
	CodeRemoteAccessPayloadInvalid ErrCode = "remoteaccess.payload_invalid"
	// CodeRemoteAccessLockRequired 锁定功能未启用/未配置密码：公网暴露前必须先
	// 启用系统锁定（设置·安全），否则任何拿到中继地址的人都能直接操作用户实例
	CodeRemoteAccessLockRequired ErrCode = "remoteaccess.lock_required"
	// CodeRemoteAccessTLSConfirmRequired TLS 未启用：启用隧道会把明文 HTTP 暴露
	// 到公网——确认风险后携 confirmInsecureTls=true 重发（确认动作入审计）
	CodeRemoteAccessTLSConfirmRequired ErrCode = "remoteaccess.tls_insecure_confirm_required"
	// CodeRemoteAccessStartFailed 反向隧道建立失败（SSH 拨号/远端绑定被拒/端口
	// 占用）：按 message 与预检建议修正 VPS sshd/防火墙后重试
	CodeRemoteAccessStartFailed ErrCode = "remoteaccess.start_failed"

	// terminal 域（广播/编队/排队指令的请求校验族）
	// CodeTerminalPayloadInvalid 请求体非法（JSON 解析失败）
	CodeTerminalPayloadInvalid ErrCode = "terminal.payload_invalid"
	// CodeTerminalIDsEmpty 广播缺 ids：补会话 id 清单重发
	CodeTerminalIDsEmpty ErrCode = "terminal.ids_empty"
	// CodeTerminalIDsTooMany ids 超单进程会话上限：分批发
	CodeTerminalIDsTooMany ErrCode = "terminal.ids_too_many"
	// CodeTerminalDataRequired 广播缺 data：补输入内容重发
	CodeTerminalDataRequired ErrCode = "terminal.data_required"
	// CodeTerminalDataTooLarge 单次广播输入超 64KB：拆分或走粘贴链路
	CodeTerminalDataTooLarge ErrCode = "terminal.data_too_large"
	// CodeTerminalBodyTooLarge 请求体超 128KB 封顶（LimitBody）：拆分
	CodeTerminalBodyTooLarge ErrCode = "terminal.body_too_large"
	// CodeTerminalProjectIDsEmpty 编队缺 projectIds：补项目 id 清单重发
	CodeTerminalProjectIDsEmpty ErrCode = "terminal.project_ids_empty"
	// CodeTerminalProjectIDsTooMany projectIds 超单次编队上限（20）：分批发起
	CodeTerminalProjectIDsTooMany ErrCode = "terminal.project_ids_too_many"
	// CodeTerminalPromptRequired 编队缺 prompt：补任务指令重发
	CodeTerminalPromptRequired ErrCode = "terminal.prompt_required"
	// CodeTerminalQueueFull 排队指令满队（5 条）：409 状态可重试的冲突语义——
	// 等会话消费/取走队列后再入队，或先 GET /api/terminals/:id/queue 清理
	CodeTerminalQueueFull ErrCode = "terminal.queue_full"
	// CodeTerminalQueueInvalid 排队指令空/超 2000 字符：精简后重发
	CodeTerminalQueueInvalid ErrCode = "terminal.queue_invalid"

	// search 域（内容搜索限流 P-20261004-124）
	// CodeSearchRateLimited 内容搜索超限 429（git grep 子进程风暴防线，每项目
	// 每分钟 30 次）：窗口滑动自动恢复——响应附 retry_after 秒数，稍候重试或
	// 降低检索频次。与 errmarkers.SearchRateLimited 文本标记成对附挂（前端
	// KNOWN_ERROR_I18N 正则映射与 agent code 分支双轨并存，git/remote 域同款）
	CodeSearchRateLimited ErrCode = "search.rate_limited"

	// notes 域（笔记库 /api/notes 族：P-20261107-2 多篇 → P-20261108-3 单库化）
	// CodeNotesNotFound 篇不存在：GET /api/notes 清单核对 noteId
	CodeNotesNotFound ErrCode = "notes.not_found"
	// CodeNotesConflict baseUpdatedAt 过期（覆盖保护三件套①）：响应附
	// currentContent/currentUpdatedAt——先读现状再决策（用我的覆盖 / 载入
	// 服务端版本 / 另存为新篇），勿盲目重试覆盖
	CodeNotesConflict ErrCode = "notes.conflict"
	// CodeNotesTooLarge 内容超 256KB：精简后重发
	CodeNotesTooLarge ErrCode = "notes.too_large"
	// CodeNotesGlobalLimit 笔记库篇数达上限（100 含回收站，只挡新增）：删减或
	// 彻底删除回收站篇后重试。P-20261108-3 单库化后唯一额度码——项目档
	// notes.limit_reached 随项目笔记端点族退役出注册表（再无产出点）
	CodeNotesGlobalLimit ErrCode = "notes.global_limit"
	// CodeNotesTitleTooLong 标题超 200 字节：换短标题
	CodeNotesTitleTooLong ErrCode = "notes.title_too_long"
)

// errCodeStatus 错误码 → HTTP status 绑定（唯一事实源，迁移端点 status 由这里
// 派生）。绑定值必须与该错误在迁移前的既有 status 一致。
var errCodeStatus = map[ErrCode]int{
	CodeProjectsNotFound:              http.StatusNotFound,
	CodeProjectLocked:                 http.StatusForbidden,
	CodeFilesPathRequired:             http.StatusBadRequest,
	CodeFilesPayloadInvalid:           http.StatusBadRequest,
	CodeFilesPayloadTooLarge:          http.StatusRequestEntityTooLarge,
	CodeFilesPathOutsideRoot:          http.StatusForbidden,
	CodeFilesNameInvalid:              http.StatusBadRequest,
	CodeFilesConflict:                 http.StatusConflict,
	CodeFilesNotFound:                 http.StatusNotFound,
	CodeFilesFileTooLarge:             http.StatusRequestEntityTooLarge,
	CodeFilesBinaryNotPreviewable:     http.StatusUnsupportedMediaType,
	CodeOpsPayloadInvalid:             http.StatusBadRequest,
	CodeOpsEventTypeInvalid:           http.StatusBadRequest,
	CodeOpsEventPayloadInvalid:        http.StatusBadRequest,
	CodeOpsPayloadTooLarge:            http.StatusRequestEntityTooLarge,
	CodeOpsApprovalRequired:           http.StatusPreconditionRequired,
	CodeOpsApprovalDenied:             http.StatusForbidden,
	CodeOpsConfirmOpInvalid:           http.StatusBadRequest,
	CodeOpsConfirmFieldTooLong:        http.StatusBadRequest,
	CodeOpsConfirmImpactInvalid:       http.StatusBadRequest,
	CodeOpsConfirmNotFound:            http.StatusNotFound,
	CodeOpsConfirmAlreadyResolved:     http.StatusConflict,
	CodeOpsConfirmHorizonInvalid:      http.StatusBadRequest,
	CodeOpsConfirmStatusInvalid:       http.StatusBadRequest,
	CodeOpsMessagePayloadInvalid:      http.StatusBadRequest,
	CodeOpsMessageTargetNotFound:      http.StatusNotFound,
	CodeUIPayloadInvalid:              http.StatusBadRequest,
	CodeUINoLiveSnapshot:              http.StatusNotFound,
	CodeRunbookPayloadInvalid:         http.StatusBadRequest,
	CodeRunbookParamsMissing:          http.StatusBadRequest,
	CodeRunbookBusy:                   http.StatusConflict,
	CodeRunbookTargetNotFound:         http.StatusNotFound,
	CodeFleetTargetsRequired:          http.StatusBadRequest,
	CodeFleetTargetsTooMany:           http.StatusBadRequest,
	CodeFleetTargetsNotFound:          http.StatusBadRequest,
	CodeFleetRunNotFound:              http.StatusNotFound,
	CodeFleetRunBusy:                  http.StatusConflict,
	CodeFleetCellNotRetryable:         http.StatusBadRequest,
	CodeFilesSensitiveConfirmRequired: http.StatusConflict,

	// 第二批（P-20261005-160）：绑定值 = 各错误迁移前的既有 status（兼容优先）
	CodeGitIndexLockStale:              http.StatusInternalServerError,
	CodeGitWriteBusy:                   http.StatusInternalServerError,
	CodeGitIndexLockFresh:              http.StatusConflict,
	CodeGitHunkConflict:                http.StatusConflict,
	CodeGitConflictStale:               http.StatusConflict,
	CodeCloneDestExists:                http.StatusBadRequest,
	CodeCloneURLInvalid:                http.StatusBadRequest,
	CodeDeployHostBusy:                 http.StatusBadRequest,
	CodeRemoteAuthFailed:               http.StatusBadGateway,
	CodeRemoteHostKeyChanged:           http.StatusBadGateway,
	CodeRemoteAccessProfileNotFound:    http.StatusNotFound,
	CodeRemoteAccessConfigInvalid:      http.StatusBadRequest,
	CodeRemoteAccessPayloadInvalid:     http.StatusBadRequest,
	CodeRemoteAccessLockRequired:       http.StatusConflict,
	CodeRemoteAccessTLSConfirmRequired: http.StatusConflict,
	CodeRemoteAccessStartFailed:        http.StatusBadGateway,
	CodeTerminalPayloadInvalid:         http.StatusBadRequest,
	CodeTerminalIDsEmpty:               http.StatusBadRequest,
	CodeTerminalIDsTooMany:             http.StatusBadRequest,
	CodeTerminalDataRequired:           http.StatusBadRequest,
	CodeTerminalDataTooLarge:           http.StatusBadRequest,
	CodeTerminalBodyTooLarge:           http.StatusRequestEntityTooLarge,
	CodeTerminalProjectIDsEmpty:        http.StatusBadRequest,
	CodeTerminalProjectIDsTooMany:      http.StatusBadRequest,
	CodeTerminalPromptRequired:         http.StatusBadRequest,
	CodeTerminalQueueFull:              http.StatusConflict,
	CodeTerminalQueueInvalid:           http.StatusBadRequest,

	// 第三批（P-20261004-124）：搜索限流
	CodeSearchRateLimited: http.StatusTooManyRequests,

	// 第四批（P-20261107-2）：多篇笔记（P-20261108-3 单库化后即 /api/notes 族）
	CodeNotesNotFound:     http.StatusNotFound,
	CodeNotesConflict:     http.StatusConflict,
	CodeNotesTooLarge:     http.StatusRequestEntityTooLarge,
	CodeNotesTitleTooLong: http.StatusBadRequest,

	// 第五批（P-20261107-5）：全局笔记库独立额度（/api/notes 族，notes 域增量）
	CodeNotesGlobalLimit: http.StatusBadRequest,
}

// StatusFor 返回错误码绑定的 HTTP status。未登记码防御性回退 500 并记日志
// （注册表与常量同文件维护，漏登记是编程错误，不应被静默吞掉）
func StatusFor(code ErrCode) int {
	if s, ok := errCodeStatus[code]; ok {
		return s
	}
	slog.Error("unregistered error code", "code", string(code))
	return http.StatusInternalServerError
}

// AllCodes 返回注册表内全部错误码（顺序不保证；切片副本）。
// 供 ops 手册「错误码对照」分节的对账单测等消费方遍历，注册表 map 本体不导出
func AllCodes() []ErrCode {
	out := make([]ErrCode, 0, len(errCodeStatus))
	for c := range errCodeStatus {
		out = append(out, c)
	}
	return out
}

// Error 返回错误响应并记日志。开发模式暴露内部错误详情，生产模式返回通用消息。
// 无 code 形态：未迁移端点保持既有响应（缺 code 字段，agent 走降级路径）
func Error(c *gin.Context, code int, publicMsg string, err error) {
	if err != nil {
		slog.Error(publicMsg, "err", err, "path", c.Request.URL.Path)
	}
	c.JSON(code, gin.H{"error": errText(publicMsg, err)})
}

// ErrorWithCode 带稳定错误码的错误响应：status 由 errCodeStatus 按 code 派生，
// 响应体 {"error", "code"}。已迁移端点统一走此入口（勿再手传 status，防双源漂移）
func ErrorWithCode(c *gin.Context, errCode ErrCode, publicMsg string, err error) {
	if err != nil {
		slog.Error(publicMsg, "err", err, "path", c.Request.URL.Path)
	}
	c.JSON(StatusFor(errCode), gin.H{"error": errText(publicMsg, err), "code": string(errCode)})
}

// ErrorWithMeta 错误响应携额外结构化字段（P-20261005-194 起被 git 域失败恢复
// hint 使用），响应体 {"error", ...meta}：既有 Error 家族的多载荷收口形态——
// 调用方传空 meta 等价 Error(status)，有 code 的调用方经 StatusFor 派生 status
// 后传入（code 面的 status 唯一事实源纪律不因本入口松动）
func ErrorWithMeta(c *gin.Context, status int, publicMsg string, err error, meta gin.H) {
	if err != nil {
		slog.Error(publicMsg, "err", err, "path", c.Request.URL.Path)
	}
	body := gin.H{"error": errText(publicMsg, err)}
	for k, v := range meta {
		body[k] = v
	}
	c.JSON(status, body)
}

// JSONWithCode 携额外载荷（policy/currentContent 等）的手拼错误体统一附加
// code 字段并按注册表派生 status：散落各处的 c.JSON(4xx, gin.H{...}) 错误面
// 经它保持错误码契约，不各自手写 "code" 键
func JSONWithCode(c *gin.Context, errCode ErrCode, body gin.H) {
	body["code"] = string(errCode)
	c.JSON(StatusFor(errCode), body)
}

// AbortWithCode 中间件拦截路径（AgentGuard）的 AbortWithStatusJSON 同型：
// code 注入响应体、status 由注册表派生
func AbortWithCode(c *gin.Context, errCode ErrCode, body gin.H) {
	body["code"] = string(errCode)
	c.AbortWithStatusJSON(StatusFor(errCode), body)
}

// errText 错误文本取值：开发模式暴露 err 原文（本地排障），生产模式只给公共消息
func errText(publicMsg string, err error) string {
	if devMode && err != nil {
		return err.Error()
	}
	return publicMsg
}
