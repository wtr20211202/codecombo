import { ref, watch } from 'vue'
import { useUIStateStore } from '../stores/uiState'
import { useNarrowLayout } from './useNarrowLayout'

// 笔记面板呈现态持久化（P-20261112-6-S3 写作现场审计补齐）：管理侧栏开合
// （sidebarOpen）与编辑/预览模式（mode）随 notesView 键族落 uiState（open/
// activeId 同族子字段）。NotesPanel 每宿主挂载各自实例化（项目页主区 / 首页
// overlay 两宿主路由互斥挂载），落盘让呈现态跨刷新、跨宿主切换一致——否则
// 每次重挂都回出厂（编辑中切去首页再回来模式被翻回 edit 的断裂感）。
//
// 窄屏出厂口径（≤700px，useNarrowLayout 同断点）：sidebarOpen 默认收起（列表
// +编辑面放不下），恢复仅桌宽生效——读回在窄屏丢弃；窄屏会话里的真实切换动作
// 照常落盘（写不设宽条件，读守卫），换回桌面宽度的会话按存档恢复。
//
// 竞态守卫（loadList 保底选篇「人的输入优先」同哲学）：读回窗口内用户已切换
// （头部按钮）则恢复整体让位——既不翻回旧档值，也避免恢复 apply 经 persist
// watch 把用户刚写的新值覆盖成旧档（写链自污染）。恢复 apply 自身触发的
// persist 回声是同值幂等写（restoreNotesViewOnce 置开 → persistNotesViewOpen
// 回声同款，S1 既有口径）。

export function useNotesPanelPresentation() {
  // edit | preview——切换不重置编辑态，仅换呈现层
  const mode = ref<'edit' | 'preview'>('edit')
  // 管理侧栏（列表/搜索/回收站，子组件 NotesSidebar）显隐——独立视图大区域默认常显
  // （P-20261108-2，notepad 文档列表心智）；窄屏（≤700px）放不下列表+编辑面默认收起
  const sidebarOpen = ref(!useNarrowLayout().narrow.value)

  let touched = false

  function persistSidebarOpen(open: boolean): void {
    touched = true
    try {
      void useUIStateStore().saveNotesViewSidebarOpen(open)
    } catch { /* pinia 未激活等环境问题静默（persistNotesViewOpen 同款） */ }
  }
  function persistMode(m: 'edit' | 'preview'): void {
    touched = true
    try {
      void useUIStateStore().saveNotesViewMode(m)
    } catch { /* pinia 未激活等环境问题静默 */ }
  }
  watch(sidebarOpen, persistSidebarOpen)
  watch(mode, persistMode)

  /** 读回并应用持久化呈现态（NotesPanel onMounted 调用；每次挂载重读——宿主
   *  切换间隔里的切换动作已即时落盘，重读才拿得到最新值，memo 会串宿主旧值）。
   *  读取失败静默回落出厂（呈现态是增益不是关键路径） */
  async function restorePresentation(): Promise<void> {
    let saved: { sidebarOpen: boolean | null; mode: 'edit' | 'preview' | '' }
    try {
      saved = await useUIStateStore().getNotesViewPresentation()
    } catch {
      return
    }
    if (touched) return
    if (saved.sidebarOpen !== null && !useNarrowLayout().narrow.value) sidebarOpen.value = saved.sidebarOpen
    if (saved.mode) mode.value = saved.mode
  }

  return { mode, sidebarOpen, restorePresentation }
}
