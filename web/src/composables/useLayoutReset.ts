import { useMessage } from 'naive-ui'
import { useProjectStore } from '../stores/project'
import { useUIStateStore } from '../stores/uiState'
import { LAYOUT_DEFAULTS, usePanelLayout } from './usePanelLayout'
import { confirmDialog } from './useDialog'
import { useI18n } from './useI18n'
import { OPS_COLLAPSE_TREE } from '../utils/opsEvents'

/**
 * 一键重置当前项目布局（P-20261002-74）：uiState 持久化了面板开合/双栏宽度/
 * 树展开/底栏高度等全套布局，调乱后只能逐项手动调回——对齐 VS Code
 * 「Reset View Locations」自救惯例：确认后把布局写回出厂默认并就地重应用，
 * 不刷新页面。
 *
 * 范围（与提案动机的面板/宽度/树展开自救对齐）：
 *   - layout 命名空间（面板开合/宽高/侧栏视图/底部 tab/最大化态）→ 出厂默认
 *   - fileTree 命名空间 + localStorage 展开键 + 挂载中的树就地收起 → 全收起
 * 不动编辑器标签/分屏与 remoteConsole/agentTerminal 等数据命名空间（内容非布局，
 * 且服务端浅合并下整命名空间替换会连带抹掉调用方拿不全的字段）。
 * 命令面板与设置外观区两个入口共用本组合式：面板布局状态是模块级单例、
 * pinia store 全局，多处实例化语义一致。
 */
export function useLayoutReset() {
  const { t } = useI18n()
  const message = useMessage()
  const projectStore = useProjectStore()
  const uiStateStore = useUIStateStore()
  const layout = usePanelLayout()

  /** 就地应用出厂默认布局并立即持久化（不等 auto-save 防抖——防重置后马上
   *  刷新时乱布局从服务端陈旧快照复活）。返回 false = 无当前项目可重置 */
  async function resetProjectLayout(): Promise<boolean> {
    const pid = projectStore.currentProjectId
    if (!pid) {
      // 首页外观区同按钮：无项目上下文时就地提示而非静默失败
      message.warning(t('layout.reset.noProject'))
      return false
    }
    // 1. 内存就地复位：面板布局是模块级单例，复位即对全 UI 生效（含首页下次进入）
    layout.sideView.value = LAYOUT_DEFAULTS.sideView
    layout.showSidePanel.value = LAYOUT_DEFAULTS.showSidePanel
    layout.showBottomPanel.value = LAYOUT_DEFAULTS.showBottomPanel
    layout.bottomTab.value = LAYOUT_DEFAULTS.bottomTab
    layout.commitLocation.value = LAYOUT_DEFAULTS.commitLocation
    layout.sidePanelWidth.value = LAYOUT_DEFAULTS.sidePanelWidth
    layout.bottomPanelHeight.value = LAYOUT_DEFAULTS.bottomPanelHeight
    // 最大化三态（终端/编辑器区/全屏互斥）一并还原：persist 的两态入服务端快照，
    // terminalMaximized 不持久化但属同族视觉覆盖，复位一视同仁
    layout.restoreFromMaximized()
    // 2. 树展开复位：先清 localStorage 展开键（树未挂载时也生效），再派发收起
    //    事件让挂载中的树就地处收起（collapseAll 的 deep watch 回写空表，与清键收敛）
    try { localStorage.removeItem(`sc.fileTree.expanded.${pid}`) } catch { /* 存储不可用忽略 */ }
    window.dispatchEvent(new CustomEvent(OPS_COLLAPSE_TREE, { detail: { projectId: pid } }))
    // 3. 服务端写回默认（既有 uiState 写端点；浅合并只动 layout/fileTree 两个命名空间）
    await uiStateStore.resetLayoutState({
      layout: {
        sidePanelWidth: LAYOUT_DEFAULTS.sidePanelWidth,
        bottomPanelHeight: LAYOUT_DEFAULTS.bottomPanelHeight,
        showSidePanel: LAYOUT_DEFAULTS.showSidePanel,
        showBottomPanel: LAYOUT_DEFAULTS.showBottomPanel,
        sideView: LAYOUT_DEFAULTS.sideView,
        bottomTab: LAYOUT_DEFAULTS.bottomTab,
        commitLocation: LAYOUT_DEFAULTS.commitLocation,
        bottomPanelMaximized: LAYOUT_DEFAULTS.bottomPanelMaximized,
        bottomPanelEditorMaximized: LAYOUT_DEFAULTS.bottomPanelEditorMaximized,
      },
      fileTree: { expandedDirs: [], selectedFile: '' },
    })
    return true
  }

  /** confirm 包装（两个入口共用）：无项目先提示；确认后重置并反馈结果 */
  async function resetLayoutWithConfirm(): Promise<void> {
    if (!projectStore.currentProjectId) {
      message.warning(t('layout.reset.noProject'))
      return
    }
    const ok = await confirmDialog({
      title: t('layout.reset.title'),
      content: t('layout.reset.confirm'),
      type: 'warning',
    })
    if (!ok) return
    if (await resetProjectLayout()) {
      message.success(t('layout.reset.done'))
    }
  }

  return { resetProjectLayout, resetLayoutWithConfirm }
}
