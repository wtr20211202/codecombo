/**
 * 值班大屏卡片类目布局（P-20261004-18）：类目级顺序 + 显隐的纯函数层。
 *
 * 大屏活动卡按「类目」分组渲染（编队/审批/提问/任务/会话五块），用户可在
 * 编辑模式下拖拽整块重排、按类目隐藏；顺序与隐藏集持久化在 uiState
 * monitorBoard 命名空间（消费方 composables/useMonitorBoardLayout.ts）。
 *
 * 设计对齐 panels/registry.ts 的 rail-top 手动序先例：
 * - 手动表只存已知类目 id（去重、剔除未注册）；空表 = 未定制回落内置序；
 * - 手动表缺失的类目（版本演进新增）按内置序续尾——定制不吞新类目；
 * - 拖拽语义 = insert-before（拖到目标 = 移到其前，VS Code 活动栏惯例）。
 *
 * 本模块零 Vue/组件依赖：全部纯函数，供宿主与单测共用。
 */

/** 大屏活动卡类目 id（固定五个；新增类目在此登记 + 补 i18n labelKey） */
export type MonitorCardId = 'fleet' | 'approvals' | 'asks' | 'tasks' | 'sessions'

export interface MonitorCardDef {
  id: MonitorCardId
  /** 类目标题 i18n key（monitorBoard.layout.cat* 编辑模式类目头/临时置顶徽标用） */
  labelKey: string
}

/** 类目注册表（内置序 = 未定制时的渲染序，与历史渲染顺序一致：
 *  编队 → 审批 → 提问 → 任务 → 会话）。新增类目 = 表内加一行。 */
export const MONITOR_CARDS: readonly MonitorCardDef[] = [
  { id: 'fleet', labelKey: 'monitorBoard.layout.catFleet' },
  { id: 'approvals', labelKey: 'monitorBoard.layout.catApprovals' },
  { id: 'asks', labelKey: 'monitorBoard.layout.catAsks' },
  { id: 'tasks', labelKey: 'monitorBoard.layout.catTasks' },
  { id: 'sessions', labelKey: 'monitorBoard.layout.catSessions' },
]

export const MONITOR_CARD_IDS: readonly MonitorCardId[] = MONITOR_CARDS.map(c => c.id)

const KNOWN_IDS = new Set<string>(MONITOR_CARD_IDS)

export function isMonitorCardId(x: unknown): x is MonitorCardId {
  return typeof x === 'string' && KNOWN_IDS.has(x)
}

/** 类目 id → labelKey（渲染层取标题用；未知 id 返回 '' 不渲染标题） */
export function monitorCardLabelKey(id: string): string {
  return MONITOR_CARDS.find(c => c.id === id)?.labelKey || ''
}

/**
 * 清洗持久化/外部输入的类目顺序表：非数组 → null（= 未定制）；已知字符串
 * 保留并去重；空表 → null。未注册 id（类目下线/脏数据）剔除——防御式读取
 * 不崩溃（restoreRailTopOrder 同口径）。
 */
export function normalizeMonitorCardOrder(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  for (const x of raw) {
    if (typeof x === 'string' && KNOWN_IDS.has(x) && !out.includes(x)) out.push(x)
  }
  return out.length > 0 ? out : null
}

/** 清洗隐藏类目集（有序性无意义，落盘用数组）：已知 id 去重保留，脏值剔除。 */
export function normalizeMonitorHiddenCards(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const x of raw) {
    if (typeof x === 'string' && KNOWN_IDS.has(x) && !out.includes(x)) out.push(x)
  }
  return out
}

/** 合成渲染序：手动表在前（已清洗），未收录类目按内置序续尾；无手动表 = 内置序。 */
export function mergeMonitorCardOrder(manual: readonly string[] | null): MonitorCardId[] {
  if (!manual || manual.length === 0) return [...MONITOR_CARD_IDS]
  const merged = manual.filter((x): x is MonitorCardId => KNOWN_IDS.has(x))
  for (const id of MONITOR_CARD_IDS) {
    if (!merged.includes(id)) merged.push(id)
  }
  return merged
}

/**
 * 拖拽重排：drag 类目移到 target 之前（insert-before）。同名 / 任一 id 不在
 * 表内 / 结果与现状相同 → null（调用方 no-op 免空写）。返回新全序。
 */
export function moveMonitorCard(
  order: readonly string[],
  dragId: string,
  targetId: string,
): MonitorCardId[] | null {
  if (!dragId || !targetId || dragId === targetId) return null
  const current = mergeMonitorCardOrder(order)
  const from = current.indexOf(dragId as MonitorCardId)
  const to = current.indexOf(targetId as MonitorCardId)
  if (from < 0 || to < 0) return null
  const next = [...current]
  next.splice(from, 1)
  // 移除后 target 前移一位（仅当从后往前拖时）：insert-before 语义（moveRailPanel 同式）
  next.splice(to > from ? to - 1 : to, 0, dragId as MonitorCardId)
  if (next.every((id, i) => id === current[i])) return null
  return next
}

export interface MonitorVisibility {
  /** 常驻类目（未隐藏），按用户序 */
  shown: MonitorCardId[]
  /** 隐藏但有待处理项 → 临时置顶显示（防漏看护栏），按内置序（确定性） */
  tempShown: MonitorCardId[]
}

/**
 * 显隐裁决：隐藏且无 pending 的类目不渲染；隐藏但有 pending 的类目临时显示
 * 并置顶（值守一屏余光监控的防漏看护栏——先看到急事，再看日常布局）。
 * pending 判定由宿主按类目语义给定（审批/提问=有待处理项，任务=非 done，
 * 会话=有运行中，编队=有运行中或失败批）。
 */
export function splitMonitorVisibility(
  merged: readonly MonitorCardId[],
  hidden: readonly string[],
  pending: ReadonlySet<string>,
): MonitorVisibility {
  const hiddenSet = new Set(hidden)
  const tempSet = new Set<MonitorCardId>()
  const shown: MonitorCardId[] = []
  for (const id of merged) {
    if (!hiddenSet.has(id)) {
      shown.push(id)
      continue
    }
    if (pending.has(id)) tempSet.add(id)
  }
  // 临时置顶块按内置序输出（多类目同时触发时顺序确定，不随用户序抖动）
  const tempShown = MONITOR_CARD_IDS.filter(id => tempSet.has(id))
  return { shown, tempShown }
}
