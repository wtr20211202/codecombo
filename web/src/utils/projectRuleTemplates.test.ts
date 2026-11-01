import { describe, expect, it } from 'vitest'
import { PROJECT_RULE_FILES, ruleFileTemplate } from './projectRuleTemplates'

/**
 * 项目规则模板纯函数单测（P-20261003-181）：清单从紧、双语模板齐备、
 * 未知文件名/未知 locale 的兜底不落空模板。
 */
describe('PROJECT_RULE_FILES', () => {
  it('清单从紧：仅三类已知 agent 规则文件', () => {
    expect([...PROJECT_RULE_FILES]).toEqual(['CLAUDE.md', 'AGENTS.md', '.cursorrules'])
  })
})

describe('ruleFileTemplate', () => {
  it.each(PROJECT_RULE_FILES)('%s：zh/en 模板齐备且以自身标题开头', (name) => {
    const zh = ruleFileTemplate(name, 'zh-CN')
    const en = ruleFileTemplate(name, 'en-US')
    expect(zh.startsWith(`# `)).toBe(true)
    expect(en.startsWith('# ')).toBe(true)
    expect(zh).toContain(name === '.cursorrules' ? '规则' : `# ${name}`)
    expect(en.length).toBeGreaterThan(40)
    expect(zh.length).toBeGreaterThan(40)
    // 模板以换行收尾（落盘文件符合 POSIX 文本惯例）
    expect(zh.endsWith('\n')).toBe(true)
    expect(en.endsWith('\n')).toBe(true)
  })

  it('未知 locale 一律英文兜底（文件内容面向 agent）', () => {
    expect(ruleFileTemplate('CLAUDE.md', 'ja-JP')).toBe(ruleFileTemplate('CLAUDE.md', 'en-US'))
    expect(ruleFileTemplate('CLAUDE.md', '')).toBe(ruleFileTemplate('CLAUDE.md', 'en-US'))
  })

  it('未知文件名返回空串（调用方不得落盘空模板）', () => {
    expect(ruleFileTemplate('README.md', 'zh-CN')).toBe('')
    expect(ruleFileTemplate('../escape.md', 'en-US')).toBe('')
  })
})
