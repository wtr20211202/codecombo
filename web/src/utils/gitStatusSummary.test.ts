import { describe, expect, it } from 'vitest'
import zh from '../locales/zh-CN'
import en from '../locales/en-US'
import { buildGitStatusSummary, GIT_SUMMARY_MAX_BYTES } from './gitStatusSummary'
import { byteLength } from './promptFit'

// 翻译面用真语言包插值（useEditorAskAgent.test.ts 同款口径）：不复制期望文案，
// locale 措辞改动即测出；两个语言包都过一遍顺带守护双语模板可插值
type Locale = Record<string, unknown>
function makeT(pack: Locale) {
  const get = (o: Locale, k: string): unknown =>
    k.split('.').reduce<unknown>((a, c) => (a as Locale | undefined)?.[c], o)
  return (key: string, params?: Record<string, unknown>) => {
    let s = get(pack, key) as string
    for (const [k, v] of Object.entries(params ?? {})) s = s.replaceAll(`{${k}}`, String(v))
    return s
  }
}

const base = { projectName: 'demo', branch: 'main', changedCount: 0, lastCommitSubject: '' }

describe('buildGitStatusSummary 纯拼装（P-20261003-176）', () => {
  it('脏工作区 + 提交主题：三段齐备（zh）', () => {
    const line = buildGitStatusSummary(
      { ...base, changedCount: 3, lastCommitSubject: 'c1: add app' },
      makeT(zh),
    )
    expect(line).toBe('git 状态（demo）：分支 main，3 处未提交变更，最近提交：c1: add app')
    expect(byteLength(line)).toBeLessThanOrEqual(GIT_SUMMARY_MAX_BYTES)
  })

  it('干净工作区无提交主题（空仓库）：两段形态', () => {
    const line = buildGitStatusSummary(base, makeT(zh))
    expect(line).toBe('git 状态（demo）：分支 main，工作区干净')
  })

  it('脏工作区无提交主题：省略提交段', () => {
    const line = buildGitStatusSummary({ ...base, changedCount: 1 }, makeT(zh))
    expect(line).toBe('git 状态（demo）：分支 main，1 处未提交变更')
  })

  it('干净工作区有提交主题', () => {
    const line = buildGitStatusSummary({ ...base, lastCommitSubject: 'fix: x' }, makeT(zh))
    expect(line).toBe('git 状态（demo）：分支 main，工作区干净，最近提交：fix: x')
  })

  it('分支缺失（非 git 工作区）：返回空串不注入', () => {
    expect(buildGitStatusSummary({ ...base, branch: '' }, makeT(zh))).toBe('')
    expect(buildGitStatusSummary({ ...base, branch: '  ' }, makeT(zh))).toBe('')
  })

  it('超长提交主题截断：保头 + … 尾缀，总长 ≤ 上限', () => {
    const subject = `merge enhance/P-20261005-228: ${'很长的提交主题描述'.repeat(20)}`
    const line = buildGitStatusSummary(
      { ...base, changedCount: 2, lastCommitSubject: subject },
      makeT(zh),
    )
    expect(byteLength(line)).toBeLessThanOrEqual(GIT_SUMMARY_MAX_BYTES)
    expect(line.endsWith('…')).toBe(true)
    // 保头：主题开头保留（信息密度在开头）
    expect(line).toContain('merge enhance/P-20261005-228')
    // 截掉的主体不再完整出现
    expect(line).not.toContain(subject.slice(0, 40) + subject.slice(40, 80))
  })

  it('en 语言包同构可插值，字节数仍在上限内', () => {
    const line = buildGitStatusSummary(
      { ...base, changedCount: 3, lastCommitSubject: 'c1: add app' },
      makeT(en),
    )
    expect(line).toBe('Git status (demo): branch main, 3 uncommitted changes, last commit: c1: add app')
    expect(byteLength(line)).toBeLessThanOrEqual(GIT_SUMMARY_MAX_BYTES)
  })

  it('截到极限仍塞不下（理论边界）：降级无提交段，不输出悬空「最近提交：」', () => {
    // 超长分支名（158 字节）把固定段顶过上限，主题一个字符都放不下
    const line = buildGitStatusSummary(
      {
        projectName: 'demo',
        branch: `feature/${'x'.repeat(150)}`,
        changedCount: 2,
        lastCommitSubject: 'some commit subject here',
      },
      makeT(zh),
    )
    expect(line).not.toContain('最近提交：')
    // 无提交段形态（模板固定段 ~230 字节超上限属文档化理论边界，装配层兜底）
    expect(line).toBe('git 状态（demo）：分支 feature/' + 'x'.repeat(150) + '，2 处未提交变更')
  })
})
