import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, type Component } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import ShareCreateDialog from '../../components/share/ShareCreateDialog.vue'
import { useShareDialog } from '../../composables/useShareDialog'

// 分享创建弹层组件测试（P-20261114-3-S1）：批量区块的服务端约束句披露——
// 批量目标打开时「批量多路径仅支持定格快照」就地可见且无模式单选；单路径
// 目标仍是模式单选面。useShareDialog 单例状态驱开（createShare/createShareBatch
// 是生产入口）；settingsApi/体积预估 probe 全量 mock；NModal 用渲染函数桩替换
//（jsdom 下 teleport 挂 body 不可查询——TerminalBroadcastResultPanel 同款惯例）。
const settingsGet = vi.hoisted(() => vi.fn())
vi.mock('../../api/domains/system', () => ({
  settingsApi: { get: settingsGet },
}))
const probe = vi.hoisted(() => vi.fn())
vi.mock('../../api/client', () => ({
  projectApi: { filesArchiveProbe: probe },
}))

const NModalStub = defineComponent({
  props: { show: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => (props.show ? h('div', { class: 'modal-stub' }, [slots.default?.(), slots.footer?.()]) : null)
  },
})

const mounted: VueWrapper[] = []

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

async function mountOpened(): Promise<VueWrapper> {
  const w = mount(ShareCreateDialog, {
    // 桩键双写：naive-ui NModal 内部 name 是 'Modal'（VTU 按 type.name 匹配）
    global: { stubs: { NModal: NModalStub as unknown as Component, Modal: NModalStub as unknown as Component } },
    attachTo: document.body,
  })
  mounted.push(w)
  await flush()
  return w
}

beforeEach(() => {
  settingsGet.mockReset()
  settingsGet.mockResolvedValue({ data: { shareDefaultTTL: 'permanent' } })
  probe.mockReset()
  probe.mockResolvedValue({ data: { entries: 3, bytes: 120, truncated: false } })
})

afterEach(() => {
  // 单例弹层状态收场（showCreate 复位），不影响下一用例从干净开态驱动
  const { cancelCreate } = useShareDialog()
  cancelCreate()
  while (mounted.length) mounted.pop()!.unmount()
})

describe('ShareCreateDialog 批量区块服务端约束披露（P-20261114-3-S1）', () => {
  it('批量目标：约束句就地可见，且无模式单选（批量仅定格）', async () => {
    const dlg = useShareDialog()
    dlg.createShareBatch('p1', ['docs/a.md', 'notes/b.md', 'src/c.ts'])
    const w = await mountOpened()

    const batchMode = w.find('[data-testid="share-batch-mode"]')
    expect(batchMode.exists()).toBe(true)
    // 冻结语义披露在场（既有文案）
    expect(batchMode.text()).toContain('多文件分享使用冻结快照')
    // 服务端约束句（P-20261114-3-S1 新增）：创建前讲明批量不可切实时
    const onlyNote = w.find('[data-testid="share-batch-frozen-only"]')
    expect(onlyNote.exists()).toBe(true)
    expect(onlyNote.text()).toContain('服务端约束')
    expect(onlyNote.text()).toContain('仅支持定格快照')
    expect(onlyNote.text()).toContain('不可改为实时视图')
    // 批量形态本就以静态说明替代模式单选
    expect(w.find('[data-testid="share-mode-group"]').exists()).toBe(false)
    w.unmount()
  })

  it('单路径目标：模式单选面在场，无批量区块与约束句', async () => {
    const dlg = useShareDialog()
    dlg.createShare('p1', 'docs/a.md', 'a.md')
    const w = await mountOpened()

    expect(w.find('[data-testid="share-mode-group"]').exists()).toBe(true)
    expect(w.find('[data-testid="share-mode-live"]').exists()).toBe(true)
    expect(w.find('[data-testid="share-mode-frozen"]').exists()).toBe(true)
    expect(w.find('[data-testid="share-batch-mode"]').exists()).toBe(false)
    expect(w.find('[data-testid="share-batch-frozen-only"]').exists()).toBe(false)
    w.unmount()
  })
})
