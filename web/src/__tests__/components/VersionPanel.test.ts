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
const proxyStatusMock = vi.hoisted(() => vi.fn())
const settingsGetMock = vi.hoisted(() => vi.fn().mockResolvedValue({ data: {} }))
const settingsUpdateMock = vi.hoisted(() => vi.fn().mockResolvedValue({ data: {} }))
vi.mock('@/api/client', () => ({
  updateApi: {
    check: checkMock,
    apply: applyMock,
    status: statusMock,
    proxyStatus: proxyStatusMock,
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

    // 长 changelog：收起态只出摘要，展开后全量落在限高内滚容器里（P-20261112-2
    // S1），「立即更新」在其后照常可达
    const clBody = wrapper.find('[data-testid="version-changelog-body"]')
    expect(clBody.text()).toContain('change line 0')
    expect(clBody.text()).not.toContain('change line 79')
    await wrapper.find('[data-testid="version-changelog-toggle"]').trigger('click')
    expect(clBody.classes()).toContain('expanded')
    expect(clBody.text()).toContain('change line 79')
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

// 更新内容渲染升级（P-20261112-2 S1）：发布说明 markdown 净化渲染（与 dsh 版本
// 弹层同源 utils/changelogRender）+ 标题行 + 收起摘要/展开全量 + 页内锚点切换；
// 净化策略本体由 utils/changelogRender.test.ts 钉住，这里守面板接线
describe('VersionPanel 更新内容渲染（P-20261112-2 S1）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetNaiveRuntimeMocks()
    checkMock.mockReset()
    applyMock.mockReset()
    statusMock.mockReset()
    statusMock.mockResolvedValue({ data: { status: 'idle', progress: 0, total: 0, version: '' } })
    notificationAdd.mockClear()
  })

  async function mountWithChangelog(changelog: string) {
    checkMock.mockResolvedValue({ data: { currentVersion: '0.0.1', latestVersion: '0.0.2', hasUpdate: true, changelog } })
    const wrapper = mount(VersionPanel, { props: { buildInfo }, attachTo: document.body })
    await flushPromises()
    await findCheckButton(wrapper).trigger('click')
    await flushPromises()
    return wrapper
  }

  const bilingual = [
    '[中文](#中文) | [English](#english)',
    '## 中文',
    '### 新增',
    '- **加粗** 条目',
    '## English',
    '### Added',
    '- **bold** entry',
  ].join('\n\n')

  it('标题行带版本号；收起态为纯文本摘要，不裸露 markdown 标记', async () => {
    const wrapper = await mountWithChangelog(bilingual)
    expect(wrapper.find('[data-testid="version-changelog-title"]').text()).toBe('v0.0.2 更新内容')
    const body = wrapper.find('[data-testid="version-changelog-body"]')
    expect(body.classes()).not.toContain('expanded')
    expect(body.text()).toBe('中文 | English 中文 新增 加粗 条目 English Added bold entry')
    expect(wrapper.find('[data-testid="version-changelog-md"]').exists()).toBe(false)
    const toggle = wrapper.find('[data-testid="version-changelog-toggle"]')
    expect(toggle.text()).toBe('展开完整说明')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  it('展开：markdown 渲染为结构化 html；再点收起回摘要', async () => {
    const wrapper = await mountWithChangelog(bilingual)
    const toggle = wrapper.find('[data-testid="version-changelog-toggle"]')
    await toggle.trigger('click')

    const md = wrapper.find('[data-testid="version-changelog-md"]')
    expect(md.exists()).toBe(true)
    expect(md.findAll('h2').map(h => h.text())).toEqual(['中文', 'English'])
    expect(md.findAll('h3').map(h => h.text())).toEqual(['新增', 'Added'])
    expect(md.findAll('strong').map(h => h.text())).toEqual(['加粗', 'bold'])
    expect(md.findAll('li')).toHaveLength(2)
    expect(md.text()).not.toContain('**')
    expect(md.text()).not.toContain('##')
    // 展开态容器保留限高内滚语义（R11）且可聚焦滚动
    const body = wrapper.find('[data-testid="version-changelog-body"]')
    expect(body.classes()).toContain('expanded')
    expect(body.attributes('tabindex')).toBe('0')
    expect(toggle.text()).toBe('收起')
    expect(toggle.attributes('aria-expanded')).toBe('true')

    await toggle.trigger('click')
    expect(wrapper.find('[data-testid="version-changelog-md"]').exists()).toBe(false)
    expect(body.attributes('tabindex')).toBeUndefined()
    expect(toggle.text()).toBe('展开完整说明')
    wrapper.unmount()
  })

  it('「中文 | English」锚点行：点击在容器内滚到目标小节，不放行默认跳转', async () => {
    const scrollSpy = vi.fn()
    Element.prototype.scrollIntoView = scrollSpy // jsdom 无实现
    const wrapper = await mountWithChangelog(bilingual)
    await wrapper.find('[data-testid="version-changelog-toggle"]').trigger('click')
    const md = wrapper.find('[data-testid="version-changelog-md"]')

    for (const [label, id] of [['English', 'english'], ['中文', '中文']] as const) {
      scrollSpy.mockClear()
      const link = md.findAll('a').find(a => a.text() === label)!
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
      link.element.dispatchEvent(ev)
      expect(ev.defaultPrevented, label).toBe(true)
      expect(scrollSpy).toHaveBeenCalledTimes(1)
      expect(scrollSpy.mock.instances[0]).toBe(md.element.querySelector(`[id="${id}"]`))
    }
    wrapper.unmount()
  })

  it('无锚点行的说明自然降级：不出现切换行，渲染与展开收起照常', async () => {
    const wrapper = await mountWithChangelog('### Added\n\n- item one')
    await wrapper.find('[data-testid="version-changelog-toggle"]').trigger('click')
    const md = wrapper.find('[data-testid="version-changelog-md"]')
    expect(md.findAll('a')).toHaveLength(0)
    expect(md.find('h3').text()).toBe('Added')
    wrapper.unmount()
  })

  it('外部内容净化：脚本与事件处理器不进 DOM（v-html 只吃净化产物）', async () => {
    const wrapper = await mountWithChangelog('hello\n\n<img src="x" onerror="window.__xss = 1">\n\n<script>window.__xss = 1</script>\n\n[x](javascript:alert(1))')
    await wrapper.find('[data-testid="version-changelog-toggle"]').trigger('click')
    const md = wrapper.find('[data-testid="version-changelog-md"]')
    expect(md.find('script').exists()).toBe(false)
    expect(md.find('img').attributes('onerror')).toBeUndefined()
    expect(md.html()).not.toContain('__xss')
    expect(md.html()).not.toContain('javascript:')
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined()
    wrapper.unmount()
  })

  // 「查看发布页」外链（P-20261112-2 S2）：标题行右侧 dsh 弹层同位同款（新窗
  // noopener）；releaseUrl 缺失（旧服务端/源未提供）不渲染零回退
  it('标题行外链：releaseUrl 在位渲染新窗链接，缺失不渲染', async () => {
    checkMock.mockResolvedValue({
      data: {
        currentVersion: '0.0.1', latestVersion: '0.0.2', hasUpdate: true,
        changelog: bilingual,
        releaseUrl: 'https://github.com/owner/repo/releases/tag/v0.0.2',
      },
    })
    const wrapper = mount(VersionPanel, { props: { buildInfo }, attachTo: document.body })
    await flushPromises()
    await findCheckButton(wrapper).trigger('click')
    await flushPromises()

    const link = wrapper.find('[data-testid="version-release-link"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toBe('查看发布页')
    expect(link.attributes('href')).toBe('https://github.com/owner/repo/releases/tag/v0.0.2')
    expect(link.attributes('target')).toBe('_blank')
    expect(link.attributes('rel')).toBe('noopener')
    wrapper.unmount()

    // 缺失：外链不渲染，标题行照常（上方 mountWithChangelog 的响应即无 releaseUrl）
    const without = await mountWithChangelog(bilingual)
    expect(without.find('[data-testid="version-release-link"]').exists()).toBe(false)
    expect(without.find('[data-testid="version-changelog-title"]').text()).toBe('v0.0.2 更新内容')
    without.unmount()
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

  // 面板内三枚开关按模板序：自动检查更新 → 跟进预发布版本 → 自动探测系统代理（S6）
  function switches(wrapper: VueWrapper) {
    const all = wrapper.findAll('[role="switch"]')
    expect(all).toHaveLength(3)
    return { autoCheck: all[0]!, prerelease: all[1]!, autoDetect: all[2]! }
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

// 失败态一键重试（P-20261110-1-S2）：结局块失败态带主按钮，复用 apply 受理
// 端点重新受理（服务端 failed 终态自 Reset）——此前重试须绕回「立即更新」，
// 通知「查看详情」回跳的落点直接可重试（升级链中断恢复形态）；拒因经 store
// 落回原因行（本组件无 message 注入点），「知道了」保持可关闭
describe('VersionPanel 失败态一键重试（P-20261110-1-S2）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetNaiveRuntimeMocks()
    checkMock.mockReset()
    applyMock.mockReset()
    statusMock.mockReset()
    notificationAdd.mockClear()
  })

  it('失败结局块带重试主按钮：点击走 apply 受理，进度块接棒', async () => {
    // 首拉（挂载同步）= 失败快照；受理后的轮询挂起不返回（无跨例泄漏）
    statusMock.mockResolvedValueOnce({ data: { status: 'failed', progress: 0, total: 0, version: '9.9.9', error: 'download failed: download returned 503 (after 3 attempts)' } })
    statusMock.mockReturnValue(new Promise(() => {}))
    applyMock.mockResolvedValue({ message: 'update started', version: '9.9.9' })
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()

    expect(wrapper.find('[data-testid="version-update-outcome-phase"]').text()).toBe('更新失败')
    expect(wrapper.find('[data-testid="version-update-outcome-reason"]').text()).toContain('after 3 attempts')
    const retry = wrapper.find('[data-testid="version-update-retry"]')
    expect(retry.exists()).toBe(true)
    expect(retry.element.disabled).toBe(false)
    // 知道了仍在：重试是首要出口，关闭是次要出口
    expect(wrapper.find('[data-testid="version-update-ack"]').exists()).toBe(true)

    await retry.trigger('click')
    await flushPromises()
    expect(applyMock).toHaveBeenCalledTimes(1)
    expect(applyMock).toHaveBeenCalledWith({ silent: true })
    expect(wrapper.find('[data-testid="version-update-progress"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="version-update-retry"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('重试被拒（npm 形态 409，状态机不承载失败）：拒因落回结局块原因行，不再只剩旧因', async () => {
    statusMock.mockResolvedValueOnce({ data: { status: 'failed', progress: 0, total: 0, version: '9.9.9', error: 'old reason' } })
    const refusal = '更新已拒绝：npm 形态请用 npm 更新'
    applyMock.mockRejectedValueOnce(Object.assign(new Error('npm managed'), { userMessage: refusal }))
    statusMock.mockResolvedValueOnce({ data: { status: 'idle', progress: 0, total: 0, version: '' } })
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()

    await wrapper.find('[data-testid="version-update-retry"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="version-update-outcome"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="version-update-outcome-phase"]').text()).toBe('更新失败')
    expect(wrapper.find('[data-testid="version-update-outcome-reason"]').text()).toBe(`原因：${refusal}`)
    // 关闭出口不因被拒消失
    expect(wrapper.find('[data-testid="version-update-ack"]').exists()).toBe(true)
  })
})

// ─── 以下 P-20261109-9 段（rebase 语义收编：两侧 describe 并存）───

// 系统代理自动探测开关 + 当前生效档位展示（P-20261110-1 S6）：开关默认关、保存走
// 既有设置链且展示态乐观翻转（失败按服务端真值回滚）；档位读 proxy-status（挂载与
// 保存后刷新），端点失败静默降级不阻断面板
describe('VersionPanel 自动探测系统代理（P-20261110-1 S6）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    resetNaiveRuntimeMocks()
    statusMock.mockReset()
    statusMock.mockResolvedValue({ data: { status: 'idle', progress: 0, total: 0, version: '' } })
    settingsGetMock.mockClear()
    settingsGetMock.mockResolvedValue({ data: {} })
    settingsUpdateMock.mockClear()
    proxyStatusMock.mockReset()
    applyAutoCheckSetting.mockClear()
  })

  // 面板内三枚开关按模板序：自动检查更新 → 跟进预发布版本 → 自动探测系统代理
  function switches(wrapper: VueWrapper) {
    const all = wrapper.findAll('[role="switch"]')
    expect(all).toHaveLength(3)
    return { autoCheck: all[0]!, prerelease: all[1]!, autoDetect: all[2]! }
  }

  it('开关默认关：settings 未带字段时不探测档不误开，保存成功翻转并刷新档位', async () => {
    proxyStatusMock.mockResolvedValue({ data: { tier: 'direct', target: 'github.com', autoDetect: false, noProxyMatch: false } })
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    const { autoDetect } = switches(wrapper)
    expect(autoDetect.attributes('aria-checked')).toBe('false')

    await autoDetect.trigger('click')
    await flushPromises()
    expect(settingsUpdateMock).toHaveBeenLastCalledWith({ updateProxyAutoDetect: true })
    expect(autoDetect.attributes('aria-checked')).toBe('true')
    expect(messageMock.success).toHaveBeenCalledWith('自动探测设置已保存')
    // 保存后档位刷新（proxy-status 再拉一次）
    expect(proxyStatusMock).toHaveBeenCalledTimes(2)
  })

  it('档位展示：读 proxy-status 渲染档位名 + 脱敏地址（env 档）', async () => {
    proxyStatusMock.mockResolvedValue({
      data: { tier: 'env', target: 'github.com', proxy: 'http://***@1.2.3.4:8080', autoDetect: true, noProxyMatch: false },
    })
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()

    const tier = wrapper.find('[data-testid="version-proxy-tier"]')
    expect(tier.exists()).toBe(true)
    expect(tier.text()).toBe('当前生效环境变量 · http://***@1.2.3.4:8080')
  })

  it('直连档：只显档位名无地址；sysdetect/显式档各映射对应文案', async () => {
    proxyStatusMock.mockResolvedValue({ data: { tier: 'direct', target: 'github.com', autoDetect: false, noProxyMatch: false } })
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    expect(wrapper.find('[data-testid="version-proxy-tier"]').text()).toBe('当前生效直连')

    proxyStatusMock.mockResolvedValue({ data: { tier: 'sysdetect', target: 'github.com', proxy: 'http://***@127.0.0.1:7890', autoDetect: true, noProxyMatch: false } })
    const wrapper2 = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    expect(wrapper2.find('[data-testid="version-proxy-tier"]').text()).toBe('当前生效系统代理 · http://***@127.0.0.1:7890')

    proxyStatusMock.mockResolvedValue({ data: { tier: 'explicit', target: 'github.com', proxy: 'socks5://***@p.example:1080', autoDetect: true, noProxyMatch: false } })
    const wrapper3 = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    expect(wrapper3.find('[data-testid="version-proxy-tier"]').text()).toBe('当前生效显式代理 · socks5://***@p.example:1080')
  })

  it('端点失败：档位行静默不展示，面板其余功能不受影响', async () => {
    proxyStatusMock.mockRejectedValue(new Error('network down'))
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    expect(wrapper.find('[data-testid="version-proxy-tier"]').exists()).toBe(false)
    // 面板照常：三开关在位
    expect(wrapper.findAll('[role="switch"]')).toHaveLength(3)
  })

  it('保存代理地址成功后：档位跟随刷新', async () => {
    proxyStatusMock.mockResolvedValue({ data: { tier: 'direct', target: 'github.com', autoDetect: false, noProxyMatch: false } })
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    expect(proxyStatusMock).toHaveBeenCalledTimes(1)

    const input = wrapper.find('input[placeholder*="socks5"]')
    await input.setValue('http://127.0.0.1:7890')
    const saveBtn = wrapper.findAll('button').find(b => b.text() === '保存')!
    await saveBtn.trigger('click')
    await flushPromises()
    expect(settingsUpdateMock).toHaveBeenLastCalledWith({ updateProxy: 'http://127.0.0.1:7890' })
    expect(proxyStatusMock).toHaveBeenCalledTimes(2)
  })

  it('保存失败：开关展示态按服务端真值回滚，不发成功提示', async () => {
    const wrapper = mount(VersionPanel, { props: { buildInfo } })
    await flushPromises()
    const { autoDetect } = switches(wrapper)

    settingsUpdateMock.mockRejectedValueOnce(new Error('save failed'))
    settingsGetMock.mockResolvedValueOnce({ data: { updateProxyAutoDetect: false } })
    await autoDetect.trigger('click')
    await flushPromises()
    expect(autoDetect.attributes('aria-checked')).toBe('false')
    expect(messageMock.success).not.toHaveBeenCalled()
  })
})

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
