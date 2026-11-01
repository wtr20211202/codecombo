import { watch } from 'vue'
import i18n from '../i18n'
import { useNotificationStore } from '../stores/notification'
import { useAssistantTaskStore } from '../stores/assistantTask'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useDesktopNotify } from './useDesktopNotify'
import { collectFleetBatches, type FleetBatchView } from '../utils/fleetBatches'

/**
 * 编队批级完成通知（P-20261005-145）：值班大屏 fleet 聚合卡的「收敛通知」半边
 * ——批内成员全员终态（无 running）时通知中心入账**单条**「编队完成：N 成功
 * M 失败」，点击直达聚合卡（monitor-fleet action → /monitor?fleet=<batchId>）。
 *
 * 语义对齐 agentTaskNotify 终态链（P-20261002-15）：任务类别子开关把门 + 桌面
 * 通知（useDesktopNotify：页面聚焦内部跳过）+ 防重复；差别在聚合粒度——批级
 * 去重（每批至多一条，不逐成员刷屏），且只认「页面开着期间观察到的运行→收敛
 * 沿」：打开前就已收口的批不补放（与 useFleetTaskBackflow 的 2min 新鲜窗同一
 * 「补账不重放」取向，页面刷新即重置）。
 *
 * 数据源全部为既有 store（会话快照 fleetBatch + bySession 终态），零新请求；
 * 挂载于 App 根（useFleetTaskBackflow 同款生命周期），值守面在任何页面都能收
 * 到收敛通知。多标签页各自一份观察态（agentTaskNotify 指纹表同语义）。
 */

// —— 模块级观察态（App 生命周期一份；刷新即重置） ——
let stopFn: (() => void) | null = null
/** 观察期间出现过 running 成员的批：「页面开着期间的收敛沿」判定依据 */
const everRunning = new Set<string>()
/** 已入账通知的批：批级去重（每批至多一条） */
const notified = new Set<string>()
/** 上限防长驻页面无界增长（seenTaskEndRecently FP_MAX 同惯例），FIFO 裁剪 */
const NOTIFIED_MAX = 200

/** 测试钩子：清空模块级状态（用例间隔离） */
export function resetFleetBatchWatchForTest(): void {
  stopFleetBatchWatch()
  everRunning.clear()
  notified.clear()
}

function notifyBatchDone(b: FleetBatchView): void {
  const store = useNotificationStore()
  // 任务事件子开关把门（通知偏好「任务」分类，默认开）：关 → 中心与桌面双静默
  //（agentTaskNotify 同款前置；去重标记照记——用户关开关不欠一条旧通知）
  if (!store.isCategoryEnabled('task')) return
  const t = (key: string, params?: Record<string, unknown>) => i18n.global.t(key, params as never)
  const title = t('notify.fleetBatch.title', { done: b.done, failed: b.failed })
  const body = b.name
  // Action 直达聚合卡：monitor-fleet → /monitor?fleet=<batchId>（useLayoutShell
  // 分发，与大屏 query 高亮消费端约定）；有失败成员走 warning 级样式（红点）
  void store.add({
    type: b.failed > 0 ? 'warning' : 'success',
    category: 'task',
    title,
    body,
    action: 'monitor-fleet',
    actionPayload: b.batchId,
  })
  if (store.prefs.desktopNotify) {
    // 携带与入账同款分级（P-20261004-117 口径：调用方透传 type 参与豁免判定
    // ——warning/success 均非 error 级，批级收敛照旧受勿扰约束）
    useDesktopNotify().notify(title, body, 'task', b.failed > 0 ? 'warning' : 'success')
  }
}

/** 单轮聚合评估：登记运行沿 + 收敛沿通知 + 观察态随批生命周期剪枝 */
export function evaluateFleetBatches(
  batches: FleetBatchView[],
): void {
  const seen = new Set<string>()
  for (const b of batches) {
    seen.add(b.batchId)
    if (b.running > 0) {
      everRunning.add(b.batchId)
      continue
    }
    // 收敛沿三守卫：观察过运行（页面打开前已收口的批不补放）、有真实终态
    //（无事实不通知）、批级去重
    if (!everRunning.has(b.batchId)) continue
    if (b.done + b.failed === 0) continue
    if (notified.has(b.batchId)) continue
    notified.add(b.batchId)
    if (notified.size > NOTIFIED_MAX) {
      const first = notified.values().next()
      if (!first.done) notified.delete(first.value)
    }
    notifyBatchDone(b)
  }
  // 批消失（成员全会话关闭）随账清理：同 batchId 不会复活（批身份一次性的），
  // 观察态不清理才会无界；notified 是防重放面，批不复活即无需随剪
  for (const id of everRunning) {
    if (!seen.has(id)) everRunning.delete(id)
  }
}

/** 启动批级观察（幂等）：会话快照（fleetBatch 元数据）与任务终态（bySession）
 *  任一变化即重算聚合——两条数据链（WS task.progress / 关闭清账快照）都已
 *  汇入这两个 store，此处是唯一观察点。bySession 深 watch：进度上报逐键写入
 *  （progressFor 原地赋值），浅层替换检测不到；对象量级 = 活跃任务数（几十
 *  上限），深比较开销可忽略 */
export function startFleetBatchWatch(): void {
  if (stopFn !== null) return
  const sessionsStore = useTerminalSessionsStore()
  const taskStore = useAssistantTaskStore()
  const evaluate = (): void => {
    evaluateFleetBatches(collectFleetBatches(sessionsStore.sessions, taskStore.bySession))
  }
  const unwatch = watch(
    () => [sessionsStore.sessions, taskStore.bySession] as const,
    evaluate,
    { deep: true },
  )
  evaluate()
  stopFn = () => {
    unwatch()
    stopFn = null
  }
}

export function stopFleetBatchWatch(): void {
  if (stopFn !== null) stopFn()
}
