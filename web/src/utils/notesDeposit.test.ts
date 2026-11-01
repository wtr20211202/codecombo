// 结论沉淀模板纯函数单测（P-20261003-292）：模板节格式（标题/字段行/终态词）
// 与追加语义（空笔记起头/缺尾换行衔接/已有空行不重复）——i18n 文案注入式
// 设计让本文件无需挂 i18n 实例即可断言结构。
import { describe, expect, it } from 'vitest'
import { appendDepositSection, buildDepositSection, isDepositStatus, localDateStr } from './notesDeposit'

const LABELS = {
  result: '结果',
  what: '做了什么',
  decisions: '关键决定',
  leftovers: '遗留项',
  done: '已完成',
  failed: '已失败',
}

describe('localDateStr', () => {
  it('按本地时区输出 YYYY-MM-DD（不用 UTC 的 toISOString）', () => {
    // 本地 2026-10-05 00:30 在 UTC 西侧时区仍是 10-04——断言随本地时区自洽
    const d = new Date(2026, 9, 5, 0, 30)
    expect(localDateStr(d)).toBe('2026-10-05')
    expect(localDateStr(new Date(2026, 0, 1))).toBe('2026-01-01')
  })
})

describe('isDepositStatus', () => {
  it('仅 done/failed 可沉淀，running/空/未知一律否', () => {
    expect(isDepositStatus('done')).toBe(true)
    expect(isDepositStatus('failed')).toBe(true)
    expect(isDepositStatus('running')).toBe(false)
    expect(isDepositStatus('')).toBe(false)
    expect(isDepositStatus(undefined)).toBe(false)
  })
})

describe('buildDepositSection', () => {
  it('标题「## 日期 任务」+ 结果/做了什么/关键决定/遗留项四行', () => {
    const s = buildDepositSection('2026-10-05', '重构登录模块', 'done', LABELS)
    const lines = s.split('\n')
    expect(lines[0]).toBe('## 2026-10-05 重构登录模块')
    expect(lines[1]).toBe('')
    expect(lines[2]).toBe('- 结果：已完成')
    expect(lines[3]).toBe('- 做了什么：')
    expect(lines[4]).toBe('- 关键决定：')
    expect(lines[5]).toBe('- 遗留项：')
    expect(s.endsWith('\n')).toBe(true)
  })

  it('failed 终态词随 labels 切换', () => {
    expect(buildDepositSection('2026-10-05', 't', 'failed', LABELS)).toContain('- 结果：已失败')
  })
})

describe('appendDepositSection', () => {
  const section = buildDepositSection('2026-10-05', '任务', 'done', LABELS)

  it('空笔记：整节起头', () => {
    expect(appendDepositSection('', section)).toBe(section)
  })

  it('缺尾换行：截尾后空行衔接（标题不黏上一段）', () => {
    expect(appendDepositSection('# 交接说明', section)).toBe(`# 交接说明\n\n${section}`)
  })

  it('已有尾换行/多余空行：归一为单个空行分隔', () => {
    expect(appendDepositSection('# 交接说明\n', section)).toBe(`# 交接说明\n\n${section}`)
    expect(appendDepositSection('# 交接说明\n\n\n', section)).toBe(`# 交接说明\n\n${section}`)
  })
})
