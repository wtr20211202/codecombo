import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { mount } from '@vue/test-utils'
import NotesSidebar from '../../views/notes/NotesSidebar.vue'
import type { MultiNoteMeta } from '../../api/client'
import type { NotesEngine } from '../../composables/useNotesMulti'

// 侧栏标签过滤交互（P-20261112-7 S3）组件级单测：
// 钉住「行内徽记点击 → setTagFilter（.stop 不触发行 select）」「过滤态胶囊显隐
// 与 x 清除 → clearTagFilter」「过滤语境空态文案」的呈现面契约。数据面（清单
// 拉取拼装/幂等/清单同步）在 useNotesMulti.test.ts 引擎层钉住——这里用轻量
// 引擎形状桩（组件只消费 refs 与动作函数），文案走 setup.ts 真实 zh 文案直译。

function meta(id: string, title: string, tags?: string[]): MultiNoteMeta {
  return { id, title, updatedAt: '2026-11-13T10:00:00Z', size: 10, ...(tags?.length ? { tags } : {}) }
}

/** 引擎形状桩（NotesSidebar 消费面：notes/trash/tagFilter/activeId + 动作函数） */
function makeEngine(opts: {
  notes?: MultiNoteMeta[]
  tagFilter?: string
} = {}) {
  return {
    notes: ref(opts.notes ?? [
      meta('n1', '交接篇', ['alpha', 'beta']),
      meta('n2', '另一篇', ['gamma']),
      meta('n3', '无标签篇'),
    ]),
    trash: ref([]),
    tagFilter: ref(opts.tagFilter ?? ''),
    activeId: ref('n1'),
    select: vi.fn(async () => {}),
    createNote: vi.fn(async () => null),
    renameNote: vi.fn(async () => true),
    trashNote: vi.fn(async () => {}),
    restoreNote: vi.fn(async () => {}),
    purgeNote: vi.fn(async () => {}),
    setTagFilter: vi.fn(async () => {}),
    clearTagFilter: vi.fn(async () => {}),
    loadTrash: vi.fn(async () => {}),
  } as unknown as NotesEngine
}

function mountSidebar(engine: NotesEngine) {
  return mount(NotesSidebar, { props: { notes: engine } })
}

describe('NotesSidebar 标签过滤（P-20261112-7 S3）', () => {
  it('行内标签徽记：每标签一枚可点徽记（title=全名），点击转 setTagFilter 且不触发行 select', async () => {
    const engine = makeEngine()
    const wrapper = mountSidebar(engine)

    const badges = wrapper.findAll('[data-testid="notes-list-tag"]')
    expect(badges.map(b => b.text())).toEqual(['alpha', 'beta', 'gamma']) // 无标签篇不渲染徽记容器
    // title 提示全名（截断友好语境：侧栏宽可调，拖宽即见全名）
    expect(badges[0]?.attributes('title')).toBe('alpha')

    await badges[1]!.trigger('click')
    expect(engine.setTagFilter).toHaveBeenCalledWith('beta')
    expect(engine.select).not.toHaveBeenCalled() // @click.stop：过滤意图不切篇
  })

  it('过滤态胶囊：tagFilter 非空才渲染（含过滤值），点 x 转 clearTagFilter；无过滤不渲染', async () => {
    const engine = makeEngine({ tagFilter: 'alpha' })
    const wrapper = mountSidebar(engine)

    const pill = wrapper.find('[data-testid="notes-tag-filter"]')
    expect(pill.exists()).toBe(true)
    expect(wrapper.find('[data-testid="notes-tag-filter-name"]').text()).toBe('alpha')
    const clear = wrapper.find('[data-testid="notes-tag-filter-clear"]')
    expect(clear.exists()).toBe(true)
    await clear.trigger('click')
    expect(engine.clearTagFilter).toHaveBeenCalledTimes(1)

    const idle = mountSidebar(makeEngine())
    expect(idle.find('[data-testid="notes-tag-filter"]').exists()).toBe(false)
  })

  it('空态文案分语境：过滤激活=「没有带该标签的笔记」（库不为空，只是无匹配）；无过滤=空库新建引导', () => {
    const filteredEmpty = mountSidebar(makeEngine({ notes: [], tagFilter: 'nope' }))
    expect(filteredEmpty.find('.np-sidebar-empty').text()).toContain('没有带该标签的笔记')

    const libraryEmpty = mountSidebar(makeEngine({ notes: [] }))
    expect(libraryEmpty.find('.np-sidebar-empty').text()).toContain('暂无笔记')
  })
})
