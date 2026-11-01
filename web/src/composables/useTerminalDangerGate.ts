import { reactive } from 'vue'
import type { MessageApi } from 'naive-ui'
import { useTerminalSessionsStore, sessionWorkingDir } from '../stores/terminal-sessions'
import { settingsApi } from '../api/domains/system'
import { terminalApi } from '../api/domains/terminal'
import {
  extractPasteCandidate,
  looksHighRisk,
  isRiskWhitelisted,
  previewNeedsConfirm,
  confirmRiskIds,
  type TerminalCommandPreviewResult,
} from '../utils/commandRisk'

/**
 * 终端高危命令影响面闸门（P-20261005-191）：粘贴链（onData 收口）与 palette
 * 命令直达插入链（TerminalView.sendText）共用的写入前预检。命中高危模式时
 * 先问服务端 /terminals/command-preview 拿影响面（模式 + 动态计数），弹确认
 * 卡（P-136 阈值确认同款形态），「仍要粘贴」才落 PTY；取消即丢弃。
 *
 * 结构化入口原理：两处入口的命令串在写入前整体可知（onData 的粘贴块带
 * bracketed-paste 包裹 / 直达链本来就是整段文本），无需从 shell 渲染域提取
 * 行——手敲（逐字符 onData）天然不构成候选，不拦（提案注明的明确边界）。
 *
 * 会话白名单：确认过的同型命令（同模式族 id）本页面会话不再拦——内存 Set，
 * 刷新即清（知情确认不跨会话免检，刻意保守）。
 */

// ============== 设置开关缓存（默认开） ==============
// 懒拉一次 + settings.changed 失效（OpsChannelBridge 桥接），粘贴是低频动作，
// 单飞请求缓存足够新鲜
let precheckEnabled: boolean | null = null
let precheckFetching: Promise<boolean> | null = null

/** settings 变更后失效缓存（下次预检现拉） */
export function invalidatePastePrecheckCache(): void {
  precheckEnabled = null
  precheckFetching = null
}

function isPastePrecheckEnabled(): Promise<boolean> {
  if (precheckEnabled !== null) return Promise.resolve(precheckEnabled)
  if (!precheckFetching) {
    precheckFetching = (settingsApi.get() as Promise<{ data?: { terminalPastePrecheckEnabled?: boolean } }>)
      .then(res => {
        // 缺字段（旧服务端）回落默认开；显式 false 才关
        precheckEnabled = res?.data?.terminalPastePrecheckEnabled !== false
        return precheckEnabled
      })
      .catch(() => {
        // 拉取失败保守取默认开（预检是知情面，缺位时宁可多问一次）
        precheckEnabled = true
        return true
      })
  }
  return precheckFetching
}

// ============== 确认卡状态（模块单例：多 pane 共享一张卡） ==============

export interface DangerGateCardState {
  show: boolean
  sessionId: string
  /** 展示用命令串（归一化后的候选文本） */
  command: string
  /** 服务端判定（预览失败为 null → 静态降级卡） */
  result: TerminalCommandPreviewResult | null
  /** 预览失败标记（卡上知情注记） */
  previewFailed: boolean
}

const card = reactive<DangerGateCardState>({
  show: false,
  sessionId: '',
  command: '',
  result: null,
  previewFailed: false,
})

/** 卡片状态（模块共享，宿主 pane 按归属渲染） */
export { card as dangerCard }

// ============== 串行裁决链（全局一条，期间一律不写 PTY） ==============
// 粘贴块到达即入队：卡片按到达顺序逐张开，排队中的块既不上屏也不丢。
// 收口成全局单链而非按会话分队列——确认卡是模块单例（一次一张），
// 两个会话并发裁决会互相覆盖 cardResolve（先开的卡永不 resolve，其块悬死）
let decisionChain: Promise<boolean> = Promise.resolve(true)

function enqueueDecision(job: () => Promise<boolean>): Promise<boolean> {
  // 前序异常（不应发生，decide 自捕获）按放行处理不拖累后续裁决
  const next = decisionChain.then(job, () => job())
  decisionChain = next
  // 摘链：链尾完成后复位空链，失败也复位（避免死链累积）
  next.catch(() => {}).finally(() => {
    if (decisionChain === next) decisionChain = Promise.resolve(true)
  })
  return next
}

// ============== UI 绑定（useMessage/useI18n 须在 setup 内取，宿主注入） ==============
type GateUi = { message: MessageApi; t: (k: string, p?: Record<string, unknown>) => string }
let gateUi: GateUi | null = null

/** 宿主装配时注入 toast/i18n（各 pane 行为一致，幂等覆盖） */
export function bindDangerGateUi(ui: GateUi): void {
  gateUi = ui
}

// ============== 闸门主入口 ==============

/**
 * 同步判定 + 异步闸门（onData 粘贴链用）：命中预筛返回 true（本 chunk 交由
 * 闸门接管发送），未命中返回 false（调用方走既有直发路径，零开销）。
 * 每个 onData chunk 现跑——纯本地正则，键入逐字符天然 miss。
 */
export function interceptTerminalInput(
  sessionId: string,
  rawData: string,
  sender: (raw: string) => void,
): boolean {
  const candidate = extractPasteCandidate(rawData)
  if (!candidate || !looksHighRisk(candidate)) return false
  void gateTerminalInput(sessionId, rawData, sender).catch(() => { /* 裁决链自捕获 */ })
  return true
}

/**
 * 闸门全流程（直达插入链 await 结果回告「已插入/已取消」；返回 true = 文本已
 * 写入终端（直接放行或确认后写入），false = 用户取消）。
 */
export function gateTerminalInput(
  sessionId: string,
  rawData: string,
  sender: (raw: string) => void,
): Promise<boolean> {
  const candidate = extractPasteCandidate(rawData)
  if (!candidate || !looksHighRisk(candidate)) {
    sender(rawData)
    return Promise.resolve(true)
  }
  return enqueueDecision(() => decide(sessionId, candidate, rawData, sender))
}

async function decide(
  sessionId: string,
  candidate: string,
  rawData: string,
  sender: (raw: string) => void,
): Promise<boolean> {
  // 开关关闭：直接放行（每次裁决现读缓存；缓存由 settings.changed/设置页保存失效，
  // 设置页切换对已连接 pane 即时生效）
  if (!await isPastePrecheckEnabled()) {
    sender(rawData)
    return true
  }
  let result: TerminalCommandPreviewResult | null = null
  let failed = false
  try {
    // 拦截器 unwrap 与 TS 类型不感知：按项目原风格手动 cast（system.ts 同注）
    const res = await terminalApi.previewCommand(candidate, cwdOfSession(sessionId)) as unknown as { data?: TerminalCommandPreviewResult }
    result = res?.data ?? null
  } catch {
    failed = true
  }
  // 服务端判空（无命中）：预筛误报，直接放行
  if (result && !result.matches?.length) {
    sender(rawData)
    return true
  }
  if (result && !previewNeedsConfirm(result)) {
    // 全零影响（干净树上的 git reset --hard 等）：灰提示不弹卡
    gateUi?.message.info(gateUi.t('terminal.cmdPreview.zeroImpact'))
    sender(rawData)
    return true
  }
  if (result && isRiskWhitelisted(result.matches)) {
    // 同型命令本会话确认过：放行（白名单按模式族粒度）
    sender(rawData)
    return true
  }
  const choice = await openCard(sessionId, candidate, result, failed)
  if (choice === 'paste') {
    confirmRiskIds((result?.matches ?? []).map(m => m.id))
    sender(rawData)
    return true
  }
  return false
}

/** 会话实时工作目录（OSC 7 上报，回落创建目录；远程/无册会话返回 '' → 静态降级） */
function cwdOfSession(sessionId: string): string {
  try {
    const s = useTerminalSessionsStore().sessions.find(x => x.id === sessionId)
    return s ? sessionWorkingDir(s) : ''
  } catch {
    return ''
  }
}

function openCard(
  sessionId: string,
  candidate: string,
  result: TerminalCommandPreviewResult | null,
  failed: boolean,
): Promise<'paste' | 'cancel'> {
  card.sessionId = sessionId
  card.command = candidate
  card.result = result
  card.previewFailed = failed
  card.show = true
  return new Promise(resolve => {
    cardResolve = resolve
  })
}

/** 卡的裁决回调（openCard 挂上，confirm/cancel 消费） */
let cardResolve: ((choice: 'paste' | 'cancel') => void) | null = null

/** 确认「仍要粘贴」 */
export function confirmDangerGate(): void {
  card.show = false
  cardResolve?.('paste')
  cardResolve = null
}

/** 取消（ESC/遮罩同效）：块被丢弃不落 PTY */
export function cancelDangerGate(): void {
  card.show = false
  cardResolve?.('cancel')
  cardResolve = null
}
