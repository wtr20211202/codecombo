/**
 * md 表格列宽增强（P-20261010-1）——HTML table 自动布局按内容长度分配，长文本
 * 列贪婪扩张会把短列压到内容最小宽以下（中文无空格可断 →「待回复」逐字竖排）。
 *
 * 职责分界：短列下限保护是纯 CSS 面（`min-width: calc(4em + 26px)`——全局
 * border-box 下补回单元格 padding/边框壳、内容区 4em + `overflow-wrap: anywhere`，
 * 见 EditorMdPreviewPane.vue），本模块只承载需要 JS 的部分——th 右缘拖拽手柄：
 *  - 拖动即把该表切 `table-layout: fixed` 并按拖前实宽写 col 显式宽（拖动起点 =
 *    原布局，表不跳变），此后该表按用户值分配、未拖的表维持自动布局；
 *  - 双击手柄该列回自动——表上已无任何显式宽则整表回自动布局；
 *  - 宽度只落 DOM 不持久化（会话内记忆）：内容重渲染（v-html 替换）即回自动
 *    布局，与分享访客页同一轻形态；
 *  - 窄屏(<700px)与触屏拖拽交互不成立：CSS 隐藏手柄 + pointerdown 双守卫回落
 *    纯自动布局；宽屏拖出的 fixed 表在窗口变窄时经 matchMedia 单例监听整体回
 *    自动布局（监听挂媒体查询而非逐表——重渲染替换 DOM 不留悬挂引用）。
 *
 * 分享访客页（server/share/page.go 内联 JS）是同形态的独立实现（两处渲染层 CSS
 * 独立、无可共享模块），交互语义保持一致；fixed 后超长内容单元格的 ellipsis +
 * title 悬浮全文纪律也与其同款（title 只落实际截断的单元格，见 syncClipTitles）。
 */

/** 拖拽可用的最小视口宽度（窄屏触屏形态列宽拖拽交互不成立） */
const WIDE_MQ = '(min-width: 700px)'
/** 拖不出比短列下限更窄的列（与 CSS min-width:4em 同源） */
const MIN_COL_EM = 4

/** fixed 化标记类（CSS 据此切 table-layout 与单元格 ellipsis 收敛） */
const FIXED_CLS = 'sc-cols-fixed'

function tableColIndex(th: HTMLElement): number {
  const parent = th.parentElement
  if (!parent) return -1
  return Array.prototype.indexOf.call(parent.children, th)
}

/** 该表回纯自动布局：摘 colgroup/fixed 标记与截断 title */
export function restoreTableAuto(tb: HTMLElement): void {
  tb.querySelectorAll('colgroup').forEach(cg => cg.remove())
  tb.classList.remove(FIXED_CLS)
  tb.querySelectorAll('th,td').forEach(c => c.removeAttribute('title'))
}

/** 单元格横向 padding(左右 12px) + 折叠边框 ≈ 26px：页面全局 border-box，
 * min-width/col 宽都含这层——下限基准是内容宽 4em（四字短词单行），故
 * CSS 与 JS 拖拽下限都补回这层壳 */
const CELL_CHROME_PX = 26

/** ellipsis 截断的单元格补 title 悬浮全文（只落实际截断的；自动布局 + anywhere
 * 兜底下无横向截断 → 全清）。读 scrollWidth 强制同步排版，拖完调用即得新态 */
function syncClipTitles(tb: HTMLElement): void {
  tb.querySelectorAll('th,td').forEach(c => {
    const cell = c as HTMLElement
    cell.removeAttribute('title')
    if (cell.scrollWidth > cell.clientWidth + 1) cell.title = cell.textContent || ''
  })
}

function canDrag(): boolean {
  // matchMedia 缺失（极旧内核/非浏览器环境）时按窄屏处理：宁可没有拖拽也不误判
  return typeof window.matchMedia === 'function' && window.matchMedia(WIDE_MQ).matches
}

/** 按当前自动布局实宽固化为 col 显式宽并切 fixed（md 表无合并单元格，按首行
 * 列数建 col；0 宽（隐藏/测量前）不写，该列留在 fixed 的均分空间里） */
function applyTableFixed(tb: HTMLTableElement): void {
  const firstRow = tb.rows[0]
  if (!firstRow) return
  const cg = document.createElement('colgroup')
  Array.prototype.forEach.call(firstRow.cells, (c: HTMLElement) => {
    const colEl = document.createElement('col')
    const wpx = Math.round(c.getBoundingClientRect().width)
    if (wpx > 0) colEl.style.width = wpx + 'px'
    cg.appendChild(colEl)
  })
  tb.insertBefore(cg, tb.firstChild)
  tb.classList.add(FIXED_CLS)
  requestAnimationFrame(() => syncClipTitles(tb))
}

function attachHandle(tb: HTMLTableElement, th: HTMLElement): void {
  const h = document.createElement('span')
  h.className = 'col-handle'
  h.setAttribute('aria-hidden', 'true')
  // 拖拽态：fixed 切换惰性到首个 pointermove——纯点击/双击手柄不改变布局
  //（否则双击「恢复自动」会先把没拖过的表切成 fixed，语义自相矛盾）
  let dragIdx = -1
  let startX = 0
  let startW = 0
  let minW = 0
  let col: HTMLTableColElement | null = null

  h.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0 || (e.pointerType && e.pointerType !== 'mouse')) return
    if (!canDrag()) return
    const idx = tableColIndex(th)
    if (idx < 0 || !tb.rows.length) return
    dragIdx = idx
    startX = e.clientX
    startW = th.getBoundingClientRect().width
    // 拖不出比短列下限更窄的列（与 CSS min-width:calc(4em+26px) 同源——
    // border-box 下补回单元格 padding/边框壳，内容区才是 4em）
    minW = MIN_COL_EM * (parseFloat(getComputedStyle(tb).fontSize) || 14) + CELL_CHROME_PX
    try {
      h.setPointerCapture(e.pointerId)
    } catch {
      /* 指针已失效等时序忽略（捕获失败仅影响窗口外跟随，拖拽本身可用） */
    }
    h.classList.add('dragging')
    e.preventDefault() // 拖拽不触发表格文本选中
  })

  h.addEventListener('pointermove', (e: PointerEvent) => {
    if (dragIdx < 0) return
    if (!tb.classList.contains(FIXED_CLS)) applyTableFixed(tb)
    if (!col) col = (tb.querySelectorAll('colgroup col')[dragIdx] as HTMLTableColElement | undefined) ?? null
    if (!col) return
    col.style.width = Math.max(minW, startW + e.clientX - startX) + 'px'
  })

  const endDrag = () => {
    if (dragIdx < 0) return
    dragIdx = -1
    col = null
    h.classList.remove('dragging')
    syncClipTitles(tb)
  }
  h.addEventListener('pointerup', endDrag)
  h.addEventListener('pointercancel', endDrag)

  // 双击：该列回自动——清该列显式宽；表上已无任何显式宽则整表回自动布局
  //（未拖过的表没有 colgroup，遍历为空 → restoreTableAuto 天然 no-op）
  h.addEventListener('dblclick', () => {
    if (dragIdx >= 0) return
    const cols = tb.querySelectorAll('colgroup col')
    const c = cols[tableColIndex(th)] as HTMLTableColElement | undefined
    if (c) c.style.width = ''
    const pinned = Array.prototype.some.call(cols, (x: HTMLTableColElement) => x.style.width)
    if (!pinned) restoreTableAuto(tb)
    else syncClipTitles(tb)
  })

  th.appendChild(h)
}

/** 窄屏回落：宽屏拖出的 fixed 表在窗口变窄(<700px)时整体回自动布局 */
let narrowFallbackInstalled = false
function ensureNarrowFallback(): void {
  if (narrowFallbackInstalled || typeof window.matchMedia !== 'function') return
  const mq = window.matchMedia(WIDE_MQ)
  if (typeof mq.addEventListener !== 'function') return
  narrowFallbackInstalled = true
  mq.addEventListener('change', e => {
    if (e.matches) return
    document.querySelectorAll(`table.${FIXED_CLS}`).forEach(t => restoreTableAuto(t as HTMLElement))
  })
}

/**
 * 给 root 内所有 md 表格挂列宽拖拽手柄（幂等：dataset 守卫，内容重渲染替换
 * DOM 后重调安全）。挂载入口在 EditorMdPreviewPane（renderedHtml 每次变化后
 * nextTick 调用——v-html 替换出的新表不带手柄）
 */
export function enhanceMdTables(root: ParentNode): void {
  ensureNarrowFallback()
  root.querySelectorAll('table').forEach(t => {
    const tb = t as HTMLTableElement
    if (tb.dataset.colResize) return
    tb.dataset.colResize = '1'
    tb.querySelectorAll('th').forEach(th => attachHandle(tb, th))
  })
}
