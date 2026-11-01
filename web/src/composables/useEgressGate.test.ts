import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchWithEgressGate } from './useEgressGate'
import { confirmDialog } from './useDialog'

// 出域闸取数回环（P-20261004-113）：JSON 警示分流 / 一次确认后带 confirmed
// 重试 / 取消与非闸门 JSON 绝不当附件继续。弹层本身由 useDialog 承载，此处
// mock 掉只验证回环语义。

vi.mock('./useDialog', () => ({ confirmDialog: vi.fn() }))
const confirmMock = vi.mocked(confirmDialog)

function jsonBlob(body: unknown): Blob {
  return new Blob([JSON.stringify(body)], { type: 'application/json' })
}

beforeEach(() => {
  confirmMock.mockReset()
})

describe('fetchWithEgressGate — 出域取数回环', () => {
  it('非 JSON 响应直通（无闸门零打扰）', async () => {
    const blob = new Blob(['hello'], { type: 'text/plain' })
    const load = vi.fn(async () => blob)
    await expect(fetchWithEgressGate(load)).resolves.toBe(blob)
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith(false)
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('警示 → 确认 → 带 confirmed=true 重取并返回附件', async () => {
    const allowed = new Blob(['full content'], { type: 'text/markdown' })
    const load = vi.fn(async (confirmed: boolean) =>
      confirmed ? allowed : jsonBlob({
        warnings: ['sensitive-content'],
        sensitiveHits: [{ type: 'known-token', count: 1 }],
      }))
    confirmMock.mockResolvedValue(true)
    await expect(fetchWithEgressGate(load, 'demo')).resolves.toBe(allowed)
    expect(load).toHaveBeenNthCalledWith(1, false)
    expect(load).toHaveBeenNthCalledWith(2, true)
    expect(confirmMock).toHaveBeenCalledTimes(1)
  })

  it('用户取消 → null，不重试', async () => {
    const load = vi.fn(async () => jsonBlob({ warnings: ['sensitive-content'] }))
    confirmMock.mockResolvedValue(false)
    await expect(fetchWithEgressGate(load)).resolves.toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('JSON 但非闸门形态 → null（不弹层、不当附件）', async () => {
    const load = vi.fn(async () => jsonBlob({ data: 'not a gate' }))
    await expect(fetchWithEgressGate(load)).resolves.toBeNull()
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('已确认仍被拦 → null（不无限循环）', async () => {
    const load = vi.fn(async () => jsonBlob({ warnings: ['sensitive-content'] }))
    confirmMock.mockResolvedValue(true)
    await expect(fetchWithEgressGate(load)).resolves.toBeNull()
    expect(load).toHaveBeenCalledTimes(2)
    expect(confirmMock).toHaveBeenCalledTimes(1)
  })

  // P-20261003-225 批量导出口令信封档：信封本身就是合法 JSON 载荷（P-29），
  // allowJsonPayload 显式声明后非闸门 JSON 直通；闸门警示仍照常分流确认
  it('allowJsonPayload：非闸门 JSON（口令信封）直通返回', async () => {
    const envelope = jsonBlob({ format: 'sc-passphrase-envelope', v: 1, ciphertext: 'xxx' })
    const load = vi.fn(async () => envelope)
    await expect(fetchWithEgressGate(load, '', { allowJsonPayload: true })).resolves.toBe(envelope)
    expect(load).toHaveBeenCalledTimes(1)
    expect(confirmMock).not.toHaveBeenCalled()
  })

  it('allowJsonPayload：闸门警示仍分流（信封档不豁免确认）', async () => {
    const envelope = jsonBlob({ format: 'sc-passphrase-envelope', v: 1, ciphertext: 'xxx' })
    const load = vi.fn(async (confirmed: boolean) =>
      confirmed ? envelope : jsonBlob({
        warnings: ['sensitive-content'],
        sensitiveHits: [{ type: 'known-token', count: 2 }],
      }))
    confirmMock.mockResolvedValue(true)
    await expect(fetchWithEgressGate(load, '', { allowJsonPayload: true })).resolves.toBe(envelope)
    expect(load).toHaveBeenNthCalledWith(1, false)
    expect(load).toHaveBeenNthCalledWith(2, true)
    expect(confirmMock).toHaveBeenCalledTimes(1)
  })
})
