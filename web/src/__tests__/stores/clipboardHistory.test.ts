import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  useClipboardHistoryStore, installClipboardHistoryCapture,
  CLIP_HISTORY_MAX, CLIP_ENTRY_MAX_BYTES,
} from '@/stores/clipboardHistory'

// 多剪贴板历史 store（P-20261002-149）：环形 ≤20、重复去重（MRU 移队首，含
// 相邻去重）、单条 100KB 字节上限、全局 copy 事件捕获对异常事件安全

describe('clipboardHistory store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('记录入史且新条目在前（MRU 序）', () => {
    const store = useClipboardHistoryStore()
    store.record('first')
    store.record('second')
    expect(store.entries.map(e => e.text)).toEqual(['second', 'first'])
  })

  it('相邻重复去重：同一文本连续复制只占一个槽位', () => {
    const store = useClipboardHistoryStore()
    store.record('same')
    store.record('same')
    store.record('same')
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0]!.text).toBe('same')
  })

  it('非相邻重复：既有条目移到队首而非追加（全表唯一）', () => {
    const store = useClipboardHistoryStore()
    store.record('a')
    store.record('b')
    store.record('c')
    store.record('a') // 再复制最早的 a → 提到队首
    expect(store.entries.map(e => e.text)).toEqual(['a', 'c', 'b'])
  })

  it('环形截断：超上限丢最旧，只留最近 20 条', () => {
    const store = useClipboardHistoryStore()
    for (let i = 0; i < CLIP_HISTORY_MAX + 5; i++) store.record(`seg-${i}`)
    expect(store.entries).toHaveLength(CLIP_HISTORY_MAX)
    // 最旧 5 条（seg-0..4）被挤出，最新在队首
    expect(store.entries[0]!.text).toBe(`seg-${CLIP_HISTORY_MAX + 4}`)
    expect(store.entries.at(-1)!.text).toBe('seg-5')
    expect(store.entries.some(e => e.text === 'seg-0')).toBe(false)
  })

  it('单条 100KB 字节上限：恰好达标可入，超出 1 字节不入史', () => {
    const store = useClipboardHistoryStore()
    store.record('a'.repeat(CLIP_ENTRY_MAX_BYTES)) // 100KB 整 → 入史
    expect(store.entries).toHaveLength(1)
    store.record('a'.repeat(CLIP_ENTRY_MAX_BYTES + 1)) // 超 1 字节 → 跳过
    expect(store.entries).toHaveLength(1)
  })

  it('上限按 UTF-8 字节算：CJK 内容 length 未超但字节超限不入史', () => {
    const store = useClipboardHistoryStore()
    // 4 万个汉字 = length 40000（< 102400）但 UTF-8 120000 字节（> 上限）
    store.record('汉'.repeat(40_000))
    expect(store.entries).toHaveLength(0)
  })

  it('空串不入史', () => {
    const store = useClipboardHistoryStore()
    store.record('')
    expect(store.entries).toHaveLength(0)
  })

  it('重复入史的条目更新捕获时刻', () => {
    const store = useClipboardHistoryStore()
    store.record('x')
    const firstAt = store.entries[0]!.at
    const later = firstAt + 5000
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(later)
    store.record('y')
    store.record('x') // x 移队首且 at 刷新
    nowSpy.mockRestore()
    expect(store.entries[0]!.text).toBe('x')
    expect(store.entries[0]!.at).toBe(later)
  })
})

describe('installClipboardHistoryCapture', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  /** 合成 copy 事件（jsdom 无 ClipboardEvent/DataTransfer 构造，按监听器实际
   *  读取面 stub clipboardData） */
  function dispatchCopy(clipboardData: { getData: (type: string) => string } | null): void {
    const e = new Event('copy') as ClipboardEvent
    Object.defineProperty(e, 'clipboardData', { value: clipboardData })
    document.dispatchEvent(e)
  }

  it('copy 事件捕获：clipboardData 带文本时入史（幂等安装不重复记录）', () => {
    const store = useClipboardHistoryStore()
    installClipboardHistoryCapture()
    installClipboardHistoryCapture() // 二次安装为 no-op
    const dt = { getData: (type: string) => (type === 'text/plain' ? 'from-copy-event' : '') }
    dispatchCopy(dt)
    dispatchCopy(dt)
    // 幂等安装 + 相邻去重 → 恰 1 条
    expect(store.entries.map(e => e.text)).toEqual(['from-copy-event'])
  })

  it('事件 clipboardData 为空时回退读 DOM 选区（Chromium execCommand/EditContext 复制形态）', () => {
    const store = useClipboardHistoryStore()
    installClipboardHistoryCapture()
    const selSpy = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'selected-seg' } as Selection)
    dispatchCopy({ getData: () => '' })
    selSpy.mockRestore()
    expect(store.entries.map(e => e.text)).toEqual(['selected-seg'])
  })

  it('clipboardData 为换行占位（EditContext 编辑器空复制）时丢弃占位优先读选区', () => {
    const store = useClipboardHistoryStore()
    installClipboardHistoryCapture()
    const selSpy = vi.spyOn(window, 'getSelection').mockReturnValue({ toString: () => 'real-selection' } as Selection)
    dispatchCopy({ getData: () => '\r\n' })
    selSpy.mockRestore()
    expect(store.entries.map(e => e.text)).toEqual(['real-selection'])
  })

  it('无 clipboardData / 空文本且无选区的合成 copy 事件安全跳过，不抛错不入史', () => {
    const store = useClipboardHistoryStore()
    installClipboardHistoryCapture()
    expect(() => document.dispatchEvent(new Event('copy'))).not.toThrow()
    expect(() => dispatchCopy({ getData: () => '' })).not.toThrow()
    expect(() => dispatchCopy({ getData: () => '\r\n' })).not.toThrow()
    expect(store.entries).toHaveLength(0)
  })
})
