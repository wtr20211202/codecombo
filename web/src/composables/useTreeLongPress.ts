import { getCurrentInstance, onBeforeUnmount } from 'vue'

/**
 * 树行长按手势（P-20261003-137）：触屏无右键，长按（500ms）是树操作菜单的
 * 触屏保底入口（P-98 通知滑动同触屏族）。
 *
 * 手势形态（标准长按模式）：
 * - pointerdown（仅 touch 指针——鼠标右键既有入口不变；pen 有笔杆键右键与
 *   手掌防误触，不混入本手势）起 500ms 计时，到时回调并轻震动反馈；
 * - 移动超阈值取消（滚动/误滑不误触发）；
 * - 抬手（pointerup）/滚动接管（pointercancel——touch-action 放行原生滚动，
 *   浏览器起滚即派 pointercancel）提前取消。
 *
 * follow-up click 吞咽：长按到时后抬手，浏览器仍会补发一次 click——不吞的话
 * 弹出菜单的同一手势会再触发目录 toggle/文件打开。标记在「下次手势开始」时
 * 失效（pointerdown 先于任何新 click），故只吞长按自身手势的补发 click，
 * 不影响随后的正常点按。
 */

/** 长按判定时长（ms）：Android 原生 contextmenu 同档，用户预期一致 */
export const LONG_PRESS_MS = 500
/** 移动取消阈值（px）：行高一半以内的小抖动容忍，超过即视为滚动/拖拽意图 */
export const LONG_PRESS_CANCEL_PX = 10

/** P = 行载荷（调用方模板闭包捕获，触发时原样回传——如 FileEntry） */
export function useTreeLongPress<P>(onLongPress: (e: PointerEvent, payload: P) => void) {
  let timer: ReturnType<typeof setTimeout> | null = null
  let baseX = 0
  let baseY = 0
  let swallowNextClick = false

  function teardown() {
    if (timer) { clearTimeout(timer); timer = null }
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
  }

  function onMove(e: PointerEvent) {
    // 距起点超阈值 = 滚动/拖拽意图，拆表收听（后续 move 无再判必要）
    if (Math.abs(e.clientX - baseX) > LONG_PRESS_CANCEL_PX || Math.abs(e.clientY - baseY) > LONG_PRESS_CANCEL_PX) teardown()
  }

  function onEnd() { teardown() }

  /** 行 pointerdown 入口（行 @pointerdown 直连，payload 随行闭包传入） */
  function onPointerDown(e: PointerEvent, payload: P) {
    if (e.pointerType !== 'touch') return
    // 新手势开始：上一手势遗留的吞咽义务作废（其补发 click 机会已过/不会再来）
    swallowNextClick = false
    teardown()
    baseX = e.clientX
    baseY = e.clientY
    timer = setTimeout(() => {
      timer = null
      swallowNextClick = true
      // 轻震动反馈：无 vibrate 能力（iOS Safari 等）静默降级——振动是加分
      // 项不是依赖项，缺席不构成错误也不做提示
      try { navigator.vibrate?.(15) } catch { /* noop */ }
      // move/up 收听随触发一并拆除：长按已成立，后续移动属菜单/滚动手势
      teardown()
      onLongPress(e, payload)
    }, LONG_PRESS_MS)
    // 收听挂 window：手指小幅滑出行元素后 move/up 仍可达（useTerminalFloat
    // 标题栏拖拽同范式）
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }

  /** 长按补发 click 消费（行 click 处理器首行调用）：true = 本次 click 是长按
   *  抬手的补发，调用方跳过点击语义 */
  function consumeClickIfFromLongPress(): boolean {
    if (!swallowNextClick) return false
    swallowNextClick = false
    return true
  }

  // getCurrentInstance 守卫（useDirSessionBadges 同款）：允许单测脱离组件实例直调
  if (getCurrentInstance()) onBeforeUnmount(teardown)

  return { onPointerDown, consumeClickIfFromLongPress }
}
