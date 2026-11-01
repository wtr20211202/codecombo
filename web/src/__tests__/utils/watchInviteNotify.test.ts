import { describe, it, expect, beforeEach, vi } from 'vitest'
// 分享子服务状态查询走 shareApi.status；地址计划以同式桩实现（host 固定、
// 端口取 status）断言「相对路径 → 绝对访客短链」拼装
const { statusMock, extrasMock, planMock } = vi.hoisted(() => ({
  statusMock: vi.fn(),
  extrasMock: vi.fn(),
  planMock: vi.fn(),
}))
vi.mock('@/api/domains/share', () => ({
  shareApi: { status: statusMock },
  fetchShareAddressExtras: extrasMock,
  // P-20261020-2：邀请通知与结果卡/管理器共用 resolveShareAddressPlan；
  // 桩保持改造前的 host:sharePort 形态，锁通知载荷契约
  resolveShareAddressPlan: planMock,
}))
import { handleWatchInviteNotify, isShareVisitorPath, resetWatchInviteNotifyStateForTest } from '@/utils/watchInviteNotify'
import { useNotificationStore } from '@/stores/notification'

// 直播邀请通知链（P-20261005-165）：url 形态白名单（反钓鱼边界，与服务端
// isShareVisitorPath 同一矩阵）+ 会话内去重 + 访客短链拼装 + 通知载荷
// （category=task、action=url）。指纹表经 reset 钩子在用例间隔离

describe('isShareVisitorPath 访客短链形态守卫', () => {
  it('合法形态：/s/<字母数字 token>', () => {
    expect(isShareVisitorPath('/s/abc123def456ghi7')).toBe(true)
    expect(isShareVisitorPath('/s/0123456789abcdef')).toBe(true)
    expect(isShareVisitorPath('/s/Upper1234567890')).toBe(true)
  })

  it('注入形态矩阵全拒（../、//、@、query、绝对 URL、伪协议、编码）', () => {
    expect(isShareVisitorPath('/s/')).toBe(false) // 裸前缀无 token
    expect(isShareVisitorPath('/s/../etc')).toBe(false) // .. 穿越
    expect(isShareVisitorPath('/s/a/../b')).toBe(false)
    expect(isShareVisitorPath('/s/abc/def')).toBe(false) // 尾随子路径
    expect(isShareVisitorPath('//evil.com/s/abc')).toBe(false) // 协议相对外链
    expect(isShareVisitorPath('https://evil.com/s/abc')).toBe(false) // 绝对 URL
    expect(isShareVisitorPath('javascript:alert(1)')).toBe(false) // 伪协议
    expect(isShareVisitorPath('/s/abc?x=1')).toBe(false) // query 附加
    expect(isShareVisitorPath('/s/abc#frag')).toBe(false) // fragment
    expect(isShareVisitorPath('/s/a@b')).toBe(false) // @ 凭据形态
    expect(isShareVisitorPath('/s/abc%2Fdef')).toBe(false) // 编码绕过
    expect(isShareVisitorPath('s/abc')).toBe(false) // 缺前导斜杠
    expect(isShareVisitorPath('/x/abc')).toBe(false) // 前缀不对
    expect(isShareVisitorPath('')).toBe(false)
    expect(isShareVisitorPath(undefined as unknown as string)).toBe(false)
    expect(isShareVisitorPath(123 as unknown as string)).toBe(false)
  })

  it('超长 token 拒绝（>80 上限）', () => {
    expect(isShareVisitorPath(`/s/${'a'.repeat(80)}`)).toBe(false)
  })
})

describe('handleWatchInviteNotify 通知链', () => {
  let addSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetWatchInviteNotifyStateForTest()
    statusMock.mockReset().mockResolvedValue({ data: { running: true, port: 18400, scheme: 'http' } })
    // 即使上游有局域网候选，通知链也必须显式清空（候选可能不可达）
    extrasMock.mockReset().mockResolvedValue({
      publicBaseUrl: '',
      externalAccessUrl: '',
      addresses: [{ ip: '172.26.144.1', family: 'v4', iface: 'vEthernet', private: true }],
    })
    planMock.mockReset().mockImplementation(async (token: string, status: { running: boolean; port: number; scheme?: string }) => ({
      state: status.running && status.port ? 'loopback' : 'unreachable',
      source: status.running && status.port ? 'legacy' : '',
      baseOrigin: status.running && status.port ? `${status.scheme || 'http'}://localhost:${status.port}` : '',
      candidates: [],
      legacy: status.running && status.port,
      url: status.running && status.port ? `${status.scheme || 'http'}://localhost:${status.port}/s/${token}` : '',
    }))
    addSpy = vi.spyOn(useNotificationStore(), 'add')
  })

  it('合法邀请 → 状态拼访客短链 + 通知入账（category=task、action=url）', async () => {
    expect(await handleWatchInviteNotify({ url: '/s/abc123def456ghi7', title: '过来看', body: '演示' })).toBe(true)
    expect(statusMock).toHaveBeenCalledTimes(1)
    // 候选不得进入通知 payload（回环入口下列表可能指向未监听网卡）
    expect(planMock).toHaveBeenCalledWith('abc123def456ghi7', { running: true, port: 18400, scheme: 'http' }, {
      publicBaseUrl: '',
      externalAccessUrl: '',
      addresses: [],
    })
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(addSpy).toHaveBeenCalledWith({
      type: 'info',
      category: 'task',
      title: '过来看',
      body: '演示',
      action: 'url',
      actionPayload: 'http://localhost:18400/s/abc123def456ghi7',
    })
  })

  it('payload 未带 title/body → 界面默认文案兜底', async () => {
    await handleWatchInviteNotify({ url: '/s/abc123def456ghi7' })
    expect(addSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '直播邀请', body: '智能体已开启终端直播，点击在新窗口观看实时画面' })
    )
  })

  it('非法 url 静默忽略：不入账、不查状态', async () => {
    expect(await handleWatchInviteNotify({ url: '//evil.com/s/abc' })).toBe(false)
    expect(await handleWatchInviteNotify({} as never)).toBe(false)
    expect(addSpy).not.toHaveBeenCalled()
    expect(statusMock).not.toHaveBeenCalled()
  })

  it('同 url+title+body 去重：整链跳过（不重复入账）', async () => {
    await handleWatchInviteNotify({ url: '/s/abc123def456ghi7', title: '过来看' })
    expect(await handleWatchInviteNotify({ url: '/s/abc123def456ghi7', title: '过来看' })).toBe(false)
    expect(addSpy).toHaveBeenCalledTimes(1)
  })

  it('同 url 不同文案视为新邀请（agent 改话术重拉可见）', async () => {
    await handleWatchInviteNotify({ url: '/s/abc123def456ghi7', title: '过来看' })
    expect(await handleWatchInviteNotify({ url: '/s/abc123def456ghi7', title: '再看一眼' })).toBe(true)
    expect(addSpy).toHaveBeenCalledTimes(2)
  })

  it('状态查询失败降级：原样入账相对路径（邀请事实不被吞）', async () => {
    statusMock.mockRejectedValue(new Error('share service down'))
    await handleWatchInviteNotify({ url: '/s/abc123def456ghi7' })
    expect(addSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ actionPayload: '/s/abc123def456ghi7' })
    )
  })

  it('子服务未就绪（running=false）同款降级', async () => {
    statusMock.mockResolvedValue({ data: { running: false, port: 0, scheme: '' } })
    await handleWatchInviteNotify({ url: '/s/abc123def456ghi7' })
    expect(addSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ actionPayload: '/s/abc123def456ghi7' })
    )
  })

  it('超长 title 截断到 200 字符（展示面防炸版）', async () => {
    await handleWatchInviteNotify({ url: '/s/abc123def456ghi7', title: 'x'.repeat(300) })
    expect(addSpy).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'x'.repeat(200) }))
  })

  it('指纹表封顶（200）逐出最早：被逐出邀请可重新入账', async () => {
    for (let i = 0; i < 201; i++) {
      expect(await handleWatchInviteNotify({ url: `/s/t${String(i).padStart(16, '0')}` })).toBe(true)
    }
    expect(await handleWatchInviteNotify({ url: '/s/t0000000000000200' })).toBe(false)
    expect(await handleWatchInviteNotify({ url: '/s/t0000000000000000' })).toBe(true)
  })
})
