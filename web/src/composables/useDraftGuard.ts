import { onBeforeUnmount } from 'vue'
import { safeStorage } from '../utils/storage'

/**
 * 输入框级防丢草稿（P-20261005-229）：单文本输入的最小防丢原语——防抖写
 * sessionStorage、回填恢复、成功提交清除。与 NewSessionDialog 的表单草稿
 * （P-20261004-89，localStorage 多字段+恢复提示条）分工：本原语面向常驻
 * 输入框（如运行中会话的排队指令输入），键随上下文漂移（按会话 id 分键），
 * 恢复是静默回填（文本直接重现于输入框，无需提示条）。
 *
 * - 车道选择：sessionStorage（会话级生命周期）——刷新天然存活、关标签页即
 *   清，与「防丢」语义对齐不残留过期草稿；一律走 safeStorage 通道（健壮性
 *   红线：隐私模式/屏蔽 Cookie 下裸访问即抛）
 * - 保存只挂用户输入事件——回填/程序性清空不落键，防「开一次面板把草稿顶空」
 *   （NewSessionDialog P-89 同纪律）
 * - 防抖窗内（默认 1s）的极端丢失接受（提案口径）；面板卸载即同步落键，
 *   比等防抖少一个丢失窗口（条件挂载的行内面板收起重开回填）
 */

/** 防抖窗口：与 NewSessionDialog 草稿（P-89）同 1s——连续键入只在停顿后落键 */
export const DRAFT_SAVE_DEBOUNCE_MS = 1000

export interface UseDraftGuardOptions {
  /** 存储键 getter：键随上下文漂移（如面板被复用换绑会话）。schedule 时刻
   *  取值锁键，火时发现键已漂移则放弃本次写入（旧上下文的文本不得写进新键） */
  key: () => string
  /** 当前草稿文本 getter：防抖火时读终值（约定只挂用户输入事件） */
  read: () => string
  /** 防抖毫秒，缺省 1s */
  debounceMs?: number
}

export function useDraftGuard(options: UseDraftGuardOptions) {
  const debounceMs = options.debounceMs ?? DRAFT_SAVE_DEBOUNCE_MS
  let timer: ReturnType<typeof setTimeout> | undefined

  /** 立即落键：非空写、空清（用户清空重写=放弃草稿，残留键不复活回填） */
  function saveNow(): void {
    const key = options.key()
    const text = options.read()
    if (text) safeStorage.sessionSet(key, text)
    else safeStorage.sessionRemove(key)
  }

  /** 用户输入触发的防抖存草稿：1s 后取文本终值落键 */
  function scheduleSave(): void {
    const key = options.key()
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      // 等待期内键漂移（行内面板复用换绑）：放弃——读到的已是新上下文的文本
      if (options.key() !== key) return
      saveNow()
    }, debounceMs)
  }

  /** 回填：有草稿返回文本（trim 后空 = 无草稿，残留空白键不触发回填） */
  function restore(): string {
    const text = safeStorage.sessionGet(options.key()) ?? ''
    return text.trim() ? text : ''
  }

  /** 成功提交后清：删键并撤销在途防抖（否则清空后被在途定时器复活） */
  function clearDraft(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    safeStorage.sessionRemove(options.key())
  }

  // 卸载即同步落键：行内面板条件挂载（收起/切行即卸载），防抖窗内的半成品
  // 随卸载落库，重开回填；成功提交链先 clearDraft 再清文本，此处读到空串
  // 走删键分支不会复活已清草稿
  onBeforeUnmount(saveNow)

  return { scheduleSave, restore, clearDraft }
}
