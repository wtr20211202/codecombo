import { ref, computed, watch, nextTick, type ComputedRef, type Ref } from 'vue'
import { useI18n } from './useI18n'
import {
  settingsKeywordKey, settingsAnchorWords, SETTINGS_CONTROL_ANCHORS,
  pinyinInitials, type SettingsTabKey,
} from '../utils/settingsSearch'

/**
 * 设置分区搜索过滤 + 行级锚定（P-20261003-301 自 SettingsModal.vue 原样搬运）：
 * 分区搜索（P-20261001-9）——左栏顶部输入关键词，标题+关键词表命中的分区才保留，
 * 空输入恢复全部；haystack = 本 locale 的分区标题 + settingsSearch.keywords 词条
 * + 控件锚点词（P-20261003-39，锚点词既参与分区匹配也驱动行级定位）
 * + 拼音首字母索引（P-20261003-220 移植主线增量）：对同一 haystack 派生首字母串
 * 后按同一条 includes 子串语义并联命中——中文首字母查询（tz→通知）走首字母分支，
 * 英文/中文全称查询走原分子串分支，两者互不影响。
 * 行级锚定（P-20261003-39）——搜索命中且分区展开时滚动定位锚点控件行 +
 * ~2s 高亮闪烁——「词条→控件」的最后一跳，省掉肉眼扫十几行。渐进降级：
 * 锚点表未覆盖的词条 / 控件 testid 缺失（表漂移）一律静默保持分区级过滤现状。
 * 纯搬运不改逻辑；命令面板直达命令共用 settingsSearch.ts 同一张表。
 */

export interface SettingsSearchOptions {
  /** 分区表（键/标题/图标），由宿主从 settingsSearch.ts 单一来源派生 */
  tabs: ComputedRef<{ key: SettingsTabKey; label: string; icon: unknown }[]>
  activeTab: Ref<SettingsTabKey>
  /** 弹窗内容滚动容器（锚点滚动的边界，只滚容器不连带页面） */
  contentRef: Ref<HTMLElement | undefined>
}

export function useSettingsSearch(options: SettingsSearchOptions) {
  const { tabs, activeTab, contentRef } = options
  const { t } = useI18n()

  const searchQuery = ref('')
  const searchActive = computed(() => searchQuery.value.trim() !== '')
  const visibleTabs = computed(() => {
    const q = searchQuery.value.trim().toLowerCase()
    if (!q) return tabs.value
    return tabs.value.filter(tb => {
      const haystack = `${tb.label} ${t(settingsKeywordKey(tb.key))} ${settingsAnchorWords(tb.key)}`
      return haystack.toLowerCase().includes(q) || pinyinInitials(haystack).includes(q)
    })
  })
  // 过滤把当前分区藏掉时先落到首个命中分区：右栏内容永远可从导航到达
  watch(visibleTabs, (list) => {
    const first = list[0]
    if (searchActive.value && first && !list.some(tb => tb.key === activeTab.value)) {
      activeTab.value = first.key
    }
  })

  // === 行级锚定：搜索命中且分区展开时滚动定位锚点控件行 + ~2s 高亮闪烁 ===
  let flashEl: HTMLElement | null = null
  let flashTimer: ReturnType<typeof setTimeout> | undefined
  // 闪烁期跟随：异步内容（设置项/规则清单）晚于锚点落地会撑高上方区域，把
  // 刚定位好的目标行挤出可视区——位置一次性算死不够，闪烁期内持续纠偏
  let followRaf: number | undefined
  let followUntil = 0
  let followUserStop = false
  const FLASH_MS = 2000

  function stopFollow(): void {
    if (followRaf !== undefined) {
      cancelAnimationFrame(followRaf)
      followRaf = undefined
    }
    followCleanup?.()
    followCleanup = null
  }
  let followCleanup: (() => void) | null = null

  function clearAnchorFlash(): void {
    if (flashTimer !== undefined) {
      clearTimeout(flashTimer)
      flashTimer = undefined
    }
    stopFollow()
    followUserStop = false
    flashEl?.classList.remove('anchor-flash')
    flashEl = null
  }

  /** 内容滚动容器与可视框；弹窗/分区尚未完成布局（display:none、高 0）时 null */
  function contentViewport(): { content: HTMLElement; box: DOMRect } | null {
    const content = contentRef.value
    if (!content) return null
    const box = content.getBoundingClientRect()
    if (box.height <= 0) return null
    return { content, box }
  }

  /** 目标行是否已完整落在内容可视框内（含 4px 呼吸量） */
  function rowVisible(rect: DOMRect, box: DOMRect): boolean {
    return rect.top >= box.top && rect.bottom <= box.bottom
  }

  /** 居中定位（首跳语义）：只滚弹窗自身的内容滚动容器，不用 scrollIntoView——
   *  它可能连带滚动遮罩后的页面；已在可视框内的行不动（保持既有零位移语义） */
  function centerRow(el: HTMLElement): void {
    const view = contentViewport()
    if (!view) return
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0 || rowVisible(rect, view.box)) return
    const { content, box } = view
    const span = Math.min(rect.height, box.height)
    content.scrollTop += rect.top - box.top - (box.height - span) / 2
  }

  /** 纠偏（跟随期语义）：只把完全/部分离开可视框的目标行拉回边缘，不重复居中
   *  ——用户此刻的滚动手感不被「每帧居中」抢走 */
  function nudgeRowIntoView(el: HTMLElement): void {
    const view = contentViewport()
    if (!view) return
    const rect = el.getBoundingClientRect()
    if (rect.height <= 0 || rowVisible(rect, view.box)) return
    if (rect.height >= view.box.height) {
      // 比可视区还高：顶端对齐（与居中结果同侧，避免底部对齐把标题滚没）
      view.content.scrollTop += rect.top - view.box.top
      return
    }
    view.content.scrollTop += rect.top < view.box.top
      ? rect.top - view.box.top
      : rect.bottom - view.box.bottom
  }

  /** 闪烁期内跟随布局变化（rAF 节流，只读矩形；用户主动滚动即停手） */
  function followRow(el: HTMLElement): void {
    stopFollow()
    followUserStop = false
    followUntil = Date.now() + FLASH_MS
    const content = contentRef.value
    const stopOnUser = (): void => { followUserStop = true }
    content?.addEventListener('wheel', stopOnUser, { passive: true })
    content?.addEventListener('pointerdown', stopOnUser, { passive: true })
    content?.addEventListener('keydown', stopOnUser)
    followCleanup = () => {
      content?.removeEventListener('wheel', stopOnUser)
      content?.removeEventListener('pointerdown', stopOnUser)
      content?.removeEventListener('keydown', stopOnUser)
    }
    const step = (): void => {
      followRaf = undefined
      if (flashEl !== el || followUserStop || Date.now() > followUntil) {
        stopFollow()
        return
      }
      nudgeRowIntoView(el)
      followRaf = requestAnimationFrame(step)
    }
    followRaf = requestAnimationFrame(step)
  }

  /**
   * 定位并闪烁锚点控件行（P-20261003-39 搜索链与 P-20261006-43 深链共用的
   * 「最后一跳」）：只在当前激活 pane 内找锚点控件（各 pane 常驻 v-show，限定
   * 前缀防跨分区误中）；找不到（锚点表漂移/弹窗内容未挂载）返回 false 静默
   * 降级为分区级呈现。
   *
   * 未完成布局时同样返回 false（不预先加闪烁类）：深链首开时 n-modal 内容可能
   * 仍在 display:none/零高状态，此时 getBoundingClientRect 全零——照旧加
   * 闪烁类并以零矩形「定位」会把滚动写丢，弹窗随后可见时目标行仍在折叠线下，
   * 闪烁却已空转（palette-project-rules 实测）。revealAnchor 的短轮询据此继续
   * 等挂载；搜索链由 followRow 兜住异步内容撑高后的漂移。
   */
  function flashControlRow(tab: SettingsTabKey, controlId: string): boolean {
    const el = contentRef.value?.querySelector<HTMLElement>(
      `[data-testid="settings-pane-${tab}"] [data-testid="${controlId}"]`,
    )
    if (!el) return false
    if (!contentViewport()) return false
    if (el.getBoundingClientRect().height <= 0) return false
    centerRow(el)
    // 命令式加/摘闪烁类：目标行无 Vue 类绑定，重渲染不会覆写外部类
    el.classList.add('anchor-flash')
    flashEl = el
    followRow(el)
    flashTimer = setTimeout(clearAnchorFlash, FLASH_MS)
    return true
  }

  watch([searchQuery, activeTab], () => {
    void nextTick(() => {
      clearAnchorFlash()
      // nextTick 后重读最新值：输入与「自动落到首个命中分区」可能同帧先后变化
      const q = searchQuery.value.trim().toLowerCase()
      if (!q) return
      const tab = activeTab.value
      // 锚点匹配与分区过滤同语义：锚点词原分子串或其拼音首字母串命中皆定位
      const hit = SETTINGS_CONTROL_ANCHORS[tab]?.find(a =>
        a.match.toLowerCase().includes(q) || pinyinInitials(a.match).includes(q),
      )
      if (hit) flashControlRow(tab, hit.controlId)
    })
  })

  /**
   * 深链锚点直达（P-20261006-43）：不经搜索词、按 controlId 直接定位区块——
   * 命令面板「项目规则管理」等经 OPEN_SETTINGS_EVENT 携 anchor 到达时弹窗可能
   * 尚在挂载（首开），短轮询等 DOM 就绪（runbook/revealEditorLine 同范式），
   * 超时静默保持分区级呈现（与锚点表漂移同一降级语义）。
   */
  function revealAnchor(tab: SettingsTabKey, controlId: string): void {
    // 先摘前次闪烁：深链连发且未经过搜索词（搜索 watch 不触发）时，
    // flashEl/flashTimer 仍指向前次目标——不清则旧闪烁类残留、旧定时器错摘新闪
    clearAnchorFlash()
    const deadline = Date.now() + 1500
    const tick = () => {
      if (flashControlRow(tab, controlId)) return
      if (Date.now() < deadline) setTimeout(tick, 50)
    }
    void nextTick(tick)
  }

  return {
    searchQuery,
    searchActive,
    visibleTabs,
    clearAnchorFlash,
    revealAnchor,
  }
}
