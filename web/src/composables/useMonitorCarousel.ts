import { ref, watch } from 'vue'

/**
 * 值班大屏轮播模式（P-20261005-166）：挂墙平板/副屏全天值守形态的观看编排——
 * 开启后每 intervalSec 秒滚动定位到下一大屏区块并描边高亮「当前幕」，无人值守
 * 的墙屏自动循环关键区块。纯前端会话态（不落盘，刷新回查看态，同编辑模式裁决）。
 *
 * 区块序列由宿主供给（getBlocks 每步现取）：临时置顶/类目显隐/空态让区块动态
 * 增减，DOM 是唯一真相，游标按「上次幕元素在新序列中的位置」解析（被卸载则
 * 回落序列首位，宁可靠左不跳步）。
 *
 * 三类暂停源收敛为「时钟停走」：任一命中即拆轮换表，全部解除才重上表（相位
 * 重置——恢复后重等一个完整间隔，避免「页签隐藏半程回前台立即跳幕」的突兀）：
 * - 用户交互（宿主接线 onUserInteraction）：人在操作时不抢滚动条，idle 窗满恢复
 * - 页签隐藏（本件自听 visibilitychange）：省资源，回前台恢复
 * - 宿主关停（再次点击开关 / 进入编辑模式 / 组件卸载）
 */

/** 轮播间隔档位（秒）：快扫 / 默认值守 / 慢速背景幕 */
export const MONITOR_CAROUSEL_INTERVALS = [10, 20, 60]
/** 交互暂停后的空闲恢复窗（毫秒）：人在操作时不抢滚动条，手离开 1 分钟交还轮播 */
export const MONITOR_CAROUSEL_IDLE_RESUME_MS = 60_000

/** data-testid 前缀 → 幕 id（与 MonitorView 类目区 testid 约定同源） */
function catIdOf(el: HTMLElement): string {
  return (el.getAttribute('data-testid') || '').replace(/^monitor-cat-/, '')
}

/**
 * @param getBlocks 当前渲染的轮播区块（有序），每步现取
 */
export function useMonitorCarousel(getBlocks: () => HTMLElement[]) {
  /** 开关（会话态不持久） */
  const on = ref(false)
  /** 间隔档位（秒），取值域 MONITOR_CAROUSEL_INTERVALS */
  const intervalSec = ref(20)
  /** 交互暂停中（人在操作；idle 窗满自动解除） */
  const pausedByInteraction = ref(false)
  /** 当前幕区块 id（'' = 无高亮；关停清空） */
  const focusId = ref('')

  let rotateTimer: ReturnType<typeof setInterval> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  /** 上次幕元素：跨步游标（存元素不存索引——区块集动态增减时索引不可靠） */
  let lastBlock: HTMLElement | null = null
  const docHidden = ref(false)

  /** 走一幕：游标推进 → 滚动定位 → 高亮换幕。首步只登记不推进——开启时刻的
   *  当前画面（序列首位）即第一幕，点击开关立即高亮给出「轮播已活」反馈，
   *  下个间隔才真正换幕（开启不应打断此刻观看位置） */
  function step(): void {
    const blocks = getBlocks()
    if (blocks.length === 0) return
    if (!lastBlock) {
      lastBlock = blocks[0]!
      focusId.value = catIdOf(lastBlock)
      return
    }
    const idx = blocks.indexOf(lastBlock)
    // 游标失效（幕块被卸载）时 (−1+1)%n=0 回落首位；末块自然回绕
    const next = blocks[(idx + 1) % blocks.length]!
    lastBlock = next
    focusId.value = catIdOf(next)
    // smooth 与分诊条定位/编队直达同手势；block:'start' 落点余量靠 .mon-cat
    // 的 scroll-margin-top（sticky 分诊行高度，既有约定）
    next.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  /** 轮换表同步：暂停源任一命中即空表；运行中才上表。intervalSec 变更即重上
   *  （新档位从当前时刻起算，不追旧相位） */
  function syncTimer(): void {
    if (rotateTimer !== null) {
      clearInterval(rotateTimer)
      rotateTimer = null
    }
    if (!on.value || pausedByInteraction.value || docHidden.value) return
    rotateTimer = setInterval(step, intervalSec.value * 1000)
  }
  watch([on, pausedByInteraction, docHidden, intervalSec], syncTimer)

  /** 交互暂停：挂起 + 重置 idle 窗（连续操作持续顺延，最后一下手离开才起算） */
  function armIdleTimer(): void {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      pausedByInteraction.value = false // watcher 重上轮换表
    }, MONITOR_CAROUSEL_IDLE_RESUME_MS)
  }

  /** 宿主交互接线入口（滚动/按压/按键任一命中即调；轮播控件自身由宿主豁免） */
  function onUserInteraction(): void {
    if (!on.value) return
    armIdleTimer()
    pausedByInteraction.value = true
  }

  function onVisibilityChange(): void {
    docHidden.value = document.hidden
  }
  document.addEventListener('visibilitychange', onVisibilityChange)

  /** 开关：开启登记首幕（step 首步语义，立即有高亮反馈）；关停拆干净（高亮/
   *  交互暂停/idle 定时器一并回收，重开从首幕重新开始） */
  function setOn(v: boolean): void {
    if (v === on.value) return
    on.value = v
    if (!v) {
      lastBlock = null
      focusId.value = ''
      if (idleTimer !== null) {
        clearTimeout(idleTimer)
        idleTimer = null
      }
      pausedByInteraction.value = false
      return
    }
    docHidden.value = document.hidden // 开启瞬间已在后台页签：直接进隐藏暂停
    const blocks = getBlocks()
    lastBlock = blocks[0] ?? null
    focusId.value = lastBlock ? catIdOf(lastBlock) : ''
  }

  /** 宿主卸载时调用：拆表 + 摘监听（本件不自动挂 Vue 生命周期——保持纯函数
   *  面，单测免组件实例即可驱动） */
  function dispose(): void {
    setOn(false)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }

  return { on, intervalSec, pausedByInteraction, focusId, setOn, onUserInteraction, dispose }
}
