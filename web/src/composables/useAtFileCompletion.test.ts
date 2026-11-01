import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 轻依赖隔离：useAtFileCompletion 的运行时依赖面（清单取数/失效事件源）全部
// mock，本文件只测触发检测/条目构建纯函数与浮层状态机，不拖 api/axios 链
// （pathCompletion.test.ts 同款姿态）
vi.mock('@/composables/projectFileList', () => ({
  collectProjectFileList: vi.fn(),
  swrTtlMs: vi.fn(() => 30_000),
  QUICK_OPEN_MAX_FILES: 20000,
  QUICK_OPEN_SWR_TTL_MS: 30_000,
}))
vi.mock('@/composables/useWebSocket', () => ({
  PROJECT_FILE_CHANGED: 'sc:project-file-changed',
}))
vi.mock('@/utils/opsEvents', () => ({
  OPS_FILES_EXTERNAL_CHANGE: 'sc:ops-files-external-change',
}))

import {
  AT_SUGGESTION_CAP,
  buildAtSuggestions,
  collectDirSet,
  detectAtTrigger,
  resetAtFileCompletionForTests,
  useAtFileCompletion,
} from '@/composables/useAtFileCompletion'
import { collectProjectFileList } from '@/composables/projectFileList'

const collect = collectProjectFileList as ReturnType<typeof vi.fn>

beforeEach(() => {
  collect.mockReset()
  resetAtFileCompletionForTests()
})

afterEach(() => {
  resetAtFileCompletionForTests()
})

// ── detectAtTrigger 触发检测 ──

describe('detectAtTrigger @ 触发检测', () => {
  it('行首 @ 与空白后 @ 触发，返回 @ 下标与片段', () => {
    expect(detectAtTrigger('@rea')).toEqual({ start: 0, frag: 'rea' })
    expect(detectAtTrigger('fix @src/u')).toEqual({ start: 4, frag: 'src/u' })
    expect(detectAtTrigger('请看 @read')).toEqual({ start: 3, frag: 'read' })
    expect(detectAtTrigger('a\t@x')).toEqual({ start: 2, frag: 'x' })
    expect(detectAtTrigger('a\n@x')).toEqual({ start: 2, frag: 'x' })
  })

  it('刚敲 @ 空片段也触发（浏览入口）', () => {
    expect(detectAtTrigger('@')).toEqual({ start: 0, frag: '' })
    expect(detectAtTrigger('hi @')).toEqual({ start: 3, frag: '' })
  })

  it('邮箱 user@host 不误触（@ 前非空白）', () => {
    expect(detectAtTrigger('user@ho')).toBeNull()
    expect(detectAtTrigger('contact a@b.com')).toBeNull()
  })

  it('中文紧贴 @ 不误触（@ 前非空白）', () => {
    expect(detectAtTrigger('联系@客服')).toBeNull()
  })

  it('@ 后片段含空白即退出补全语境', () => {
    expect(detectAtTrigger('@src done')).toBeNull()
    expect(detectAtTrigger('@')).not.toBeNull()
  })

  it('无 @ 返回 null', () => {
    expect(detectAtTrigger('plain text')).toBeNull()
  })

  it('超长片段视为普通文本不触发', () => {
    const long = `@${'a'.repeat(500)}`
    expect(detectAtTrigger(long)).toBeNull()
  })
})

// ── buildAtSuggestions 条目构建 ──

const FILES = [
  { name: 'useFoo.ts', path: 'src/composables/useFoo.ts' },
  { name: 'README.md', path: 'README.md' },
  { name: 'app.ts', path: 'src/app.ts' },
  { name: 'guide.md', path: 'docs/guide.md' },
  { name: 'x.ts', path: 'src/utils/x.ts' },
]
const DIRS = collectDirSet(FILES)

describe('collectDirSet 祖先目录集合', () => {
  it('从文件路径派生全部祖先目录', () => {
    expect(DIRS).toEqual(new Set(['src', 'src/composables', 'src/utils', 'docs']))
  })
})

describe('buildAtSuggestions 文件形态（无斜杠片段）', () => {
  it('大小写不敏感子序列命中，文件名命中加权靠前', () => {
    const hits = buildAtSuggestions(FILES, DIRS, 'readme')
    expect(hits[0]?.path).toBe('README.md')
    // `sac` 是 src/composables 的子序列——路径字段参与匹配（Quick Open 同款双字段）
    const byPath = buildAtSuggestions(FILES, DIRS, 'usefoo')
    expect(byPath.map(h => h.path)).toContain('src/composables/useFoo.ts')
  })

  it('空片段全量按短路径优先列出（刚敲 @ 的浏览入口）', () => {
    const hits = buildAtSuggestions(FILES, DIRS, '')
    expect(hits.length).toBe(FILES.length)
    expect(hits[0]?.path).toBe('README.md') // 最短路径在前
    expect(hits.every(h => h.kind === 'file')).toBe(true)
  })

  it('上限 100 截断', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `f${i}.ts`, path: `d/f${i}.ts` }))
    expect(buildAtSuggestions(many, collectDirSet(many), 'f').length).toBe(AT_SUGGESTION_CAP)
  })
})

describe('buildAtSuggestions 目录形态（斜杠片段，P-196 修正案）', () => {
  it('frag 以 / 结尾列出基准目录的直接子目录（仅目录条目）', () => {
    const hits = buildAtSuggestions(FILES, DIRS, 'src/')
    expect(hits.map(h => h.path).sort()).toEqual(['src/composables/', 'src/utils/'])
    expect(hits.every(h => h.kind === 'dir')).toBe(true)
    // 文件不得混入目录形态
    expect(hits.map(h => h.path)).not.toContain('src/app.ts')
  })

  it('根级 / 列出顶层目录', () => {
    const hits = buildAtSuggestions(FILES, DIRS, '/')
    expect(hits.map(h => h.path).sort()).toEqual(['docs/', 'src/'])
  })

  it('尾段模糊过滤子目录', () => {
    expect(buildAtSuggestions(FILES, DIRS, 'src/comp').map(h => h.path)).toEqual(['src/composables/'])
    expect(buildAtSuggestions(FILES, DIRS, 'src/zzz')).toEqual([])
  })

  it('nav 段不是真实目录 → 零条目（防口语串/盘符路径误弹）', () => {
    expect(buildAtSuggestions(FILES, DIRS, 'nope/')).toEqual([])
    expect(buildAtSuggestions(FILES, DIRS, 'C:/x')).toEqual([])
  })
})

// ── 浮层状态机（控制器接线）──

function keyEvent(key: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    isComposing: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent
}

/** 控制器测试座：文本/光标由外部驱动，applyText 捕获插入调用 */
function setupController() {
  let text = ''
  let cursor = 0
  const applied: Array<{ start: number; end: number; replacement: string }> = []
  const at = useAtFileCompletion({
    projectId: () => 'p1',
    getText: () => text,
    getCursor: () => cursor,
    applyText: (start, end, replacement) => {
      text = text.slice(0, start) + replacement + text.slice(end)
      cursor = start + replacement.length
      applied.push({ start, end, replacement })
    },
    getAnchorEl: () => null,
  })
  return {
    at,
    applied,
    type: (t: string) => {
      text = t
      cursor = t.length
      at.onInput()
    },
    getText: () => text,
  }
}

async function flushLoad(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('useAtFileCompletion 浮层状态机', () => {
  it('敲 @ 片段弹层，选中以「@相对路径 」替换触发区间', async () => {
    collect.mockResolvedValue({ files: FILES, truncated: false })
    const { at, applied, type, getText } = setupController()
    type('fix @rea')
    expect(at.open.value).toBe(false) // 取数未回不弹
    await flushLoad()
    expect(at.open.value).toBe(true)
    expect(at.items.value.map(h => h.path)).toContain('README.md')

    at.onKeydown(keyEvent('Enter'))
    expect(applied).toHaveLength(1)
    expect(applied[0]).toEqual({ start: 4, end: 8, replacement: '@README.md ' })
    expect(getText()).toBe('fix @README.md ')
    expect(at.open.value).toBe(false)
  })

  it('↑↓ 循环移动活动项，Esc 关层不插入', async () => {
    collect.mockResolvedValue({ files: FILES, truncated: false })
    const { at, applied, type } = setupController()
    type('@')
    await flushLoad()
    expect(at.open.value).toBe(true)
    const n = at.items.value.length
    at.onKeydown(keyEvent('ArrowDown'))
    expect(at.activeIndex.value).toBe(1 % n)
    at.onKeydown(keyEvent('ArrowUp'))
    expect(at.activeIndex.value).toBe(0)
    at.onKeydown(keyEvent('Escape'))
    expect(at.open.value).toBe(false)
    expect(applied).toHaveLength(0)
  })

  it('浮层未开时按键零接管（输入框其余行为零变化）', async () => {
    collect.mockResolvedValue({ files: FILES, truncated: false })
    const { at, applied, type } = setupController()
    const ev = keyEvent('Enter')
    at.onKeydown(ev)
    expect(ev.preventDefault).not.toHaveBeenCalled()
    expect(applied).toHaveLength(0)
    type('no trigger here')
    await flushLoad()
    expect(at.open.value).toBe(false)
  })

  it('邮箱片段不触发浮层', async () => {
    collect.mockResolvedValue({ files: FILES, truncated: false })
    const { at, type } = setupController()
    type('mail user@ho')
    await flushLoad()
    expect(at.open.value).toBe(false)
  })

  it('@src/ 目录级补全：仅目录条目，选中注入目录相对路径', async () => {
    collect.mockResolvedValue({ files: FILES, truncated: false })
    const { at, applied, type, getText } = setupController()
    type('check @src/')
    await flushLoad()
    expect(at.open.value).toBe(true)
    expect(at.items.value.map(h => h.path).sort()).toEqual(['src/composables/', 'src/utils/'])
    // 活动项 = 排序首位（同分按路径短→长：src/utils/ 先于 src/composables/）
    at.onKeydown(keyEvent('Enter'))
    expect(applied[0]?.replacement).toBe('@src/utils/ ')
    expect(getText()).toBe('check @src/utils/ ')
  })

  it('焦点离开关浮层；关闭后迟到的取数不得重新弹层', async () => {
    let resolveLoad!: (v: unknown) => void
    collect.mockReturnValue(new Promise(resolve => { resolveLoad = resolve }))
    const { at, type } = setupController()
    type('@rea')
    at.onFocusout()
    expect(at.open.value).toBe(false)
    resolveLoad({ files: FILES, truncated: false })
    await flushLoad()
    expect(at.open.value).toBe(false)
  })

  it('consumeEnterKeyup：keydown 消费过的 Enter 放行一次后复位', async () => {
    collect.mockResolvedValue({ files: FILES, truncated: false })
    const { at, type } = setupController()
    expect(at.consumeEnterKeyup()).toBe(false) // 浮层未开：未消费
    type('@rea')
    await flushLoad()
    at.onKeydown(keyEvent('Enter'))
    expect(at.consumeEnterKeyup()).toBe(true) // 本次 Enter 已被浮层消费
    expect(at.consumeEnterKeyup()).toBe(false) // 一次性
  })

  it('IME 合成期间输入不评估，compositionend 后恢复', async () => {
    collect.mockResolvedValue({ files: FILES, truncated: false })
    const { at, type } = setupController()
    at.onCompositionStart()
    type('@rea')
    await flushLoad()
    expect(at.open.value).toBe(false) // 合成中不触发
    at.onCompositionEnd()
    await flushLoad()
    expect(at.open.value).toBe(true) // 上屏后按终值评估
  })
})
