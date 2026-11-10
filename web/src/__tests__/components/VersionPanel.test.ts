import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper, type DOMWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

// 检查更新「已是最新」态反馈强化（P-20261109-2）组件测试：
// 成功块显著化（回显当前版本）、判断只认后端 hasUpdate（当前高于最新不发假通知）、
// channelEmpty 不渲染成功态、checking 期按钮禁用防连点。
// naive-ui 走一站式 mock 工厂（message 记录器，NIcon/NTooltip/NSwitch 真值保留）；
// vue-i18n 用 setup.ts 全局 mock（zh 文案直译 + 命名插值），断言可直接对文案。

vi.mock('naive-ui', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()),
)

const checkMock = vi.hoisted(() => vi.fn())
const applyMock = vi.hoisted(() => vi.fn())
const statusMock = vi.hoisted(() => vi.fn())
const settingsGetMock = vi.hoisted(() => vi.fn().mockResolvedValue({ data: {} }))
const settingsUpdateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ data: {} }))
vi.mock('@/api/client', () => ({
  updateApi: {
    check: checkMock,
    apply: applyMock,
    status: statusMock,
    clearStatus: vi.fn(),
    restart: vi.fn(),
    healthPing: vi.fn(),
  },
  settingsApi: {
    get: settingsGetMock,
    update: settingsUpdateMock,
  },
}))

// 前端自动检查电路 store 桩（P-20261109-6）：只观察「自动检查更新」开关保存后的
// 同帧应用（门控本体由 stores/updateCheck.test.ts 覆盖）
const applyAutoCheckSetting = vi.hoisted(() => vi.fn())
vi.mock('@/stores/updateCheck', () => ({
  useUpdateCheckStore: () => ({ applyAutoCheckSetting }),
}))

// 更新进度 store（P-20261109-10）的轮询环在锁定态下只排程不发请求——桩成
// 锁定，组件测试只观察「受理 / 挂载同步」两个入口，不被后台轮询扰动调用计数
vi.mock('@/stores/lock', () => ({
  useLockStore: () => ({ isLocked: true }),
}))

// 通知中心 store 桩：只观察 add 载荷（「已是最新」不得入通知中心）
const notificationAdd = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/stores/notification', () => ({
  useNotificationStore: () => ({ add: notificationAdd }),
}))

import VersionPanel from '../../components/home/VersionPanel.vue'
import { messageMock, resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'

const buildInfo = {
  version: '0.0.1',
  commit: 'abcdef1234567',
  buildTime: '2026-11-09T00:00:00Z',
  goVersion: 'go1.24',
  platform: 'linux/amd64',
}

// 检查按钮的三态文案（setup.ts 的 t 直译 zh-CN 文案）
const CHECK_LABELS = ['检查更新', '重新检查', '检查中…']

function findCheckButton(wrapper: VueWrapper): DOMWrapper<HTMLButtonElement> {
  const btn = wrapper.findAll('button').find(b => CHECK_LABELS.includes(b.text()))
  if (!btn) throw new Error('check button not found')
  return btn as DOMWrapper<HTMLButtonElement>
}

// shouldShowToast 的 5s 去重窗为模块级状态，跨用例共享——钉住 Date.now，
// 每例从互不相干的时间基点起跑，杜绝前例的放行记录把后例吞掉
let clock = 1_000_000
let nowSpy: ReturnType<typeof vi.spyOn>

describe('VersionPanel 检查更新反馈（P-20261109-2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetNaiveRuntimeMocks()
    checkMock.mockReset()
    applyMock.mockReset()
    statusMock.mockReset()
    notificationAdd.mockClear()
    clock += 60_000
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })

  afterEach(() => {
    nowSpy.mockRestore()
  })

  it('已是最新：成功块回显版本号，手动 toast 去重窗内只出一次且不入通知中心', async () => {
    checkMock.mockResolvedValue({ data: { currentVersion: '0.0.1', latestVersion: '0.0.1', hasUpdate: false } })
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()

    await findCheckButton(wrapper).trigger('click')
    await flushPromises()

    const text = wrapper.find('.version-uptodate-text')
    expect(text.exists()).toBe(true)
    expect(text.text()).toBe('已是最新版本（v0.0.1）')
    // 成功块带对勾图标（图形化成功终态，而非单行灰字）
    expect(wrapper.find('.version-uptodate-icon').exists()).toBe(true)
    expect(messageMock.success).toHaveBeenCalledTimes(1)
    expect(messageMock.success).toHaveBeenCalledWith('已是最新版本')

    // 5s 窗内再查一次：面板照常刷新，toast 不叠加
    await findCheckButton(wrapper).trigger('click')
    await flushPromises()
    expect(checkMock).toHaveBeenCalledTimes(2)
    expect(messageMock.success).toHaveBeenCalledTimes(1)

    // 「已是最新」不入通知中心、不点亮外层版本号绿点
    expect(notificationAdd).not.toHaveBeenCalled()
    expect(wrapper.emitted('update-detected')).toBeUndefined()
  })

  it('当前版本高于最新：不发「发现新版本」通知，成功块回显当前版本而非更旧的 latest', async () => {
    // dev 构建领先官方 tag：字符串不等但后端 semver 判定无更新
    checkMock.mockResolvedValue({ data: { currentVersion: '0.0.9', latestVersion: '0.0.1', hasUpdate: false } })
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()

    await findCheckButton(wrapper).trigger('click')
    await flushPromises()

    expect(notificationAdd).not.toHaveBeenCalled()
    expect(wrapper.emitted('update-detected')).toBeUndefined()
    expect(wrapper.find('.version-uptodate-text').text()).toBe('已是最新版本（v0.0.9）')
    // 「立即更新」区不得出现
    expect(wrapper.find('.panel-btn.primary').exists()).toBe(false)
  })

  it('channelEmpty：不渲染「已是最新」成功块，改走通道提示 toast', async () => {
    checkMock.mockResolvedValue({ data: { currentVersion: '0.0.1', hasUpdate: false, channelEmpty: true } })
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()

    await findCheckButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.find('.version-uptodate').exists()).toBe(false)
    expect(messageMock.info).toHaveBeenCalledTimes(1)
    expect(messageMock.success).not.toHaveBeenCalled()
    // 未入状态机：按钮仍是首查文案
    expect(findCheckButton(wrapper).text()).toBe('检查更新')
  })

  it('checking 期按钮禁用并显示「检查中…」，连点不发并发请求；返回后恢复', async () => {
    let resolveCheck: (v: unknown) => void = () => {}
    checkMock.mockImplementation(() => new Promise((resolve) => { resolveCheck = resolve }))
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()

    const btn = findCheckButton(wrapper)
    await btn.trigger('click')
    expect(btn.element.disabled).toBe(true)
    expect(btn.text()).toBe('检查中…')

    // 请求在途时再点：既有禁用态又有函数内重入守卫，只发一次请求
    await btn.trigger('click')
    expect(checkMock).toHaveBeenCalledTimes(1)

    resolveCheck({ data: { currentVersion: '0.0.1', latestVersion: '0.0.1', hasUpdate: false } })
    await flushPromises()
    expect(btn.element.disabled).toBe(false)
    expect(btn.text()).toBe('重新检查')
  })
})

// 更新进度可见性（P-20261109-10）：面板消费全局 updateProgress store——受理后
// 进度块就地出现、「立即更新」不可再点（在途 409 前端静默的误可点洞）、开始
// 通知不由前端入账（服务端单一发射）；挂载即同步，服务端在途（F5/他页/CLI
// 发起）进度恢复；长 changelog 限高内滚，操作区首屏可达
describe('VersionPanel 更新进度（P-20261109-10）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetNaiveRuntimeMocks()
    checkMock.mockReset()
    applyMock.mockReset()
    statusMock.mockReset()
    notificationAdd.mockClear()
  })

  const longChangelog = Array.from({ length: 80 }, (_, i) => `- change line ${i}`).join('\n')

  it('立即更新：受理后进度块出现、按钮隐去，开始通知不由前端入账', async () => {
    statusMock.mockResolvedValue({ data: { status: 'idle', progress: 0, total: 0, version: '' } })
    checkMock.mockResolvedValue({ data: { currentVersion: '0.0.1', latestVersion: '0.0.2', hasUpdate: true, changelog: longChangelog } })
    applyMock.mockResolvedValue({ message: 'update started', version: '0.0.2' })
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    await findCheckButton(wrapper).trigger('click')
    await flushPromises()

    // 长 changelog 落在限高内滚容器里，「立即更新」在其后照常可达
    expect(wrapper.find('[data-testid="version-changelog-body"]').text()).toContain('change line 79')
    const updateNow = wrapper.find('[data-testid="version-update-now"]')
    expect(updateNow.exists()).toBe(true)
    notificationAdd.mockClear() // 「发现新版本」通知属检查面，此后只观察更新链

    await updateNow.trigger('click')
    await flushPromises()
    expect(applyMock).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="version-update-progress"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="version-update-phase"]').text()).toBe('下载中')
    expect(wrapper.find('[data-testid="version-update-now"]').exists()).toBe(false)
    expect(notificationAdd).not.toHaveBeenCalled()
  })

  it('挂载同步：服务端在途即接管，进度与字节明细恢复（F5/关面板重开）', async () => {
    statusMock.mockResolvedValue({ data: { status: 'downloading', progress: 40 * 1024 * 1024, total: 100 * 1024 * 1024, version: '0.0.2' } })
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    expect(wrapper.find('[data-testid="version-update-phase"]').text()).toBe('下载中')
    expect(wrapper.find('[data-testid="version-update-bytes"]').text()).toBe('40%（40.0 MB / 100.0 MB）')
    // 在途：检查按钮与「立即更新」都不出现（防 409 误点）
    expect(wrapper.findAll('button').some(b => CHECK_LABELS.includes(b.text()))).toBe(false)
  })

  it('挂载同步到上次失败：结局块回显原因，知道了确认已读', async () => {
    statusMock.mockResolvedValue({ data: { status: 'failed', progress: 0, total: 0, version: '0.0.2', error: 'update verification failed: checksum mismatch' } })
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    expect(wrapper.find('[data-testid="version-update-outcome-phase"]').text()).toBe('更新失败')
    expect(wrapper.find('[data-testid="version-update-outcome-reason"]').text()).toBe('原因：update verification failed: checksum mismatch')
  })
})

// 「自动检查更新」开关（P-20261109-6）：保存成功即同帧应用到前端 6h 自动检查电路
// （关=停表、开=重新起表），开关展示态乐观翻转——n-switch 以 :value 受控，此前
// 不回写展示态，保存成功后开关仍停在旧位、再点又提交同一值（关掉后界面开不回来）；
// 失败按服务端真值回滚且不应用。预发布开关同一缺陷顺带修复
describe('VersionPanel 自动检查更新开关（P-20261109-6）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetNaiveRuntimeMocks()
    statusMock.mockReset()
    statusMock.mockResolvedValue({ data: { status: 'idle', progress: 0, total: 0, version: '' } })
    settingsGetMock.mockClear()
    settingsUpdateMock.mockClear()
    applyAutoCheckSetting.mockClear()
  })

  // 面板内两枚开关按模板序：自动检查更新 → 跟进预发布版本
  function switches(wrapper: VueWrapper) {
    const all = wrapper.findAll('[role="switch"]')
    expect(all).toHaveLength(2)
    return { autoCheck: all[0]!, prerelease: all[1]! }
  }

  it('保存成功：展示态翻转 + 同帧应用到自动检查电路，关掉后可再开回', async () => {
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    const { autoCheck } = switches(wrapper)
    expect(autoCheck.attributes('aria-checked')).toBe('true')

    await autoCheck.trigger('click')
    await flushPromises()
    expect(settingsUpdateMock).toHaveBeenLastCalledWith({ updateChecks: false })
    expect(autoCheck.attributes('aria-checked')).toBe('false')
    expect(applyAutoCheckSetting).toHaveBeenLastCalledWith(false)
    expect(messageMock.success).toHaveBeenCalledWith('自动检查更新设置已保存')

    await autoCheck.trigger('click')
    await flushPromises()
    expect(settingsUpdateMock).toHaveBeenLastCalledWith({ updateChecks: true })
    expect(autoCheck.attributes('aria-checked')).toBe('true')
    expect(applyAutoCheckSetting).toHaveBeenLastCalledWith(true)
    expect(applyAutoCheckSetting).toHaveBeenCalledTimes(2)
  })

  it('保存失败：按服务端真值回滚展示态，不应用到自动检查电路', async () => {
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    const { autoCheck } = switches(wrapper)

    settingsUpdateMock.mockRejectedValueOnce(new Error('save failed'))
    settingsGetMock.mockResolvedValueOnce({ data: { updateChecks: true } })
    await autoCheck.trigger('click')
    await flushPromises()
    expect(autoCheck.attributes('aria-checked')).toBe('true')
    expect(applyAutoCheckSetting).not.toHaveBeenCalled()
    expect(messageMock.success).not.toHaveBeenCalled()
  })

  it('读到服务端已关：开关展示为关（缺字段=旧服务端视为开，口径同 store）', async () => {
    settingsGetMock.mockResolvedValueOnce({ data: { updateChecks: false } })
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    expect(switches(wrapper).autoCheck.attributes('aria-checked')).toBe('false')
  })

  it('预发布开关同款：保存成功展示态翻转（不经自动检查电路）', async () => {
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    const { prerelease } = switches(wrapper)
    expect(prerelease.attributes('aria-checked')).toBe('false')

    await prerelease.trigger('click')
    await flushPromises()
    expect(settingsUpdateMock).toHaveBeenLastCalledWith({ updateChannel: 'prerelease' })
    expect(prerelease.attributes('aria-checked')).toBe('true')
    expect(applyAutoCheckSetting).not.toHaveBeenCalled()
  })

})

// ─── 以下 P-20261109-9 段（rebase 语义收编：两侧 describe 并存）───

// 伴随校验资产拉取失败旗标（P-20261109-9）：后端检查判定此刻更新必被校验拒绝时
// 置 companionFetchFailed + 逐资产原因——面板即时告警，「立即更新」保持可点
//（否决置灰：点击后端受理前先 skipCache 重拉，瞬时失败不该伪装成不可用）。
// 与 09-10 异步受理共存：发起走 progress.start（silent，被拒反馈由面板自出），
// 拒绝（伴随重拉仍失败 500 / npm 409 等）同步返回带本地化 userMessage；
// 锁定桩下轮询环只排程不发请求，被拒路径不会被后台轮询扰动调用计数
describe('VersionPanel 伴随校验资产告警（P-20261109-9）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetNaiveRuntimeMocks()
    checkMock.mockReset()
    applyMock.mockReset()
    statusMock.mockReset()
    notificationAdd.mockClear()
    clock += 60_000
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })

  afterEach(() => {
    nowSpy.mockRestore()
  })

  const flagged = (reason: string) => ({
    data: {
      currentVersion: '0.0.1',
      latestVersion: '0.0.2',
      hasUpdate: true,
      companionFetchFailed: true,
      companionFetchError: reason,
    },
  })

  async function mountChecked(first: unknown) {
    checkMock.mockResolvedValueOnce(first)
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    await findCheckButton(wrapper).trigger('click')
    await flushPromises()
    return wrapper
  }

  it('旗标置位：告警块带逐资产原因，「立即更新」在场且可点', async () => {
    const wrapper = await mountChecked(flagged('checksum: status 503 (after 3 attempts)'))

    const warn = wrapper.find('.version-companion-warn')
    expect(warn.exists()).toBe(true)
    expect(warn.attributes('role')).toBe('alert')
    expect(warn.text()).toContain('此刻更新将被拒')
    expect(wrapper.find('.version-companion-warn-reason').text())
      .toBe('原因：checksum: status 503 (after 3 attempts)')

    const updateBtn = wrapper.find('[data-testid="version-update-now"]')
    expect(updateBtn.exists()).toBe(true)
    expect(updateBtn.element.disabled).toBe(false)
    // 仍是「发现新版本」：通知照发（新版本确实存在，只是此刻取不到校验资产）
    expect(wrapper.emitted('update-detected')?.[0]).toEqual(['0.0.2'])
  })

  it('点击更新被拒后：面板自出本地化拒绝 toast（silent 发起，store 透传）+ 静默同步告警原因，不重复「发现新版本」通知', async () => {
    const wrapper = await mountChecked(flagged('checksum: stale reason'))
    expect(notificationAdd).toHaveBeenCalledTimes(1)

    // 拦截器（silent 也照算）给出的本地化 userMessage 随 AppError 回到调用方
    const refusal = '更新已拒绝：伴随校验资产（.sha256/.sig）在发布中但未能取到（checksum: dial tcp: i/o timeout）'
    applyMock.mockRejectedValueOnce(Object.assign(new Error('raw'), { userMessage: refusal }))
    checkMock.mockResolvedValueOnce(flagged('checksum: dial tcp: i/o timeout (after 3 attempts)'))
    await wrapper.find('[data-testid="version-update-now"]').trigger('click')
    await flushPromises()

    // silent 发起：首页/设置入口无拦截器 toast，被拒反馈由面板自出（不双弹）
    expect(applyMock).toHaveBeenCalledWith({ silent: true })
    expect(messageMock.error).toHaveBeenCalledTimes(1)
    expect(messageMock.error.mock.calls[0][0]).toBe(refusal)
    // 静默同步走 silent 检查
    expect(checkMock).toHaveBeenLastCalledWith({ silent: true })
    expect(wrapper.find('.version-companion-warn-reason').text())
      .toBe('原因：checksum: dial tcp: i/o timeout (after 3 attempts)')
    // 按钮仍可点（可再试），通知没有因同步而重复
    expect(wrapper.find<HTMLButtonElement>('[data-testid="version-update-now"]').element.disabled).toBe(false)
    expect(notificationAdd).toHaveBeenCalledTimes(1)
  })

  it('被拒错误无本地化文案（网络层等）：兜底「更新失败」', async () => {
    const wrapper = await mountChecked(flagged('checksum: x'))
    applyMock.mockRejectedValueOnce(new Error('Network Error'))
    await wrapper.find('[data-testid="version-update-now"]').trigger('click')
    await flushPromises()
    expect(messageMock.error.mock.calls[0][0]).toBe('更新失败')
  })

  it('受理成功：进度块就地出现，告警块随 canStartUpdate 隐藏（开始通知仍不由前端入账）', async () => {
    const wrapper = await mountChecked(flagged('checksum: transient'))
    applyMock.mockResolvedValueOnce({ message: 'update started', version: '0.0.2' })
    // 状态轮询挂起不返回：停在进行中态，且不续排真实定时器（无跨例泄漏）
    statusMock.mockReturnValueOnce(new Promise(() => {}))

    await wrapper.find('[data-testid="version-update-now"]').trigger('click')
    await flushPromises()

    expect(statusMock).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.version-companion-warn').exists()).toBe(false)
    expect(wrapper.find('[data-testid="version-update-progress"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('apply 在途（受理前重拉中）：按钮禁用并显示「更新中…」，连点只发一次；被拒后恢复可点', async () => {
    const wrapper = await mountChecked(flagged('checksum: transient'))
    let rejectApply: (e: unknown) => void = () => {}
    applyMock.mockImplementationOnce(() => new Promise((_, reject) => { rejectApply = reject }))
    checkMock.mockResolvedValueOnce(flagged('checksum: transient'))

    const btn = wrapper.find<HTMLButtonElement>('[data-testid="version-update-now"]')
    await btn.trigger('click')
    expect(btn.element.disabled).toBe(true)
    expect(btn.text()).toBe('更新中…')
    await btn.trigger('click')
    expect(applyMock).toHaveBeenCalledTimes(1)

    rejectApply(Object.assign(new Error('refused'), { userMessage: '更新已拒绝' }))
    await flushPromises()
    expect(btn.element.disabled).toBe(false)
    expect(btn.text()).toBe('立即更新')
  })

  it('有更新但无旗标：不渲染告警块', async () => {
    const wrapper = await mountChecked({
      data: { currentVersion: '0.0.1', latestVersion: '0.0.2', hasUpdate: true },
    })
    expect(wrapper.find('[data-testid="version-update-now"]').exists()).toBe(true)
    expect(wrapper.find('.version-companion-warn').exists()).toBe(false)
  })
})
