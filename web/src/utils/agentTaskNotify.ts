import i18n from '../i18n'
import { useNotificationStore } from '../stores/notification'
import { useDesktopNotify } from '../composables/useDesktopNotify'
import type { RemoteTaskMeta, TaskProgressStep } from '../stores/assistantTask'
import { maskSensitive } from './sensitiveMask'
import { parseRemoteTaskKey } from './remoteTaskKey'

/**
 * agent 任务终态通知链（P-20261002-15）：task.progress 的 done/failed 分支 →
 * 通知中心入账（Category 任务，terminalId 在位带跳转 action）+ 桌面通知
 * （useDesktopNotify：页面聚焦时内部跳过，尊重 desktopNotify 总开关与任务分类
 * 子开关，均默认开；点击直达会话 P-20261004-121——terminalId 透传，onclick
 * 派发 OPS_ACTIVATE_TERMINAL 既有激活广播）。逻辑独立成纯函数模块：不持有视图
 * 状态，OpsChannelBridge 仅委托一行——组件拆分（P-27）时本链路随事件桥整体
 * 迁移即可。
 *
 * 联邦派发回流（P-20261004-131）：terminalId 携 remote: 命名空间键时，会话
 * 本体在对端——直达跳转换成跳实例（switch-instance action，useLayoutBootstrap
 * 既有分发），正文带来源实例注记（meta 缺省回退实例 id）
 */

/** task.progress 事件载荷（agentops 手册约定的字段） */
export interface AgentTaskProgressPayload {
  task?: string
  status?: string // running | done | failed
  step?: string
  steps?: TaskProgressStep[] // 结构化步骤清单（P-20261004-7，发布口已规整）
  terminalId?: string
  /** 结论摘要尾部（P-20261005-221，服务端发布口对终态尽力附加；已遮蔽压平）：
   * done=最后 assistant 结论 / failed=最后 error 现场。旧上报与远程回流链
   * （remote: 键载荷桥接自对端任务记录）无此字段——缺省=纯状态体不硬凑 */
  summary?: string
  /** 远程来源元数据（P-20261004-131 回流链携带；本地 WS 链无此字段） */
  remoteMeta?: RemoteTaskMeta
}

// —— 防重复：同 terminalId+status 短窗口只入账一次（智能体上报重试/WS 重连
// 可能重复送达同一终态）。指纹表模块级（多标签页各自一份，语义为「本页已入账
// 即不再入账」）；上限防长会话无界增长（同 seenDRecently 惯例）
const endFingerprints = new Map<string, number>()
const DEDUP_WINDOW_MS = 3000
const FP_MAX = 200

/** 终态指纹短窗口内出现过（幂等判断；now 可注入供测试驱动） */
export function seenTaskEndRecently(key: string, now = Date.now()): boolean {
  const prev = endFingerprints.get(key)
  if (prev !== undefined && now - prev < DEDUP_WINDOW_MS) return true
  endFingerprints.set(key, now)
  if (endFingerprints.size > FP_MAX) {
    const first = endFingerprints.keys().next()
    if (!first.done) endFingerprints.delete(first.value)
  }
  return false
}

// —— 耗时估算：任务身份首次上报非终态的时间记起点，终态消费即清除
//（同一会话的下一个任务从新的 running 重新记起点）；无起点则正文不含耗时
const startMarks = new Map<string, number>()
const START_MAX = 200

function markTaskStart(key: string, now: number): void {
  if (startMarks.has(key)) return
  startMarks.set(key, now)
  if (startMarks.size > START_MAX) {
    const first = startMarks.keys().next()
    if (!first.done) startMarks.delete(first.value)
  }
}

/** 消费起点并返回耗时毫秒；无起点（智能体未先报 running）返回 null */
export function takeTaskElapsed(key: string, now = Date.now()): number | null {
  const start = startMarks.get(key)
  startMarks.delete(key)
  if (start === undefined || now < start) return null
  return now - start
}

// 测试钩子：清空模块级状态（用例间隔离）
export function resetAgentTaskNotifyStateForTest(): void {
  endFingerprints.clear()
  startMarks.clear()
}

// —— 结论摘要展示装配（P-20261005-221） ——

/** 通知体摘要展示截断（rune）：80~120 档取中——桌面通知/webhook 正文长度敏感
 * （webhook 侧另有 500 rune 总截断兜底），超长以 … 标注省略 */
const NOTIFY_SUMMARY_MAX_RUNES = 100

/**
 * 摘要展示装配：遮蔽兜底（P-108 同模式集前端侧 maskSensitive——外发面从严，
 * 服务端 MaskText 为主、此处双保护）→ 空白归一单行 → rune 截断（先遮蔽后截，
 * 截断边界不劈开遮蔽命中）。空/纯空白返回空串 = 正文保持纯状态体
 */
export function clipNotifySummary(raw: string | undefined): string {
  const masked = maskSensitive((raw ?? '').trim())
  if (!masked) return ''
  const single = masked.replace(/\s+/g, ' ').trim()
  const runes = Array.from(single)
  if (runes.length <= NOTIFY_SUMMARY_MAX_RUNES) return single
  return runes.slice(0, NOTIFY_SUMMARY_MAX_RUNES).join('') + '…'
}

/**
 * 通知链入口（OpsChannelBridge 对每个 task.progress 事件调用一次）：
 * 非终态仅记耗时起点；终态经防重复后入账通知中心 + 发桌面通知
 */
export function handleAgentTaskProgressNotify(p: AgentTaskProgressPayload, now = Date.now()): void {
  // 身份键：terminalId 优先，缺省回退任务名（无归属上报的防重复）
  const identity = p.terminalId || p.task || ''
  if (p.status !== 'done' && p.status !== 'failed') {
    markTaskStart(identity, now)
    return
  }
  const store = useNotificationStore()
  // 任务事件子开关（通知偏好的「任务」分类，默认开）：关 → 中心与桌面双静默
  if (!store.isCategoryEnabled('task')) return
  if (seenTaskEndRecently(`${identity}|${p.status}`, now)) return
  const elapsedMs = takeTaskElapsed(identity, now)

  const t = (key: string) => i18n.global.t(key)
  const failed = p.status === 'failed'
  const title = p.task || t('notify.task.untitled')
  // 正文 = 完成/失败 + 耗时若有（格式同长任务通知的（N.Ns）后缀惯例）；
  // 远程来源（P-20261004-131）附实例注记——完成的是哪台机器上的活一眼可辨
  const remote = parseRemoteTaskKey(p.terminalId)
  let body =
    elapsedMs !== null
      ? `${failed ? t('notify.task.failed') : t('notify.task.done')}（${(elapsedMs / 1000).toFixed(1)}s）`
      : failed ? t('notify.task.failed') : t('notify.task.done')
  if (remote) {
    body += `\n${i18n.global.t('notify.task.remoteSource', { instance: p.remoteMeta?.instanceName || remote.instanceId })}`
  }
  // 结论摘要（P-20261005-221）：服务端发布口终态顺带附结论尾部，值守一屏知
  // 结果——中心条目/桌面通知/webhook 三消费面同 body 一致受益。done=结论、
  // failed=排障第一现场；缺字段/空结论（clip 后为空）保持纯状态体不硬凑
  const summary = clipNotifySummary(p.summary)
  if (summary) {
    // 带 {text} 插参的模板行不经单参包装 t（口径同 remoteSource 行的直调形态）
    body += `\n${failed ? i18n.global.t('notify.task.errorTail', { text: summary }) : i18n.global.t('notify.task.summary', { text: summary })}`
  }

  // 通知中心入账：后端失败 store.add 自动降级本地插入；failed 走 error 级样式（红点）。
  // 远程会话不在本地会话表，terminal 直达无意义 → 跳实例（switch-instance 既有分发）
  void store.add({
    type: failed ? 'error' : 'success',
    category: 'task',
    title,
    body,
    action: remote ? 'switch-instance' : p.terminalId ? 'terminal' : undefined,
    actionPayload: remote ? remote.instanceId : p.terminalId,
  })

  // 桌面通知：desktopNotify 总开关（子开关已在上方把关）；页面聚焦（visible）
  // 时 useDesktopNotify 内部跳过——回拉信号只打扰已切走的用户。携带 task
  // 类别（P-20261003-115）：免打扰例外类别按归属判定穿透。携带与入账同款分级
  //（P-20261004-117）：failed 走 error 级——夜间挂机跑任务失败时穿透勿扰
  // 仍弹桌面通知（值班警报可达性），done 的 success 级照旧静默。透传
  // terminalId（P-20261004-121）：桌面通知点击直达会话，与中心入账 action
  // 'terminal' 同款落点；无归属上报不传——点击仅聚焦维持现状
  if (store.prefs.desktopNotify) {
    useDesktopNotify().notify(title, body, 'task', failed ? 'error' : 'success', p.terminalId)
  }
}
