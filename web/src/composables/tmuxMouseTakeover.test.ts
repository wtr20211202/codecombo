import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TMUX_MOUSE_ENABLED,
  isTmuxMouseTakeoverEnabled,
  syncTmuxMouseTakeoverLocal,
  setTmuxMouseTakeover,
} from './tmuxMouseTakeover'

// tmux 鼠标接管开关（P-20261109-7 C）写路径收口测试：mock settingsApi 验证
// 「乐观更新 → PUT → 失败回滚」三段与模块镜像的反应式一致性。settingsApi.update
// 真实实现走 axios（锁 cookie/全局错误弹层），写路径语义由本测试钉死
const { updateMock } = vi.hoisted(() => ({
  updateMock: vi.fn<(data: Record<string, unknown>, config?: unknown) => Promise<unknown>>(),
}))
vi.mock('../api/domains/system', () => ({
  settingsApi: { update: updateMock },
}))

beforeEach(() => {
  updateMock.mockReset()
  updateMock.mockResolvedValue({})
  // 用例间把镜像归位（缺字段 = 服务端未配置 → 默认开）
  syncTmuxMouseTakeoverLocal(undefined)
})

describe('tmux 鼠标接管开关（P-20261109-7 C）', () => {
  it('缺省 = 开（DEFAULT_TMUX_MOUSE_ENABLED）；syncTmuxMouseTakeoverLocal 同步布尔、忽略缺字段', () => {
    expect(DEFAULT_TMUX_MOUSE_ENABLED).toBe(true)
    expect(isTmuxMouseTakeoverEnabled()).toBe(true)
    syncTmuxMouseTakeoverLocal(false)
    expect(isTmuxMouseTakeoverEnabled()).toBe(false)
    syncTmuxMouseTakeoverLocal(undefined) // 缺字段不动（服务端未配置回落默认）
    expect(isTmuxMouseTakeoverEnabled()).toBe(false)
    syncTmuxMouseTakeoverLocal(true)
    expect(isTmuxMouseTakeoverEnabled()).toBe(true)
  })

  it('setTmuxMouseTakeover 成功：乐观更新 + PUT 携带单字段 terminalTmuxMouseEnabled', async () => {
    const ok = await setTmuxMouseTakeover(false)
    expect(ok).toBe(true)
    expect(isTmuxMouseTakeoverEnabled()).toBe(false)
    expect(updateMock).toHaveBeenCalledTimes(1)
    const [data, config] = updateMock.mock.calls[0]!
    expect(data).toEqual({ terminalTmuxMouseEnabled: false })
    expect((config as { silent?: boolean })?.silent).toBe(true) // 静默：失败由调用方 toast
  })

  it('setTmuxMouseTakeover 失败：本地回滚保持原值（失败可恢复），仍返回 false', async () => {
    syncTmuxMouseTakeoverLocal(true)
    updateMock.mockRejectedValue(new Error('network'))
    const ok = await setTmuxMouseTakeover(false)
    expect(ok).toBe(false)
    expect(isTmuxMouseTakeoverEnabled()).toBe(true) // 回滚
  })
})
