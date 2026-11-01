import { defineStore } from 'pinia'
import { ref } from 'vue'

// index.lock 遗留锁修复条状态（P-20261002-150）：axios 拦截器在 git 写命令失败
// 的错误原文命中服务端稳定标记（IndexLockStaleMarker）时写入，修复条组件按当前
// 项目消费。git 写入口众多（暂存/提交/分支/stash…），拦截器是唯一统一观测点；
// 一次只记录最近一条——同一把锁反复失败覆盖刷新即可，清理成功或手动关闭即清除
export const useGitLockRecoveryStore = defineStore('gitLockRecovery', () => {
  const projectId = ref('')
  const at = ref(0)

  function report(id: string) {
    projectId.value = id
    at.value = Date.now()
  }

  // clear：带 id 时只清除该项目的记录（防止清理 B 项目时误清 A 项目的提示）
  function clear(id?: string) {
    if (!id || projectId.value === id) {
      projectId.value = ''
      at.value = 0
    }
  }

  return { projectId, at, report, clear }
})
