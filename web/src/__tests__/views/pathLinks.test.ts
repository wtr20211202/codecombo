import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 轻依赖隔离：pathLinks 的运行时依赖面（清单缓存/项目 store）全部 mock，
// 保证本文件只测链接纯逻辑（基准折叠/在册校验/描述构建/URL 约定）与 provider
// 接线，不拖 api/monaco 真身
vi.mock('@/composables/projectFileList', () => ({
  collectProjectFileList: vi.fn(),
  swrTtlMs: vi.fn(() => 30_000),
  QUICK_OPEN_MAX_FILES: 20000,
  QUICK_OPEN_SWR_TTL_MS: 30_000,
}))
vi.mock('@/stores/project', () => ({
  useProjectStore: () => ({ currentProjectId: 'p1' }),
}))
vi.mock('@/composables/useWebSocket', () => ({
  PROJECT_FILE_CHANGED: 'sc:project-file-changed',
}))
vi.mock('@/utils/opsEvents', () => ({
  OPS_FILES_EXTERNAL_CHANGE: 'sc:ops-files-external-change',
}))

import { foldToProjectPath, linkUrl, resolveLinkTarget } from '@/views/editor/pathLinks'
import {
  buildPathLinkDescriptors,
  connectEditorPathLinks,
  resetPathLinksForTests,
} from '@/views/editor/pathLinks'
import { collectProjectFileList } from '@/composables/projectFileList'

const collect = collectProjectFileList as ReturnType<typeof vi.fn>

beforeEach(() => {
  collect.mockReset()
  resetPathLinksForTests()
})

afterEach(() => {
  resetPathLinksForTests()
})

describe('foldToProjectPath 基准折叠', () => {
  it('根基准：. 原地、纯相对拼接', () => {
    expect(foldToProjectPath('', './src/a.ts')).toBe('src/a.ts')
    expect(foldToProjectPath('', 'src/a.ts')).toBe('src/a.ts')
  })

  it('文件目录基准：../ 逐级上级', () => {
    expect(foldToProjectPath('src/a', './utils/b.ts')).toBe('src/a/utils/b.ts')
    expect(foldToProjectPath('src/a', '../lib/x.go')).toBe('src/lib/x.go')
    expect(foldToProjectPath('src/a', '../../README.md')).toBe('README.md')
  })

  it('越出项目根返回 null', () => {
    expect(foldToProjectPath('src', '../../../x.ts')).toBeNull()
    expect(foldToProjectPath('', '../x.ts')).toBeNull()
  })

  it('反斜杠分隔符同收（Windows 工具链输出形态）', () => {
    expect(foldToProjectPath('src', '.\\api\\file.go')).toBe('src/api/file.go')
    expect(foldToProjectPath('', 'src\\x.go')).toBe('src/x.go')
  })
})

describe('resolveLinkTarget 在册校验', () => {
  const files = new Set(['README.md', 'src/app.ts', 'src/lib/util.ts', 'lib/util.ts', 'docs/guide.md'])

  it('./ ../ 显式相对按当前文件目录解析，在册命中', () => {
    expect(resolveLinkTarget('./app.ts', 'src/main.ts', files)).toBe('src/app.ts')
    // src/main.ts 的 ../ 出到项目根：lib/util.ts（根下），非 src/lib/util.ts
    expect(resolveLinkTarget('../lib/util.ts', 'src/main.ts', files)).toBe('lib/util.ts')
  })

  it('纯相对先按当前文件目录、未命中再按项目根', () => {
    // src/main.ts 里写 src/app.ts：文件目录基准 = src/src/app.ts（不在册）→ 根基准命中
    expect(resolveLinkTarget('src/app.ts', 'src/main.ts', files)).toBe('src/app.ts')
    // 根级 README.md 里写 src/app.ts：文件目录基准（根）直接命中
    expect(resolveLinkTarget('src/app.ts', 'README.md', files)).toBe('src/app.ts')
    // docs/guide.md 里写 guide.md 邻居形态（docs/xxx）：文件目录基准命中
    expect(resolveLinkTarget('./guide.md', 'docs/guide.md', files)).toBe('docs/guide.md')
  })

  it('不在册（模块名/示意路径）与绝对路径一律 null', () => {
    expect(resolveLinkTarget('vendor/ghost.ts', 'README.md', files)).toBeNull()
    expect(resolveLinkTarget('./ghost.ts', 'src/main.ts', files)).toBeNull()
    expect(resolveLinkTarget('/etc/hosts', 'README.md', files)).toBeNull()
    expect(resolveLinkTarget('C:\\proj\\a.ts', 'README.md', files)).toBeNull()
  })
})

describe('linkUrl URL 约定', () => {
  it('file:/// 相对路径 + extractSelection 可解析的 #L 片段', () => {
    expect(linkUrl('src/app.ts')).toBe('file:///src/app.ts')
    expect(linkUrl('src/app.ts', 2)).toBe('file:///src/app.ts#L2')
    expect(linkUrl('src/app.ts', 2, 5)).toBe('file:///src/app.ts#L2,5')
  })
})

describe('buildPathLinkDescriptors 全文扫描', () => {
  const files = new Set(['README.md', 'src/app.ts', 'src/lib/util.ts'])
  const current = 'README.md'

  it('在册路径 + :line:col 尾缀 → 描述含 1-based 列区间与行列', () => {
    const ds = buildPathLinkDescriptors(
      ['# demo', 'see ./src/app.ts:2 and src/lib/util.ts:3:4'],
      current,
      files,
    )
    expect(ds).toHaveLength(2)
    expect(ds[0]).toMatchObject({
      lineNumber: 2, startColumn: 5, target: 'src/app.ts', line: 2, text: './src/app.ts:2',
    })
    // 列区间覆盖完整命中文本（含 :2 后缀）：col5 起 13 字符
    expect(ds[0]!.endColumn).toBe(5 + './src/app.ts:2'.length)
    expect(ds[1]).toMatchObject({
      lineNumber: 2, target: 'src/lib/util.ts', line: 3, col: 4,
    })
  })

  it('不在册示意路径与模块名（无分隔符）不产链接', () => {
    const ds = buildPathLinkDescriptors(
      ['missing ./ghost/x.ts and module lodash-utils'],
      current,
      files,
    )
    expect(ds).toEqual([])
  })

  it('多行混合：各自行号正确，markdown 链接括号内路径可链', () => {
    const ds = buildPathLinkDescriptors(
      ['[guide](./docs/a.md)', '', 'ref: src/app.ts'],
      current,
      new Set([...files, 'docs/a.md']),
    )
    expect(ds).toHaveLength(2)
    expect(ds[0]).toMatchObject({ lineNumber: 1, target: 'docs/a.md' })
    expect(ds[1]).toMatchObject({ lineNumber: 3, target: 'src/app.ts' })
  })

  it('自引用本文件保留（内建 reveal 原地定位）', () => {
    const ds = buildPathLinkDescriptors(['self: ./README.md:1'], 'README.md', files)
    expect(ds).toHaveLength(1)
    expect(ds[0]).toMatchObject({ target: 'README.md', line: 1 })
  })
})

/** 伪 monaco 命名空间：接线面用到的三件（registerLinkProvider/Range/Uri.parse） */
function fakeMonaco() {
  const providers: Array<{
    provideLinks(model: unknown): Promise<{ links: unknown[] }>
  }> = []
  const monaco = {
    languages: {
      registerLinkProvider: (_selector: string, p: (typeof providers)[number]) => {
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
    Uri: {
      parse: (s: string) => s, // 测试面直接以字符串形态断言 url
    },
  }
  return { monaco, providers }
}

/** 伪 model：uri + 逐行内容（getLineCount/getLineContent） */
function fakeModel(uriPath: string, lines: string[]) {
  return {
    uri: { scheme: 'file', path: uriPath },
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
  }
}

describe('connectEditorPathLinks 接线与 provider 流程', () => {
  it('幂等注册：重复接线只注册一份 provider', () => {
    const { monaco, providers } = fakeMonaco()
    connectEditorPathLinks(monaco as never)
    connectEditorPathLinks(monaco as never)
    expect(providers).toHaveLength(1)
  })

  it('provider 全流程：在册路径产出链接，url 带 #L 片段、tooltip=命中文本', async () => {
    collect.mockResolvedValue({
      files: [
        { name: 'README.md', path: 'README.md' },
        { name: 'app.ts', path: 'src/app.ts' },
      ],
      truncated: false,
    })
    const { monaco, providers } = fakeMonaco()
    connectEditorPathLinks(monaco as never)
    const model = fakeModel('/README.md', ['open ./src/app.ts:2 now'])
    const { links } = await providers[0]!.provideLinks(model)
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      range: { startLineNumber: 1, startColumn: 6 },
      url: 'file:///src/app.ts#L2',
      tooltip: './src/app.ts:2',
    })
  })

  it('非 file scheme / 非项目 model（diff、远程、untitled）零链接零取数', async () => {
    const { monaco, providers } = fakeMonaco()
    connectEditorPathLinks(monaco as never)
    const diffModel = fakeModel('/diff:HEAD:wt:src/a.ts', ['see ./src/app.ts:2'])
    expect((await providers[0]!.provideLinks(diffModel)).links).toEqual([])
    expect(collect).not.toHaveBeenCalled()
  })

  it('清单缓存复用：两次计算只拉一次（同源 SWR 链）', async () => {
    collect.mockResolvedValue({ files: [{ name: 'b.ts', path: 'src/b.ts' }], truncated: false })
    const { monaco, providers } = fakeMonaco()
    connectEditorPathLinks(monaco as never)
    const model = fakeModel('/README.md', ['a src/b.ts:1', 'b src/b.ts:2'])
    await providers[0]!.provideLinks(model)
    await providers[0]!.provideLinks(model)
    expect(collect).toHaveBeenCalledTimes(1)
  })

  it('取数失败：本次零链接（增益路径静默，不扰阅读）', async () => {
    collect.mockRejectedValue(new Error('network down'))
    const { monaco, providers } = fakeMonaco()
    connectEditorPathLinks(monaco as never)
    const model = fakeModel('/README.md', ['see ./src/app.ts:2'])
    expect((await providers[0]!.provideLinks(model)).links).toEqual([])
  })
})
