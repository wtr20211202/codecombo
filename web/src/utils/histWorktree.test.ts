import { describe, expect, it } from 'vitest'
import {
  HIST_WORKTREE_PREFIX,
  histWorktreeName,
  histWorktreeSiblingPath,
  isHistWorktreePath,
  normalizeWorktreePathKey,
} from './histWorktree'

describe('histWorktreeName', () => {
  it('前缀 + 截到 8 位短 hash（与提交列表展示口径一致）', () => {
    expect(histWorktreeName('f67f4abdeadbeef')).toBe('wt-hist-f67f4abd')
    expect(histWorktreeName('abc')).toBe('wt-hist-abc')
  })
})

describe('normalizeWorktreePathKey', () => {
  it('反斜杠折正斜杠、去尾分隔符、小写（Windows 大小写不敏感）', () => {
    expect(normalizeWorktreePathKey('D:\\Repo\\wt-hist-abc/')).toBe('d:/repo/wt-hist-abc')
    expect(normalizeWorktreePathKey('D:/Repo/wt-hist-ABC')).toBe(normalizeWorktreePathKey('d:\\repo\\WT-HIST-abc'))
  })
})

describe('isHistWorktreePath', () => {
  it('尾段目录名带前缀即认，正反斜杠两态一致', () => {
    expect(isHistWorktreePath('D:/repo/../wt-hist-f67f4abd')).toBe(true)
    expect(isHistWorktreePath('D:\\repo\\wt-hist-f67f4abd')).toBe(true)
    expect(isHistWorktreePath('/mnt/c/tmp/wt-hist-12345678')).toBe(true)
  })
  it('非历史检视形态不误判（前缀必须在尾段、非子串）', () => {
    expect(isHistWorktreePath('D:/repo')).toBe(false)
    expect(isHistWorktreePath('D:/wt-hist-feature')).toBe(true) // 前缀开头即认，后续段不参与
    expect(isHistWorktreePath('D:/repo/wt-hist')).toBe(false) // 纯前缀段=空 hash，非本约定产物
    expect(isHistWorktreePath('D:/repo/xwt-hist-abc')).toBe(false)
  })
})

describe('histWorktreeSiblingPath', () => {
  it('仓库兄弟目录惯例位，正斜杠拼接（win 形态入参也归一）', () => {
    expect(histWorktreeSiblingPath('D:\\workspace\\repo', 'f67f4abd')).toBe('D:/workspace/wt-hist-f67f4abd')
    expect(histWorktreeSiblingPath('/home/u/repo', 'f67f4abd')).toBe('/home/u/wt-hist-f67f4abd')
  })
  it('去项目根尾分隔符；无父段回落相对名（git 以仓库根为 cwd 解析）', () => {
    expect(histWorktreeSiblingPath('D:\\repo\\', 'abc12345')).toBe('D:/wt-hist-abc12345')
    expect(histWorktreeSiblingPath('repo', 'abc12345')).toBe(`${HIST_WORKTREE_PREFIX}abc12345`)
  })
})
