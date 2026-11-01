import { onScopeDispose, ref, watch, type Ref } from 'vue'

/**
 * 全屏遮罩显隐最小驻留去抖（P-20261011-1 ②）。
 *
 * 动机：远控/串流（低帧率、事件节流）环境下，全屏遮罩的显隐源若反复振荡
 * （实例切换被网络探测反复触发、锁态被迟到的 WS 4001 拉回），遮罩高频进出
 * 即「全屏闪烁」——且每次离场过渡都可能在节流环境挂起，残留不透明遮罩吞掉
 * 全页点击。本 composable 给显隐源加双向滞回：
 *
 * - **离场缓冲**（hideDelayMs）：源变 false 后延迟离场；期间源回 true 直接
 *   取消——短于缓冲的假离场完全不可见（不闪一下就走）。
 * - **重进静默窗**（reenterDelayMs）：离场落地后源回 true 时延迟重进——
 *   振荡回场不再瞬时闪现，真实新状态照常显示（只延迟、不吞掉）。
 *
 * 两个方向都是「延迟」而非「丢弃」：显示态永远最终收敛到源的真实值，遮罩
 * 只是比裸源更晚离开/更晚回来，语义不撒谎。
 *
 * 不用 @vueuse 的 refDebounced/watchDebounced：两者是双向尾沿去抖，会把
 * 「进入」也延迟（锁屏出现延迟不可接受）；这里进入恒即时、仅离场侧带滞回。
 */
export interface OverlayDwellOptions {
  /** 源变 false 后的离场缓冲 ms（默认 150：任务书示例值） */
  hideDelayMs?: number
  /** 离场落地后源回 true 的重进静默窗 ms（默认 300：任务书示例值） */
  reenterDelayMs?: number
}

export function useOverlayDwell(source: Ref<boolean>, options: OverlayDwellOptions = {}) {
  const hideDelayMs = options.hideDelayMs ?? 150
  const reenterDelayMs = options.reenterDelayMs ?? 300

  // 展示值：初值跟随源（遮罩族挂载时源多为 false，进入路径不受影响）
  const shown = ref(source.value)
  // shown 上次落地为 false 的时刻；-Infinity 表示「从未隐藏」，重进窗不生效
  let hiddenAt = Number.NEGATIVE_INFINITY
  let hideTimer: number | null = null
  let showTimer: number | null = null

  function clearTimers(): void {
    if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null }
    if (showTimer !== null) { clearTimeout(showTimer); showTimer = null }
  }

  watch(source, (v) => {
    if (v) {
      // 源回 true：离场缓冲期内 → 取消离场（遮罩全程未走，零闪烁）
      if (hideTimer !== null) { clearTimeout(hideTimer); hideTimer = null }
      if (shown.value || showTimer !== null) return
      // 重进静默窗：距上次离场落地不足 reenterDelayMs 时延迟重进
      const wait = Math.max(0, reenterDelayMs - (Date.now() - hiddenAt))
      if (wait <= 0) {
        shown.value = true
        return
      }
      showTimer = window.setTimeout(() => {
        showTimer = null
        shown.value = true
      }, wait)
    } else {
      // 源变 false：尚未显示的静默重进直接撤销（短脉冲进入不闪现）
      if (showTimer !== null) { clearTimeout(showTimer); showTimer = null }
      if (!shown.value || hideTimer !== null) return
      hideTimer = window.setTimeout(() => {
        hideTimer = null
        shown.value = false
        hiddenAt = Date.now()
      }, hideDelayMs)
    }
  })

  onScopeDispose(clearTimers)

  return shown
}
