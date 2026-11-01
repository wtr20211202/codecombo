import { describe, expect, it } from 'vitest'
import {
  APPROVAL_PATTERN_THRESHOLD,
  APPROVAL_PATTERN_WINDOW_MS,
  APPROVAL_SUGGEST_SHOWN_KEY,
  APPROVAL_SUGGEST_THROTTLE_MS,
  AUTO_ALLOW_GAP_MS,
  SHOWN_MAP_MAX,
  countManualAllows,
  deriveOpPrefix,
  detectAllowPattern,
  isManualAllow,
  isPatternThrottled,
  loadShownMap,
  ruleCoversOp,
  saveShownMap,
  type ApprovalPatternRecord,
} from './approvalPattern'

// 审批模式自学习检测（P-20261006-28）纯函数单测：前缀派生 / 人工允许判定
// （ruleHit 与落库间隔双排除）/ 规则覆盖判定 / 近窗计数与阈值 / 节流表
// 读写与封顶。时间全部显式注入（now 参数时间旅行），不依赖真实时钟

const NOW = Date.parse('2026-10-13T12:00:00Z')

/** 造一条 N 天前人工允许的记录（间隔 1h，远超自动落库分界） */
function manualAllow(op: string, daysAgo: number, over: Partial<ApprovalPatternRecord> = {}): ApprovalPatternRecord {
  const resolved = new Date(NOW - daysAgo * 24 * 3600 * 1000).toISOString()
  return {
    op,
    status: 'allowed',
    ruleHit: '',
    createdAt: new Date(Date.parse(resolved) - 3600 * 1000).toISOString(),
    resolvedAt: resolved,
    ...over,
  }
}

describe('deriveOpPrefix', () => {
  it('git 开头取前两 token（子命令是语义边界）', () => {
    expect(deriveOpPrefix('git push origin release/v1')).toBe('git push')
    expect(deriveOpPrefix('git reset --hard HEAD~1')).toBe('git reset')
  })

  it('非 git 取首 token（命名空间形/守护路由标签形）', () => {
    expect(deriveOpPrefix('files.write docs/a.md')).toBe('files.write')
    expect(deriveOpPrefix('批量替换 src/**/*.ts')).toBe('批量替换')
  })

  it('单 token op 前缀即自身；空白 op 返回空串（不可检测）', () => {
    expect(deriveOpPrefix('deploy')).toBe('deploy')
    expect(deriveOpPrefix('   ')).toBe('')
    expect(deriveOpPrefix('')).toBe('')
  })
})

describe('isManualAllow', () => {
  it('allowed + 无 ruleHit + 间隔超分界 = 人工允许', () => {
    expect(isManualAllow(manualAllow('git push', 1))).toBe(true)
  })

  it('非 allowed 终态不计（拒绝模式不建议——信任方向单向）', () => {
    expect(isManualAllow(manualAllow('git push', 1, { status: 'denied' }))).toBe(false)
    expect(isManualAllow(manualAllow('git push', 1, { status: 'pending' }))).toBe(false)
  })

  it('ruleHit 非空不计（规则裁决/已有规则覆盖的 ask 命中）', () => {
    expect(isManualAllow(manualAllow('git push', 1, { ruleHit: 'git push' }))).toBe(false)
  })

  it('间隔 ≤ 分界不计（全局档位/规则 allow 落库即终态的自动放行）', () => {
    const at = new Date(NOW - 3600 * 1000).toISOString()
    expect(isManualAllow({
      op: 'git push', status: 'allowed', ruleHit: '',
      createdAt: at, resolvedAt: new Date(Date.parse(at) + AUTO_ALLOW_GAP_MS).toISOString(),
    })).toBe(false)
  })

  it('时间戳缺失/坏值按不可判处理（不计入，宁漏不计）', () => {
    expect(isManualAllow({ op: 'git push', status: 'allowed', ruleHit: '' })).toBe(false)
    expect(isManualAllow(manualAllow('git push', 1, { resolvedAt: 'not-a-date' }))).toBe(false)
  })
})

describe('ruleCoversOp', () => {
  const rules = [{ opPattern: 'git push' }, { opPattern: 'FILES.WRITE' }, { opPattern: '' }]

  it('任一规则 opPattern 前缀命中即覆盖（大小写不敏感，同服务端口径）', () => {
    expect(ruleCoversOp(rules, 'git push origin main')).toBe(true)
    expect(ruleCoversOp(rules, 'git push')).toBe(true)
    expect(ruleCoversOp(rules, 'files.write a.md')).toBe(true)
  })

  it('无命中/规则表为空 = 未覆盖', () => {
    expect(ruleCoversOp(rules, 'git reset --hard')).toBe(false)
    expect(ruleCoversOp([], 'git push')).toBe(false)
  })

  it('空 op 视为已覆盖（不可检测方向保守）；空 pattern 规则跳过', () => {
    expect(ruleCoversOp([], '')).toBe(true)
    expect(ruleCoversOp([{ opPattern: '' }], 'git push')).toBe(false)
  })
})

describe('countManualAllows', () => {
  it('同前缀（大小写不敏感归一）且在窗内的人工允许计数', () => {
    const records = [
      manualAllow('git push origin release/v1', 0.1),
      manualAllow('GIT PUSH origin release/v2', 1),
      manualAllow('git push origin main', 6),
      // 不同前缀 / 非人工 / 出窗各一
      manualAllow('git reset --hard', 1),
      manualAllow('git push origin x', 1, { ruleHit: 'git push' }),
      manualAllow('git push origin y', 8),
    ]
    expect(countManualAllows(records, 'git push', NOW)).toBe(3)
  })

  it('空前缀/无匹配返回 0', () => {
    expect(countManualAllows([manualAllow('git push', 1)], '', NOW)).toBe(0)
    expect(countManualAllows([], 'git push', NOW)).toBe(0)
  })
})

describe('detectAllowPattern', () => {
  it('达阈值且无规则覆盖 → 返回前缀与计数', () => {
    const records = [1, 2, 3].map(i => manualAllow(`git push origin release/v${i}`, 1))
    expect(detectAllowPattern(records, 'git push origin release/v4', [], NOW))
      .toEqual({ pattern: 'git push', count: 3 })
  })

  it('未达阈值 / 已有规则覆盖 / 空前缀 → null', () => {
    const records = [1, 2].map(i => manualAllow(`git push origin release/v${i}`, 1))
    expect(detectAllowPattern(records, 'git push origin v3', [], NOW)).toBeNull()
    expect(detectAllowPattern(
      [1, 2, 3].map(i => manualAllow(`git push origin release/v${i}`, 1)),
      'git push origin v4',
      [{ opPattern: 'git push' }],
      NOW,
    )).toBeNull()
    expect(detectAllowPattern(records, '  ', [], NOW)).toBeNull()
  })

  it('阈值/窗口参数化：默认常量对齐提案定值（≥3 次 / 7 天）', () => {
    expect(APPROVAL_PATTERN_THRESHOLD).toBe(3)
    expect(APPROVAL_PATTERN_WINDOW_MS).toBe(7 * 24 * 3600 * 1000)
  })
})

describe('节流表（单键 JSON map）', () => {
  const iso = (ms: number) => new Date(ms).toISOString()

  it('loadShownMap：正常读回 / 坏 JSON / 非对象 / 坏条目跳过 / 缺键空表', () => {
    expect(loadShownMap(() => JSON.stringify({ 'git push': iso(NOW) })))
      .toEqual({ 'git push': iso(NOW) })
    expect(loadShownMap(() => 'not-json')).toEqual({})
    expect(loadShownMap(() => JSON.stringify([1]))).toEqual({})
    expect(loadShownMap(() => JSON.stringify({ 'git push': 3, '': iso(NOW), ok: iso(NOW) })))
      .toEqual({ ok: iso(NOW) })
    expect(loadShownMap(() => null)).toEqual({})
  })

  it('isPatternThrottled：窗内 true、出窗/缺条目 false、key 小写归一', () => {
    const map = { 'git push': iso(NOW - APPROVAL_SUGGEST_THROTTLE_MS + 1000) }
    expect(isPatternThrottled(map, 'Git Push', NOW)).toBe(true)
    expect(isPatternThrottled(map, 'git push', NOW + APPROVAL_SUGGEST_THROTTLE_MS + 1)).toBe(false)
    expect(isPatternThrottled({}, 'git push', NOW)).toBe(false)
    expect(isPatternThrottled({ 'git push': 'bad' }, 'git push', NOW)).toBe(false)
  })

  it('saveShownMap：清出窗条目 + 超限裁最旧（返回瘦身后的表）', () => {
    const saved = saveShownMap({
      stale: iso(NOW - APPROVAL_SUGGEST_THROTTLE_MS - 1),
      fresh: iso(NOW),
    }, NOW)
    expect(saved).toEqual({ fresh: iso(NOW) })

    const flood: Record<string, string> = {}
    for (let i = 0; i < SHOWN_MAP_MAX + 5; i++) {
      flood[`p${String(i).padStart(3, '0')}`] = iso(NOW - i * 1000)
    }
    const capped = saveShownMap(flood, NOW)
    expect(Object.keys(capped)).toHaveLength(SHOWN_MAP_MAX)
    // 时刻最新的 50 条留存（p000 最新），最旧的 5 条（p050 起）被裁掉
    expect(capped.p000).toBeDefined()
    expect(capped.p049).toBeDefined()
    expect(capped.p050).toBeUndefined()
  })

  it('存储键为 safeStorage 单键约定串', () => {
    expect(APPROVAL_SUGGEST_SHOWN_KEY).toBe('sc.approvalRuleSuggestShown')
  })
})
