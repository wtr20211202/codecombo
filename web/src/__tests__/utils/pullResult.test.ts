import { describe, it, expect } from 'vitest'
import { pullResultSummary, isConflictPullError } from '../../utils/pullResult'

// pull 结果摘要分档（P-20261003-202）：三档键选择 + 计数边界
describe('pullResultSummary', () => {
  it('有新提交：success + 计数键', () => {
    expect(pullResultSummary(3)).toEqual({
      level: 'success',
      key: 'layout.pullSuccessWithCount',
      params: { n: 3 },
    })
  })

  it('零提交：info 轻提示（已最新）', () => {
    expect(pullResultSummary(0)).toEqual({ level: 'info', key: 'layout.pullUpToDate' })
  })

  it('无法计量（-1/undefined/null）：回落既有成功文案不回退', () => {
    for (const v of [-1, undefined, null]) {
      expect(pullResultSummary(v)).toEqual({ level: 'success', key: 'layout.pullSuccess' })
    }
  })
})

// 冲突形态 pull 失败判定（P-20261004-44）：标记双源（rawMessage=stderr 兜 +
// data.output=stdout 主源）+ 非 AppError 形态兜底
describe('isConflictPullError', () => {
  it('真实 409 形态：stderr 为空，CONFLICT 行在 data.output（主源）', () => {
    expect(isConflictPullError({
      rawMessage: 'git pull: ',
      data: { output: 'Auto-merging a.txt\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.\n' },
    })).toBe(true)
  })

  it('AppError 形态：rawMessage 含 CONFLICT 行（stderr 偶带冲突措辞）也命中', () => {
    expect(isConflictPullError({
      rawMessage: 'git pull: From origin\n   main -> FETCH_HEAD\nCONFLICT (content): Merge conflict in a.txt\nAutomatic merge failed; fix conflicts and then commit the result.',
    })).toBe(true)
  })

  it('大小写不敏感：仅小写 merge conflict 尾行也命中', () => {
    expect(isConflictPullError({ rawMessage: 'git pull: error: Merge conflict in b.txt' })).toBe(true)
    expect(isConflictPullError({ data: { output: 'conflict markers detected in c.txt' } })).toBe(true)
  })

  it('非冲突失败（网络/认证/无上游/写排队超时）不误报', () => {
    for (const msg of [
      'git pull: fatal: Authentication failed',
      'git pull: fatal: no tracking information for the current branch',
      'git pull: another git write operation is still in progress',
      'git pull: ',
    ]) {
      expect(isConflictPullError({ rawMessage: msg, data: { output: '' } })).toBe(false)
    }
  })

  it('兜底形态：裸 Error（message）/字符串/空值不抛', () => {
    expect(isConflictPullError(new Error('CONFLICT (modify/delete): x.txt'))).toBe(true)
    expect(isConflictPullError('git pull: merge conflict in y.txt')).toBe(true)
    expect(isConflictPullError(undefined)).toBe(false)
    expect(isConflictPullError(null)).toBe(false)
    expect(isConflictPullError({})).toBe(false)
  })
})
