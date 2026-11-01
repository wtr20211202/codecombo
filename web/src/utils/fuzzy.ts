// 模糊匹配打分：quick open / 命令面板的过滤与排序核心。
// query 是 target 的不区分大小写子序列即视为命中，返回分数（越大越好）；
// 否则返回 null。纯子串过滤的痛点：`urepo` 匹配不到 `useRepo.ts`，
// camelCase / 分隔符断词完全无法跨越，而子序列匹配正是 quick open 的业界惯例。

// 权重均为整数，便于单测精确断言。相对关系是设计意图：
// 词首(8) > 连续(5) > 靠前(4) > 单字(1)，前置字符每个扣 1 分引导靠前匹配。
const SCORE_CHAR = 1
const SCORE_CONSECUTIVE = 5
const SCORE_BOUNDARY = 8
const SCORE_FIRST = 4
const LEAD_PENALTY = 1

const NEG = -1e9

function isSeparator(code: number): boolean {
  // / \ . - _ 空格：路径与标识符里最常见的断词点
  return code === 47 || code === 92 || code === 46 || code === 45 || code === 95 || code === 32
}

function isBoundaryAt(t: string, j: number): boolean {
  if (j === 0) return true
  const prev = t.charCodeAt(j - 1)
  const cur = t.charCodeAt(j)
  if (isSeparator(prev)) return true
  // camelCase 驼峰：小写或数字后跟大写
  if (cur >= 65 && cur <= 90 && ((prev >= 97 && prev <= 122) || (prev >= 48 && prev <= 57))) return true
  return false
}

/** 单词匹配：子序列 DP，连续/词首/靠前加权 */
function scoreOne(query: string, target: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  // t 保留原始大小写供驼峰边界判断，字符比较用小写
  const t = target
  const tl = target.toLowerCase()
  const n = q.length
  const m = t.length
  if (n > m) return null
  // 廉价预筛：query 的每个字符都必须在 target 中出现，挡掉绝大多数 DP
  const need = new Set(q)
  for (const ch of tl) need.delete(ch)
  if (need.size > 0) return null

  // dp[i][j]：q[0..i) 已匹配且 q[i-1] 命中 t[j-1]（0 基）时的最优分
  const dp: number[][] = []
  for (let i = 0; i <= n; i++) dp.push(new Array<number>(m + 1).fill(NEG))
  dp[0]![0] = 0
  for (let i = 1; i <= n; i++) {
    // prefixMax：q[i-1] 可衔接的更早命中位置（t 下标 < j-1）的最优分
    let prefixMax = NEG
    for (let j = 1; j <= m; j++) {
      const prevRow = dp[i - 1]![j - 1]!
      if (tl.charCodeAt(j - 1) === q.charCodeAt(i - 1)) {
        let best = NEG
        const bonus = isBoundaryAt(t, j - 1) ? SCORE_BOUNDARY : 0
        if (i === 1) {
          // 首个命中：靠前奖励 − 前置字符扣分
          best = Math.max(best, SCORE_FIRST - (j - 1) * LEAD_PENALTY + SCORE_CHAR + bonus)
        } else {
          if (prevRow > NEG / 2) best = Math.max(best, prevRow + SCORE_CHAR + bonus + SCORE_CONSECUTIVE)
          if (prefixMax > NEG / 2) best = Math.max(best, prefixMax + SCORE_CHAR + bonus)
        }
        dp[i]![j] = best
      }
      if (prevRow > prefixMax) prefixMax = prevRow
    }
  }
  let best = NEG
  for (let j = 1; j <= m; j++) {
    if (dp[n]![j]! > best) best = dp[n]![j]!
  }
  return best > NEG / 2 ? best : null
}

/**
 * 模糊匹配（多 token）：query 按空白拆分，每个 token 都必须命中（AND 语义），
 * 总分为各 token 之和；空 query 返回 0（调用方按「全部命中」处理）。
 */
export function fuzzyMatch(query: string, target: string): number | null {
  const tokens = query.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return 0
  let total = 0
  for (const tok of tokens) {
    const s = scoreOne(tok, target)
    if (s === null) return null
    total += s
  }
  return total
}

/**
 * 双字段加权：主字段（文件名 / 命令标题）命中权重 ×2——名字比路径/关键词
 * 更代表条目（VS Code quick open 惯例）。两处都未命中返回 null。
 */
export function fuzzyScoreWeighted(query: string, primary: string, secondary?: string): number | null {
  const ps = fuzzyMatch(query, primary)
  const ss = secondary ? fuzzyMatch(query, secondary) : null
  if (ps === null && ss === null) return null
  return Math.max(ps === null ? NEG : ps * 2, ss === null ? NEG : ss)
}
