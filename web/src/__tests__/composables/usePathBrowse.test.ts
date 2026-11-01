import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref, nextTick } from 'vue'

// mock browseApi.list，避免真实网络请求
const listMock = vi.fn()
vi.mock('@/api/client', () => ({
  browseApi: { list: (...args: any[]) => listMock(...args) },
}))

import { usePathBrowse } from '@/composables/usePathBrowse'

describe('usePathBrowse', () => {
  beforeEach(() => {
    listMock.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('250ms 防抖后才请求联想', async () => {
    listMock.mockResolvedValue({ data: [] })
    const path = ref('/home/user')
    usePathBrowse(path)
    path.value = '/home/user/proj'
    await vi.advanceTimersByTimeAsync(249)
    expect(listMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(listMock).toHaveBeenCalledWith('/home/user')
  })

  it('prefix 过滤 + 过滤掉 ..', async () => {
    listMock.mockResolvedValue({
      data: [
        { name: 'foo', path: '/p/foo' },
        { name: 'foobar', path: '/p/foobar' },
        { name: 'bar', path: '/p/bar' },
        { name: '..', path: '/' },
      ],
    })
    const path = ref('')
    const browse = usePathBrowse(path)
    path.value = '/p/f'
    await vi.advanceTimersByTimeAsync(250)
    await nextTick()
    expect(browse.suggestions.value).toEqual([
      { name: 'foo', path: '/p/foo' },
      { name: 'foobar', path: '/p/foobar' },
    ])
    expect(browse.showSuggestions.value).toBe(true)
  })

  it('Windows 盘根分支：输入 C 时列盘根', async () => {
    listMock.mockResolvedValue({ data: [{ name: 'Users', path: 'C:/Users' }] })
    const path = ref('')
    usePathBrowse(path)
    path.value = 'C'
    await vi.advanceTimersByTimeAsync(250)
    await nextTick()
    expect(listMock).toHaveBeenCalledWith('C:')
  })

  it('closeBrowse 清空浏览状态且不改 pathRef', () => {
    const path = ref('/some/path')
    const browse = usePathBrowse(path)
    browse.browseDirs.value = [{ name: 'foo', path: '/some/path/foo' }]
    browse.browseCurrent.value = '/some/path'
    browse.browseLoading.value = true
    const before = path.value
    browse.closeBrowse()
    expect(browse.browseDirs.value).toEqual([])
    expect(browse.browseCurrent.value).toBe('')
    expect(browse.browseLoading.value).toBe(false)
    expect(path.value).toBe(before)
  })

  it('selectSuggestion 的 onSelect 先于 pathRef 变更触发', () => {
    const path = ref('/p')
    let pathAtOnSelect = '__unset__'
    const onSelect = vi.fn((_p: string) => {
      pathAtOnSelect = path.value
    })
    const browse = usePathBrowse(path, { onSelect })
    browse.selectSuggestion({ name: 'foo', path: '/p/foo' })
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(pathAtOnSelect).toBe('/p') // onSelect 触发时 pathRef 尚未变更
    expect(path.value).toContain('foo') // 之后 pathRef 才被改写
    expect(path.value).not.toBe('/p')
  })
})
