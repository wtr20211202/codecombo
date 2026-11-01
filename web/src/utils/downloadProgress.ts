/**
 * B 类导出点下载进度 toast（P-20261030-2）：口令信封档与 .scpkg 迁移包必须
 * 先取全量内容再（服务端）加密/封装、且走 POST 载荷，不可直链——保留 blob
 * 但挂 axios onDownloadProgress，把「整包进内存期间零反馈」的黑洞期变成可见
 * 进度（百分比 + 速率，sync.progress 展示形态的轻量 toast 版）。
 *
 * 生命周期：onProgress 节流更新驻留 loading toast → settle() 幂等销毁。
 * 成功/失败的终态提示归调用方（各自既有文案），本模块只负责传输中反馈——
 * 进度是「下载阶段」的进度（加密/封装在服务端紧随其后，前端瞬时），total
 * 缺失（chunked 无 Content-Length）时如实降级为已接收量 + 速率。
 */
import { h } from 'vue'
import type { MessageApiInjection } from 'naive-ui/es/message/src/MessageProvider'
import type { AxiosProgressEvent } from 'axios'
import { formatBytes } from './bytes'

/** 进度刷新节流：loading toast 的 content 重渲染按此间隔收敛（进度事件
 *  每块数据都触发，逐帧重渲染是无谓的响应式开销） */
const UPDATE_INTERVAL_MS = 150

export interface DownloadProgressTracker {
  /** axios onDownloadProgress 直接挂载点 */
  onProgress(e: AxiosProgressEvent): void
  /** 收尾（成功/失败都要调）：销毁驻留 toast。终态提示归调用方 */
  settle(): void
}

/**
 * 建一个下载进度驻留 toast（duration 0，settle 前不消失）。title 为调用方
 * 已翻译的动作名（如 t('claudeSessions.batch.exportProgress')）；内容行 =
 * title + 百分比（total 可知）或已接收量（chunked）+ 实时速率。
 */
export function createDownloadProgressTracker(
  message: MessageApiInjection,
  title: string,
): DownloadProgressTracker {
  const sticky = message.loading(
    () => h('span', { 'data-testid': 'download-progress-toast' }, title),
    { duration: 0 },
  )

  let settled = false
  let lastPaint = 0
  let lastSampleAt = 0
  let lastSampleLoaded = 0
  let rate = 0 // 字节/秒（最近一次采样窗口均值）

  function renderBody(e: AxiosProgressEvent): string {
    const parts: string[] = []
    if (e.total && e.total > 0) parts.push(`${Math.min(100, Math.round((e.loaded / e.total) * 100))}%`)
    else parts.push(formatBytes(e.loaded))
    // "/s" 是 SI 单位符号（非可译文案），与 formatBytes 的单位符号同性质
    if (rate > 0) parts.push(`${formatBytes(rate)}/s`)
    return `${title} ${parts.join(' · ')}`
  }

  return {
    onProgress(e: AxiosProgressEvent) {
      if (settled) return
      const now = Date.now()
      // 速率：按采样窗口滑动均值（首样本无窗口不计），比瞬时值稳
      if (lastSampleAt > 0 && now > lastSampleAt && e.loaded >= lastSampleLoaded) {
        rate = ((e.loaded - lastSampleLoaded) * 1000) / (now - lastSampleAt)
      }
      lastSampleAt = now
      lastSampleLoaded = e.loaded
      if (now - lastPaint < UPDATE_INTERVAL_MS) return
      lastPaint = now
      sticky.content = () => h('span', { 'data-testid': 'download-progress-toast' }, renderBody(e))
    },
    settle() {
      // 幂等：成功/失败双路径都会收尾，销毁后不再接受 content 赋值
      if (settled) return
      settled = true
      sticky.destroy()
    },
  }
}
