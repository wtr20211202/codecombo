// 面包屑符号段纯函数（P-20261005-195）：monaco DocumentSymbol 树 → 光标归属
// 祖先链 → 面包屑段/同层下拉数据。零依赖（不经 monaco 命名空间、不经 store），
// jsdom 直测——monacoImportResolve 同款分层纪律（monaco 类型面以最小结构接口
// 表达，utils 不 import monaco，桥接层用结构类型对接）。
//
// 归属口径 = range 全范围包含（VS Code 面包屑同款：光标在符号签名/空行/函数体
// 内都算「在该符号里」，selectionRange 仅标记声明位置不参与判定）。

/** monaco DocumentSymbol 的最小结构面（桥接层直传 provider 原始输出） */
export interface DocumentSymbolLite {
  name: string
  kind: number
  range: { startLineNumber: number; endLineNumber: number }
  children?: DocumentSymbolLite[]
}

/** 面包屑符号段节点：行号为 1 基闭区间（含 endLine——空体/单行符号可命中） */
export interface CrumbSymbol {
  name: string
  kind: number
  line: number
  endLine: number
  children: CrumbSymbol[]
}

/** 面包屑 UI 载荷形态：只留渲染与跳转所需三字段（kind 留作符号类型图标扩展位） */
export interface CrumbSymbolRef {
  name: string
  kind: number
  line: number
}

/** provider 原始输出 → 归一化符号树：剔无名项（有的 provider 产占位空名）、
 *  递归收编 children、同层按起始行排序（二分定位的前置不变量）。行号防越界
 *  （endLine < line 的畸形项按单行收敛，不丢弃——VS Code 同样容忍畸形范围） */
export function toCrumbSymbols(roots: readonly DocumentSymbolLite[]): CrumbSymbol[] {
  const out: CrumbSymbol[] = []
  for (const s of roots) {
    if (!s || typeof s.name !== 'string' || !s.name) continue
    const r = s.range
    if (!r || typeof r.startLineNumber !== 'number' || typeof r.endLineNumber !== 'number') continue
    const line = Math.max(1, Math.floor(r.startLineNumber))
    const endLine = Math.max(line, Math.floor(r.endLineNumber))
    out.push({
      name: s.name,
      kind: typeof s.kind === 'number' ? s.kind : 0,
      line,
      endLine,
      children: s.children ? toCrumbSymbols(s.children) : [],
    })
  }
  out.sort((a, b) => a.line - b.line)
  return out
}

/** 同层内二分：rightmost 满足 startLine <= line 的下标；全在 line 之后返回 -1 */
function bisectLastAtOrBefore(nodes: readonly CrumbSymbol[], line: number): number {
  let lo = 0
  let hi = nodes.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (nodes[mid]!.line <= line) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** 行号 → 符号祖先链（含当前符号）：同层二分定位候选后向下递归。常规文件同层
 *  符号按 startLine 不重叠，二分候选即包含者；畸形重叠（前一符号 range 吞掉
 *  本行）回看一步兜底（回看步数有界——再往前的不重叠序下不可能包含，防畸形
 *  输入把每层拖成 O(n)）——每层 O(log n) + 常数步，高频光标移动零压力 */
export function symbolChainAtLine(roots: readonly CrumbSymbol[], line: number): CrumbSymbol[] {
  let nodes = roots
  const chain: CrumbSymbol[] = []
  for (;;) {
    const idx = bisectLastAtOrBefore(nodes, line)
    // 候选与前一符号二选一（前一同层符号畸形吞行的兜底步）
    const hit
      = (idx >= 0 && line >= nodes[idx]!.line && line <= nodes[idx]!.endLine)
        ? nodes[idx]!
        : (idx - 1 >= 0 && line >= nodes[idx - 1]!.line && line <= nodes[idx - 1]!.endLine)
            ? nodes[idx - 1]!
            : null
    if (!hit) return chain
    chain.push(hit)
    nodes = hit.children
    if (nodes.length === 0) return chain
  }
}

/** 尾段同层符号（下拉列表数据）：链空 = 顶层符号；链非空 = 链尾的父的孩子
 *  （含链尾自身，UI 高亮当前项——VS Code 面包屑下拉同形态） */
export function symbolSiblingsOf(roots: readonly CrumbSymbol[], chain: readonly CrumbSymbol[]): CrumbSymbol[] {
  if (chain.length === 0) return [...roots]
  const tail = chain[chain.length - 1]!
  // 链尾孩子即「下一层」，不是同层——同层看父的孩子；顶层链尾的父是文件根
  return siblingsAmong(roots, tail)
}

function siblingsAmong(nodes: readonly CrumbSymbol[], target: CrumbSymbol): CrumbSymbol[] {
  for (const n of nodes) {
    if (n === target) return [...nodes]
    const found = siblingsAmong(n.children, target)
    if (found.length) return found
  }
  return []
}

/** 树 → UI 载荷映射（去 children 引用，防大对象跨组件持有） */
export function toCrumbRefs(list: readonly CrumbSymbol[]): CrumbSymbolRef[] {
  return list.map(s => ({ name: s.name, kind: s.kind, line: s.line }))
}
