import { describe, it, expect } from 'vitest'
import {
  NESTING_CHILD_RULES,
  matchChildRule,
  buildNestGroups,
  applyNestGroups,
} from './fileNesting'
import type { NestEntry } from './fileNesting'

function f(path: string, isDir = false): NestEntry {
  return { name: path.split('/').pop() || path, path, isDir }
}

describe('matchChildRule / NESTING_CHILD_RULES', () => {
  it('四族命中与基名剥离', () => {
    expect(matchChildRule('foo.test.ts')?.base).toBe('foo')
    expect(matchChildRule('foo.spec.ts')?.base).toBe('foo')
    expect(matchChildRule('foo.test.js')?.base).toBe('foo')
    expect(matchChildRule('index.spec.tsx')?.base).toBe('index')
    expect(matchChildRule('foo.css')?.base).toBe('foo')
    expect(matchChildRule('foo.scss')?.base).toBe('foo')
    expect(matchChildRule('index.d.ts')?.base).toBe('index')
    expect(matchChildRule('foo.d.cts')?.base).toBe('foo')
  })

  it('非子文件不命中（含 _test.go 等族外语法）', () => {
    expect(matchChildRule('foo.ts')).toBeNull()
    expect(matchChildRule('main_test.go')).toBeNull()
    expect(matchChildRule('tests.ts')).toBeNull()
    expect(matchChildRule('style.css.ts')).toBeNull() // 名字含词 ≠ 后缀命中
  })

  it('模式表可增补（结构契约）', () => {
    for (const r of NESTING_CHILD_RULES) {
      expect(r.id.length).toBeGreaterThan(0)
      expect(r.pattern.global).toBeFalsy() // 带 g 标志会让 exec 跨调用漂移
    }
  })
})

describe('buildNestGroups', () => {
  it('任务书场景：foo.vue 行收纳 test+css（+2）', () => {
    const entries = [
      f('src'),
      f('src/App.vue'),
      f('src/components'),
      f('src/components/Card.vue'),
      f('src/components/Card.css'),
      f('src/components/Card.test.ts'),
    ]
    const g = buildNestGroups(entries)
    expect(g.mainToChildren.get('src/components/Card.vue')).toHaveLength(2)
    expect(g.childToMain.get('src/components/Card.css')).toBe('src/components/Card.vue')
    expect(g.childToMain.get('src/components/Card.test.ts')).toBe('src/components/Card.vue')
    expect(g.childToMain.has('src/App.vue')).toBe(false)
  })

  it('index.ts + index.spec.ts + index.d.ts：同基名族全折叠', () => {
    const entries = [f('utils/index.ts'), f('utils/index.spec.ts'), f('utils/index.d.ts')]
    const g = buildNestGroups(entries)
    expect(g.childToMain.get('utils/index.spec.ts')).toBe('utils/index.ts')
    expect(g.childToMain.get('utils/index.d.ts')).toBe('utils/index.ts')
  })

  it('同基名其他扩展族：js 折叠进 ts，目录外的同名不成族', () => {
    const entries = [f('a/index.ts'), f('a/index.js'), f('b/index.js')]
    const g = buildNestGroups(entries)
    expect(g.childToMain.get('a/index.js')).toBe('a/index.ts')
    expect(g.childToMain.has('b/index.js')).toBe(false)
  })

  it('主文件资格：无优先扩展名邻居时保持平铺', () => {
    // foo.md 不能当主文件；css 子文件无主 → 平铺
    const entries = [f('docs/foo.md'), f('docs/foo.css')]
    const g = buildNestGroups(entries)
    expect(g.childToMain.size).toBe(0)
    expect(g.mainToChildren.size).toBe(0)
  })

  it('目录边界：不同目录同名基名互不收纳；目录行不参与', () => {
    const entries = [f('a'), f('a/foo.ts'), f('b/foo.test.ts')]
    const g = buildNestGroups(entries)
    expect(g.childToMain.size).toBe(0)
  })

  it('vue 优先于 ts：foo.vue + foo.ts + foo.test.ts 归一到一个主行', () => {
    const entries = [f('c/foo.ts'), f('c/foo.vue'), f('c/foo.test.ts')]
    const g = buildNestGroups(entries)
    expect(g.childToMain.get('c/foo.ts')).toBe('c/foo.vue')
    expect(g.childToMain.get('c/foo.test.ts')).toBe('c/foo.vue')
    expect(g.mainToChildren.get('c/foo.vue')).toHaveLength(2)
  })

  it('单层嵌套：子文件不再收纳自己的同族（.test.css 无主则平铺）', () => {
    const entries = [f('x/foo.test.ts'), f('x/foo.test.css'), f('x/foo.ts')]
    const g = buildNestGroups(entries)
    // foo.test.css 的基名是 foo.test，主候选 foo.test.ts 已是子文件 → 不成族
    expect(g.childToMain.get('x/foo.test.css')).toBeUndefined()
    expect(g.childToMain.get('x/foo.test.ts')).toBe('x/foo.ts')
  })

  it('大小写敏感：基名 Foo 与 foo 不成族', () => {
    const entries = [f('d/Foo.ts'), f('d/foo.test.ts')]
    const g = buildNestGroups(entries)
    expect(g.childToMain.size).toBe(0)
  })
})

describe('applyNestGroups', () => {
  const family = [
    f('src/components'),
    f('src/components/Card.css'),
    f('src/components/Card.vue'),
    f('src/components/Card.test.ts'),
    f('src/components/Other.vue'),
  ]
  const g = buildNestGroups(family)

  it('折叠态：子行隐藏、其余行原序保留', () => {
    const rows = applyNestGroups(family, g, new Set())
    expect(rows.map(r => r.path)).toEqual([
      'src/components',
      'src/components/Card.vue',
      'src/components/Other.vue',
    ])
  })

  it('展开态：子行紧随主行之后（不按平铺字母序位出现）', () => {
    const rows = applyNestGroups(family, g, new Set(['src/components/Card.vue']))
    expect(rows.map(r => r.path)).toEqual([
      'src/components',
      'src/components/Card.vue',
      'src/components/Card.css',
      'src/components/Card.test.ts',
      'src/components/Other.vue',
    ])
  })

  it('开关关闭（无归组）：恒等透传', () => {
    expect(applyNestGroups(family, { childToMain: new Map(), mainToChildren: new Map() }, new Set()))
      .toEqual(family)
  })
})
