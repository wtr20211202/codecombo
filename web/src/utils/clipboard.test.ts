import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'
import { useClipboardHistoryStore } from '@/stores/clipboardHistory'

describe('copyText', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    // navigator.clipboard / isSecureContext / execCommand 的 defineProperty 覆盖逐层摘除
    Reflect.deleteProperty(navigator as unknown as object, 'clipboard')
    Reflect.deleteProperty(window, 'isSecureContext')
    Reflect.deleteProperty(document, 'execCommand')
  })

  /** jsdom 未实现 execCommand（属性不存在），显式定义桩覆盖降级路径 */
  function stubExecCommand(impl: () => boolean) {
    const exec = vi.fn(impl)
    Object.defineProperty(document, 'execCommand', { value: exec, configurable: true })
    return exec
  }

  it('空串直接失败（无复制语义）', async () => {
    await expect(copyText('')).resolves.toBe(false)
  })

  it('secure context + clipboard API：写入成功并补位入剪贴板历史', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    const writeText = vi.fn<(t: string) => Promise<void>>().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    await expect(copyText('hello')).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith('hello')
    // P-20261002-149：程序化复制不派发 copy 事件，这里补位入史
    expect(useClipboardHistoryStore().entries.some(i => i.text === 'hello')).toBe(true)
  })

  it('clipboard API 被权限拒绝时降级 execCommand 路径（Range 选区，不依赖焦点）', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) },
    })
    const exec = stubExecCommand(() => true)

    await expect(copyText('fallback')).resolves.toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
    // 临时选区载体已清理
    expect(document.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(0)
  })

  it('非 secure context（局域网 IP 访问形态）直接走降级路径', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    const exec = stubExecCommand(() => true)

    await expect(copyText('lan')).resolves.toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('降级路径 execCommand 失败（返回 false）如实报告失败', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    stubExecCommand(() => false)
    await expect(copyText('nope')).resolves.toBe(false)
  })

  it('降级路径无选区对象（getSelection null）时放弃复制不崩链', async () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true })
    stubExecCommand(() => true)
    vi.spyOn(window, 'getSelection').mockReturnValue(null)
    await expect(copyText('noselection')).resolves.toBe(false)
  })
})
