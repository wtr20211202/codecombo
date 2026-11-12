import { describe, expect, it, vi, beforeEach } from 'vitest'

// 笔记写请求的本窗 nonce 头（P-20261111-4 S1 回声抑制）：写路径（save/create/
// remove/purge/restore）统一携 X-Notes-Origin——服务端写路径广播 notes.updated
// 时经 payload.origin 原样回带，useNotesMulti.onExternalUpdate 收到同 nonce 跳过
// （本窗自动保存回声不再触发整篇重读）。读路径不广播不携头；migration POST 不携
// （migrated 广播是服务端自发起的作用域级批量并入，消费方恒按外部更新处理）。
// 本测只验「域层交给 axios 的 config 形状」，@/api/http 整体桩化不进拦截链
const { getMock, postMock, putMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  putMock: vi.fn(),
  deleteMock: vi.fn(),
}))

vi.mock('@/api/http', () => ({
  default: { get: getMock, post: postMock, put: putMock, delete: deleteMock },
}))

import {
  NOTES_ORIGIN_HEADER, notesGlobalApi, notesOriginNonce, resetNotesOriginNonceForTest,
} from '@/api/domains/notes'

/** 取调用 config 头里的 nonce（未携头返回 undefined） */
function originOf(mock: ReturnType<typeof vi.fn>, call = 0): string | undefined {
  const cfg = mock.mock.calls[call]?.[mock.mock.calls[call].length - 1] as
    { headers?: Record<string, string> } | undefined
  return cfg?.headers?.[NOTES_ORIGIN_HEADER]
}

describe('notesGlobalApi 回声抑制 nonce 头（P-20261111-4 S1）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetNotesOriginNonceForTest()
  })

  it('写路径五方法统一携 X-Notes-Origin，且与 notesOriginNonce() 同源', async () => {
    getMock.mockResolvedValue({ data: [] })
    postMock.mockResolvedValue({ data: { id: 'n1', title: '', content: '', createdAt: '', updatedAt: '' } })
    putMock.mockResolvedValue({ data: { id: 'n1', title: '', content: '', createdAt: '', updatedAt: '' } })
    deleteMock.mockResolvedValue({ message: 'ok' })

    await notesGlobalApi.create({ title: 't' })
    await notesGlobalApi.save('n1', { content: 'c', baseUpdatedAt: 'u' })
    await notesGlobalApi.remove('n1')
    await notesGlobalApi.purge('n1')
    await notesGlobalApi.restore('n1')

    const nonce = notesOriginNonce()
    expect(nonce).toBeTruthy()
    expect(originOf(postMock, 0)).toBe(nonce) // create
    expect(originOf(putMock, 0)).toBe(nonce) // save
    expect(originOf(deleteMock, 0)).toBe(nonce) // remove（软删）
    expect(originOf(deleteMock, 1)).toBe(nonce) // purge
    expect(originOf(postMock, 1)).toBe(nonce) // restore
  })

  it('读路径（list/get/migrationStatus）不携 nonce 头', async () => {
    getMock.mockResolvedValue({ data: [] })
    await notesGlobalApi.list()
    await notesGlobalApi.get('n1')
    await notesGlobalApi.migrationStatus()
    expect(getMock).toHaveBeenCalledTimes(3)
    for (const call of getMock.mock.calls) {
      const cfg = call[1] as { headers?: Record<string, string> } | undefined
      expect(cfg?.headers?.[NOTES_ORIGIN_HEADER]).toBeUndefined()
    }
  })

  it('nonce 页面会话内稳定、惰性生成；重置钩子换新（用例隔离）', () => {
    const a = notesOriginNonce()
    expect(notesOriginNonce()).toBe(a) // 同会话幂等
    resetNotesOriginNonceForTest()
    expect(notesOriginNonce()).not.toBe(a) // 重置后换新
    expect(notesOriginNonce()).toMatch(/^notes-/)
  })
})
