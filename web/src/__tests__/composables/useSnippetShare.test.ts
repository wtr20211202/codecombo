import { describe, it, expect, vi, beforeEach } from 'vitest'

// 片段分享口令透传（P-20261020-6）：创建请求带 passphrase，结果卡拿到同一
// 明文（仅存活到结果卡关闭）；关闭弹窗清空草稿口令。UI 交互由 e2e 覆盖，
// 这里锁 API 调用契约与单例状态。

const { openResult } = vi.hoisted(() => ({ openResult: vi.fn() }))

vi.mock('@/composables/useShareDialog', () => ({
  useShareDialog: () => ({ openResult }),
}))

vi.mock('@/api/domains/share', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/domains/share')>()
  return {
    ...actual,
    // 地址计划上下文不触真实 HTTP：空基址 + 无候选 → 回退 host:sharePort
    fetchShareAddressExtras: vi.fn().mockResolvedValue({ publicBaseUrl: '', externalAccessUrl: '', addresses: [] }),
    shareApi: {
      ...actual.shareApi,
      createSnippet: vi.fn(),
      status: vi.fn(),
    },
  }
})

import { shareApi, type ShareInfo } from '@/api/domains/share'
import type { ShareAddressPlan } from '@/utils/shareAddress'
import { useSnippetShare } from '@/composables/useSnippetShare'

const snippetShare: ShareInfo = {
  token: 'snippettoken00001',
  kind: 'snippet',
  projectId: '',
  projectName: '',
  path: '',
  name: 'panic: quota',
  isDir: false,
  size: 12,
  createdAt: '2026-10-20T00:00:00Z',
  expiresAt: '2026-10-21T00:00:00Z',
  hasPassphrase: true,
}

beforeEach(() => {
  vi.mocked(shareApi.createSnippet).mockReset()
  vi.mocked(shareApi.status).mockReset()
  openResult.mockReset()
  vi.mocked(shareApi.status).mockResolvedValue({
    data: { running: true, port: 18080, scheme: 'http' },
  } as unknown as Awaited<ReturnType<typeof shareApi.status>>)
})

describe('useSnippetShare 口令透传', () => {
  it('创建片段的 passphrase 随请求发送，并交给结果卡', async () => {
    vi.mocked(shareApi.createSnippet).mockResolvedValue({
      data: snippetShare,
    } as unknown as Awaited<ReturnType<typeof shareApi.createSnippet>>)
    const api = useSnippetShare()
    api.openShareSnippet('panic: quota')
    api.draftName.value = 'panic'
    api.draftPassphrase.value = 'snippet-secret'
    const ok = await api.submitSnippet()

    expect(ok).toBe(true)
    expect(shareApi.createSnippet).toHaveBeenCalledWith('panic: quota', 'panic', 'snippet-secret', true, false)
    expect(openResult).toHaveBeenCalledTimes(1)
    const [shareArg, planArg, secretArg] = openResult.mock.calls[0] as [ShareInfo, ShareAddressPlan, string]
    expect(shareArg.token).toBe('snippettoken00001')
    expect(planArg.url).toContain('/s/snippettoken00001')
    expect(planArg.url).not.toContain('snippet-secret')
    expect(secretArg).toBe('snippet-secret')
  })

  it('未设口令仍发空串（API 层缺省省略字段），结果卡口令为空', async () => {
    vi.mocked(shareApi.createSnippet).mockResolvedValue({
      data: { ...snippetShare, hasPassphrase: false },
    } as unknown as Awaited<ReturnType<typeof shareApi.createSnippet>>)
    const api = useSnippetShare()
    api.openShareSnippet('public text')
    await api.submitSnippet()

    expect(shareApi.createSnippet).toHaveBeenCalledWith('public text', '', '', true, false)
    expect(openResult.mock.calls[0]?.[2]).toBe('')
  })

  it('关闭弹窗丢弃草稿口令', () => {
    const api = useSnippetShare()
    api.openShareSnippet('x')
    api.draftPassphrase.value = 'secret'
    api.closeDialog()
    expect(api.showDialog.value).toBe(false)
    expect(api.draftPassphrase.value).toBe('')
  })
})
