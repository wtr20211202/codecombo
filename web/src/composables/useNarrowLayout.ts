import { readonly, ref, watch } from 'vue'

/**
 * 窄屏工作区形态（P-20261019-7）：≤700px 与 md 表格窄屏回落、设置弹窗
 * （P-20261019-6）同口径——手机竖屏是产品既有形态（二维码接力扫码直达
 * 当前页），但项目页多栏布局此前没有收口。
 *
 * 形态只改「呈现」，不改 uiState 语义：侧栏/底栏的开合状态沿用同一套
 * showSidePanel/showBottomPanel，桌面↔窄屏切换时同一状态自然映射（窄屏把
 * 侧栏变 drawer、底栏变覆盖主区的抽屉），无需第二套持久化键。
 *
 * 用 matchMedia 而非 resize 监听：断点翻转才触发，窗口拖拽过程零回调；
 * jsdom（vitest）无 matchMedia 时保持 desktop 形态，组件测试不受影响。
 */
export const NARROW_BREAKPOINT = 700
const NARROW_QUERY = `(max-width: ${NARROW_BREAKPOINT}px)`

/**
 * 顶栏紧凑档断点：700~900px（小平板/分屏窗口）工作区仍用桌面多栏形态，但
 * 顶栏图标按钮已放不下（实测 768px 溢出 29px）；该档只把低频图标收进
 * 「更多」菜单，不改 rail/侧栏/底栏形态。
 */
export const COMPACT_TOPBAR_BREAKPOINT = 900
const COMPACT_TOPBAR_QUERY = `(max-width: ${COMPACT_TOPBAR_BREAKPOINT}px)`

const narrow = ref(false)
const compactTopbar = ref(false)
let mql: MediaQueryList | null = null
let compactMql: MediaQueryList | null = null

function syncFromMql(event?: MediaQueryListEvent): void {
  narrow.value = event ? event.matches : !!mql?.matches
}

function syncCompactFromMql(event?: MediaQueryListEvent): void {
  compactTopbar.value = event ? event.matches : !!compactMql?.matches
}

function ensureNarrowQuery(): void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
  // 两个媒体查询各只建一次；任一已建时仅补另一个（模块单例，首个组件 setup 初始化）
  if (mql === null) {
    mql = window.matchMedia(NARROW_QUERY)
    narrow.value = mql.matches
    // 旧 Safari 只有 addListener：两种 API 都防御性探测，三平台浏览器一致
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', syncFromMql)
    else if (typeof mql.addListener === 'function') mql.addListener(syncFromMql)
  }
  if (compactMql === null) {
    compactMql = window.matchMedia(COMPACT_TOPBAR_QUERY)
    compactTopbar.value = compactMql.matches
    if (typeof compactMql.addEventListener === 'function') compactMql.addEventListener('change', syncCompactFromMql)
    else if (typeof compactMql.addListener === 'function') compactMql.addListener(syncCompactFromMql)
  }
}

/**
 * 窄屏编辑器编辑态（项目页会话级，不落 uiState）：窄屏默认只读，用户显式
 * 点「开始编辑」后保持到离开窄屏或刷新——安全默认（防误触改文件），
 * 刷新/换设备回到只读。跨文件保留编辑态：连续改多个文件不必每次解锁。
 */
const editorEditing = ref(false)

// 进入窄屏即回到只读默认：桌面缩窗/手机旋转回横屏再进入都重新走安全态。
// 离开窄屏不清零——桌面本就不看该值，再次进入会先复位。
watch(narrow, (v) => {
  if (v) editorEditing.value = false
})

export function useNarrowLayout() {
  ensureNarrowQuery()
  return {
    narrow: readonly(narrow),
    compactTopbar: readonly(compactTopbar),
    narrowEditorEditing: readonly(editorEditing),
    setNarrowEditorEditing(v: boolean): void {
      editorEditing.value = v
    },
    toggleNarrowEditorEditing(): void {
      editorEditing.value = !editorEditing.value
    },
  }
}

/** 仅供测试：重置模块级状态（matchMedia 监听随 jsdom 环境销毁，无需移除） */
export function resetNarrowLayoutForTests(): void {
  narrow.value = false
  compactTopbar.value = false
  editorEditing.value = false
  mql = null
  compactMql = null
}
