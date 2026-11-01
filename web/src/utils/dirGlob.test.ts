import { describe, expect, it } from 'vitest'
import { buildDirGlob } from './dirGlob'

describe('buildDirGlob（P-20261003-118 目录右键搜索的 glob 预填合成）', () => {
  it('普通目录：原样 + /** 尾缀', () => {
    expect(buildDirGlob('packages')).toBe('packages/**')
    expect(buildDirGlob('a/b/c')).toBe('a/b/c/**')
  })

  it('CJK 与空格目录名不转义（非元字符）', () => {
    expect(buildDirGlob('内 海')).toBe('内 海/**')
  })

  it('字符类元字符转义：[ ] 不被解释为字符类（weird[1] 不再匹配 weird1）', () => {
    expect(buildDirGlob('weird[1]')).toBe('weird\\[1\\]/**')
    expect(buildDirGlob('arr[0]')).toBe('arr\\[0\\]/**')
  })

  it('交替组元字符转义：{ } 不被 rg globset 解释为 alternation（a{b} 不再匹配 ab）', () => {
    expect(buildDirGlob('a{b}')).toBe('a\\{b\\}/**')
  })

  it('通配元字符转义：目录名里的 * ? 作字面量', () => {
    expect(buildDirGlob('a*b')).toBe('a\\*b/**')
    expect(buildDirGlob('a?b')).toBe('a\\?b/**')
  })

  it('打头 ! 转义：不被 rg 否定语法吞掉（!lead 从排除变包含）', () => {
    expect(buildDirGlob('!lead')).toBe('\\!lead/**')
  })

  it('反斜杠归一为 / 且不被二次转义（防御：树内路径恒为 / 分隔）', () => {
    expect(buildDirGlob('a\\b')).toBe('a/b/**')
  })

  it('首尾斜杠剥除；空串返回空 glob（=不过滤，项目根防御分支）', () => {
    expect(buildDirGlob('/pkg/')).toBe('pkg/**')
    expect(buildDirGlob('')).toBe('')
    expect(buildDirGlob('/')).toBe('')
  })

  it('组合形态：多段路径中仅元字符被转义', () => {
    expect(buildDirGlob('pkgs/v[2]/inner')).toBe('pkgs/v\\[2\\]/inner/**')
  })
})
