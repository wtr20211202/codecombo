import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * git 失败恢复直达通道（P-20261005-194）：axios 拦截器是 git 域失败的唯一统一
 * 观测点，但 pull 流宿主（useProjectActions，Layout 装配）与冲突视图宿主
 * （GitPanel，随 git 底部 tab 挂载）都不在拦截器可达范围——沿 previewPort /
 * runbookDraft「暂存载荷 → 宿主消费 → 消费清位」惯例落 store：
 *   - 拦截器动作 toast 按钮 click 时 request() 写入（'先拉取' / '解决冲突'）
 *   - useLayoutShell 消费 pull（必要时切项目后走既有拉取流）；conflict 分支只负责
 *     把 git 底部 tab 带上屏（GitPanel 未挂载时信号无处消费）
 *   - GitPanel 挂载即消费 conflict（重拉冲突计数 → 就地展开冲突视图，P-44
 *     openConflictFromToast 同语义收口）
 * 消费方按 kind 分工（pull 归 shell、conflict 归 GitPanel），不重复消费。
 */

/** 待消费的恢复动作请求；at 代际戳供消费方做 TTL 防陈旧请求迟到期新现场 */
export interface GitFailHintRequest {
  kind: 'pull' | 'conflict'
  projectId: string
  at: number
}

/**
 * 消费时效窗：请求在 store 里暂存（GitPanel 未挂载时无从消费），超窗即作废——
 * 防用户点了按钮没等到面板挂载、几分钟后打开 git tab 时旧请求意外触发动作。
 * 10s toast 窗 + 挂载耗时的数倍余量取 30s。
 */
export const GIT_FAIL_HINT_TTL_MS = 30_000

export function isGitFailHintFresh(req: GitFailHintRequest): boolean {
  return Date.now() - req.at <= GIT_FAIL_HINT_TTL_MS
}

export const useGitFailHintStore = defineStore('gitFailHint', () => {
  const pending = ref<GitFailHintRequest | null>(null)

  function request(kind: GitFailHintRequest['kind'], projectId: string) {
    pending.value = { kind, projectId, at: Date.now() }
  }

  function consume() {
    pending.value = null
  }

  return { pending, request, consume }
})
