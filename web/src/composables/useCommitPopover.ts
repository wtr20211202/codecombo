import { ref } from 'vue'
import { copyText } from '../utils/clipboard'

/** 提交行数据（CommitsPanel 列表与悬浮层共用） */
export interface Commit {
  hash: string
  shortHash: string
  message: string
  body?: string
  author: string
  /** 作者邮箱（后端 git log %ae，悬浮层与行内 meta 展示） */
  email?: string
  date: string
  refs: string[]
  parents: string[]
}

/**
 * 提交悬浮层（可移入复制 + 完整时间）：
 * 原生 title 悬浮窗随鼠标移动即消失、无法移入复制；改用共享 NPopover（manual 定位）。
 * 触发带 400ms 悬停延迟：划过行不弹（对齐原生 title 的节流手感），刻意停留才出现；
 * 移入悬浮层保持显示（离开宽限期），内可选中/一键复制完整信息，
 * 同时承载完整时间展示（相对时间行不做任何改动的回退查看处）。
 */
const POP_SHOW_DELAY = 400
const POP_HIDE_GRACE = 260

export function useCommitPopover(options: {
  /** 复制成功后的提示（宿主注入 message.success） */
  onCopied: () => void
}) {
  const popCommit = ref<Commit | null>(null)
  const popX = ref(0)
  const popY = ref(0)
  let popShowTimer: number | null = null
  let popHideTimer: number | null = null
  let popPending: { commit: Commit; x: number; y: number } | null = null

  function openCommitPop(commit: Commit, e: MouseEvent) {
    if (popHideTimer) { clearTimeout(popHideTimer); popHideTimer = null }
    if (popCommit.value?.hash === commit.hash) return // 同一条提交内移动不重置
    const el = (e.currentTarget as HTMLElement).getBoundingClientRect()
    popPending = { commit, x: Math.max(4, el.left), y: el.bottom + 6 }
    if (popShowTimer) clearTimeout(popShowTimer)
    popShowTimer = window.setTimeout(() => {
      if (!popPending) return
      popCommit.value = popPending.commit
      popX.value = popPending.x
      popY.value = popPending.y
      popPending = null
      popShowTimer = null
    }, POP_SHOW_DELAY)
  }

  function cancelPopShow() {
    if (popShowTimer) { clearTimeout(popShowTimer); popShowTimer = null }
    popPending = null
  }

  function schedulePopHide() {
    cancelPopShow()
    if (popHideTimer) clearTimeout(popHideTimer)
    popHideTimer = window.setTimeout(() => {
      popCommit.value = null
      popHideTimer = null
    }, POP_HIDE_GRACE)
  }

  function cancelPopHide() {
    if (popHideTimer) { clearTimeout(popHideTimer); popHideTimer = null }
  }

  function closeCommitPop() {
    popCommit.value = null
    cancelPopShow()
    cancelPopHide()
  }

  async function copyFullMessage() {
    const c = popCommit.value
    if (!c) return
    // 复制成功才提示（onCopied 由宿主注入 message.success）；
    // 失败静默（composable 无 message 能力），降级已由 copyText 内部处理
    const ok = await copyText(c.body || c.message)
    if (ok) options.onCopied()
    else console.debug('copy commit message failed')
  }

  return {
    popCommit, popX, popY,
    openCommitPop, schedulePopHide, cancelPopHide, closeCommitPop, copyFullMessage,
  }
}
