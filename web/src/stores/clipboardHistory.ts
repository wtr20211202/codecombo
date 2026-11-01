import { defineStore } from 'pinia'
import { ref } from 'vue'

// 多剪贴板历史（P-20261002-149，JetBrains Ctrl+Shift+V 同语义）：应用内所有复制
// 路径（原生 Ctrl+C 的 copy 事件、copyText / writeClipboard 程序化复制）单获入
// 环形历史，Ctrl+Alt+V 呼出选择弹层按序取用——多段记录组装不再反复切换源头。
// 仅内存态（不落盘）：剪贴板常含密码/token 等敏感串，持久化把泄露面从进程内
// 扩大到存储介质，与收益不成比例；会话内环形即可覆盖「顺序抓录」主场景

/** 环形历史上限：只留最近 N 条（最旧先丢），与 JetBrains 常用默认档一致 */
export const CLIP_HISTORY_MAX = 20

/** 单条入史上限（UTF-8 字节）：超大复制不入史——截断存储会让粘贴拿到残段
 *  （静默数据损坏），跳过即回到「该次复制不可从历史取用」的安全退化 */
export const CLIP_ENTRY_MAX_BYTES = 100 * 1024

export interface ClipboardHistoryEntry {
  /** 递增 id（v-for key；文本可能重复出现后被去重合并，不能用文本当 key） */
  id: number
  text: string
  /** 捕获时刻（epoch ms；展示与调试用） */
  at: number
}

// 字节统计复用模块级 encoder（useTerminalClipboard 同款）：CJK 下 string.length
// 低估约 3 倍，100KB 上限按真实字节算
const sizeEncoder = new TextEncoder()

export const useClipboardHistoryStore = defineStore('clipboardHistory', () => {
  // 新条目在前的环形表（弹层按 MRU 展示）
  const entries = ref<ClipboardHistoryEntry[]>([])
  let nextId = 1

  /**
   * 捕获一段复制文本入史：空串/超限跳过；与既有条目重复时移到队首（MRU，
   * 全表唯一——含相邻去重，同一文本不会占两个槽位），否则插队首并环形截断
   */
  function record(text: string): void {
    if (!text) return
    if (sizeEncoder.encode(text).length > CLIP_ENTRY_MAX_BYTES) return
    const existing = entries.value.findIndex(e => e.text === text)
    if (existing >= 0) {
      const hit = entries.value.splice(existing, 1)[0]
      if (!hit) return
      hit.at = Date.now()
      entries.value.unshift(hit)
      return
    }
    entries.value.unshift({ id: nextId++, text, at: Date.now() })
    if (entries.value.length > CLIP_HISTORY_MAX) entries.value.length = CLIP_HISTORY_MAX
  }

  return { entries, record }
})

let captureInstalled = false

/**
 * 安装全局 copy 事件捕获（幂等，main.ts 启动时装一次）：原生 Ctrl+C / 菜单复制 /
 * execCommand 降级路径都会冒泡出真实 copy 事件，读其内容入史。只读不
 * preventDefault——原生复制行为不受影响。程序化 navigator.clipboard.writeText
 * 不派发 copy 事件，由 copyText / writeClipboard 调 record 补位。
 *
 * 事件时点读数（Chromium 实测）：事件 clipboardData 只在监听器主动 setData 时
 * 可读，程序化 execCommand 复制与 EditContext 编辑器（Monaco 新输入体系）的
 * 原生复制在事件时点 getData 为空或为无害占位（"\r\n"）——回退读当前 DOM 选区；
 * 两者皆空/纯空白（占位与误选空白）跳过不记
 */
export function installClipboardHistoryCapture(): void {
  if (captureInstalled) return
  captureInstalled = true
  document.addEventListener('copy', (e: ClipboardEvent) => {
    const evText = e.clipboardData?.getData('text/plain') ?? ''
    const text = evText.trim() ? evText : (window.getSelection()?.toString() ?? '')
    if (!text.trim()) return
    useClipboardHistoryStore().record(text)
  })
}
