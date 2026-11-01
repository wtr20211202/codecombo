import { describe, it, expect, beforeEach, vi } from 'vitest'
// previewPort store 经 router 判路由分支：单测锁「项目页就地开面板」分支，
// 首页跳转分支由 e2e 兜底（jsdom 下真 router 无法构造）
vi.mock('@/router', () => ({
  default: {
    currentRoute: { value: { name: 'project' } },
    push: vi.fn(async () => {}),
  },
}))
// 隧道桥（P-20261004-5）走 tunnelApi.open：mock 拦截网络面
const { openTunnelMock } = vi.hoisted(() => ({ openTunnelMock: vi.fn() }))
vi.mock('@/api/domains/remote', () => ({
  tunnelApi: { open: openTunnelMock },
}))
import { handlePreviewPortNotify, resetPreviewPortNotifyStateForTest } from '@/utils/previewPortNotify'
import { useNotificationStore } from '@/stores/notification'
import { usePreviewPortStore, isValidPreviewPort, PREVIEW_PORT_MIN, PREVIEW_PORT_MAX } from '@/stores/previewPort'
import { usePanelLayout, resetPanelLayout } from '@/composables/usePanelLayout'

// 预览端口直达链（P-20261002-70）：端口校验（1024~65535 整数）+ 会话内去重
// （同 port+label 只入账一次）+ 悬浮球登记 + 通知载荷（category=task、
// action=preview）。指纹表经 reset 钩子在用例间隔离

describe('isValidPreviewPort 端口校验', () => {
  it('边界与类型：1024/65535 合法，1023/65536/非整数/非数字非法', () => {
    expect(PREVIEW_PORT_MIN).toBe(1024)
    expect(PREVIEW_PORT_MAX).toBe(65535)
    expect(isValidPreviewPort(1024)).toBe(true)
    expect(isValidPreviewPort(65535)).toBe(true)
    expect(isValidPreviewPort(3000)).toBe(true)
    expect(isValidPreviewPort(1023)).toBe(false)
    expect(isValidPreviewPort(65536)).toBe(false)
    expect(isValidPreviewPort(0)).toBe(false)
    expect(isValidPreviewPort(3000.5)).toBe(false)
    expect(isValidPreviewPort('3000')).toBe(false)
    expect(isValidPreviewPort(null)).toBe(false)
    expect(isValidPreviewPort(undefined)).toBe(false)
    expect(isValidPreviewPort(NaN)).toBe(false)
    expect(isValidPreviewPort(Infinity)).toBe(false)
  })
})

describe('handlePreviewPortNotify 通知链', () => {
  let addSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetPreviewPortNotifyStateForTest()
    addSpy = vi.spyOn(useNotificationStore(), 'add')
  })

  it('合法上报 → 悬浮球登记 + 通知入账（category=task、action=preview）', () => {
    const previewPort = usePreviewPortStore()
    expect(handlePreviewPortNotify({ port: 3000, label: 'vite dev server' })).toBe(true)
    expect(previewPort.port).toBe(3000)
    expect(previewPort.label).toBe('vite dev server')
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(addSpy).toHaveBeenCalledWith({
      type: 'info',
      category: 'task',
      title: '预览端口 :3000 · vite dev server',
      body: 'agent 上报服务已就绪，点击直达预览面板',
      action: 'preview',
      actionPayload: '3000',
    })
  })

  it('无 label → 标题退化为纯端口形态', () => {
    handlePreviewPortNotify({ port: 4173 })
    expect(addSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '预览端口 :4173', actionPayload: '4173' })
    )
  })

  it('同会话重复上报同端口+label 去重：整链跳过（不重复入账）', () => {
    handlePreviewPortNotify({ port: 3000, label: 'dev' })
    expect(handlePreviewPortNotify({ port: 3000, label: 'dev' })).toBe(false)
    expect(addSpy).toHaveBeenCalledTimes(1)
  })

  it('同端口不同 label 视为新上报（服务换名重报可见）', () => {
    handlePreviewPortNotify({ port: 3000, label: 'dev' })
    expect(handlePreviewPortNotify({ port: 3000, label: 'vite' })).toBe(true)
    expect(addSpy).toHaveBeenCalledTimes(2)
    expect(usePreviewPortStore().label).toBe('vite')
  })

  it('非法端口静默忽略：不入账、不登记', () => {
    const previewPort = usePreviewPortStore()
    expect(handlePreviewPortNotify({ port: 80 })).toBe(false)
    expect(handlePreviewPortNotify({ port: '3000' as unknown as number })).toBe(false)
    expect(handlePreviewPortNotify({})).toBe(false)
    expect(addSpy).not.toHaveBeenCalled()
    expect(previewPort.port).toBeNull()
  })

  it('超长 label 截断到 64 字符（通知/悬浮球展示防炸版）', () => {
    handlePreviewPortNotify({ port: 5173, label: 'x'.repeat(100) })
    expect(usePreviewPortStore().label).toHaveLength(64)
  })

  it('指纹表封顶（200）逐出最早：长会话无界防线，被逐出端口可重新入账', () => {
    // 201 个不同端口上报 → 最早指纹（2000）被逐出
    for (let p = 2000; p <= 2200; p++) {
      expect(handlePreviewPortNotify({ port: p })).toBe(true)
    }
    // 仍在表内的端口去重命中
    expect(handlePreviewPortNotify({ port: 2200 })).toBe(false)
    // 被逐出的最早端口重新入账（不误伤为重复）
    expect(handlePreviewPortNotify({ port: 2000 })).toBe(true)
    expect(addSpy).toHaveBeenCalledTimes(202)
  })

  // —— source=detected 被动探测链（P-20261002-83）——

  it('探测命中（source=detected）→ 弱化文案入账 + store 登记来源', () => {
    const previewPort = usePreviewPortStore()
    expect(handlePreviewPortNotify({ port: 5173, label: 'vite', source: 'detected' })).toBe(true)
    expect(previewPort.port).toBe(5173)
    expect(previewPort.source).toBe('detected')
    expect(addSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: '检测到本地服务 :5173 · vite',
        body: '终端输出识别到服务已就绪，点击直达预览面板',
        action: 'preview',
        actionPayload: '5173',
      })
    )
  })

  it('探测命中无 label → 标题退化为纯端口弱化形态', () => {
    handlePreviewPortNotify({ port: 4174, source: 'detected' })
    expect(addSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '检测到本地服务 :4174' })
    )
    expect(usePreviewPortStore().source).toBe('detected')
  })

  it('agent 实报（无 source）→ 正式文案 + 来源清空', () => {
    handlePreviewPortNotify({ port: 3000, label: 'dev', source: 'detected' })
    handlePreviewPortNotify({ port: 3001, label: 'dev' })
    expect(usePreviewPortStore().source).toBe('')
    expect(addSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '预览端口 :3001 · dev', body: 'agent 上报服务已就绪，点击直达预览面板' })
    )
  })

  it('探测先到、agent 实报后到（同 port+label）→ 样式升级但通知不重复入账', () => {
    const previewPort = usePreviewPortStore()
    handlePreviewPortNotify({ port: 3000, label: 'dev', source: 'detected' })
    expect(handlePreviewPortNotify({ port: 3000, label: 'dev' })).toBe(false)
    expect(addSpy).toHaveBeenCalledTimes(1) // 不重复入账
    expect(previewPort.source).toBe('') // 悬浮球升级为正式上报样式
    expect(previewPort.port).toBe(3000)
  })

  it('agent 实报先到、探测后到（同 port+label）→ 整链跳过，正式样式不被降级', () => {
    const previewPort = usePreviewPortStore()
    handlePreviewPortNotify({ port: 3000, label: 'dev' })
    expect(handlePreviewPortNotify({ port: 3000, label: 'dev', source: 'detected' })).toBe(false)
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(previewPort.source).toBe('')
  })

  it('非 detected 的其它 source 值按 agent 上报处理（服务端标注白名单）', () => {
    handlePreviewPortNotify({ port: 3002, label: 'dev', source: 'spoofed' })
    expect(usePreviewPortStore().source).toBe('')
    expect(addSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: '预览端口 :3002 · dev' })
    )
  })
})

describe('previewPortStore.openInPanel 面板直达', () => {
  beforeEach(() => {
    resetPreviewPortNotifyStateForTest()
    resetPanelLayout()
    openTunnelMock.mockReset()
  })

  it('项目页路由下就地开底部预览面板并交付端口', () => {
    const previewPort = usePreviewPortStore()
    const layout = usePanelLayout()
    previewPort.openInPanel(4173)
    expect(layout.showBottomPanel.value).toBe(true)
    expect(layout.bottomTab.value).toBe('preview')
    expect(previewPort.openPort).toBe(4173)
    // 项目页就地打开：不打跳转意图标
    expect(layout.pendingBottomTab.value).toBeNull()
    // 面板消费后清位：同端口的再次直达可重新触发
    previewPort.consumeOpen()
    expect(previewPort.openPort).toBeNull()
  })

  it('非法端口拒绝开面板', () => {
    const previewPort = usePreviewPortStore()
    const layout = usePanelLayout()
    previewPort.openInPanel(80)
    expect(layout.showBottomPanel.value).toBe(false)
    expect(previewPort.openPort).toBeNull()
  })
})

// —— hostId 远程端口隧道链（P-20261004-5）——

describe('handlePreviewPortNotify 带 hostId 隧道链', () => {
  let addSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetPreviewPortNotifyStateForTest()
    resetPanelLayout()
    addSpy = vi.spyOn(useNotificationStore(), 'add')
    openTunnelMock.mockReset()
  })

  it('hostId 上报 → 立即登记 + 异步开隧道挂映射；直达打开隧道口并带徽标载荷', async () => {
    openTunnelMock.mockResolvedValue({ data: { hostId: 'sc_rh_1', remotePort: 5173, localPort: 40001 } })
    const previewPort = usePreviewPortStore()
    expect(handlePreviewPortNotify({ port: 5173, label: 'vite', hostId: 'sc_rh_1' })).toBe(true)
    // 登记先行（不阻塞通知链），隧道就绪后补挂映射
    expect(previewPort.port).toBe(5173)
    expect(previewPort.tunnel).toBeNull()
    await vi.waitFor(() => expect(previewPort.tunnel).toEqual({ hostId: 'sc_rh_1', remotePort: 5173, localPort: 40001 }))
    expect(openTunnelMock).toHaveBeenCalledWith('sc_rh_1', 5173)
    // 入账仍为原口径（actionPayload = 远端口，消费方经 store 解析映射）
    expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({ actionPayload: '5173' }))

    // 直达：远端口解析为隧道口 + 徽标载荷
    previewPort.openInPanel(5173)
    expect(previewPort.openPort).toBe(40001)
    expect(previewPort.openTunnel).toEqual({ remote: 5173, local: 40001 })
    previewPort.consumeOpen()
    expect(previewPort.openTunnel).toBeNull()
  })

  it('隧道开失败 → 静默降级（映射缺位，直达退化为直开远端端口）', async () => {
    openTunnelMock.mockRejectedValue(new Error('dial boom'))
    const previewPort = usePreviewPortStore()
    expect(handlePreviewPortNotify({ port: 3000, hostId: 'sc_rh_1' })).toBe(true)
    await vi.waitFor(() => expect(openTunnelMock).toHaveBeenCalled())
    // 微任务排空后映射仍未挂
    await Promise.resolve()
    expect(previewPort.tunnel).toBeNull()
    previewPort.openInPanel(3000)
    expect(previewPort.openPort).toBe(3000)
    expect(previewPort.openTunnel).toBeNull()
  })

  it('同 port+label+hostId 去重；本机同号端口与远程上报互不误伤', () => {
    openTunnelMock.mockResolvedValue({ data: { hostId: 'sc_rh_1', remotePort: 3000, localPort: 40002 } })
    expect(handlePreviewPortNotify({ port: 3000, label: 'dev', hostId: 'sc_rh_1' })).toBe(true)
    expect(handlePreviewPortNotify({ port: 3000, label: 'dev', hostId: 'sc_rh_1' })).toBe(false)
    expect(addSpy).toHaveBeenCalledTimes(1)
    // 不同 hostId = 另一台主机的同号服务，视为新上报
    expect(handlePreviewPortNotify({ port: 3000, label: 'dev', hostId: 'sc_rh_2' })).toBe(true)
    expect(addSpy).toHaveBeenCalledTimes(2)
  })

  it('换端口重新上报 → 旧隧道映射失效（映射仅对同端口有效）', async () => {
    openTunnelMock.mockResolvedValue({ data: { hostId: 'sc_rh_1', remotePort: 3000, localPort: 40003 } })
    const previewPort = usePreviewPortStore()
    handlePreviewPortNotify({ port: 3000, hostId: 'sc_rh_1' })
    await vi.waitFor(() => expect(previewPort.tunnel).not.toBeNull())
    handlePreviewPortNotify({ port: 3001 })
    expect(previewPort.tunnel).toBeNull()
    expect(previewPort.port).toBe(3001)
  })
})
