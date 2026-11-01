/**
 * 闪烁自诊断（P-20261011-1 ④）：`?__debug-flicker=1` 激活。
 *
 * 动机：远控/串流（低帧率、事件节流）环境下全屏遮罩「闪烁/无法使用」的
 * 现场取证此前只能靠猜测——本模块用零侵入的 MutationObserver 记录全屏遮罩
 * 与顶层弹层的显隐事件流（类名 + transition 阶段 + 时间戳）：
 *
 * - 控制台逐行打印（`[flicker]` 前缀，远控现场 F12 复制即得）；
 * - 同步积累进 `window.__scFlickerLog` 环形缓冲（上限 500，防振荡风暴打爆
 *   内存——这正是被诊断场景的常态），`window.__scFlickerDump()` 一键导出
 *   文本供智能体经 ops 会话回传（诊断能力一等公民可被智能体驱动）；
 * - 激活链路双入口：冷启动直读 `window.location.search`（router 解析前即
 *   武装，boot 遮罩首现事件不漏）；运行期经 ops navigate 携 query 跳转，
 *   由 App.vue 的 route.query watch 驱动 setFlickerDebug 开关。
 *
 * 无本机守卫（与 ?__crash=1 不同）：本模块纯只读观测，不注入不改行为，
 * 远程实例（非本机主机名）访问同样需要它——那正是串流诊断的主场景。
 */

/** 激活参数名（URL query key） */
export const FLICKER_DEBUG_QUERY_KEY = '__debug-flicker'

/** 控制台事件流行前缀（e2e/人工均按此 grep） */
export const FLICKER_LOG_PREFIX = '[flicker]'

/** 观测面：全屏遮罩族 + naive 顶层弹层遮罩 + modal 过渡阶段类。
 * modal 的过渡类挂在 BodyWrapper 的包装 div 上（不带 .n-modal-mask），
 * 单列为选择器才能捕捉「弹窗淡入淡出卡住」的离场阶段 */
export const FLICKER_WATCH_SELECTORS = [
  '.app-boot-loading',
  '.instance-switch-overlay',
  '.lock-overlay',
  '.n-modal-mask',
  '.n-drawer-mask',
  '.fade-in-scale-up-transition-enter-active',
  '.fade-in-scale-up-transition-leave-active',
] as const

/** 单条事件：t=墙钟、dt=会话内相对 ms、kind=显隐/阶段、phase=transition 阶段 */
export interface FlickerEvent {
  t: number
  dt: number
  kind: 'show' | 'hide' | 'phase'
  target: string
  phase: string
  classes: string
}

/** 环形缓冲上限：振荡风暴下防无界内存（超出丢最旧，dropped 计数进 stop 行） */
export const FLICKER_LOG_CAP = 500

/** Vue Transition 阶段类后缀（boot-fade-leave-active → leave-active） */
const TRANSITION_PHASE_RE = /-(enter|leave)-(active|from|to)$/

/** 从 class 串解析 transition 阶段（无过渡类 → idle）。-active 是过渡进行中
 * 的伞标（离场全程在场），优先上报；无 active 时取最后一个命中（from/to） */
export function parseTransitionPhase(classes: string): string {
  const hits: string[] = []
  for (const c of classes.split(/\s+/)) {
    const m = c.match(TRANSITION_PHASE_RE)
    if (m) hits.push(m[0].slice(1))
  }
  if (hits.length === 0) return 'idle'
  return hits.find(h => h.endsWith('-active')) ?? hits[hits.length - 1]!
}

/** 事件 → 控制台/导出统一行格式（前缀稳定，供 grep 与 e2e 断言） */
export function formatFlickerEvent(e: FlickerEvent): string {
  return `${FLICKER_LOG_PREFIX} +${e.dt}ms ${e.kind} ${e.target} phase=${e.phase} classes="${e.classes}"`
}

interface FlickerWindow {
  __scFlickerLog?: FlickerEvent[]
  __scFlickerDump?: () => string
}

/** DOM 全局窗（bare Window 接口不含 console/Element——它们在 typeof globalThis 侧） */
type DomWindow = Window & typeof globalThis

let running: { stop: () => void } | null = null

/**
 * 启动观测（幂等：已在跑则返回同一 stop 句柄）。stop 带重入守卫——断开
 * 观察、打印 stop 行、清单例；缓冲与导出函数保留在 window 上供事后读取。
 */
export function startFlickerDebug(win: DomWindow = window): () => void {
  if (running) return running.stop
  const fw = win as unknown as FlickerWindow
  const doc = win.document
  if (!doc || !doc.body) return () => {}

  const buffer: FlickerEvent[] = []
  fw.__scFlickerLog = buffer
  fw.__scFlickerDump = () => buffer.map(formatFlickerEvent).join('\n')

  const startedAt = Date.now()
  // 同元素去重：类名没变的重复 attribute 突变不打（Vue 批量 patch 常见）
  const lastLine = new WeakMap<Element, string>()

  function push(kind: FlickerEvent['kind'], target: string, el: Element | null, classes: string): void {
    const phase = parseTransitionPhase(classes)
    // 去重键不含 kind：show 后紧跟的同值 attribute 突变（Vue 批量 patch 常见）
    // 是冗余 phase 事件，跳过；类名真变了键必变，照常打
    const key = `${target}|${phase}|${classes}`
    if (el && kind === 'phase' && lastLine.get(el) === key) return
    if (el) lastLine.set(el, key)
    const evt: FlickerEvent = {
      t: Date.now(),
      dt: Date.now() - startedAt,
      kind,
      target,
      phase,
      classes,
    }
    if (buffer.length >= FLICKER_LOG_CAP) buffer.shift()
    buffer.push(evt)
    // eslint-disable-next-line no-console -- 诊断流本体即输出目的，e2e/人工按前缀 grep
    win.console.log(formatFlickerEvent(evt))
  }

  function matchSelector(el: Element): string | null {
    for (const sel of FLICKER_WATCH_SELECTORS) {
      try {
        if (el.matches(sel)) return sel
      } catch {
        // 选择器为静态常量不会非法；防御 continue
      }
    }
    return null
  }

  /** 新增节点：本体命中记 show；命中节点的后代（modal 包装 div 内的 mask）也记 */
  function scanAdded(root: Element): void {
    const direct = matchSelector(root)
    if (direct) push('show', direct, root, root.className)
    for (const sel of FLICKER_WATCH_SELECTORS) {
      if (sel.startsWith('.fade-in')) continue // 过渡阶段类只经 attribute 突变捕捉
      root.querySelectorAll(sel).forEach((hit) => {
        push('show', sel, hit, hit.className)
      })
    }
  }

  /** 移除节点：本体或后代命中记 hide（取缓冲内最后一次类名，Element 已脱离文档时 className 仍可读） */
  function scanRemoved(root: Element): void {
    const direct = matchSelector(root)
    if (direct) push('hide', direct, root, root.className)
    for (const sel of FLICKER_WATCH_SELECTORS) {
      if (sel.startsWith('.fade-in')) continue
      root.querySelectorAll(sel).forEach((hit) => {
        push('hide', sel, hit, hit.className)
      })
    }
  }

  const observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        const el = m.target
        if (!(el instanceof win.Element)) continue
        const sel = matchSelector(el)
        if (sel) push('phase', sel, el, el.className)
      } else if (m.type === 'childList') {
        m.addedNodes.forEach((n) => {
          if (n instanceof win.Element) scanAdded(n)
        })
        m.removedNodes.forEach((n) => {
          if (n instanceof win.Element) scanRemoved(n)
        })
      }
    }
  })
  observer.observe(doc.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  })

  win.console.log(
    `${FLICKER_LOG_PREFIX} session start selectors=${FLICKER_WATCH_SELECTORS.join(',')}`,
  )

  const session = { stopped: false }
  const stop = (): void => {
    if (session.stopped) return
    session.stopped = true
    observer.disconnect()
    win.console.log(
      `${FLICKER_LOG_PREFIX} session stop events=${buffer.length}（缓冲保留于 window.__scFlickerLog，__scFlickerDump() 导出）`,
    )
    if (running && running.stop === stop) running = null
  }
  running = { stop }
  return stop
}

/** 显隐开关（App.vue 的 route.query watch 调用）：幂等，重复同向调用无副作用 */
export function setFlickerDebug(active: boolean, win: DomWindow = window): void {
  if (active) {
    startFlickerDebug(win)
  } else {
    // stop 自带重入守卫并自清单例，未运行时调用为无害空操作
    running?.stop()
  }
}
