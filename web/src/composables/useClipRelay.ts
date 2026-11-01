import type { MessageApiInjection } from 'naive-ui/es/message/src/MessageProvider'
import i18n from '../i18n'
import { clipApi } from '../api/domains/system'
import { AppError } from '../api/error-types'
import { useClipboardHistoryStore } from '../stores/clipboardHistory'
import { CLIP_MAX_BYTES, clipByteLength, ownClipDeviceId, readLocalClipboardText } from '../utils/clipRelay'
import { copyText } from '../utils/clipboard'

/**
 * 跨设备剪贴板中继（P-20261002-32）交互动作面：
 * - sendLocalClipboard：发送侧——读本机剪贴板（navigator.clipboard.readText，
 *   失败/非安全上下文回退应用内剪贴板历史最新一条）POST /api/clip 写入服务端
 *   单槽，成功后服务端向其他已解锁设备广播 clipboard.arrived
 * - takeArrived：接收侧——GET /api/clip 读取即焚 + copyText 落入本地剪贴板
 *     （copyText 自带降级链与剪贴板历史入史，健壮性红线合规）
 * message 由调用方注入（OpsChannelBridge / useLayoutViews 的 setup 实例）；
 * t 走 i18n.global——本组合式的动作在命令面板分发与 ops 事件回调里执行，
 * 那是非 setup 上下文（useI18n() 在此抛 MUST_BE_CALL_SETUP_TOP(26)），
 * 与 previewPortNotify 纯函数面同款取词方式
 */
export function useClipRelay(message: MessageApiInjection) {
  const t = i18n.global.t

  /** 发送本机剪贴板内容到其他设备。返回 true = 已受理（广播已发出） */
  async function sendLocalClipboard(): Promise<boolean> {
    const text = await readLocalClipboardText(useClipboardHistoryStore().entries)
    if (!text) {
      message.warning(t('clip.sendEmpty'))
      return false
    }
    // 与服务端 32KB 上限镜像的前置拦截：命中即就地提示，不发注定被拒的请求
    if (clipByteLength(text) > CLIP_MAX_BYTES) {
      message.warning(t('clip.sendTooLarge'))
      return false
    }
    try {
      await clipApi.send(text, ownClipDeviceId())
      message.success(t('clip.sent'))
      return true
    } catch {
      // 413 = 服务端权威裁决（理论上已被上方镜像上限前置拦截，兜并发窗口）；
      // silent 请求不弹全局错误，这里给专属文案
      message.error(t('clip.sendFailed'))
      return false
    }
  }

  /** 取走到达的剪贴板内容（toast 点击触发）：读取即焚——同机其他 tab 或其他
   *  设备先点了，本端拿到 404，按知情提示呈现而非错误 */
  async function takeArrived(): Promise<void> {
    let content: string
    try {
      const res = await clipApi.take()
      content = res?.content ?? ''
    } catch (e) {
      if (e instanceof AppError && e.status === 404) {
        message.info(t('clip.gone'))
        return
      }
      message.error(t('clip.takeFailed'))
      return
    }
    if (!content) {
      message.info(t('clip.gone'))
      return
    }
    const ok = await copyText(content)
    if (ok) message.success(t('clip.taken'))
    else message.error(t('common.copyFailed'))
  }

  return { sendLocalClipboard, takeArrived }
}
