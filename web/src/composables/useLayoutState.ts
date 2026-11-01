import { watch, type Ref } from 'vue'
import { useUIStateStore } from '../stores/uiState'
import { useProjectStore } from '../stores/project'
import { useInstanceStore } from '../stores/instance'
import type { SideView, BottomTab, CommitLocation } from './usePanelLayout'
import { isUntitledPath, type OpenFile, type EditorGroup } from './useOpenFiles'

/** 分屏组持久化清单上限（P-20261002-94）：分屏组是精选对照位，超出截旧（保
 *  列表尾部 = 较新打开的签）；清单随 uiState 全量落盘，无上限会无限膨胀
 *  （关闭栈 10 条/存档点 10 条同款封顶先例） */
export const SPLIT_FILES_MAX = 20

/** UI 状态持久化——对接 uiStateStore——从 Layout.vue 提取 */
export function useLayoutState(
  panelState: {
    sideView: Ref<SideView>
    showSidePanel: Ref<boolean>
    showBottomPanel: Ref<boolean>
    bottomTab: Ref<BottomTab>
    commitLocation: Ref<CommitLocation>
    sidePanelWidth: Ref<number>
    bottomPanelHeight: Ref<number>
    bottomPanelMaximized: Ref<boolean>
    bottomPanelEditorMaximized: Ref<boolean>
  },
  editorState: {
    openFiles: Ref<OpenFile[]>
    activeFileIndex: Ref<number>
    /** 分屏开合（与分屏组清单 splitFiles 一起记忆，P-20261002-94） */
    splitOpen?: Ref<boolean>
    /** 分屏方向（P-20261005-230）：缺省不采集（collect 落横向零值，旧调用方零感知） */
    splitDirection?: Ref<'horizontal' | 'vertical'>
    /** 全组去重文件（beforeunload 脏检查需覆盖分屏组；缺省回退 openFiles） */
    allFiles?: Ref<OpenFile[]>
    /** 双组模型（P-20261002-94）：组 1 文件清单/活跃位持久化采集源；
     *  缺省 = 不采集（旧调用方/单测零感知） */
    groups?: Ref<EditorGroup[]>
  },
) {
  const uiStateStore = useUIStateStore()
  const projectStore = useProjectStore()

  /** 收集当前完整的 UI 状态快照 */
  function collectCurrentUIState(
    extra?: {
      fileTreeExpanded?: string[]
      terminalActiveTab?: string
      gitPanelCollapsed?: string[]
      gitPanelBranch?: string
    },
  ) {
    // 未命名草稿（untitled://N，P-20261002-24）不持久化：内部键非真实磁盘路径，
    // 刷新恢复会逐个 readFile 失败弹错；草稿内容本就不跨刷新。activeIndex
    // 同步映射到剔除后的新列表（活跃的是草稿则恢复为无活跃标签）
    const persistList = editorState.openFiles.value.filter(f => !isUntitledPath(f.path))
    const activeFile = editorState.openFiles.value[editorState.activeFileIndex.value]
    const restoredActive = activeFile && !isUntitledPath(activeFile.path)
      ? persistList.indexOf(activeFile)
      : -1
    // 分屏组清单（P-20261002-94）：与主组同口径剔除 untitled 草稿；另剔除 diff
    // 伪键与 P-50 预览签（临时性 tab 不入持久化清单）。上限 SPLIT_FILES_MAX
    // 超出截旧（保尾部）；活跃签被剔除/截掉时活跃位落空
    const g1 = editorState.groups?.value?.[1]
    const splitPersist = (g1?.files ?? [])
      .filter(f => !isUntitledPath(f.path) && !f.isDiff && !f.isPreview)
    const splitFiles = splitPersist.slice(-SPLIT_FILES_MAX).map(f => f.path)
    const splitActive = g1 && g1.activeIndex >= 0 ? g1.files[g1.activeIndex] : undefined
    const splitActiveFile = splitActive && splitFiles.includes(splitActive.path) ? splitActive.path : ''
    return {
      instanceId: useInstanceStore().currentInstanceId,
      projectId: projectStore.currentProjectId || undefined,
      editor: {
        openFiles: persistList.map(f => f.path),
        activeIndex: restoredActive,
        scrollPositions: {},
        splitOpen: editorState.splitOpen?.value ?? false,
        splitFiles,
        splitActiveFile,
        // 恒写当前方向（不省略）：省略会触发 P-20261006-24 子字段回填从基底复活
        // 旧值（内存已切横向、基底还是纵向时会把纵向补进补丁）；缺省横向也显式写，
        // 关屏/重开后旧记录被新零值覆盖（幂等）
        splitDirection: editorState.splitDirection?.value ?? 'horizontal',
      },
      fileTree: {
        expandedDirs: extra?.fileTreeExpanded || [],
        selectedFile: '',
      },
      layout: {
        sidePanelWidth: panelState.sidePanelWidth.value,
        bottomPanelHeight: panelState.bottomPanelHeight.value,
        showSidePanel: panelState.showSidePanel.value,
        showBottomPanel: panelState.showBottomPanel.value,
        sideView: panelState.sideView.value,
        bottomTab: panelState.bottomTab.value,
        commitLocation: panelState.commitLocation.value,
        bottomPanelMaximized: panelState.bottomPanelMaximized.value,
        bottomPanelEditorMaximized: panelState.bottomPanelEditorMaximized.value,
      },
      terminal: {
        activeTabId: extra?.terminalActiveTab || '',
      },
      gitPanel: {
        collapsedSections: extra?.gitPanelCollapsed || [],
        selectedBranch: extra?.gitPanelBranch || '',
      },
    }
  }

  /** beforeunload 时同步保存 UI 状态 */
  function forceSaveState(extra?: Parameters<typeof collectCurrentUIState>[0]) {
    const state = collectCurrentUIState(extra)
    uiStateStore.forceSaveCurrentState(state)
  }

  /** boot 基线对齐（P-20261002-8）：引导恢复落定后调用——把内存脏键基线推进
   *  到本页初始现实，恢复出的初始值不计为「本页变更」（详见 store.alignBaseline
   *  注释）。与 forceSave/auto-save 同一 collect 面（不传 extra，字段面一致） */
  function alignBaselineAfterRestore() {
    uiStateStore.alignBaseline(collectCurrentUIState())
  }

  /** beforeunload 处理器（绑定到 window）：脏检查覆盖全组（含分屏组） */
  function createBeforeUnloadHandler(
    extra?: Parameters<typeof collectCurrentUIState>[0],
  ): (e: BeforeUnloadEvent) => void {
    return (e: BeforeUnloadEvent) => {
      const state = collectCurrentUIState(extra)
      uiStateStore.forceSaveCurrentState(state)
      const pool = editorState.allFiles?.value ?? editorState.openFiles.value
      const hasUnsaved = pool.some(
        f => f.content !== f.originalContent,
      )
      if (hasUnsaved) {
        e.preventDefault()
      }
    }
  }

  /** 注册 UI 状态自动持久化（防抖 2s） */
  function setupAutoSave(
    extra?: Parameters<typeof collectCurrentUIState>[0],
  ) {
    watch(
      [
        panelState.sideView,
        panelState.showSidePanel,
        panelState.showBottomPanel,
        panelState.bottomTab,
        panelState.commitLocation,
        panelState.sidePanelWidth,
        panelState.bottomPanelHeight,
        panelState.bottomPanelMaximized,
        panelState.bottomPanelEditorMaximized,
        // 只盯 openFiles 的路径清单签名：持久化仅存路径不存内容。
        // 历史实现 deep watch 整个 openFiles（含 content/originalContent 全文），
        // 编辑器每击键都会触发一次 uiState GET+PUT 网络往返
        () => editorState.openFiles.value.map(f => f.path).join('\u0000'),
        editorState.activeFileIndex,
        ...(editorState.splitOpen ? [editorState.splitOpen] : []),
        // 分屏方向（P-20261005-230）：切方向即时持久化（方向是单值枚举，直接比对）
        ...(editorState.splitDirection ? [editorState.splitDirection] : []),
        // 分屏组清单/活跃位签名（P-20261002-94）：两组清单一起走既有签名 watch
        //（组 1 开签/关签/换活跃都触发持久化；活跃 index 直接比对不 join）
        ...(editorState.groups ? [
          () => (editorState.groups!.value[1]?.files ?? []).map(f => f.path).join('\u0000'),
          () => editorState.groups!.value[1]?.activeIndex ?? -1,
        ] : []),
        () => projectStore.currentProjectId,
      ],
      () => {
        // 实例切换期间跳过持久化：此时 store 被批量清理、组件即将 remount，
        // 写入会把"旧布局 + 空 projectId"的脏快照落到实例的持久化 key 上
        if (useInstanceStore().switching) return
        const state = collectCurrentUIState(extra)
        uiStateStore.saveCurrentState(state)
      },
      { deep: true },
    )
  }

  /** 从持久化数据恢复 UI 状态 */
  async function restoreState(): Promise<{
    projectId?: string
    editor?: { openFiles: string[]; activeIndex: number; splitOpen?: boolean; splitFiles?: string[]; splitActiveFile?: string; splitDirection?: 'horizontal' | 'vertical' }
    layout?: {
      sidePanelWidth?: number
      bottomPanelHeight?: number
      showSidePanel?: boolean
      showBottomPanel?: boolean
      sideView?: string
      bottomTab?: string
      commitLocation?: string
      bottomPanelMaximized?: boolean
      bottomPanelEditorMaximized?: boolean
    }
    fileTree?: { expandedDirs: string[] }
    gitPanel?: { collapsedSections: string[]; selectedBranch: string }
    terminal?: { activeTabId: string }
    instanceId?: string
  } | null> {
    try {
      const state = await uiStateStore.getInstanceState()
      return state as any
    } catch {
      return null
    }
  }

  return {
    collectCurrentUIState,
    forceSaveState,
    alignBaselineAfterRestore,
    createBeforeUnloadHandler,
    setupAutoSave,
    restoreState,
  }
}
