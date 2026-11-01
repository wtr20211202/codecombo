import { describe, expect, it } from 'vitest'
import {
  COMMIT_MSG_MAX_LEN,
  subjectLineOf,
  validateCommitMsg,
  validateCommitSubject,
} from './commitMsgRules'

/**
 * 提交信息规范校验纯函数（P-20261003-273）：规则语义与 scripts/check-commit-msg.cjs
 * （P-20261002-92 门禁）逐条对齐——格式 / 类型白名单 / scope 非空 / 标题非空 /
 * 长度上限 / Merge、Revert 跳过。
 */

describe('subjectLineOf 标题行提取', () => {
  it('取首个非空非注释行', () => {
    expect(subjectLineOf('feat: 标题\n\n正文')).toBe('feat: 标题')
  })
  it('跳过 # 注释行（模板预填/历史回填的帮助块）与空行', () => {
    expect(subjectLineOf('# 帮助\n\n  fix: 实际标题')).toBe('fix: 实际标题')
  })
  it('空信息返回空串', () => {
    expect(subjectLineOf('')).toBe('')
    expect(subjectLineOf('# 只有注释\n')).toBe('')
  })
  it('兼容 CRLF', () => {
    expect(subjectLineOf('fix: win\r\n\r\nbody')).toBe('fix: win')
  })
})

describe('validateCommitSubject 规则矩阵', () => {
  it('合规信息零违规（带/不带 scope）', () => {
    expect(validateCommitSubject('feat: 标题')).toEqual([])
    expect(validateCommitSubject('fix(web): 修门禁')).toEqual([])
  })
  it('Merge/Revert 自动信息跳过', () => {
    expect(validateCommitSubject('Merge branch \'main\' of https://x')).toEqual([])
    expect(validateCommitSubject('Revert "feat: 旧提交"')).toEqual([])
  })
  it('空标题 → subject', () => {
    expect(validateCommitSubject('')).toEqual([{ rule: 'subject' }])
    expect(validateCommitSubject('   ')).toEqual([{ rule: 'subject' }])
  })
  it('不符 type(scope): 格式 → format', () => {
    expect(validateCommitSubject('没有前缀的标题')).toEqual([{ rule: 'format' }])
    expect(validateCommitSubject('1feat: 数字开头类型不符')).toEqual([{ rule: 'format' }])
  })
  it('类型不在白名单 → type（带类型名参数）', () => {
    expect(validateCommitSubject('combo: 直推成功提交')).toEqual([{ rule: 'type', type: 'combo' }])
    expect(validateCommitSubject('c2: 修补后的新消息')).toEqual([{ rule: 'type', type: 'c2' }])
  })
  it('空 scope → scope', () => {
    expect(validateCommitSubject('feat(): 空括号')).toEqual([{ rule: 'scope' }])
  })
  it('标题为空但格式在 → subject', () => {
    expect(validateCommitSubject('feat:   ')).toEqual([{ rule: 'subject' }])
  })
  it('超长 → length（携带实际长度与上限）', () => {
    const long = 'feat: ' + 'x'.repeat(COMMIT_MSG_MAX_LEN)
    expect(validateCommitSubject(long)).toEqual([
      { rule: 'length', len: long.length, max: COMMIT_MSG_MAX_LEN },
    ])
  })
  it('自定义上限生效', () => {
    expect(validateCommitSubject('feat: 标题', 5)).toEqual([
      { rule: 'length', len: 'feat: 标题'.length, max: 5 },
    ])
  })
  it('多条违规并存（type + scope）', () => {
    expect(validateCommitSubject('xyz(): 多重违规')).toEqual([
      { rule: 'type', type: 'xyz' },
      { rule: 'scope' },
    ])
  })
})

describe('validateCommitMsg 完整信息入口', () => {
  it('正文不计入：只核验标题行', () => {
    expect(validateCommitMsg('chore: 合规标题\n\n随便多长的正文都无关')).toEqual([])
  })
  it('标题行违规照常报出', () => {
    expect(validateCommitMsg('bad message\n\n正文')).toEqual([{ rule: 'format' }])
  })
})
