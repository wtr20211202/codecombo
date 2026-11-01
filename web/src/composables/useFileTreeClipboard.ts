import { ref } from 'vue'

/**
 * 文件树内部剪贴板（P-20261023-2③a 树内复制/剪切/粘贴）：多选（文件+文件夹
 * 混合）Ctrl+C/右键「复制」/「剪切」入板（路径集 + 项目 id + 模式），目标目录
 * Ctrl+V/右键「粘贴」走服务端 batch copy / move——文件夹复制完全在自家协议内，
 * 无浏览器限制（与 OS 文件粘贴的 clipboardData.files 通道互不覆盖：树内复制
 * 不写 OS 剪贴板，OS 复制不进内部剪贴板）。
 *
 * 模块级单例（useCompareBaseline 同范式）：文件树面板随侧栏视图切换 v-if 卸载，
 * 组件内 ref 会丢状态；复制→切视图→回来粘贴是真实动线。会话级语义不持久化
 * （刷新即清，剪贴板本就是短时态）。
 *
 * 与 OS 剪贴板的冲突消解：宿主在 window blur 时清板（用户去资源管理器复制
 * 文件意味着 OS 剪贴板已换内容，滞留的内部板会抢在 OS 粘贴通道之前被消费——
 * blur 清板是最小代价的诚实启发，跨应用粘贴动线不被陈旧内部板劫持）。
 */

export type TreeClipboardMode = 'copy' | 'cut'

export interface TreeClipboard {
  projectId: string
  paths: string[]
  mode: TreeClipboardMode
}

const clipboard = ref<TreeClipboard | null>(null)

export function useFileTreeInternalClipboard() {
  /** 入板（覆盖式——每次复制/剪切替换全部内容，OS 剪贴板同语义） */
  function setTreeClipboard(projectId: string, paths: string[], mode: TreeClipboardMode): void {
    if (!projectId || paths.length === 0) return
    clipboard.value = { projectId, paths: [...paths], mode }
  }

  /** 可粘贴判定：板非空且属于当前项目（跨项目路径集无意义，禁粘贴而非错落） */
  function canPaste(projectId: string): boolean {
    return !!clipboard.value && clipboard.value.projectId === projectId && clipboard.value.paths.length > 0
  }

  /** 剪切条目集合（渲染面：剪切态弱化显示，调用方按 projectId 过滤） */
  function cutPathsOf(projectId: string): Set<string> {
    if (!clipboard.value || clipboard.value.mode !== 'cut' || clipboard.value.projectId !== projectId) return new Set()
    return new Set(clipboard.value.paths)
  }

  /** 剪切粘贴消费后清板（move 语义：一份内容只挪一次）；copy 粘贴后保留可反复贴 */
  function consumeIfCut(): void {
    if (clipboard.value?.mode === 'cut') clipboard.value = null
  }

  function clearTreeClipboard(): void {
    clipboard.value = null
  }

  return { clipboard, setTreeClipboard, canPaste, cutPathsOf, consumeIfCut, clearTreeClipboard }
}
