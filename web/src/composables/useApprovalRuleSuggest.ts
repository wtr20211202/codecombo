import { ref } from 'vue'
import { safeStorage } from '../utils/storage'
import {
  APPROVAL_SUGGEST_SHOWN_KEY,
  detectAllowPattern,
  isPatternThrottled,
  loadShownMap,
  saveShownMap,
  type ApprovalPatternSuggestion,
  type ApprovalShownMap,
} from '../utils/approvalPattern'
import { opsConfirmApi, type ApprovalRecord } from '../api/domains/opsconfirm'
import { settingsApi, type AgentApprovalRule, type ApprovalRuleEffect } from '../api/domains/system'
import { openSettingsTab } from '../utils/openSettings'

/**
 * 审批模式自学习建议（P-20261006-28）：用户连续手动允许同型操作（近 7 天同
 * op 前缀 ≥3 次）且无对应规则覆盖时，建议把该模式升格为审批规则（P-35 规则
 * 可发现性补全——比 P-26 合并审批更前置的治本面）。检测/节流纯函数在
 * utils/approvalPattern；本 composable 只持数据面与两处胶水：
 * - 检测源拉取：既有 GET /ops-confirm?status=allowed（裁决落库数据面，软依赖
 *   注记：P-162 审批同类历史在队，其历史数据落地后可换更近便的源，接口面
 *   不变）+ GET /settings 规则表（覆盖判定用），失败静默保旧值——建议是
 *   增强引导，缺数据只少一次建议，不弹错不阻断裁决
 * - 节流落账：7 天同模式只建议一次（提案定值）。shown 表加载进模块级 plain
 *   object（非响应式是刻意的）：markShown 只写存储不翻响应式面——建议条不
 *   因「刚标记完」而自我隐藏，重开页面经存储读回才生效节流
 *
 * 状态为模块级单例（useApprovalGuide 同款），全局卡堆（ApprovalCards）与值班
 * 大屏（MonitorView）两宿主共用同一份数据与节流——大屏裁决同样计入模式。
 *
 * 规则预填通道（一键进入 P-35 规则表单）：设置弹窗内容随 n-modal 显隐装卸，
 * 建议条点击时弹窗多半关闭、window 事件无人接——预填请求落模块级 ref，
 * 设置侧两侧消费（SecuritySettings 切审批规则页签，ApprovalRulesSettings 开
 * 新增弹窗并预填 op 前缀 + allow，用户确认粒度后自行保存，不自动落库）。
 */

export interface ApprovalRulePrefill {
  opPattern: string
  effect: ApprovalRuleEffect
}

/** 待消费的规则预填请求（消费即清 null；null = 无待办） */
export const pendingRulePrefill = ref<ApprovalRulePrefill | null>(null)

/** 建议条「创建规则」入口：落预填请求 + 打开设置弹窗定位安全分区（既有
 *  OPEN_SETTINGS_EVENT 通道）。大屏路由须先回首页再调本函数——show 宿主监听
 *  随首页宿主注册，直接发事件会落空；该路由前置在建议条组件内处理
 *  （ApprovalModeBadge.openRecovery 同款，组件才持有 useRouter） */
export function requestApprovalRulePrefill(opPattern: string): void {
  pendingRulePrefill.value = { opPattern, effect: 'allow' }
  openSettingsTab('security')
}

// ---- 检测数据面（模块级单例） ----

const history = ref<ApprovalRecord[]>([])
const rules = ref<AgentApprovalRule[]>([])
/**
 * 节流表读侧快照：模块首个消费者触发时从存储加载一次，此后**只读**——
 * 刻意不随 markShown 翻新（读侧快照若同步落账，任何一次建议重算——seedPending
 * 重入/WS 重播/refresh 再完成都会触发——会把「本集刚展示过」误判成「7 天内
 * 已建议」而当场自我隐藏，e2e 重试态实测踩坑）。7 天节流的生效点是「下一次
 * 加载」：重开页面/刷新后快照重读，本集展示过的模式即被抑制
 */
let shownMap: ApprovalShownMap = {}
let shownLoaded = false
/** 写侧累积：本会话各次 markShown 的合并面——与读侧快照合并后整体落存储，
 *  同会话多模式多次落账互不覆盖 */
const writtenMarks: ApprovalShownMap = {}
/** 「暂不」会话内即隐集合（节流管跨会话，这里管当次不烦人） */
const dismissedPatterns = ref<Set<string>>(new Set())
/** in-flight 防抖 + 过期响应丢弃序号（并发刷新后到者胜，旧响应不覆写） */
let fetchSeq = 0

function ensureShownLoaded(): void {
  if (shownLoaded) return
  shownMap = loadShownMap(k => safeStorage.getItem(k))
  shownLoaded = true
}

/** 拉取检测源（silent）：allowed 裁决列表 + settings 规则表。limit 500 收敛
 *  payload——30 天保留窗内 allowed 记录超 500 的极端值守场景取最新 500，检测
 *  best-effort 降级不失效（量级注记：审批是低频人机交互，常规远低于此） */
async function refresh(): Promise<void> {
  const seq = ++fetchSeq
  try {
    const [listRes, cfgRes] = await Promise.all([
      opsConfirmApi.list({ status: 'allowed', limit: 500 }),
      settingsApi.get({ silent: true }),
    ])
    if (seq !== fetchSeq) return
    history.value = (listRes as unknown as { data?: ApprovalRecord[] })?.data ?? []
    rules.value = (cfgRes as unknown as { data?: { agentApprovalRules?: AgentApprovalRule[] } })?.data?.agentApprovalRules ?? []
  } catch { /* 检测源拉取失败：保旧值，建议静默缺席 */ }
}

/** 首次展示落节流：写存储（读侧快照刻意不翻新，见其注记——建议条不在场期
 *  因自身落账被重算隐藏），不翻任何响应式面。同模式双宿主同帧各标一次幂等 */
function markShown(pattern: string): void {
  const key = pattern.trim().toLowerCase()
  if (!key) return
  ensureShownLoaded()
  writtenMarks[key] = new Date().toISOString()
  safeStorage.setItem(APPROVAL_SUGGEST_SHOWN_KEY, JSON.stringify(saveShownMap({ ...shownMap, ...writtenMarks })))
}

/** 「暂不」：会话内即隐（7 天节流已在首次展示时落存储，此处只收显隐） */
function dismiss(pattern: string): void {
  const key = pattern.trim().toLowerCase()
  if (!key) return
  dismissedPatterns.value = new Set([...dismissedPatterns.value, key])
}

/**
 * 对当前 pending 堆算建议：按堆序取首个通过「检测 → 节流 → 暂不」三道门的
 * pending op；无则 null。同屏多张同型卡只出一条（防噪音）；首个模式被节流
 * 时后继模式仍可建议（节流按模式隔离）
 */
function suggestionFor(pending: ApprovalRecord[]): ApprovalPatternSuggestion | null {
  ensureShownLoaded()
  const now = Date.now()
  for (const rec of pending) {
    if (rec.status !== 'pending') continue
    const hit = detectAllowPattern(history.value, rec.op, rules.value, now)
    if (!hit) continue
    const key = hit.pattern.trim().toLowerCase()
    if (dismissedPatterns.value.has(key)) continue
    if (isPatternThrottled(shownMap, hit.pattern, now)) continue
    return hit
  }
  return null
}

export function useApprovalRuleSuggest() {
  return { refresh, suggestionFor, markShown, dismiss }
}

// ---- 单测复位钩子（模块级单例的跨例隔离，useFleetTaskBackflow 同款约定） ----
export function resetApprovalRuleSuggestForTest(): void {
  history.value = []
  rules.value = []
  shownMap = {}
  shownLoaded = false
  for (const k of Object.keys(writtenMarks)) delete writtenMarks[k]
  dismissedPatterns.value = new Set()
  pendingRulePrefill.value = null
  fetchSeq = 0
}
