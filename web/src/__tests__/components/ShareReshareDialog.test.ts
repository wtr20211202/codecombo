import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, type Component } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import ShareReshareDialog from '../../components/share/ShareReshareDialog.vue'
import ShareTtlPicker from '../../components/share/ShareTtlPicker.vue'
import type { ShareInfo } from '../../api/domains/share'
import type { ReshareSubmit } from '../../composables/useShareReshare'

// 重新分享弹层组件测试（P-20261114-3-S1）：两形态断言——①批量行（Paths 非空）
// 模式控件禁用 + 约束说明文案 + 无有效期节（createBatch 无 TTL 参数）；②单路径
// 模式可切实时 + TTL 随模式换档联动（未动随 frozen 30 天 / live 设置默认档，
// 动过跨模式保留）+ 未动不发 ttl（服务端兜底契约）。settingsApi 全量 mock
// （live 侧默认档镜像）；NModal 用渲染函数桩替换（jsdom 下 teleport 挂 body
// 不可查询，且运行时无模板编译器，桩不能用 template 字符串——
// TerminalBroadcastResultPanel 组件测试同款惯例）。
const settingsGet = vi.hoisted(() => vi.fn())
vi.mock('../../api/domains/system', () => ({
  settingsApi: { get: settingsGet },
}))

const NModalStub = defineComponent({
  props: { show: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => (props.show ? h('div', { class: 'modal-stub' }, [slots.default?.(), slots.footer?.()]) : null)
  },
})

function row(overrides: Partial<ShareInfo>): ShareInfo {
  return {
    token: 't1',
    kind: 'file',
    projectId: 'p1',
    projectName: 'demo',
    path: 'docs/a.md',
    name: 'a.md',
    isDir: false,
    size: 10,
    createdAt: '2026-10-01T00:00:00Z',
    ...overrides,
  }
}

const mounted: VueWrapper[] = []

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

async function mountOpened(source: ShareInfo): Promise<VueWrapper> {
  const w = mount(ShareReshareDialog, {
    props: { source, show: false },
    // 桩键双写：naive-ui NModal 内部 name 是 'Modal'（VTU 按 type.name 匹配）
    global: { stubs: { NModal: NModalStub as unknown as Component, Modal: NModalStub as unknown as Component } },
    attachTo: document.body,
  })
  mounted.push(w)
  await w.setProps({ show: true })
  await flush()
  return w
}

beforeEach(() => {
  settingsGet.mockReset()
  settingsGet.mockResolvedValue({ data: { shareDefaultTTL: 'permanent' } })
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
})

describe('ShareReshareDialog 批量行（Paths 非空）', () => {
  it('模式控件禁用 + 批量约束说明 + 无有效期节；确认载荷恒 frozen 且不带 ttl', async () => {
    const w = await mountOpened(row({ frozen: true, path: '', paths: ['docs/a.md', 'notes/b.md'], name: 'a.md +1' }))

    // 沿用提示：批量恒 frozen，提示行在场
    const hint = w.find('[data-testid="share-reshare-mode-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain('模式沿用来源链接：定格快照')

    // 模式单选组禁用：frozen 选中、live/frozen 输入均 disabled（批量禁切）
    const frozenInput = w.find('[data-testid="share-reshare-mode-frozen"] input').element as HTMLInputElement
    const liveInput = w.find('[data-testid="share-reshare-mode-live"] input').element as HTMLInputElement
    expect(frozenInput.checked).toBe(true)
    expect(frozenInput.disabled).toBe(true)
    expect(liveInput.disabled).toBe(true)

    // 约束说明就地标注：不可切实时 + 调整选择集走新建批量
    const note = w.find('[data-testid="share-reshare-batch-note"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('批量分享仅支持定格快照、不可改实时')
    expect(note.text()).toContain('新建批量分享')

    // createBatch 无 TTL 参数：有效期整节不出现
    expect(w.find('[data-testid="share-reshare-ttl-row"]').exists()).toBe(false)

    // 确认：mode 恒 frozen、不带 ttl/expiresAt（服务端 frozen 默认 30 天兜底）
    await w.find('[data-testid="share-reshare-confirm"]').trigger('click')
    const emitted = w.emitted('confirm')
    expect(emitted).toHaveLength(1)
    const submit = emitted![0]![0] as ReshareSubmit
    expect(submit.mode).toBe('frozen')
    expect(submit.ttl).toBeUndefined()
    expect(submit.expiresAt).toBeUndefined()
    // 确认后弹层自关
    expect(w.emitted('update:show')).toEqual([[false]])
    w.unmount()
  })
})

describe('ShareReshareDialog 单路径', () => {
  it('模式可切：沿用提示在场，切实时后提示退场；TTL 随模式换档联动', async () => {
    settingsGet.mockResolvedValue({ data: { shareDefaultTTL: '7d' } })
    const w = await mountOpened(row({ frozen: true }))

    // 打开即沿用来源 frozen：提示 + 未动 TTL 走 frozen 默认 30 天
    expect(w.find('[data-testid="share-reshare-mode-hint"]').text()).toContain('模式沿用来源链接：定格快照')
    expect(w.find('[data-testid="share-reshare-ttl-hint"]').text()).toContain('冻结副本默认保留 30 天')
    const frozenInput = w.find('[data-testid="share-reshare-mode-frozen"] input').element as HTMLInputElement
    const liveInput = w.find('[data-testid="share-reshare-mode-live"] input').element as HTMLInputElement
    expect(frozenInput.checked).toBe(true)
    expect(frozenInput.disabled).toBe(false)
    expect(liveInput.disabled).toBe(false)

    // 切实时：TTL 未动 → 随模式换到 live 侧默认档（settings.shareDefaultTTL 镜像 7 天）
    await w.find('[data-testid="share-reshare-mode-live"] input').setValue(true)
    await flush()
    expect(w.find('[data-testid="share-reshare-mode-hint"]').exists()).toBe(false)
    expect(w.find('[data-testid="share-reshare-ttl-hint"]').text()).toContain('7 天')
    expect(w.find('[data-testid="share-reshare-ttl-hint"]').text()).toContain('可在设置中修改默认值')

    // 切回定格：TTL 又随模式回 frozen 默认 30 天（联动双向）
    await w.find('[data-testid="share-reshare-mode-frozen"] input').setValue(true)
    await flush()
    expect(w.find('[data-testid="share-reshare-ttl-hint"]').text()).toContain('冻结副本默认保留 30 天')
    w.unmount()
  })

  it('live 来源打开：TTL 预选设置默认档；确认未动档位不显式发 ttl（服务端兜底）', async () => {
    settingsGet.mockResolvedValue({ data: { shareDefaultTTL: '1d' } })
    const w = await mountOpened(row({ frozen: false }))

    expect(w.find('[data-testid="share-reshare-mode-hint"]').text()).toContain('模式沿用来源链接：实时视图')
    // 异步拉取的设置默认档已落到预选展示
    await flush()
    expect(w.find('[data-testid="share-reshare-ttl-hint"]').text()).toContain('1 天')

    await w.find('[data-testid="share-reshare-confirm"]').trigger('click')
    const submit = w.emitted('confirm')![0]![0] as ReshareSubmit
    expect(submit.mode).toBe('live')
    expect(submit.ttl).toBeUndefined()
    expect(submit.expiresAt).toBeUndefined()
    expect(submit.viewOnce).toBe(false)
    w.unmount()
  })

  it('主动改档位：载荷携带所选档位且跨模式保留；未动不发字段', async () => {
    const w = await mountOpened(row({ frozen: false }))
    await flush()

    // 经 ShareTtlPicker 事件主动改 7 天（等价于选择器交互）
    w.findComponent(ShareTtlPicker).vm.$emit('update:choice', '7d')
    await flush()
    expect(w.find('[data-testid="share-reshare-ttl-hint"]').text()).toContain('7 天')

    // 改过的档位跨模式切换保留（不随模式回默认）
    await w.find('[data-testid="share-reshare-mode-frozen"] input').setValue(true)
    await flush()
    expect(w.find('[data-testid="share-reshare-ttl-hint"]').text()).not.toContain('冻结副本默认保留 30 天')
    expect(w.find('[data-testid="share-reshare-ttl-hint"]').text()).toContain('7 天')

    await w.find('[data-testid="share-reshare-confirm"]').trigger('click')
    const submit = w.emitted('confirm')![0]![0] as ReshareSubmit
    expect(submit.mode).toBe('frozen')
    expect(submit.ttl).toBe('7d')
    w.unmount()
  })

  it('来源带一次性而切定格：互斥说明就地呈现，载荷不携带一次性（服务端 400 前置规避）', async () => {
    const w = await mountOpened(row({ frozen: false, viewOnce: true }))

    // live 打开：无互斥说明（沿用一次性）
    expect(w.find('[data-testid="share-reshare-viewonce-note"]').exists()).toBe(false)
    await w.find('[data-testid="share-reshare-mode-frozen"] input').setValue(true)
    await flush()
    expect(w.find('[data-testid="share-reshare-viewonce-note"]').exists()).toBe(true)
    expect(w.find('[data-testid="share-reshare-viewonce-note"]').text()).toContain('不携带一次性查看')

    await w.find('[data-testid="share-reshare-confirm"]').trigger('click')
    const submit = w.emitted('confirm')![0]![0] as ReshareSubmit
    expect(submit.mode).toBe('frozen')
    expect(submit.viewOnce).toBe(false)
    w.unmount()
  })

  it('口令超 64 字节（按 UTF-8 字节口径）：错误就地呈现且确认禁用', async () => {
    const w = await mountOpened(row({ frozen: false }))
    const pass = w.find('[data-testid="share-reshare-pass"] input')
    await pass.setValue('口'.repeat(30)) // 90 字节 > 64：字符数远小于 64 的对照组
    await flush()
    expect(w.find('[data-testid="share-reshare-pass-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="share-reshare-pass-error"]').text()).toContain('64 字节')
    expect((w.find('[data-testid="share-reshare-confirm"]').element as HTMLButtonElement).disabled).toBe(true)

    // 回到合法长度：错误退场，确认可用
    await pass.setValue('')
    await flush()
    expect(w.find('[data-testid="share-reshare-pass-error"]').exists()).toBe(false)
    expect((w.find('[data-testid="share-reshare-confirm"]').element as HTMLButtonElement).disabled).toBe(false)
    w.unmount()
  })
})
