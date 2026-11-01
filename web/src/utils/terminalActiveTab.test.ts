import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recallActiveTab, rememberActiveTab } from './terminalActiveTab'

describe('terminalActiveTab', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    // 配额满用例注入的 setItem mock 不泄漏到相邻用例（storage.test.ts 同款纪律）
    vi.restoreAllMocks()
  })

  it('记录后可恢复（projectId → tabId 映射）', () => {
    rememberActiveTab('p1', 'sess-a')
    rememberActiveTab('p2', 'sess-b')
    expect(recallActiveTab('p1')).toBe('sess-a')
    expect(recallActiveTab('p2')).toBe('sess-b')
  })

  it('同项目重记覆盖旧值', () => {
    rememberActiveTab('p1', 'sess-a')
    rememberActiveTab('p1', 'sess-c')
    expect(recallActiveTab('p1')).toBe('sess-c')
  })

  it('同值重记零写入（早返回省一次 localStorage 序列化）', () => {
    rememberActiveTab('p1', 'sess-a')
    const setItem = vi.spyOn(window.localStorage, 'setItem')
    rememberActiveTab('p1', 'sess-a')
    expect(setItem).not.toHaveBeenCalled()
    expect(recallActiveTab('p1')).toBe('sess-a')
  })

  it('空 projectId / 空 tabId 不写入', () => {
    rememberActiveTab('', 'sess-a')
    rememberActiveTab('p1', '')
    expect(localStorage.getItem('sc.term.activeTabMap')).toBeNull()
  })

  it('无记忆返回空串（调用方校验 tab 存在后回退）', () => {
    expect(recallActiveTab('p9')).toBe('')
    expect(recallActiveTab('')).toBe('')
  })

  it('配额满（QuotaExceededError）写入不抛异常：safeStorage 吞错，仅损失记忆（P-20261003-245）', () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    expect(() => rememberActiveTab('p1', 'sess-a')).not.toThrow()
    // 如实语义：存储可读时读到 localStorage 真值（写入失败即未持久化）
    expect(recallActiveTab('p1')).toBe('')
  })

  it('损坏的持久化数据防御解析（坏 JSON / 非对象形态）', () => {
    localStorage.setItem('sc.term.activeTabMap', '{broken json')
    expect(recallActiveTab('p1')).toBe('')
    localStorage.setItem('sc.term.activeTabMap', '[1,2]')
    expect(recallActiveTab('p1')).toBe('')
    localStorage.setItem('sc.term.activeTabMap', 'null')
    expect(recallActiveTab('p1')).toBe('')
  })
})
