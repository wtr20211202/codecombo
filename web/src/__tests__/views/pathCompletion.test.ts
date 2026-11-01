import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 轻依赖隔离：pathCompletion 的运行时依赖面（清单取数/项目 store/失效事件源）
// 全部 mock，保证本文件只测补全纯逻辑与 provider 接线，不拖 api/axios 链
vi.mock('@/composables/projectFileList', () => ({
  collectProjectFileList: vi.fn(),
  swrTtlMs: vi.fn(() => 30_000),
  QUICK_OPEN_MAX_FILES: 20000,
  QUICK_OPEN_SWR_TTL_MS: 30_000,
}))
vi.mock('@/stores/project', () => ({
  useProjectStore: () => ({ currentProjectId: 'p1', currentProject: { path: 'D:/demo/proj' } }),
}))
vi.mock('@/composables/useWebSocket', () => ({
  PROJECT_FILE_CHANGED: 'sc:project-file-changed',
}))
vi.mock('@/utils/opsEvents', () => ({
  OPS_FILES_EXTERNAL_CHANGE: 'sc:ops-files-external-change',
}))

import { buildDirSet, parentDir } from '@/views/editor/editorFileListCache'
import {
  buildPathSuggestions,
  connectEditorPathCompletion,
  detectPathQuoteContext,
  fuzzyMatchPath,
  isPathCompletionIntent,
  projectRelativePathFromUri,
  resetPathCompletionForTests,
  resolvePathRequest,
} from '@/views/editor/pathCompletion'
import { collectProjectFileList } from '@/composables/projectFileList'

const collect = collectProjectFileList as ReturnType<typeof vi.fn>

beforeEach(() => {
  collect.mockReset()
  resetPathCompletionForTests()
})

afterEach(() => {
  resetPathCompletionForTests()
  vi.useRealTimers()
})

describe('detectPathQuoteContext 引号上下文探测', () => {
  it('开放引号后的文本作为路径前缀返回', () => {
    expect(detectPathQuoteContext("import x from './src/u")).toEqual({ quote: "'", prefix: './src/u' })
    expect(detectPathQuoteContext('const s = "hello')).toEqual({ quote: '"', prefix: 'hello' })
    expect(detectPathQuoteContext('const t = `./x')).toEqual({ quote: '`', prefix: './x' })
    expect(detectPathQuoteContext("'")).toEqual({ quote: "'", prefix: '' })
  })

  it('无开放引号返回 null（代码区 / 不激活的前提）', () => {
    expect(detectPathQuoteContext('const a = 1 /')).toBeNull()
    expect(detectPathQuoteContext('const b = c / d')).toBeNull()
    expect(detectPathQuoteContext('// 注释里没有引号 /')).toBeNull()
  })

  it('闭合引号之后的再开引号是新字符串（前缀从其后起）', () => {
    // 'a' 已闭合，行尾 '/ 是正在输入的新字符串——前缀为 /
    expect(detectPathQuoteContext("require('a') + '/")).toEqual({ quote: "'", prefix: '/' })
  })

  it('前缀混入引号（口语/拼接语境）返回 null', () => {
    expect(detectPathQuoteContext('"abc"def/')).toBeNull()
  })
})

describe('isPathCompletionIntent 激活门槛（触发从严）', () => {
  it('空前缀与普通文本不激活', () => {
    expect(isPathCompletionIntent('')).toBe(false)
    expect(isPathCompletionIntent('hello')).toBe(false)
    expect(isPathCompletionIntent('src/util')).toBe(false)
    expect(isPathCompletionIntent("it's fine")).toBe(false)
  })

  it('/ 结尾（触发字符落点）与 ./ ../ / 开头（显式路径意图）激活', () => {
    expect(isPathCompletionIntent('./')).toBe(true)
    expect(isPathCompletionIntent('../')).toBe(true)
    expect(isPathCompletionIntent('src/')).toBe(true)
    expect(isPathCompletionIntent('./src/u')).toBe(true)
    expect(isPathCompletionIntent('../x')).toBe(true)
    expect(isPathCompletionIntent('/src')).toBe(true)
  })

  it('盘符绝对形态激活（P-20261005-232）：正反斜杠双形态，裸盘符不激活', () => {
    expect(isPathCompletionIntent('D:/x')).toBe(true)
    expect(isPathCompletionIntent('D:\\x')).toBe(true)
    expect(isPathCompletionIntent('d:/')).toBe(true)
    expect(isPathCompletionIntent('C:\\demo\\src\\ut')).toBe(true)
    expect(isPathCompletionIntent('D:')).toBe(false) // 盘符裸写（未落分隔符）不算意图
    expect(isPathCompletionIntent('https://x')).toBe(false) // 协议形态不命中盘符锚定
  })
})

describe('parentDir / buildDirSet', () => {
  it('父目录：根级与项目根返回空串', () => {
    expect(parentDir('a/b/c.ts')).toBe('a/b')
    expect(parentDir('c.ts')).toBe('')
    expect(parentDir('a/b')).toBe('a')
  })

  it('祖先目录集合：多层路径逐层入集，根级文件不入', () => {
    expect(buildDirSet([{ name: 'c.ts', path: 'a/b/c.ts' }, { name: 'x.ts', path: 'x.ts' }]))
      .toEqual(new Set(['a', 'a/b']))
  })
})

describe('resolvePathRequest 路径基准解析', () => {
  const dirs = new Set(['src', 'src/a', 'src/a/utils'])

  it('相对当前文件目录：./ 原地 ../ 上级', () => {
    expect(resolvePathRequest('src/a/main.ts', './', dirs)).toEqual({ baseDir: 'src/a', filter: '', navPrefix: './' })
    expect(resolvePathRequest('src/a/main.ts', '../', dirs)).toEqual({ baseDir: 'src', filter: '', navPrefix: '../' })
    expect(resolvePathRequest('src/a/main.ts', '../../', dirs)).toEqual({ baseDir: '', filter: '', navPrefix: '../../' })
  })

  it('越出项目根 / 导航段非真实目录（盘符路径、口语串）返回 null', () => {
    expect(resolvePathRequest('src/a/main.ts', '../../../', dirs)).toBeNull()
    expect(resolvePathRequest('src/a/main.ts', './nope/x', dirs)).toBeNull()
    expect(resolvePathRequest('src/a/main.ts', 'C:/Users/kevin/', dirs)).toBeNull()
    expect(resolvePathRequest('src/a/main.ts', 'hello world /', dirs)).toBeNull()
  })

  it('/ 开头按项目根相对（绝对项目路径最小集）', () => {
    expect(resolvePathRequest('src/a/main.ts', '/src/', dirs)).toEqual({ baseDir: 'src', filter: '', navPrefix: '/src/' })
  })

  it('最后一段是过滤段，导航前缀到其前为止（./ 相对当前文件目录解析）', () => {
    // 文件在 src/a/main.ts，'./utils' 相对解析为 src/a/utils（在清单目录集内）
    expect(resolvePathRequest('src/a/main.ts', './utils/u', dirs)).toEqual({
      baseDir: 'src/a/utils', filter: 'u', navPrefix: './utils/',
    })
    // 文件在项目根，'./src' 相对解析为 src
    expect(resolvePathRequest('main.ts', './src/u', dirs)).toEqual({
      baseDir: 'src', filter: 'u', navPrefix: './src/',
    })
    // './src' 相对 src/a/ 解析为 src/a/src（不在目录集）→ null
    expect(resolvePathRequest('src/a/main.ts', './src/u', dirs)).toBeNull()
  })
})

describe('resolvePathRequest 绝对宿主路径剥根映射（P-20261005-232）', () => {
  const dirs = new Set(['src', 'src/utils'])
  const root = 'D:/demo/proj'

  it('盘符正斜杠形态剥根映射：大小写不敏感，导航段照常校验', () => {
    expect(resolvePathRequest('main.ts', 'd:/DEMO/proj/src/', dirs, root)).toEqual({
      baseDir: 'src', filter: '', navPrefix: '/src/', fromAbsolute: true,
    })
    expect(resolvePathRequest('main.ts', 'D:/demo/proj/src/utils/HE', dirs, root)).toEqual({
      baseDir: 'src/utils', filter: 'HE', navPrefix: '/src/utils/', fromAbsolute: true,
    })
    // 导航段非真实目录照常 null（既有防御不因映射放宽）
    expect(resolvePathRequest('main.ts', 'D:/demo/proj/nope/', dirs, root)).toBeNull()
  })

  it('反斜杠形态与混合分隔符同链；剥根回原文切片保留已敲大小写', () => {
    expect(resolvePathRequest('main.ts', 'D:\\demo\\proj\\src\\', dirs, root)).toEqual({
      baseDir: 'src', filter: '', navPrefix: '/src/', fromAbsolute: true,
    })
    expect(resolvePathRequest('main.ts', 'd:/demo\\proj/src/utils/HE', dirs, root)).toEqual({
      baseDir: 'src/utils', filter: 'HE', navPrefix: '/src/utils/', fromAbsolute: true,
    })
  })

  it('裸根（根本身 / 根+尾分隔）基准=项目根；兄弟目录名前缀不命中', () => {
    expect(resolvePathRequest('main.ts', 'D:/demo/proj', dirs, root)).toEqual({
      baseDir: '', filter: '', navPrefix: '/', fromAbsolute: true,
    })
    expect(resolvePathRequest('main.ts', 'D:/demo/proj/', dirs, root)).toEqual({
      baseDir: '', filter: '', navPrefix: '/', fromAbsolute: true,
    })
    // proj-other 与 proj 同前缀但非完整路径段——不命中（relpath.go 同款口径）
    expect(resolvePathRequest('main.ts', 'D:/demo/proj-other/src/', dirs, root)).toBeNull()
  })

  it('界外盘符路径不激活（提案②如实不响应）', () => {
    expect(resolvePathRequest('main.ts', 'C:/Users/kevin/', dirs, root)).toBeNull()
    expect(resolvePathRequest('main.ts', 'D:\\Windows\\', dirs, root)).toBeNull()
  })

  it('posix 绝对形态命中根剥根（linux 侧），大小写敏感；未命中回落 / 项目根相对既有语义', () => {
    expect(resolvePathRequest('main.ts', '/home/u/proj/src/', dirs, '/home/u/proj')).toEqual({
      baseDir: 'src', filter: '', navPrefix: '/src/', fromAbsolute: true,
    })
    expect(resolvePathRequest('main.ts', '/HOME/u/proj/src/', dirs, '/home/u/proj')).toBeNull()
    // 未命中根的 / 前缀 = P-107 既有「项目根相对」最小集，语义不变（无 fromAbsolute）
    expect(resolvePathRequest('main.ts', '/src/', dirs, root)).toEqual({
      baseDir: 'src', filter: '', navPrefix: '/src/',
    })
  })

  it('退化根（盘根级 / posix 根）不映射；未传 projectRoot 维持既有行为', () => {
    expect(resolvePathRequest('main.ts', 'C:/x/src/', dirs, 'C:/')).toBeNull()
    expect(resolvePathRequest('main.ts', '/x/src/', dirs, '/')).toBeNull()
    expect(resolvePathRequest('main.ts', 'D:/demo/proj/src/', dirs)).toBeNull()
    expect(resolvePathRequest('main.ts', 'D:/demo/proj/src/', dirs, '')).toBeNull()
  })
})

describe('fuzzyMatchPath 大小写不敏感模糊匹配', () => {
  it('空前缀全过；子序列命中；大小写不敏感', () => {
    expect(fuzzyMatchPath('', 'anything.ts')).toBe(true)
    expect(fuzzyMatchPath('UT', 'utils.ts')).toBe(true)
    expect(fuzzyMatchPath('uls', 'utils.ts')).toBe(true)
    expect(fuzzyMatchPath('HE', 'helpers.ts')).toBe(true)
    expect(fuzzyMatchPath('zz', 'utils.ts')).toBe(false)
  })
})

describe('buildPathSuggestions 条目构建（目录合成 + 过滤 + 上限）', () => {
  const files = [
    { name: 'README.md', path: 'README.md' },
    { name: 'main.ts', path: 'main.ts' },
    { name: 'a.ts', path: 'src/a.ts' },
    { name: 'helpers.ts', path: 'src/utils/helpers.ts' },
    { name: 'deep.ts', path: 'src/utils/nested/deep.ts' },
    { name: 'guide.md', path: 'docs/guide.md' },
  ]

  it('基准目录的直接子文件 + 首段合成的目录钻取项，目录优先', () => {
    const all = buildPathSuggestions(files, '', '', './')
    expect(all.map((d) => d.label)).toEqual(['docs/', 'src/', 'main.ts', 'README.md'])
    expect(all[0]).toMatchObject({ kind: 'folder', insert: 'docs/', detail: './docs/' })
    expect(all[2]).toMatchObject({ kind: 'file', insert: 'main.ts', detail: './main.ts' })
  })

  it('深层基准：src/utils 下有 nested/ 目录与 helpers.ts 文件', () => {
    const all = buildPathSuggestions(files, 'src/utils', '', '../utils/')
    expect(all.map((d) => d.label)).toEqual(['nested/', 'helpers.ts'])
  })

  it('过滤段模糊命中（大小写不敏感）', () => {
    expect(buildPathSuggestions(files, '', 're', './').map((d) => d.label)).toEqual(['README.md'])
    expect(buildPathSuggestions(files, 'src/utils', 'HE', './utils/').map((d) => d.label)).toEqual(['helpers.ts'])
    expect(buildPathSuggestions(files, '', 'docs', './').map((d) => d.label)).toEqual(['docs/'])
  })

  it('条目上限 PATH_SUGGESTION_CAP=100', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ name: `f${i}.ts`, path: `f${i}.ts` }))
    expect(buildPathSuggestions(many, '', '', './')).toHaveLength(100)
  })
})

describe('projectRelativePathFromUri URI 守卫', () => {
  it('file scheme 解出项目相对路径（含 URL 编码还原）', () => {
    expect(projectRelativePathFromUri({ scheme: 'file', path: '/src/App.vue' })).toBe('src/App.vue')
    expect(projectRelativePathFromUri({ scheme: 'file', path: '/src/My%20File.ts' })).toBe('src/My File.ts')
  })

  it('非 file scheme（DiffEditor 匿名 model）与伪路径一律 null', () => {
    expect(projectRelativePathFromUri({ scheme: 'inmemory', path: '/model/1' })).toBeNull()
    expect(projectRelativePathFromUri({ scheme: 'file', path: '/remote:h1:/etc/hosts' })).toBeNull()
    expect(projectRelativePathFromUri({ scheme: 'file', path: '/untitled://3' })).toBeNull()
    expect(projectRelativePathFromUri({ scheme: 'file', path: '/diff:HEAD:wt:src/a.ts' })).toBeNull()
    expect(projectRelativePathFromUri({ scheme: 'file', path: '/untitled.txt' })).toBeNull()
    expect(projectRelativePathFromUri({ scheme: 'file', path: '/' })).toBeNull()
  })
})

/** 伪 monaco 命名空间：只实现接线面用到的三件（注册/枚举/Range） */
function fakeMonaco() {
  const providers: Array<{
    triggerCharacters?: string[]
    provideCompletionItems(model: unknown, position: { lineNumber: number; column: number }): Promise<{ suggestions: unknown[] }>
  }> = []
  const monaco = {
    languages: {
      CompletionItemKind: { File: 16, Folder: 19 },
      registerCompletionItemProvider: (_selector: string, p: (typeof providers)[number]) => {
        providers.push(p)
        return { dispose: () => {} }
      },
    },
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
  }
  return { monaco, providers }
}

/** 伪 model：uri + 单行前缀文本（getValueInRange 返回构造时给定的整行前缀） */
function fakeModel(uriPath: string, linePrefix: string) {
  return {
    uri: { scheme: 'file', path: uriPath },
    getValueInRange: () => linePrefix,
  }
}

describe('connectEditorPathCompletion 接线与 provider 流程', () => {
  it('幂等注册：重复接线只注册一份 provider，触发字符为 / 与 \\（反斜杠形态，P-20261005-232）', () => {
    const { monaco, providers } = fakeMonaco()
    connectEditorPathCompletion(monaco as never)
    connectEditorPathCompletion(monaco as never)
    expect(providers).toHaveLength(1)
    expect(providers[0]!.triggerCharacters).toEqual(['/', '\\'])
  })

  it('字符串内 ./ 前缀：返回基准目录子条目，range 覆盖过滤段', async () => {
    collect.mockResolvedValue({
      files: [
        { name: 'README.md', path: 'README.md' },
        { name: 'main.ts', path: 'main.ts' },
        { name: 'a.ts', path: 'src/a.ts' },
        { name: 'helpers.ts', path: 'src/utils/helpers.ts' },
      ],
      truncated: false,
    })
    const { monaco, providers } = fakeMonaco()
    connectEditorPathCompletion(monaco as never)
    const model = fakeModel('/main.ts', "import x from './src/u")
    const position = { lineNumber: 1, column: 26 } // 行尾（列值不参与前缀截取，fake 全行返回）
    const { suggestions } = await providers[0]!.provideCompletionItems(model, position)
    // src 下直接子文件 a.ts 不命中 'u'，utils 目录命中 → 单目录钻取项
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({
      label: 'utils/',
      insertText: 'utils/',
      filterText: 'utils',
      detail: './src/utils/',
      // range 覆盖过滤段 'u'：列 26-1 → 26
      range: { startColumn: 25, endColumn: 26 },
    })
  })

  it('无引号上下文（代码区 /）与有引号无路径意图：零条目', async () => {
    const { monaco, providers } = fakeMonaco()
    connectEditorPathCompletion(monaco as never)
    const codeModel = fakeModel('/src/a/main.ts', 'const v = 1 /')
    expect((await providers[0]!.provideCompletionItems(codeModel, { lineNumber: 1, column: 14 })).suggestions).toEqual([])
    const proseModel = fakeModel('/src/a/main.ts', 'const s = "hello')
    expect((await providers[0]!.provideCompletionItems(proseModel, { lineNumber: 1, column: 17 })).suggestions).toEqual([])
    // 零条目路径不应触发取数
    expect(collect).not.toHaveBeenCalled()
  })

  it('绝对宿主形态命中项目根：主区间照常盖过滤段，头部由附加编辑回填 / 项目根相对形态', async () => {
    collect.mockResolvedValue({
      files: [
        { name: 'a.ts', path: 'src/a.ts' },
        { name: 'helpers.ts', path: 'src/utils/helpers.ts' },
      ],
      truncated: false,
    })
    const { monaco, providers } = fakeMonaco()
    connectEditorPathCompletion(monaco as never)
    // 项目根=D:/demo/proj（store mock），小写盘符验证大小写不敏感匹配
    const typed = 'd:/demo/proj/src/utils/HE'
    const model = fakeModel('/main.ts', `import x from '${typed}`)
    const position = { lineNumber: 1, column: 15 + typed.length + 1 }
    const { suggestions } = await providers[0]!.provideCompletionItems(model, position)
    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({
      label: 'helpers.ts',
      insertText: 'helpers.ts',
      // detail 展示回填后的相对终态（navPrefix + label）
      detail: '/src/utils/helpers.ts',
      // 主替换区间照常只盖过滤段（Monaco 建议过滤以 range 起点到光标为口径）
      range: { startColumn: 39, endColumn: 41 },
      // 绝对前缀头部（引号后到过滤段之前）由附加编辑原子替换为相对导航前缀
      additionalTextEdits: [{ range: { startColumn: 16, endColumn: 39 }, text: '/src/utils/' }],
    })
  })

  it('界外盘符形态（未命中项目根）：零条目', async () => {
    collect.mockResolvedValue({ files: [{ name: 'a.ts', path: 'src/a.ts' }], truncated: false })
    const { monaco, providers } = fakeMonaco()
    connectEditorPathCompletion(monaco as never)
    const model = fakeModel('/main.ts', "import x from 'C:/Users/kevin/")
    expect((await providers[0]!.provideCompletionItems(model, { lineNumber: 1, column: 31 })).suggestions).toEqual([])
  })

  it('导航段非真实目录（口语串内 /）：零条目', async () => {
    collect.mockResolvedValue({ files: [{ name: 'a.ts', path: 'src/a.ts' }], truncated: false })
    const { monaco, providers } = fakeMonaco()
    connectEditorPathCompletion(monaco as never)
    const model = fakeModel('/src/a/main.ts', 'note "hello world /')
    const { suggestions } = await providers[0]!.provideCompletionItems(model, { lineNumber: 1, column: 20 })
    expect(suggestions).toEqual([])
  })

  it('缓存与失效链：新鲜命中不重拉；失效事件 1s 尾沿后重拉（同源链）', async () => {
    vi.useFakeTimers()
    collect.mockResolvedValue({ files: [{ name: 'b.ts', path: 'src/b.ts' }], truncated: false })
    const { monaco, providers } = fakeMonaco()
    connectEditorPathCompletion(monaco as never)
    const model = fakeModel('/main.ts', "import x from './")
    const position = { lineNumber: 1, column: 18 }
    await providers[0]!.provideCompletionItems(model, position)
    await providers[0]!.provideCompletionItems(model, position)
    expect(collect).toHaveBeenCalledTimes(1) // 新鲜缓存命中基线

    window.dispatchEvent(new CustomEvent('sc:project-file-changed'))
    await vi.advanceTimersByTimeAsync(999)
    await providers[0]!.provideCompletionItems(model, position)
    expect(collect).toHaveBeenCalledTimes(1) // 去抖窗口内未失效
    await vi.advanceTimersByTimeAsync(1)
    await providers[0]!.provideCompletionItems(model, position)
    expect(collect).toHaveBeenCalledTimes(2) // 尾沿到点失效，触发重拉

    // OPS 批量写盘广播同链失效
    window.dispatchEvent(new CustomEvent('sc:ops-files-external-change', { detail: { paths: ['src/b.ts'] } }))
    await vi.advanceTimersByTimeAsync(1000)
    await providers[0]!.provideCompletionItems(model, position)
    expect(collect).toHaveBeenCalledTimes(3)
  })

  it('SWR 陈旧换新：TTL=0 时旧表立即出条目、后台静默重拉', async () => {
    const { swrTtlMs } = await import('@/composables/projectFileList')
    const ttl = swrTtlMs as ReturnType<typeof vi.fn>
    collect.mockResolvedValue({ files: [{ name: 'old.ts', path: 'old.ts' }], truncated: false })
    const { monaco, providers } = fakeMonaco()
    connectEditorPathCompletion(monaco as never)
    const model = fakeModel('/main.ts', "import x from './")
    const position = { lineNumber: 1, column: 18 }
    const first = await providers[0]!.provideCompletionItems(model, position)
    expect(first.suggestions.map((s) => (s as { label: string }).label)).toEqual(['old.ts'])

    ttl.mockReturnValue(0)
    collect.mockResolvedValue({ files: [{ name: 'new.ts', path: 'new.ts' }], truncated: false })
    const second = await providers[0]!.provideCompletionItems(model, position)
    expect(second.suggestions.map((s) => (s as { label: string }).label)).toEqual(['old.ts']) // 旧表立即可用
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(2)) // 后台重拉已发出
    await new Promise((r) => setTimeout(r, 0)) // 冲掉换新赋值的微任务
    const third = await providers[0]!.provideCompletionItems(model, position)
    expect(third.suggestions.map((s) => (s as { label: string }).label)).toEqual(['new.ts']) // 已换新
  })

  it('首次取数失败：本次零条目，下次触发重试成功', async () => {
    collect.mockRejectedValueOnce(new Error('network down'))
    collect.mockResolvedValue({ files: [{ name: 'ok.ts', path: 'ok.ts' }], truncated: false })
    const { monaco, providers } = fakeMonaco()
    connectEditorPathCompletion(monaco as never)
    const model = fakeModel('/main.ts', "import x from './")
    const position = { lineNumber: 1, column: 18 }
    expect((await providers[0]!.provideCompletionItems(model, position)).suggestions).toEqual([])
    expect((await providers[0]!.provideCompletionItems(model, position)).suggestions.map((s) => (s as { label: string }).label))
      .toEqual(['ok.ts'])
  })
})
