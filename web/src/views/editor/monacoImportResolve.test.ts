// monacoImportResolve 纯函数单测（P-20261004-45）
// 覆盖：四形态说明符提取（含去重/误报防御）、跨行 import 子句按词找说明符、
// 相对说明符扩展名探测序与项目根折叠。裸包名判否是 MVP 诚实边界锚。
import { describe, expect, it } from 'vitest'
import {
  extractImportSpecifiersFromLine,
  findImportSpecifierForWord,
  parentDir,
  resolveImportSpecifierPath,
  resolveRelativeSpecifierPath,
} from './monacoImportResolve'

describe('extractImportSpecifiersFromLine', () => {
  it('四形态各提取一条', () => {
    expect(extractImportSpecifiersFromLine("import { helper } from './util/helper'")).toEqual(['./util/helper'])
    expect(extractImportSpecifiersFromLine("import './polyfill'")).toEqual(['./polyfill'])
    expect(extractImportSpecifiersFromLine("const m = await import('./lazy')")).toEqual(['./lazy'])
    expect(extractImportSpecifiersFromLine("const x = require('./legacy')")).toEqual(['./legacy'])
  })

  it('同一行多个说明符按出现序排列并去重', () => {
    expect(extractImportSpecifiersFromLine("export * from './a'; export { b } from './b'")).toEqual(['./a', './b'])
    expect(extractImportSpecifiersFromLine("const a = require('./x') + require('./x')")).toEqual(['./x'])
  })

  it('普通代码与赋值形态不误报', () => {
    expect(extractImportSpecifiersFromLine("const from = 'not-a-module'")).toEqual([])
    expect(extractImportSpecifiersFromLine("importance('x'); Imported('y')")).toEqual([])
    expect(extractImportSpecifiersFromLine('const url = `./template`')).toEqual([])
  })
})

describe('findImportSpecifierForWord', () => {
  const TEXT = [
    "import { helper, utils } from './util/helper'",
    "import main from './main'",
    'import {',
    '  deep as d,',
    "  nested,",
    "} from './util/nested'",
    "import type { Ctx } from './types'",
    "import './side-effect'",
  ].join('\n')

  it('命名导入/默认导入/命名空间子句按词命中', () => {
    expect(findImportSpecifierForWord(TEXT, 'helper')).toBe('./util/helper')
    expect(findImportSpecifierForWord(TEXT, 'utils')).toBe('./util/helper')
    expect(findImportSpecifierForWord(TEXT, 'main')).toBe('./main')
  })

  it('跨行花括号子句命中（深层的 as 别名）', () => {
    expect(findImportSpecifierForWord(TEXT, 'deep')).toBe('./util/nested')
    expect(findImportSpecifierForWord(TEXT, 'nested')).toBe('./util/nested')
  })

  it('type 修饰导入命中；副作用导入（无子句）不命中', () => {
    expect(findImportSpecifierForWord(TEXT, 'Ctx')).toBe('./types')
    expect(findImportSpecifierForWord(TEXT, 'side-effect')).toBeNull()
  })

  it('无导入/无词/部分词不误命中', () => {
    expect(findImportSpecifierForWord('const helper2 = 1', 'helper2')).toBeNull()
    expect(findImportSpecifierForWord(TEXT, 'helpe')).toBeNull()
    expect(findImportSpecifierForWord(TEXT, '')).toBeNull()
    expect(findImportSpecifierForWord(TEXT, 'constructor')).toBeNull()
  })
})

describe('resolveRelativeSpecifierPath 段折叠', () => {
  it('同目录/下钻/根相对', () => {
    expect(resolveRelativeSpecifierPath('src/util', './helper')).toBe('src/util/helper')
    expect(resolveRelativeSpecifierPath('src/util', '../helper')).toBe('src/helper')
    expect(resolveRelativeSpecifierPath('', './helper')).toBe('helper')
    expect(resolveRelativeSpecifierPath('', '/src/helper')).toBe('src/helper')
  })

  it('多层回退与冗余段收敛', () => {
    expect(resolveRelativeSpecifierPath('src/a/b', '../../c/d')).toBe('src/c/d')
    expect(resolveRelativeSpecifierPath('src', './a/./b//c/')).toBe('src/a/b/c')
  })

  it('越出项目根返回 null', () => {
    expect(resolveRelativeSpecifierPath('', '../outside')).toBeNull()
    expect(resolveRelativeSpecifierPath('src', '../../../../root')).toBeNull()
  })
})

describe('resolveImportSpecifierPath 扩展名探测', () => {
  const files = new Set([
    'src/util/helper.ts',
    'src/widget.tsx',
    'src/types.d.ts',
    'src/util/index.ts',
    'src/legacy.js',
    'src/explicit.d.ts',
  ])

  it('按 .ts → .tsx → .d.ts 单文件序命中', () => {
    expect(resolveImportSpecifierPath('src/main.ts', './util/helper', files)).toBe('src/util/helper.ts')
    expect(resolveImportSpecifierPath('src/main.ts', './widget', files)).toBe('src/widget.tsx')
    expect(resolveImportSpecifierPath('src/main.ts', './types', files)).toBe('src/types.d.ts')
  })

  it('目录形态命中 index.ts', () => {
    expect(resolveImportSpecifierPath('src/main.ts', './util', files)).toBe('src/util/index.ts')
  })

  it('根相对说明符以项目根为基准', () => {
    expect(resolveImportSpecifierPath('src/main.ts', '/src/widget', files)).toBe('src/widget.tsx')
  })

  it('自带 TS 后缀的 spec 原样探测', () => {
    expect(resolveImportSpecifierPath('src/main.ts', './explicit.d.ts', files)).toBe('src/explicit.d.ts')
    expect(resolveImportSpecifierPath('src/main.ts', './util/helper.ts', files)).toBe('src/util/helper.ts')
  })

  it('裸包名与协议形态不可解析（MVP 边界锚）', () => {
    expect(resolveImportSpecifierPath('src/main.ts', 'vue', files)).toBeNull()
    expect(resolveImportSpecifierPath('src/main.ts', '@scope/pkg', files)).toBeNull()
    expect(resolveImportSpecifierPath('src/main.ts', 'node:fs', files)).toBeNull()
    expect(resolveImportSpecifierPath('src/main.ts', 'http://example.com/x', files)).toBeNull()
  })

  it('反斜杠说明符归一为正斜杠（win 误写容错）', () => {
    expect(resolveImportSpecifierPath('src/main.ts', '.\\util\\helper', files)).toBe('src/util/helper.ts')
  })

  it('越出项目根与全未命中返回 null', () => {
    expect(resolveImportSpecifierPath('src/main.ts', '../../outside', files)).toBeNull()
    expect(resolveImportSpecifierPath('src/main.ts', './missing', files)).toBeNull()
    expect(resolveImportSpecifierPath('src/main.ts', './legacy.js', files)).toBeNull()
  })
})

describe('parentDir 口径', () => {
  it('与 pathCompletion.parentDir 同口径', () => {
    expect(parentDir('src/util/helper.ts')).toBe('src/util')
    expect(parentDir('main.ts')).toBe('')
    expect(parentDir('src')).toBe('')
  })
})
