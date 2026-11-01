import { nextTick } from 'vue'
import { useProjectStore } from '../stores/project'
import { usePanelLayout } from './usePanelLayout'
import { OPS_LOCATE_IN_TREE, type LocateInTreeDetail } from '../utils/opsEvents'

/**
 * 编辑器「在文件树中定位」（P-20261003-294）：把编辑器 tab 的项目相对路径
 * 派发给文件树 reveal 链路，tab 右键菜单与命令面板「定位当前文件到树」共用。
 *
 * - 只派发 window 事件 OPS_LOCATE_IN_TREE（终端侧 useTerminalTreeLocate 同款
 *   模式）：接收方（FileTreeView.onLocateInTree）负责保证侧栏可见 + 退最大化
 *   + 清树搜索 + 逐层展开 + 滚动定位，派发方不感知文件面板布局——相比
 *   revealCurrentFileInTree 直调链（面包屑在用），事件接收方多覆盖被最大化
 *   底部面板与树搜索过滤两种「reveal 了但看不见」形态
 * - 侧栏停在 changes 等视图时 FileTreeView 未挂载（监听随 v-if 卸载，事件会
 *   丢）：派发前先切回 files 视图并等重挂完成（useLayoutBridge 的
 *   revealInFileTree 注入链同款预处理），编辑器右键恰是「侧栏停在哪都可能」
 *   的高频入口
 * - 编辑器 tab 路径本就是项目相对正斜杠口径（OPS_LOCATE_IN_TREE detail 契约），
 *   反斜杠形态防御性归一（useEditorAskAgent 同款）
 */
export function useEditorTreeLocate() {
  const projectStore = useProjectStore()
  const layout = usePanelLayout()

  /** 统一派发链（locateInTree / revealProjectRoot 共用）：先保证 files 视图
   *  已挂载，再派发定位事件 */
  async function dispatchLocate(path: string, focus = false): Promise<void> {
    const pid = projectStore.currentProjectId
    if (!pid) return
    // 侧栏不在 files 视图：FileTreeView 未挂载、无人监听本事件——先切视图，
    // nextTick 等 v-if 重挂的 onMounted 注册好监听再派发（否则事件静默丢失）
    if (layout.sideView.value !== 'files') {
      layout.sideView.value = 'files'
      await nextTick()
    }
    window.dispatchEvent(new CustomEvent<LocateInTreeDetail>(OPS_LOCATE_IN_TREE, {
      // focus 只在需要时携带：既有定位调用方的事件载荷保持原形（契约不变）
      detail: { path, projectId: pid, ...(focus ? { focus: true } : {}) },
    }))
  }

  /** 派发「在文件树中定位」：path = 目标 tab 的项目相对路径；无当前项目或
   *  空路径时 no-op（编辑器 tab 只存在于项目上下文，此处纯防御） */
  async function locateInTree(path: string): Promise<void> {
    const rel = path.replace(/\\/g, '/')
    if (!rel) return
    await dispatchLocate(rel)
  }

  /** 打开文件树并回到项目根（空路径 = 项目根，FileTreeView 滚回顶部）；分享
   *  管理器「新建分享」CTA 用——不替用户猜文件，只把人送到树里自己选。与
   *  locateInTree 的差异：允许空路径 + 落点后把键盘焦点移到树列表（focus
   *  扩展字段），既有定位调用方不传 focus 保持不抢编辑器焦点 */
  async function revealProjectRoot(): Promise<void> {
    await dispatchLocate('', true)
  }

  return { locateInTree, revealProjectRoot }
}
