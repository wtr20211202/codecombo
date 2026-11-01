import { describe, it, expect, beforeEach } from 'vitest'
import { defineComponent, h, nextTick, type Component } from 'vue'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import ClipboardHistoryPopover from '../../components/common/ClipboardHistoryPopover.vue'
import { useClipboardHistoryStore } from '../../stores/clipboardHistory'

// 剪贴板历史弹层敏感项遮蔽（P-20261005-14，遮蔽家族第三面）：命中 sensitiveMask
// 模式集的条目默认打码 + 弱边框、逐条「显示」揭示（会话级，重开回打码）、pick 恒
// 上抛原文（遮蔽只挡眼睛不挡数据流）。i18n/naive-ui 走 setup.ts 全局 mock（真实
// zh 文案直译）；NModal 用渲染函数桩替换（jsdom 下真实 NModal 经 teleport 挂
// body，wrapper 查询不可达；且运行时无模板编译器，桩不能用 template 字符串——
// InstanceNotifyOverview.test.ts 同款）。遮蔽链不 mock：真实 maskApprovalSecrets
// 对真实 store 条目生效，模式集演进自动流入本测试面。
const NModalStub = defineComponent({
  props: { show: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => (props.show ? h('div', { class: 'modal-stub' }, slots.default?.()) : null)
  },
})

// 命中 ④ 已知前缀（ghp_ + ≥12 值段）：打码形态 = 前缀 + *** + 尾 4
const SECRET = 'deploy with token ghp_abcdefghij123456'
const SECRET_MASKED = 'deploy with token ghp_***3456'
// 普通 条目（路径段无 ≥20 高熵串、无密钥前缀）：零误伤不遮蔽
const PLAIN = 'src/views/Dashboard.vue'

async function mountOpened(): Promise<ReturnType<typeof mount>> {
  const store = useClipboardHistoryStore()
  store.record(PLAIN)
  store.record(SECRET)
  const w = mount(ClipboardHistoryPopover, {
    props: { show: false },
    // naive-ui 组件名实为 Modal（双键同 InstanceNotifyOverview.test.ts 惯例）
    global: { stubs: { NModal: NModalStub as unknown as Component, Modal: NModalStub as unknown as Component } },
  })
  await w.setProps({ show: true })
  await nextTick()
  return w
}

describe('ClipboardHistoryPopover 敏感项遮蔽（P-20261005-14）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('敏感条目默认打码 + 弱边框 + 显示钮；普通条目零误伤', async () => {
    const w = await mountOpened()
    const items = w.findAll('[data-testid="clip-history-item"]')
    expect(items).toHaveLength(2)

    // MRU 在前：最新复制的敏感条目第一位——标题/悬停提示都是打码文
    const secret = items[0]!
    expect(secret.classes()).toContain('clip-history-item-sensitive')
    expect(secret.find('.clip-history-item-texts').text()).toBe(SECRET_MASKED)
    expect(secret.text()).not.toContain('abcdefghij')
    expect(secret.find('.clip-history-item-title').attributes('title')).toBe(SECRET_MASKED)

    // 普通条目原文直显，无遮蔽类与揭示钮
    const plain = items[1]!
    expect(plain.classes()).not.toContain('clip-history-item-sensitive')
    expect(plain.text()).toBe(PLAIN)
    expect(plain.find('[data-testid="clip-history-reveal"]').exists()).toBe(false)
    w.unmount()
  })

  it('逐条揭示可逆：显示→原文可见，隐藏→回打码', async () => {
    const w = await mountOpened()
    const reveal = w.find('[data-testid="clip-history-reveal"]')
    expect(reveal.text()).toBe('显示')

    await reveal.trigger('click')
    await nextTick()
    expect(w.findAll('[data-testid="clip-history-item"]')[0]!.find('.clip-history-item-texts').text()).toBe(SECRET)
    expect(w.find('[data-testid="clip-history-reveal"]').text()).toBe('隐藏')

    await w.find('[data-testid="clip-history-reveal"]').trigger('click')
    await nextTick()
    expect(w.findAll('[data-testid="clip-history-item"]')[0]!.find('.clip-history-item-texts').text()).toBe(SECRET_MASKED)
    w.unmount()
  })

  it('取用原文不变：打码态点选条目 pick 上抛原文（遮蔽不挡数据流）', async () => {
    const w = await mountOpened()
    await w.findAll('[data-testid="clip-history-item"]')[0]!.trigger('click')
    expect(w.emitted('pick')?.[0]).toEqual([SECRET])
    w.unmount()
  })

  it('弹层重开回打码：揭示态是会话级组件内态不跨开关', async () => {
    const w = await mountOpened()
    await w.find('[data-testid="clip-history-reveal"]').trigger('click')
    await nextTick()
    expect(w.findAll('[data-testid="clip-history-item"]')[0]!.find('.clip-history-item-texts').text()).toBe(SECRET)

    await w.setProps({ show: false })
    await w.setProps({ show: true })
    await nextTick()
    expect(w.findAll('[data-testid="clip-history-item"]')[0]!.find('.clip-history-item-texts').text()).toBe(SECRET_MASKED)
    w.unmount()
  })
})
