import { ref } from 'vue'

/**
 * 两文件对比基准（P-20261002-75）：文件树右键「选为对比基准」记录的目标。
 * 模块级共享状态（usePanelLayout 同款单例模式）——设/清在 FileTreeView
 * （经 useFileTreeContext），展示与点击取消在 StatusBar，跨组件同源不落
 * props/事件；生命周期 = 设定 → 消费（对比成功开出 diff 即清，一次性语义）
 * 或手动取消（状态栏点击 / 基准文件右键）。
 * projectId 随行：跨项目残留的基准在展示与消费两侧按「项目不匹配」忽略，
 * 切回原项目时提示与可用性自然恢复（对标 VS Code Select for Compare 的全局存活）。
 */
export interface CompareBaseline {
  projectId: string
  path: string
  name: string
}

const baseline = ref<CompareBaseline | null>(null)

export function useCompareBaseline() {
  function setCompareBaseline(b: CompareBaseline) {
    baseline.value = b
  }

  function clearCompareBaseline() {
    baseline.value = null
  }

  /** 当前项目下生效的基准名（跨项目残留返回空串，展示侧直接 v-if） */
  function baselineNameOf(currentProjectId: string): string {
    const b = baseline.value
    if (!b || b.projectId !== currentProjectId) return ''
    return b.name
  }

  return { baseline, setCompareBaseline, clearCompareBaseline, baselineNameOf }
}
