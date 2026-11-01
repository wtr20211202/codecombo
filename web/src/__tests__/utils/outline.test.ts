import { describe, expect, it } from 'vitest'
import { extractCodeOutline, extractMarkdownOutline, extractOutline, isMarkdownPath } from '../../utils/outline'

describe('extractMarkdownOutline', () => {
  it('提取 ATX 标题并带层级与行号', () => {
    const md = '# Title\n\ntext\n## Section\n### Sub'
    const items = extractMarkdownOutline(md)
    expect(items).toEqual([
      { level: 1, text: 'Title', line: 1 },
      { level: 2, text: 'Section', line: 4 },
      { level: 3, text: 'Sub', line: 5 },
    ])
  })

  it('提取 Setext 标题（=== 与 ---）', () => {
    const md = 'Title\n=====\n\ntext\nSub\n---'
    const items = extractMarkdownOutline(md)
    expect(items).toEqual([
      { level: 1, text: 'Title', line: 1 },
      { level: 2, text: 'Sub', line: 5 },
    ])
  })

  it('代码围栏外的无标题文档返回空', () => {
    expect(extractMarkdownOutline('plain text\nno headings')).toEqual([])
  })
})

describe('extractCodeOutline', () => {
  it('Go：顶层函数与类型（struct/interface）', () => {
    const go = [
      'package main',
      '',
      'import "fmt"',
      '',
      'type Server struct {',
      '\tport int',
      '}',
      '',
      'func main() {',
      '\tfmt.Println("hi")',
      '}',
      '',
      'type Handler interface {',
      '\tServe()',
      '}',
      '',
      'func (s *Server) Start() error {',
      '\treturn nil',
      '}',
    ].join('\n')
    const items = extractCodeOutline('go', go)
    expect(items).toEqual([
      { level: 1, text: 'type Server', line: 5 },
      { level: 1, text: 'func main()', line: 9 },
      { level: 1, text: 'type Handler', line: 13 },
      { level: 1, text: 'func Start()', line: 17 },
    ])
  })

  it('Go：if/for 等非声明行不计入', () => {
    const go = 'func f() {\n\tif err != nil {\n\t\tfor i := range xs {\n\t\t}\n\t}\n}'
    const items = extractCodeOutline('go', go)
    expect(items).toEqual([{ level: 1, text: 'func f()', line: 1 }])
  })

  it('TS：function/class/interface/type/const 箭头函数', () => {
    const ts = [
      'export interface Foo { a: number }',
      'export type Bar = string',
      'export class Impl implements Foo {',
      '  method() {}',
      '}',
      'export function helper(): void {}',
      'const arrow = (x: number) => x',
    ].join('\n')
    const items = extractCodeOutline('ts', ts)
    expect(items).toEqual([
      { level: 2, text: 'interface Foo', line: 1 },
      { level: 2, text: 'type Bar', line: 2 },
      { level: 1, text: 'class Impl', line: 3 },
      { level: 1, text: 'function helper()', line: 6 },
      { level: 2, text: 'const arrow()', line: 7 },
    ])
  })

  it('Python：class 一级、def 二级', () => {
    const py = 'class App:\n    def run(self):\n        pass\n\ndef main():\n    App().run()'
    const items = extractCodeOutline('py', py)
    expect(items).toEqual([
      { level: 1, text: 'class App', line: 1 },
      { level: 2, text: 'def run()', line: 2 },
      { level: 2, text: 'def main()', line: 5 },
    ])
  })

  it('不支持的扩展名返回空（json/无扩展名）', () => {
    expect(extractCodeOutline('json', '{"a": 1}')).toEqual([])
    expect(extractCodeOutline('', 'func main() {}')).toEqual([])
  })

  it('空内容返回空', () => {
    expect(extractCodeOutline('go', '')).toEqual([])
    expect(extractMarkdownOutline('')).toEqual([])
  })
})

describe('extractOutline', () => {
  it('按扩展名分发 md 与代码', () => {
    expect(extractOutline('a.md', '# H')).toEqual([{ level: 1, text: 'H', line: 1 }])
    expect(extractOutline('a.go', 'func main() {}')).toEqual([{ level: 1, text: 'func main()', line: 1 }])
  })

  it('空内容/无扩展名返回空', () => {
    expect(extractOutline('a.go', '')).toEqual([])
    expect(extractOutline('noext', 'func main() {}')).toEqual([])
  })

  it('isMarkdownPath 大小写不敏感识别 md/markdown', () => {
    expect(isMarkdownPath('a.MD')).toBe(true)
    expect(isMarkdownPath('readme.Markdown')).toBe(true)
    expect(isMarkdownPath('a.go')).toBe(false)
  })
})
