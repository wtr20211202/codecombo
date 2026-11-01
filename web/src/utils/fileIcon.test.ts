import { describe, it, expect } from 'vitest'
import { getFileIconColor } from './fileIcon'

// 文件类型图标色（P-20261002-147）：文件树与编辑器 tab 色点共用的同源色表
describe('getFileIconColor', () => {
  it('目录统一强调蓝，与扩展名无关', () => {
    expect(getFileIconColor('src', true)).toBe('var(--accent-blue-light)')
    expect(getFileIconColor('a.ts', true)).toBe('var(--accent-blue-light)')
  })

  it('扩展名命中色表（ts/md 已知色）', () => {
    expect(getFileIconColor('app.ts', false)).toBe('#3178c6')
    expect(getFileIconColor('README.md', false)).toBe('#519aba')
  })

  it('扩展名大小写不敏感、多重点号取末段', () => {
    expect(getFileIconColor('App.VUE', false)).toBe('#42b883')
    expect(getFileIconColor('router.index.js', false)).toBe('#f7df1e')
  })

  it('无扩展名/点开头/未知扩展名回退次级文本色', () => {
    expect(getFileIconColor('Makefile', false)).toBe('var(--text-secondary)')
    expect(getFileIconColor('.gitignore', false)).toBe('var(--text-secondary)')
    expect(getFileIconColor('a.zzz', false)).toBe('var(--text-secondary)')
  })
})
