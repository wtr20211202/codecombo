// 环境画像取数 composable（P-20261007-14）：GET /projects/:id/env-profile 的
// 面板侧单一取数口——跟随当前项目加载，刷新令牌防项目切换的过期响应落地
// （NotesPanel/TodoPanel 同款纪律）。画像=历史观测聚合非实时拓扑，MVP 不做
// 轮询（端口登记随探测/上报增量刷新，手动刷新同径重拉即可；值守大屏类
// 高频面另有 terminal-ports 全局口）
import { ref } from 'vue'
import { envProfileApi, type EnvProfile } from '../api/domains/envprofile'
import { useProjectStore } from '../stores/project'

export function useEnvProfile() {
  const profile = ref<EnvProfile | null>(null)
  const loading = ref(false)
  const loadFailed = ref(false)
  // 源级降级标记：sentinels/deployTargets 键缺席（读失败）与「空数组」是两种
  // 诚实值——面板对缺席键显示降级提示而非「无规则」
  const degraded = ref<{ sentinels: boolean; deployTargets: boolean }>({
    sentinels: false,
    deployTargets: false,
  })

  let reqToken = 0

  async function refresh(): Promise<void> {
    const pid = useProjectStore().currentProjectId
    if (!pid) return
    const token = ++reqToken
    loading.value = true
    loadFailed.value = false
    try {
      const res = await envProfileApi.get(pid)
      if (token !== reqToken) return
      // data 缺席（服务端 5xx 走 reject 不会到这；防御性兜空画像 = 三区空态）
      profile.value = res.data ?? { projectId: pid, devPorts: [] }
      degraded.value = {
        sentinels: profile.value.sentinels === undefined,
        deployTargets: profile.value.deployTargets === undefined,
      }
    } catch {
      if (token !== reqToken) return
      loadFailed.value = true
    } finally {
      if (token === reqToken) loading.value = false
    }
  }

  return { profile, loading, loadFailed, degraded, refresh }
}
