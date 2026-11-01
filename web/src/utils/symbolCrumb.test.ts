// symbolCrumb 纯函数单测（P-20261005-195）：归属二分 × 排序归一 × 同层下拉数据。
// 归属正确性另配「与线性扫描对照」的暴力互检（合成乱序深树），防二分边界回归。
import { describe, expect, it } from 'vitest'
import {
  symbolChainAtLine, symbolSiblingsOf, toCrumbRefs, toCrumbSymbols,
  type CrumbSymbol, type DocumentSymbolLite,
} from './symbolCrumb'

/** 构造 provider 原始形态（range 面必填、children 可省） */
function sym(name: string, start: number, end: number, children?: DocumentSymbolLite[]): DocumentSymbolLite {
  return { name, kind: 12, range: { startLineNumber: start, endLineNumber: end }, children }
}

/** 线性暴力归属（互检基准：全树深度优先序首个包含者链） */
function bruteForceChain(roots: CrumbSymbol[], line: number): CrumbSymbol[] {
  const chain: CrumbSymbol[] = []
  let nodes = roots
  for (;;) {
    const hit = nodes.find(n => line >= n.line && line <= n.endLine)
    if (!hit) return chain
    chain.push(hit)
    nodes = hit.children
  }
}

describe('toCrumbSymbols', () => {
  it('归一化：剔无名/无范围畸形项，range 折叠为行区间，children 递归收编', () => {
    const tree = toCrumbSymbols([
      sym('a', 3, 8),
      sym('', 1, 2), // 无名占位（部分 provider 产空名）→ 剔
      { name: 'bad', kind: 1 } as unknown as DocumentSymbolLite, // 无 range → 剔
      sym('b', 1, 2, [sym('b1', 2, 2), sym('bad-child', 99, 90)]), // endLine<line 畸形 → 单行收敛
      { name: 'nokind', range: { startLineNumber: 1, endLineNumber: 1 } } as unknown as DocumentSymbolLite, // 缺 kind → 0 兜底
    ])
    expect(tree.map(s => s.name)).toEqual(['b', 'nokind', 'a']) // 同层按起始行排序
    expect(tree[0]!.children.map(s => `${s.name}:${s.line}-${s.endLine}`)).toEqual(['b1:2-2', 'bad-child:99-99'])
    expect(tree[1]!.kind).toBe(0)
  })

  it('空输入/全畸形输入返回空数组（UI 零降级不显示空段的前提）', () => {
    expect(toCrumbSymbols([])).toEqual([])
    expect(toCrumbSymbols([null as unknown as DocumentSymbolLite, sym('', 1, 1)])).toEqual([])
  })
})

describe('symbolChainAtLine', () => {
  // 模拟真实 TS 文件形态：两个顶层函数 + 一个类（方法嵌套其中）
  const roots = toCrumbSymbols([
    sym('alphaOne', 1, 3),
    sym('alphaTwo', 5, 7),
    sym('Greeter', 9, 15, [
      sym('greet', 10, 12),
      sym('farewell', 13, 15),
    ]),
  ])

  it('顶层函数归属：链 = [函数]；类方法归属：链 = [类, 方法]', () => {
    expect(symbolChainAtLine(roots, 2).map(s => s.name)).toEqual(['alphaOne'])
    expect(symbolChainAtLine(roots, 6).map(s => s.name)).toEqual(['alphaTwo'])
    expect(symbolChainAtLine(roots, 11).map(s => s.name)).toEqual(['Greeter', 'greet'])
    expect(symbolChainAtLine(roots, 14).map(s => s.name)).toEqual(['Greeter', 'farewell'])
  })

  it('符号间空隙（import 区/顶层空行）返回空链——面包屑不显示空段', () => {
    expect(symbolChainAtLine(roots, 4)).toEqual([])
    expect(symbolChainAtLine(roots, 8)).toEqual([])
    expect(symbolChainAtLine([], 1)).toEqual([])
  })

  it('边界行命中：首行（含签名行）与 endLine 均归属该符号', () => {
    expect(symbolChainAtLine(roots, 9).map(s => s.name)).toEqual(['Greeter'])
    expect(symbolChainAtLine(roots, 15).map(s => s.name)).toEqual(['Greeter', 'farewell'])
  })

  it('畸形重叠回看：二分候选不含本行时回退前一符号（有界一步）', () => {
    // A 的 range 畸形吞掉 B 之后的行：line=9 二分命 B(4-5) 不含，回看一步落 A
    const overlap = toCrumbSymbols([sym('B', 4, 5), sym('A', 1, 10)])
    expect(overlap.map(s => s.name)).toEqual(['A', 'B'])
    expect(symbolChainAtLine(overlap, 9).map(s => s.name)).toEqual(['A'])
    // 回看一步仍不含则止步（链停在上一层），不无限前扫
    expect(symbolChainAtLine(overlap, 20)).toEqual([])
  })

  it('二分定位与线性扫描互检：合成 300 乱序深树逐行对照全等', () => {
    // 乱序 + 行间空隙 + 每符号 2 层嵌套，覆盖二分右界/回看步/下潜三条路径
    const raw: DocumentSymbolLite[] = []
    let ln = 1
    for (let i = 0; i < 60; i++) {
      const topStart = ln
      const kids: DocumentSymbolLite[] = []
      ln += 1 // 签名行
      for (let j = 0; j < 5; j++) {
        kids.push(sym(`m${i}_${j}`, ln, ln + 1))
        ln += 3 // 体 2 行 + 1 空隙
      }
      raw.push(sym(`top${i}`, topStart, ln, kids))
      ln += 2 // 顶层间空隙
    }
    // 故意乱序喂入：归一化必须先排序，二分才成立
    const shuffled = [...raw].sort(() => Math.random() - 0.5)
    const tree = toCrumbSymbols(shuffled)
    for (let line = 1; line <= ln + 2; line++) {
      const viaBisect = symbolChainAtLine(tree, line).map(s => s.name)
      const viaLinear = bruteForceChain(tree, line).map(s => s.name)
      expect(viaBisect).toEqual(viaLinear)
    }
  })
})

describe('symbolSiblingsOf', () => {
  const roots = toCrumbSymbols([
    sym('alphaOne', 1, 3),
    sym('Greeter', 9, 15, [sym('greet', 10, 12), sym('farewell', 13, 15)]),
  ])

  it('链空 = 顶层符号（下拉列文件级符号）', () => {
    expect(symbolSiblingsOf(roots, []).map(s => s.name)).toEqual(['alphaOne', 'Greeter'])
  })

  it('链尾同层 = 父的孩子（含尾段自身，供 UI 高亮当前项）', () => {
    const chain = symbolChainAtLine(roots, 11)
    expect(symbolSiblingsOf(roots, chain).map(s => s.name)).toEqual(['greet', 'farewell'])
    // 顶层函数尾段的同层 = 文件顶层
    const top = symbolChainAtLine(roots, 2)
    expect(symbolSiblingsOf(roots, top).map(s => s.name)).toEqual(['alphaOne', 'Greeter'])
  })
})

describe('toCrumbRefs', () => {
  it('映射为 UI 载荷三字段，剥离 children 树引用', () => {
    const tree = toCrumbSymbols([sym('a', 1, 2, [sym('a1', 2, 2)])])
    expect(toCrumbRefs(tree)).toEqual([{ name: 'a', kind: 12, line: 1 }])
  })
})
