import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'

// 版本面板更新进度块组件测试——聚焦 S4 断点续传透出（P-20261110-1-S4）：下载中态
// 「已续传 xxMB」标记的显隐（resumedBytes>0 且下载阶段才显；全量会话/服务端省略
// /非下载阶段不显）与字节明细同源、分母不因续传起点失真。store 全链路在
// stores/updateProgress.test.ts，徽标在 UpdateProgressBadge.test.ts。
// vue-i18n 用 setup.ts 全局 mock（zh 文案直译 + 命名插值），断言直对文案。

vi.mock('@/api/client', () => ({
  updateApi: { apply: vi.fn(), status: vi.fn(), clearStatus: vi.fn() },
}))
vi.mock('@/stores/lock', () => ({ useLockStore: () => ({ isLocked: true }) }))

const openVersionPanel = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('@/utils/openSettings', () => ({ openVersionPanel }))

import UpdateProgressBlock from '../../components/home/UpdateProgressBlock.vue'
import { useUpdateProgressStore } from '../../stores/updateProgress'

const MB = 1024 * 1024

describe('UpdateProgressBlock 续传透出（P-20261110-1-S4）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    openVersionPanel.mockClear()
  })

  it('续传会话：字节明细旁显「已续传 xxMB」，百分比分母仍为总长', async () => {
    const store = useUpdateProgressStore()
    store.tracking = true
    store.snapshot = { status: 'downloading', progress: 60 * MB, total: 100 * MB, version: '9.9.9', resumedBytes: 40 * MB }
    const wrapper = mount(UpdateProgressBlock)
    await nextTick()
    const resumed = wrapper.find('[data-testid="version-update-resumed"]')
    expect(resumed.exists()).toBe(true)
    expect(resumed.text()).toBe('已续传 40.0 MB')
    // 分母口径：60MB/100MB = 60%——分母是总长，不把续传起点加进分子分母（否则 >100%）
    expect(wrapper.find('[data-testid="version-update-bytes"]').text()).toContain('60%')
  })

  it('全量会话（快照无 resumedBytes）：不显续传标记', async () => {
    const store = useUpdateProgressStore()
    store.tracking = true
    store.snapshot = { status: 'downloading', progress: 30 * MB, total: 100 * MB, version: '9.9.9' }
    const wrapper = mount(UpdateProgressBlock)
    await nextTick()
    expect(wrapper.find('[data-testid="version-update-resumed"]').exists()).toBe(false)
  })

  it('resumedBytes=0（服务端全量回退归 0 后省略）：不显续传标记', async () => {
    const store = useUpdateProgressStore()
    store.tracking = true
    store.snapshot = { status: 'downloading', progress: 30 * MB, total: 100 * MB, version: '9.9.9', resumedBytes: 0 }
    const wrapper = mount(UpdateProgressBlock)
    await nextTick()
    expect(wrapper.find('[data-testid="version-update-resumed"]').exists()).toBe(false)
  })

  it('非下载阶段（校验中）：字节明细与续传标记一并隐去', async () => {
    const store = useUpdateProgressStore()
    store.tracking = true
    store.snapshot = { status: 'verifying', progress: 100 * MB, total: 100 * MB, version: '9.9.9', resumedBytes: 40 * MB }
    const wrapper = mount(UpdateProgressBlock)
    await nextTick()
    expect(wrapper.find('[data-testid="version-update-bytes"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="version-update-resumed"]').exists()).toBe(false)
  })
})

// unknown 结局「仍为旧版本」明示（P-20261122-5）：服务可达且运行旧版本=更新未
// 完成（用户 mac 实测案的结局收口面）——明示文案带旧版本号 + 发布页手动升级
// 外链（noopener 红线）；不可达（serverSeen=false）回落通用文案不误报
describe('UpdateProgressBlock unknown 结局明示（P-20261122-5）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    openVersionPanel.mockClear()
  })

  function mountUnknown(serverSeen: boolean) {
    const store = useUpdateProgressStore()
    store.outcome = { phase: 'unknown', version: '0.0.1-beta.9', error: '', at: '', serverSeen }
    store.snapshot = { status: 'idle', progress: 0, total: 0, version: '0.0.1-beta.9', buildVersion: '0.0.1-beta.8' }
    return mount(UpdateProgressBlock)
  }

  it('服务可达且版本<目标：明示「更新未完成仍为旧版本」+手动升级外链', async () => {
    const wrapper = mountUnknown(true)
    await nextTick()
    const stillOld = wrapper.find('[data-testid="version-update-unknown-still-old"]')
    expect(stillOld.exists()).toBe(true)
    expect(stillOld.text()).toContain('更新未完成')
    expect(stillOld.text()).toContain('0.0.1-beta.8')
    const link = wrapper.find('[data-testid="version-update-manual-link"]')
    expect(link.exists()).toBe(true)
    expect(link.attributes('href')).toBe('https://github.com/wtr20211202/codecombo/releases')
    expect(link.attributes('rel')).toBe('noopener')
    // 明示形态取代通用文案
    expect(wrapper.text()).not.toContain('服务长时间未恢复')
  })

  it('不可达（serverSeen=false）：回落通用 unknownHint 文案，不出外链', async () => {
    const wrapper = mountUnknown(false)
    await nextTick()
    expect(wrapper.find('[data-testid="version-update-unknown-still-old"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="version-update-manual-link"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('服务长时间未恢复')
  })

  it('旧服务端不带 buildVersion（快照缺字段）：回落通用文案', async () => {
    const store = useUpdateProgressStore()
    store.outcome = { phase: 'unknown', version: '0.0.1-beta.9', error: '', at: '', serverSeen: true }
    store.snapshot = { status: 'idle', progress: 0, total: 0, version: '0.0.1-beta.9' }
    const wrapper = mount(UpdateProgressBlock)
    await nextTick()
    expect(wrapper.find('[data-testid="version-update-unknown-still-old"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('服务长时间未恢复')
  })
})
