// HTTP 基础设施：axios 实例 + 拦截器 + 实例切换上下文 + 423 统一处理。
// 从 client.ts 拆出（Phase B 领域拆分）：client.ts 保留为兼容桶，
// 领域 API 定义在 api/domains/*，导入面与拆分前 100% 一致。
import axios from 'axios'
import { h } from 'vue'
import { NButton } from 'naive-ui'
import type { MessageApiInjection } from 'naive-ui/es/message/src/MessageProvider'
import type { InternalAxiosRequestConfig } from 'axios'
import { AppError, classify } from './error-types'
import type { ErrorLogEntry, ErrorRetryInfo } from './error-types'
import type { AxiosAdapter, AxiosDefaults, AxiosResponse } from 'axios'
import { useErrorLogStore } from '@/stores/errorLog'
import { useGitLockRecoveryStore } from '@/stores/gitLockRecovery'
import { useGitFailHintStore } from '@/stores/gitFailHint'
import { gitHintToastAction, type GitHintAction } from '@/utils/gitFailHint'
import { openSettingsTab } from '@/utils/openSettings'
import { shouldShowToast } from '@/utils/toastDedupe'
import { applyLockRejection, getUnlockToken } from '@/stores/lock'
import i18n from '@/i18n'

// 不走代理的路径前缀（始终发往本机后端）。/system/network 是二维码接力
// 选址的本机网卡清单（P-20261019-10）——代理到远端实例会返回错误机器的地址
export const LOCAL_PREFIXES = ['/instances', '/tokens', '/settings', '/browse', '/clone', '/ui-state', '/system/network']

// 模块级引用：由 App.vue 在 Naive UI provider 内注入
let _message: MessageApiInjection | null = null
let _panelSwitcher: (() => void) | null = null

export function setMessageApi(m: MessageApiInjection): void { _message = m }
export function setPanelSwitcher(fn: () => void): void { _panelSwitcher = fn }

// 模块级变量，由 instanceStore 注入
let _currentInstanceId: string | null = null
let _isRemoteInstance = false
// 全局 AbortController，实例切换时取消所有请求
let _abortController = new AbortController()

export function cancelAllRequests() {
  _abortController.abort()
  _abortController = new AbortController()
}

export function getAbortSignal() {
  return _abortController.signal
}

export function setInstanceContext(id: string | null, isRemote: boolean) {
  _currentInstanceId = id
  _isRemoteInstance = isRemote
}

export function getCurrentInstanceContext() {
  return { instanceId: _currentInstanceId, isRemote: _isRemoteInstance }
}

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
})

// ---- GET in-flight 去重（P-20261003-246）----
// 同一 GET（URL+params 全等）并发重复请求在 adapter 层合并为一次网络请求，并发
// 等待者共享首个结果——多面板挂载并发拉 settings/status/metrics 的请求风暴削减。
// 语义边界：这是 in-flight 合并不是缓存——完成即出表（成功失败都删），后续请求
// 照常重新发出，轮询/重试/刷新语义不变；仅幂等 GET 参与（写类方法合并=改变副
// 作用次数，与 P-179 重试同一条安全红线）。
// 读后写重取豁免（skipInflightDedupe）：写成功后紧跟的同键重取若撞上一个写前
// 发起、仍在途的同键 GET，合并会把写前快照当最新值返回（fulle2e run7 实测：
// 会话星标后的列表重取并入在途检索 GET，行对象回退未星标态，下一次「取消星标」
// 被算成重星标）——写后重取的调用点用该标记豁免合并，直发新请求
const inflightGets = new Map<string, Promise<AxiosResponse>>()

// per-request 豁免标记（axios config 自定义字段，adapter 层读取）
declare module 'axios' {
  export interface AxiosRequestConfig {
    skipInflightDedupe?: boolean
  }
}

// params 稳定序列化：键排序 + 递归，同语义载荷得到同键（调用点对象字面量的键序
// 差异不影响命中）；非普通对象（如 URLSearchParams）回落 String(v) 的确定性形
// 态。仅用于合并键比较，不参与真实请求构造
function paramsFingerprint(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'object') return String(value)
  if (Array.isArray(value)) return `[${value.map(paramsFingerprint).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${paramsFingerprint(v)}`).join(',')}}`
}

// 合并键：baseURL + 改写后最终路径 + params。实例身份天然进键——远程代理改写拦
// 截器已把 /proxy/<id>/api 前缀写进 url（本地是 /api + 相对路径），同键即同目标
function inflightKey(config: InternalAxiosRequestConfig): string {
  return [
    (config.method ?? 'get').toLowerCase(),
    config.baseURL ?? '',
    config.url ?? '',
    paramsFingerprint(config.params),
  ].join('|')
}

// 等待者的错误按各自 config 重抛：共享的拒绝对象携带首个发起者的 config，而
// silent / errorLabel / 重试快照是 per-caller 语义——静默探测并入非静默在途
// 请求时若直接透传，会被代弹 toast + 代写 Console。原型链重挂（Object.create
// + 覆写 own 属性）保留 AxiosError 的 instanceof 识别（isAxiosError/isCancel
// 语义不破），仅 config 一层按等待者取值。
// isWaiterRedelivery 标记（run9 errorlog-filter 实测缺陷修正）：等待者会沿各自
// 调用链把同一网络失败的拒绝二次送达响应拦截器，拦截器按送达次数入账错误中心
// ——一次 404 双行、计数断言翻倍。合并语义下网络失败只发生一次，账面也只记
// 一次：带标记的送达跳过 errorLog.add（toast/console 仍是 per-caller 语义不变）
function withWaiterConfig(reason: unknown, config: InternalAxiosRequestConfig): unknown {
  if (reason && typeof reason === 'object' && 'config' in reason) {
    const rebound = Object.create(reason) as Record<string, unknown>
    rebound.config = config
    rebound.isWaiterRedelivery = true
    return rebound
  }
  return reason
}

// 仅真实 axios 实例可挂去重（测试环境的 axios mock 无 defaults/adapter——去重是
// 网络层优化，缺失时优雅降级为直通，既有 mock 型单测零扰动）
const instanceDefaults = api.defaults as AxiosDefaults | undefined
if (instanceDefaults?.adapter) {
  const networkAdapter: AxiosAdapter = axios.getAdapter(instanceDefaults.adapter)
  instanceDefaults.adapter = (config: InternalAxiosRequestConfig) => {
    if ((config.method ?? 'get').toLowerCase() !== 'get') return networkAdapter(config)
    // 读后写重取豁免：跳过合并直发（语义见 inflightGets 注释）
    if (config.skipInflightDedupe) return networkAdapter(config)
    const key = inflightKey(config)
    const shared = inflightGets.get(key)
    // 每个等待者拿响应浅拷贝：axios 的 transformResponse 在 dispatchRequest 里
    // 逐调用改写 response.data（共享对象会让后到消费者跳过独立反序列化、与前到
    // 消费者共用同一结果——未去重时各请求各自 JSON.parse，此处保持同款隔离）。
    // 响应是普通对象字面量，spread 不损原型；错误对象绝不拷贝（见 withWaiterConfig）
    if (shared) {
      return shared.then(
        (response) => ({ ...response }),
        (reason: unknown) => { throw withWaiterConfig(reason, config) },
      )
    }
    const inflight = networkAdapter(config).finally(() => { inflightGets.delete(key) })
    inflightGets.set(key, inflight)
    return inflight.then((response) => ({ ...response }))
  }
}

// index.lock 遗留锁稳定标记（P-20261002-150）：服务端 git 层对写命令失败的
// 错误原文追加（server/git/indexlock.go IndexLockStaleMarker），命中即点亮
// 变更面板修复条
const INDEX_LOCK_STALE_RE = /stale git index lock detected/i

// 携带重试快照的内部请求配置（P-20261003-179）：origUrl 由远程代理改写拦截器
// 在改写前写入（见下方），错误入账时作为重放路径快照
interface RetryableInternalConfig extends InternalAxiosRequestConfig {
  origUrl?: string
}

// 所有请求自动关联全局 AbortController（实例切换即全量取消）。调用方经
// AxiosRequestConfig.signal 自带的信号不被覆盖，而是与全局信号合并——任一
// 触发即取消（跨项目搜索的逐轮 AbortController 经此接入，P-20261005-182）。
// AbortSignal.any 缺失的旧内核回退取调用方信号：该请求失去实例切换联动
// （仅旧内核），换取消能力可用——新内核走原生合并无此权衡
api.interceptors.request.use((config) => {
  const globalSignal = getAbortSignal()
  // axios 的 signal 形参类型是宽容的 GenericAbortSignal（结构最小面），实传
  // 均为真 AbortSignal（AbortController.signal），收窄以复用原生合并
  const own = config.signal as AbortSignal | null | undefined
  config.signal = own
    ? (typeof AbortSignal.any === 'function' ? AbortSignal.any([globalSignal, own]) : own)
    : globalSignal
  return config
})

// 克隆目标目录预检（P-20261003-26）稳定错误原文（server/api/gitops/clone.go
// errCloneDestExists，对外契约）——KNOWN_ERROR_I18N 映射为友好文案；
// CloneModal / useAddProjectDialog 复用同源正则做行内/具体提示
export const CLONE_DEST_EXISTS_RE = /destination directory already exists and is not empty/i

// 克隆 URL 形态预检（P-20261003-70）稳定错误原文（server/api/gitops/clone.go
// errCloneURLInvalid，对外契约）——前端两个克隆入口行内即时校验收口在
// web/src/utils/cloneUrl.ts（同规则），此处映射兜底直达 API 的调用方
export const CLONE_URL_INVALID_RE = /invalid clone URL/i

// 请求拦截器：远程实例时将 /api/xxx 改写为 /proxy/<id>/api/xxx
api.interceptors.request.use((config) => {
  if (!_isRemoteInstance || !_currentInstanceId) return config

  const url = config.url || ''
  if (LOCAL_PREFIXES.some(prefix => url.startsWith(prefix))) return config

  // 错误中心原地重试（P-20261003-179）：改写前快照原始相对路径——重放走同一
  // api 实例会再次经过本拦截器改写，若存改写后路径会叠加出 /proxy/<id>/api/proxy/...
  ;(config as RetryableInternalConfig).origUrl = url
  // 清除 baseURL，使用绝对路径
  config.baseURL = ''
  config.url = `/proxy/${_currentInstanceId}/api${url}`
  return config
})

// 请求拦截器：附加 unlock token（与 Authorization 解耦的独立头 X-Lock-Token）。
// 令牌读内存态（P-20261019-2，不再落 localStorage）：本 tab 解锁签发的 token
// 以头形态直带；刷新后内存为空则不带头，同源请求由浏览器自动携带服务端下发的
// HttpOnly cookie，服务端锁校验按「头 > cookie」回退
api.interceptors.request.use((config) => {
  const token = getUnlockToken()
  if (token) {
    config.headers = config.headers || {}
    config.headers['X-Lock-Token'] = token
  }
  return config
})

// 423 锁定响应统一处理（axios 拦截器与其他直连通道共用）：
// 真锁定 → 清 unlock token + 切 lock store 锁定态；预期 Revoke / stale 竞态 → 不动状态。
// 返回 true 表示真锁定（已处理），false 表示无需处理（调用方按各自通道静默拒绝即可）。
export function handleLockedResponse(requestUrl: string, requestToken: string): boolean {
  // 改密码 / 改配置 接口的 423 是预期的（修改成功后服务端 RevokeAllTokens）
  const isExpectedRevoke =
    requestUrl.includes('/lock/password') || requestUrl.includes('/lock/config')

  // 竞态保护：unlock() 会写入新 token，但 in-flight 旧请求（无 token 或旧 token）
  // 收到 423 时不应清掉新 token，否则刚解锁的页面会被再次锁定。
  // 比较「请求发出时携带的 token」与「当前内存中的 token」（P-20261019-2 起
  // localStorage 不再持有令牌副本）：
  //   不一致 → 该 423 来自 stale 请求，跳过锁定页切换，仅静默拒绝。
  const currentToken = getUnlockToken() || ''
  const isStaleRequest = !!currentToken && requestToken !== currentToken

  if (isExpectedRevoke || isStaleRequest) return false

  // 真锁定：清 token + 切锁定屏（与 WS 通道 4001 处置 applyLockRejection 同一实现）
  applyLockRejection()
  return true
}

// 结构化错误码直查层（P-20261005-153）：P-305 起已迁移端点的错误响应体携
// {error, code}（server/api/shared/errors.go 注册表）——code 命中本表即用映射
// 键，跳过下方 KNOWN_ERROR_I18N 正则层；未登记码/未迁移域（响应无 code 字段）
// 回退正则层，行为与消费层落地前完全一致。
//
// 首批只收「码精度 ≥ 文案正则精度」的高频用户面码——反例注记：
//   - files.conflict 不收：一个码横跨「目标已存在/被外部修改」两种语义，code
//     优先反而丢失正则层的细分文案（fileExists / 现场各异），正则继续更准；
//   - deploy.host_busy 不收：deploy.mutex.busy 文案带 {task} 插值，参数靠正则
//     捕获组提取，本层是纯 Record 不带参数提取器；
//   - ops.* 不收：审批/载荷校验码是 agent 面（前端零消费），非用户面。
// 收录即契约：值是 i18n 键，须在 zh/en 齐备（check-i18n --errcodes 对账：
// 缺词条、码不在 Go 注册表当轮 check 即红）；新码迁入在表尾追加一行。
export const ERROR_CODE_I18N: Record<string, string> = {
  'project.locked': 'errors.known.projectLocked',
  'git.index_lock_stale': 'errors.known.staleIndexLock',
  'git.write_busy': 'errors.known.gitWriteBusy',
  'git.hunk_conflict': 'errors.known.hunkChanged',
  'git.conflict_stale': 'errors.known.conflictStale',
  'search.rate_limited': 'errors.known.searchRateLimited',
  'clone.dest_exists': 'clone.destExists.label',
  'clone.url_invalid': 'clone.urlInvalid.label',
  'terminal.queue_full': 'errors.known.queueFull',
  'remote.host_key_changed': 'errors.known.hostKeyChanged',
  'files.not_found': 'errors.known.fileNotFound',
  'files.name_invalid': 'errors.known.invalidFileName',
  // 笔记库（P-20261107-2 多篇 → P-20261108-3 单库化 /api/notes 族）：冲突 409 由
  // 笔记面板冲突条专属消费（三动作），拦截器文案仅兜底非面板场景
  'notes.conflict': 'errors.known.notesConflict',
  'notes.too_large': 'errors.known.notesTooLarge',
  'notes.title_too_long': 'errors.known.notesTitleTooLong',
  // 笔记库额度（单库化后唯一额度码——项目档 notes.limit_reached 随项目端点族退役出注册表）
  'notes.global_limit': 'errors.known.notesGlobalLimit',
}

// 响应拦截器：分类 + 写 Console + 弹友好提示（除非 silent）+ 抛 AppError
api.interceptors.response.use(
  (response) => response.data,
  (error) => {
    // 请求被主动取消（实例切换/路由变更）—— 不算错误，跳过分类、不写 Console、不弹提示
    if (error.code === 'ERR_CANCELED') {
      return Promise.reject(new AppError(
        'unknown', 'request canceled', 0,
        error.config?.url ?? '',
        (error.config?.method ?? 'GET').toUpperCase(),
      ))
    }

    // 锁定态处理：423 静默切锁定页，必须在 classify() 流程之前
    // （真锁定 / 预期 Revoke / stale 竞态三态均静默拒绝：不走 classify，不写 Console，不弹 toast）
    if (error.response?.status === 423) {
      const url = (error.config?.url as string) || ''
      const requestToken = (error.config?.headers?.['X-Lock-Token'] as string) || ''
      handleLockedResponse(url, requestToken)
      return Promise.reject(error)
    }

    const category = classify(error)
    const status = error.response?.status ?? 0
    const url = error.config?.url ?? ''
    const method = (error.config?.method ?? 'GET').toUpperCase()
    const backendError =
      (error.response?.data as { error?: string } | undefined)?.error

    // 请求关联 ID（P-20261003-216）：后端 X-Request-Id 响应头入错误元数据，
    // 与服务端日志的 rid= 字段精确对齐（跨面排障免时间猜测）；
    // 无响应（网络层失败）或路由拦截的 fulfill 响应头缺省，不展示
    const ridHeader = error.response?.headers?.['x-request-id']
    const requestId = typeof ridHeader === 'string' && ridHeader !== '' ? ridHeader : undefined

    // rawMessage：优先后端原文，无 response 时用 i18n 兜底
    const rawMessage = backendError
      ?? (error.code === 'ECONNABORTED' ? i18n.global.t('errors.network')
        : error.message === 'Network Error' ? i18n.global.t('errors.network')
        : error.message)

    // 已知后端业务错误 → 友好本地化提示（服务端稳定英文原文 → 用户语言），
    // 原文永远保留在 rawMessage / Console / 详情面板，不会丢失诊断信息。
    // 条目：[稳定标记正则, i18n 键, 可选参数提取]——第三元素把正则捕获组转成
    // t() 插值参数（如 runtime 预检错误里的运行时名），无参数条目省略
    const KNOWN_ERROR_I18N: Array<[RegExp, string, ((m: RegExpMatchArray) => Record<string, unknown>)?]> = [
      // SSH 主机密钥 TOFU 变更拒绝（P-20261003-34，服务端稳定标记 hostKeyChangedMarker）
      [/host key has changed/i, 'errors.known.hostKeyChanged'],
      [/auth rejected by remote server|unable to authenticate|authentication failed/i, 'errors.known.authFailed'],
      [/invalid lock token|invalid authorization header/i, 'errors.known.lockTokenInvalid'],
      [/too many authentication failures/i, 'errors.known.authTooMany'],
      [/instance not found/i, 'errors.known.instanceNotFound'],
      [/remote host not found/i, 'errors.known.remoteHostNotFound'],
      // 同主机部署串行互斥（P-20261003-41）：POST /api/deploy 对该主机已有
      // 在途任务的 400 拒绝——原文含持锁任务 ID（server/deploy/manager.go
      // Trigger 的对外契约），改原文须同步此处正则与 deploy.mutex.busy 文案
      [/deploy already in progress for this host/i, 'deploy.mutex.busy'],
      // 部署日志下载（P-20261003-142）：任务终态 1h 内存窗外 GET
      // /api/deploy/:taskId/log 的 410 拒绝——稳定标记即 server/deploy/
      // logexport.go LogExpiredMarker（对外契约，改措辞须两侧同步）。blob
      // 下载调用的错误体是 Blob、拦截器读不出原文，前端组件侧就地解析同标记
      //（composables/useDeployLogDownload.ts），此映射兜底非 blob 直调方
      [/deploy log expired/i, 'deploy.logDownload.expired'],
      // 手动携密同步三道服务端硬面（P-20261024-3，errmarkers 注册表同串——
      // 改原文须两侧同步）：未配对/未核对 → 仪式对话框；信封拒绝 → 统一文案
      //（防 oracle：篡改/重放/钥不配不区分）；定时携密 → 红线说明
      [/credential sync requires pairing and fingerprint verification/i, 'errors.known.credSyncUnverified'],
      [/credential sync envelope rejected/i, 'errors.known.credSyncEnvelope'],
      [/credential sync is manual-only/i, 'errors.known.credSyncManualOnly'],
      [/project not found/i, 'errors.known.projectNotFound'],
      [/session not found/i, 'errors.known.sessionNotFound'],
      [/task not found/i, 'errors.known.taskNotFound'],
      [/snippet not found/i, 'errors.known.notFoundGeneric'],
      [/credential not found/i, 'errors.known.credentialNotFound'],
      [/file not found/i, 'errors.known.fileNotFound'],
      [/file already exists/i, 'errors.known.fileExists'],
      // 变更列表同作用域重名（P-20261007-19）：服务端稳定标记 ChangelistExists
      //（errmarkers 注册表，改原文须同步此处正则与 errors.known.changelistExists 文案）
      [/changelist already exists/i, 'errors.known.changelistExists'],
      // 内容搜索限流（P-20261004-124）：搜索端点 30 次/分钟/项目超限的 429 拒绝
      //——稳定原文即 server/errmarkers SearchRateLimited（对外契约，与 code
      // search.rate_limited 成对附挂，改措辞须两侧同步）
      [/search rate limited/i, 'errors.known.searchRateLimited'],
      // 克隆目标目录预检（P-20261003-26）：POST /api/clone 对已存在非空目录的
      // 400 拒绝——CloneModal / useAddProjectDialog 命中时行内/具体提示，
      // 此处映射保证其他调用方（直达 API）也能拿到本地化文案
      [CLONE_DEST_EXISTS_RE, 'clone.destExists.label'],
      // 克隆 URL 形态预检（P-20261003-70）：POST /api/clone 对打错形态 URL 的
      // 400 拒绝——克隆入口行内即时拦截在前端（utils/cloneUrl.ts），此处兜底
      // 直达 API 的调用方
      [CLONE_URL_INVALID_RE, 'clone.urlInvalid.label'],
      // 文件名跨平台兼容性（P-20261002-132）：服务端创建/重命名入口对 Windows
      // 保留设备名与段结尾点/空格的 400 拒绝（行内输入前端已即时拦截，此处兜底
      // 直达 API 的调用方）
      [/invalid file name/i, 'errors.known.invalidFileName'],
      [/path is not a git repository/i, 'errors.known.notGitRepo'],
      // 替换历史还原冲突（P-20261004-66）：暂存区在替换后被推进，备份补丁对
      // 新基面失配（errRestoreConflictStable 稳定原文，改措辞须两侧同步）——
      // 工作区已归暂存区态，备份补丁仍在历史条目可重试
      [/replace backup no longer applies/i, 'errors.known.replaceRestoreConflict'],
      // index.lock 遗留锁（P-20261002-150）：写命令失败且服务端检出陈旧锁——
      // 文案指向修复条；拦截器下方还会点亮变更面板的一键清理入口
      [/stale git index lock detected/i, 'errors.known.staleIndexLock'],
      // git 写串行队列等待超时（P-20261002-78）：同仓库写命令排队 30s 仍未
      // 轮到（有操作挂起/长冲突）——服务端稳定标记 GitWriteBusyMarker，
      // 命令未执行，文案引导稍后重试（与上方遗留锁修复条互补：那条事后恢复，
      // 本条事前排队的兜底出口）
      [/another git write operation is still in progress/i, 'errors.known.gitWriteBusy'],
      // git 全局并发门排队超时（P-20261004-125）：全局并发上限打满后排队
      // 20s 仍未轮到——服务端稳定标记 GitGateBusyMarker，命令未执行，文案
      // 引导稍后重试（与上方写队列互补：那条 per-repo 写互斥，本条全局
      // 进程总量防线，P-124 搜索限流同族）
      [/too many concurrent git operations/i, 'errors.known.gitGateBusy'],
      // 选择性 stash 降级拒绝（P-20261003-119）：scope=staged 但本机 git < 2.35——
      // 服务端稳定原文 ErrStashStagedUnsupported（改措辞须两侧同步）；创建弹窗已按
      // list 的 stagedSupported 禁用该档，此处兜底直达 API 的调用方
      [/stash --staged requires git 2\.35 or newer/i, 'errors.known.stashStagedUnsupported'],
      // stash hash 稳定引用失效（P-20261003-264）：按 hash 操作时条目已不在当前
      // stash 栈（另一标签页 drop/pop 过）——服务端稳定原文 errmarkers.StashEntryGone
      //（改措辞须两侧同步）；明确拒绝不错位，文案引导刷新列表后重试
      [/stash entry no longer exists/i, 'errors.known.stashEntryGone'],
      // stash 应用到新分支（P-20261003-263）：目标分支已存在的冲突拒绝——
      // 服务端预检稳定原文（git 层 "git branch '<name>' already exists"）+
      // 预检与执行间竞态的 git 自身报错（"a branch named '<name>' already
      // exists"），同一正则族两条原文都收；改措辞须两侧同步
      [/branch (?:named )?'([^']+)' already exists/i, 'errors.known.branchExists', m => ({ name: m[1] })],
      [/path does not exist or is not a directory/i, 'errors.known.pathNotExist'],
      [/path traversal not allowed|invalid path/i, 'errors.known.invalidPath'],
      [/remote unreachable/i, 'errors.known.netUnreachable'],
      [/connection refused/i, 'errors.known.connRefused'],
      [/no route to host|i\/o timeout/i, 'errors.known.netUnreachable'],
      [/session busy|正在回复中/i, 'errors.known.sessionBusy'],
      [/session archived|会话已归档/i, 'errors.known.sessionArchived'],
      [/max websocket connections/i, 'errors.known.wsLimit'],
      [/no ai provider configured/i, 'errors.known.noAiProvider'],
      [/already up to date/i, 'errors.known.alreadyUpToDate'],
      // hunk 级工作区回滚冲突（P-20261003-49）：git apply -R 上下文失配——
      // 服务端稳定标记 HunkDiscardConflictMarker（"hunk no longer applies"），
      // 安全失败（工作区未动），文案告知「块已变化」可重看 diff 再决策
      [/hunk no longer applies/i, 'errors.known.hunkChanged'],
      // 对比实验采用落盘冲突（P-20261004-72）：标注后工作区再被手改（指纹对账
      // 失配/文件增减）或补丁上下文失配——服务端稳定标记即
      // server/api/compareexp/apply.go ApplyConflictMarker（对外契约，改措辞
      // 须两侧同步）；安全失败（工作区未动），文案引导重新标注刷新参照系
      [/compare experiment workspace changed since adoption/i, 'errors.known.compareApplyConflict'],
      // 冲突解决写回乐观锁（P-20261004-27）：解析载入到写回之间冲突文件被外部
      // 改动的 409 拒绝——稳定标记即 server/git/merge.go ConflictStaleMarker
      //（对外契约，改措辞须两侧同步）；带固定 "conflict " 前缀与 files.WriteFile
      // 的既有 409 原文互不误配。写回未发生，文案引导重新解析重走快照
      //（ConflictView 另置横幅给显式重解析入口）
      [/conflict file was modified externally/i, 'errors.known.conflictStale'],
      // 在系统中显示（P-20261003-323）：headless 实例宿主无显示环境的 501 明确
      // 语义 + Linux 打开器失败的可行动提示——原文即 server/api/files/reveal*.go
      // 的稳定英文标记，改措辞须两侧同步
      [/no display environment/i, 'errors.known.noDisplay'],
      [/xdg-open is not available|xdg-open exited with \d+/i, 'errors.known.xdgOpenMissing'],
      // 交互式 rebase 失败（P-20261003-324）：服务端已 rebase --abort 恢复原状，
      // 稳定前缀即 server/git/merge.go 失败路径的对外契约（改文案须两侧同步）
      [/rebase failed \(working tree restored via rebase --abort\)/i, 'errors.known.rebaseConflictAborted'],
      // 从中心更新：中心侧 ServeBinary 的两种 404 语义（无预置且无更新源 /
      // 更新源里没有该平台包）——原文随 rawMessage 透传，子串稳定可匹配
      [/update source not configured/i, 'errors.known.centerNoUpdateSource'],
      // npm 分发形态拒绝自更新 409（P-20261102-2）——稳定原文即
      // server/errmarkers UpdateNpmManaged（改文案须两侧同步）
      [/installed via npm — update with:/i, 'errors.known.updateNpmManaged'],
      [/binary not found for/i, 'errors.known.centerBinaryMissing'],
      [/wrong passphrase or corrupted export file/i, 'errors.known.wrongPassphrase'],
      // 项目硬锁（P-20261004-3）：locked 项目写族的 403 拒绝——稳定标记
      // project.locked 即 server/middleware/projectlock.go 的对外契约
      //（P-305 结构化错误码落地前按明文关键字识别，改文案须两侧同步）
      [/project\.locked/i, 'errors.known.projectLocked'],
      // agent runtime 创建前预检（P-20261003-79）：POST /api/terminals kind=agent
      // 对缺失/损坏二进制的 400 拒绝——稳定标记原文即 server/agentops/precheck.go
      // PrecheckError.Error（对外契约），运行时名经捕获组进插值参数
      [/runtime (\S+) is not installed or not in the service process path/i, 'agent.runtime.errorMissing', m => ({ name: m[1] })],
      [/runtime (\S+) failed version quick check/i, 'agent.runtime.errorVersionCheck', m => ({ name: m[1] })],
      // 排队指令（P-20261003-248）：POST/PUT /api/terminals/:id/queue 对满队的
      // 409 与空/超长的 400 拒绝——稳定原文即 server/store/agentsessionqueue.go
      // ErrQueue*（对外契约，改文案须两侧同步）
      [/queue is full/i, 'errors.known.queueFull'],
      [/instruction is empty or too long/i, 'errors.known.queueInvalid'],
      // 冻结分享体积护栏（P-20261003-320）：POST /api/share mode=frozen 对
      // 超 200MB / 快照库总量触顶的 413 拒绝——稳定原文即 server/share/
      // snapshot.go 的哨兵错误（对外契约），改文案须两侧同步
      [/share too large to freeze/i, 'share.frozen.tooLarge'],
      [/share snapshot store is full/i, 'share.frozen.quotaFull'],
      // 会话回放体积护栏（P-20261004-103）：POST /api/share/cast 的 413 拒绝
      // ——稳定原文即 errmarkers.ReplayTooLarge（对外契约），改文案须两侧同步
      [/recording replay too large to share/i, 'share.cast.tooLarge'],
      [/not found$/i, 'errors.known.notFoundGeneric'],
    ]
    const knownHit = KNOWN_ERROR_I18N.find(([re]) => re.test(rawMessage))
    const knownErrorKey = knownHit?.[1]
    const knownErrorParams = knownHit?.[2]?.(rawMessage.match(knownHit[0]) as RegExpMatchArray)

    // code 优先层（P-20261005-153）：结构化错误码直查命中即用，正则层让位——
    // 映射不再依赖服务端文案措辞（Go 侧重排一句不失配）；响应无 code 字段
    //（未迁移端点/网络层失败）时本层自然空转，零行为变化。
    // own-property 守卫：远程代理透传的 code 是外部输入，裸索引会读到原型链
    // 键（如 "constructor"）拿到真值函数当 i18n 键用
    const errorCode = (error.response?.data as { code?: string } | undefined)?.code
    const codeErrorKey =
      errorCode != null && Object.prototype.hasOwnProperty.call(ERROR_CODE_I18N, errorCode)
        ? ERROR_CODE_I18N[errorCode]
        : undefined

    // 遗留锁修复条（P-20261002-150）：错误原文命中服务端稳定标记时，从请求
    // URL 提取项目 ID 记入修复条 store（直连 /projects/<id>/… 与远程代理
    // /proxy/<inst>/api/projects/<id>/… 两种形态都能命中同一段）
    const pid = url.match(/\/projects\/([^/]+)/)?.[1]
    if (INDEX_LOCK_STALE_RE.test(rawMessage)) {
      if (pid) useGitLockRecoveryStore().report(pid)
    }

    // userMessage：关键路径 errorLabel 优先，code 命中次之，已知错误正则映射
    // 再次，分类兜底
    const userMessage = error.config?.errorLabel
      ? i18n.global.t(error.config.errorLabel)
      : codeErrorKey
        ? i18n.global.t(codeErrorKey)
        : knownErrorKey
          ? i18n.global.t(knownErrorKey, knownErrorParams ?? {})
          : i18n.global.t(`errors.${category}`)

    // git 失败恢复 hint（P-20261005-194）：服务端分类器（server/git/failhint.go）
    // 随 gitops 错误响应返回结构化 hint {kind, detail?}，与错误码正交。命中可行动
    // 类别时把裸 toast 升级为「原因一句话 + 建议动作 + 直达按钮」（时长放宽 10s
    // 留点击窗口，P-44 冲突动作 toast 同档）；未命中/无既定动作的 kind 保持裸
    // toast 零降级——原文照旧走 rawMessage / Console / 错误中心，诊断信息不丢
    const hintBody = (error.response?.data as { hint?: { kind?: string; detail?: string } } | undefined)?.hint
    const hintAction = gitHintToastAction(hintBody, pid)
    const toastText = hintAction
      ? i18n.global.t(hintAction.reasonKey, hintAction.reasonParams ?? {})
      : userMessage
    const dispatchHintAction = (action: GitHintAction) => {
      if (!action.button) return
      if (action.button.run === 'credentials') {
        // git 凭据面在 设置→安全（CredentialList）：「打开设置定位分区」全局通道
        openSettingsTab('security')
        return
      }
      // pull / conflict 经 store 由宿主消费（useLayoutShell 消费 pull、GitPanel
      // 消费 conflict）；能走到这里 hintAction 已保证 pid 存在（映射层门控）
      useGitFailHintStore().request(action.button.run, pid!)
    }

    // 弹友好提示（除非 silent）；同文案 5s 窗口去重——服务器重启瞬间多个
    // 并发请求同时失败会叠出一摞相同 toast（错误面板仍全量留痕可查）
    if (!error.config?.silent && _message && shouldShowToast('api:' + toastText)) {
      _message.error(
        () => h('div', { style: 'display: flex; align-items: center; gap: 12px;' }, [
          h('span', null, toastText),
          hintAction?.button && h(
            NButton,
            { size: 'tiny', quaternary: true, onClick: () => dispatchHintAction(hintAction) },
            () => i18n.global.t(hintAction.button!.labelKey),
          ),
          _panelSwitcher && h(
            NButton,
            { size: 'tiny', quaternary: true, onClick: () => _panelSwitcher!() },
            () => i18n.global.t('console.toastViewDetail'),
          ),
        ]),
        { duration: hintAction ? 10000 : 5000 },
      )
    }

    // 错误中心原地重试配置（P-20261003-179）：仅幂等 GET 附带——非幂等
    //（POST/DELETE 等）重放有重复副作用风险，安全边界不提供；PUT/PATCH 同为
    // 写意图请求从严不放行（安全边界详见 error-types ErrorRetryInfo 注）。
    // url 取改写前快照（远程代理改写拦截器写入），params 是 GET 的语义载荷
    //（readFile 的 path 等）；实例上下文快照供重放前校验
    const retry: ErrorRetryInfo | undefined = method === 'GET'
      ? {
          url: (error.config as RetryableInternalConfig | undefined)?.origUrl ?? url,
          params: error.config?.params,
          instanceId: _currentInstanceId,
          isRemote: _isRemoteInstance,
        }
      : undefined

    // 永远写 Console——但 P-246 等待者重投递（isWaiterRedelivery，见
    // withWaiterConfig）只入账一次：合并语义下一次网络失败一条账，首达者已记，
    // 重复入账会让错误中心计数翻倍（run9 errorlog-filter 三例实测形态）
    if (!(error as { isWaiterRedelivery?: boolean }).isWaiterRedelivery) {
      useErrorLogStore().add({
        category, method, url, status,
        rawMessage, userMessage,
        sourceLabel: error.config?.errorLabel,
        requestId,
        retry,
        // 结构化错误码（P-305 响应体 {error, code}；P-20261005-153）：详情面板
        // 徽标透出，用户报障可引用
        code: errorCode,
      })
    }

    // Console 面向开发者排障；silent 调用（存在性探测/批量恢复链等预期失败，
    // 调用方自行处置）不写——404 探测刷 console 会打穿 console-hygiene 零错误
    // 扫描。错误日志留痕（上方 errorLog.add）不在此列，silent 与否都记账
    if (!error.config?.silent) console.error('[API Error]', category, status, url, rawMessage)
    return Promise.reject(new AppError(
      category, rawMessage, status, url, method, error.config?.errorLabel,
      userMessage,
      // 结构化错误载荷（如 rebase/lock 409 携 remoteBranches、文件 409 携
      // currentContent）：调用方按需读取，不影响既有 message/rawMessage 契约
      (error.response?.data as Record<string, unknown> | undefined) ?? undefined,
    ))
  },
)

// 错误中心「重试」（P-20261003-179）：原地重放 GET 失败请求。经同一 axios 实例
// 发出——远程代理改写 / 解锁头 / 全局中止信号由既有请求拦截器重新生效；重放
// 失败走既有响应拦截器（新错误条目入账 + toast，原条目保持未恢复），重放成功
// 把原条目标记已恢复。返回是否已恢复（含拒绝重试的 false）。
export async function retryErrorEntry(entry: ErrorLogEntry): Promise<boolean> {
  const retryInfo = entry.retry
  if (!retryInfo) return false
  const ctx = getCurrentInstanceContext()
  if (ctx.instanceId !== retryInfo.instanceId || ctx.isRemote !== retryInfo.isRemote) {
    // 失败后切换过实例：原地重试会打到错误目标（另一实例/另一远程主机的同名
    // 路由），明确拒绝并提示回原面板
    _message?.warning(i18n.global.t('errorlog.retry.instanceChanged'))
    return false
  }
  try {
    await api.get(retryInfo.url, { params: retryInfo.params })
    useErrorLogStore().markRecovered(entry.id)
    return true
  } catch {
    // 失败详情由响应拦截器入账（新条目 + toast），此处只反馈「未恢复」
    return false
  }
}

export default api
