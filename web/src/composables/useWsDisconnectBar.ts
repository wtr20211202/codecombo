import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import { useProjectStore } from '../stores/project'
import { useLockStore } from '../stores/lock'

// 全局断连指示条（P-20261002-5）：项目 WS 断开且已选项目时在顶栏下方渐显提示，
// 恢复后立即消失。数据来源是装配点（useLayoutShell）传入的 connected ref——
// useWebSocket 非单例，二次调用会新开一条 WS 连接，本 composable 只读不连。

// 防闪烁：断开需持续超过该时长才显示（重连风暴中 connected 抖动不闪条），
// 恢复则立即隐藏——断连消失是用户明确期待的好消息，无需反向延迟
const SHOW_DELAY_MS = 500

/** 锁定态不显示：锁定时 WS 本就被门控断开（shouldConnect: !isLocked），
 *  横条若照常显示会把「正常锁定」误报成「连接故障」 */
export function useWsDisconnectBar(connected: Ref<boolean>) {
  const projectStore = useProjectStore()
  const lockStore = useLockStore()
  const visible = ref(false)
  let showTimer: ReturnType<typeof setTimeout> | null = null

  watch(
    () => [connected.value, projectStore.currentProjectId, lockStore.isLocked] as const,
    ([isConnected, projectId, locked]) => {
      if (showTimer) {
        clearTimeout(showTimer)
        showTimer = null
      }
      if (!isConnected && projectId && !locked) {
        showTimer = setTimeout(() => {
          showTimer = null
          visible.value = true
        }, SHOW_DELAY_MS)
      } else {
        visible.value = false
      }
    },
    { immediate: true },
  )

  onBeforeUnmount(() => {
    if (showTimer) clearTimeout(showTimer)
  })

  return { visible }
}
