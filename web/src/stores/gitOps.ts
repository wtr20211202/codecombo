import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * git 操作进行中反馈（P-20261005-211）：跨入口共享的 in-flight 记账面——
 * fetch/pull/push/stage/commit 慢操作（大仓/弱网 10s+）期间按钮给 loading 态并
 * 前端去重，消除「不知在不在跑而重复点击」的请求堆积。Pinia 而非组件本地 ref：
 * 同一操作有多个触发入口（GitPanel 快捷钮 / 顶栏拉取流 / 分支右键推送 / 提交
 * 连招），各入口的本地 loading 互不可见，只有 store 层按 项目×操作类型 记账
 * 才能让任一入口的飞行中状态反映到所有按钮上。
 *
 * 粒度是 per 操作类型非全局锁：pull 在飞不阻断 commit 等其他面板操作；
 * 计数而非布尔：同族多入口可合法并发（如分支右键推送与快捷推送），各自
 * begin/end 配对互不吞账。
 */

export type GitOpType = 'fetch' | 'pull' | 'push' | 'stage' | 'commit'

/**
 * spinner 延迟显示阈值：in-flight 超过此时长才亮 loading 图标——本地 stage/
 * commit 毫秒级完成时按钮全程不进入 loading 态，不抖动（快操作零感知惯例）。
 * busy（禁用）不等阈值即时生效，延迟只作用于视觉图标。
 */
export const GIT_SPINNER_DELAY_MS = 150

export const useGitOpsStore = defineStore('gitOps', () => {
  // key = `${projectId}|${op}` → 在飞计数；项目删除遗留的少量键有界（≤5×项目数），
  // 键含项目 id，切项目天然隔离不串账
  const inflight = ref<Record<string, number>>({})
  // spinner 可见态：与 inflight 分离——begin 时若阈值内即结束，spinner 从未置真
  const spinner = ref<Record<string, boolean>>({})
  // 延迟定时器是纯调度非状态，不进响应式
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function keyOf(projectId: string, op: GitOpType): string {
    return `${projectId}|${op}`
  }

  /** 记一笔者操作开始（不做去重，合法并发入口用 begin；用户触发面用 tryBegin） */
  function begin(projectId: string, op: GitOpType): void {
    const k = keyOf(projectId, op)
    inflight.value[k] = (inflight.value[k] || 0) + 1
    if (!timers.has(k)) {
      spinner.value[k] = false
      timers.set(k, setTimeout(() => {
        timers.delete(k)
        spinner.value[k] = true
      }, GIT_SPINNER_DELAY_MS))
    }
  }

  /** 记一笔者操作结束（与 begin 严格配对，调用方放 finally） */
  function end(projectId: string, op: GitOpType): void {
    const k = keyOf(projectId, op)
    const rest = (inflight.value[k] || 0) - 1
    if (rest > 0) { inflight.value[k] = rest; return }
    delete inflight.value[k]
    const timer = timers.get(k)
    if (timer) { clearTimeout(timer); timers.delete(k) } // 快操作：阈值内结束，spinner 从未亮起
    spinner.value[k] = false
  }

  /** 去重闸：同 项目×操作 已在飞行中返回 false（调用方静默忽略或提示），
   *  否则记账并返回 true。前端先拦，不依赖服务端幂等 */
  function tryBegin(projectId: string, op: GitOpType): boolean {
    if ((inflight.value[keyOf(projectId, op)] || 0) > 0) return false
    begin(projectId, op)
    return true
  }

  function isBusy(projectId: string, op: GitOpType): boolean {
    return (inflight.value[keyOf(projectId, op)] || 0) > 0
  }

  /** 按钮 loading 图标可见 = 在飞 且 已超过延迟阈值（快操作不亮） */
  function spinnerOn(projectId: string, op: GitOpType): boolean {
    return (inflight.value[keyOf(projectId, op)] || 0) > 0 && !!spinner.value[keyOf(projectId, op)]
  }

  return { inflight, spinner, begin, end, tryBegin, isBusy, spinnerOn }
})
