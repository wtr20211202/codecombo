import { describe, it, expect, beforeEach } from 'vitest'
import {
  pvPreviewable, pvBinaryPreviewable,
  preferredViewMode, rememberViewMode, defaultViewMode,
} from './filePreviewMode'

// 统一双视图（P-20261119-4）：kind 分流判定与 per 扩展名偏好记忆。
// localStorage 真环境（vitest jsdom setup 提供），beforeEach 清键防串扰。
describe('pvPreviewable', () => {
  it('注册表可预览 kind 全命中（渲染面分支的可见性判据）', () => {
    for (const k of ['markdown', 'html', 'csv', 'sheet', 'docx', 'pdf', 'image', 'video', 'audio', 'text']) {
      expect(pvPreviewable(k), k).toBe(true)
    }
  })
  it('info/未注册/缺席 = 不可预览（真未知格式不出预览态）', () => {
    expect(pvPreviewable('info')).toBe(false)
    expect(pvPreviewable(undefined)).toBe(false)
    expect(pvPreviewable('')).toBe(false)
  })
})

describe('pvBinaryPreviewable', () => {
  it('二进制默认预览态集合：服务端读数的 kind 全在内', () => {
    for (const k of ['docx', 'pdf', 'image', 'video', 'audio', 'html', 'csv', 'sheet']) {
      expect(pvBinaryPreviewable(k), k).toBe(true)
    }
  })
  it('markdown/text 不在内（缓冲渲染——sniffed-binary 下缓冲为空，回落信息卡）', () => {
    expect(pvBinaryPreviewable('markdown')).toBe(false)
    expect(pvBinaryPreviewable('text')).toBe(false)
    expect(pvBinaryPreviewable('info')).toBe(false)
  })
})

describe('view mode preference（per 扩展名 localStorage）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('无记录回落 null（打开链走 kind 默认态）', () => {
    expect(preferredViewMode('docs/report.docx')).toBeNull()
  })

  it('切换即写、按扩展名键控（同名不同扩展互不串扰）', () => {
    rememberViewMode('a/报告.docx', 'preview')
    rememberViewMode('b/notes.md', 'source')
    expect(preferredViewMode('c/其他.DOCX')).toBe('preview') // 大小写不敏感
    expect(preferredViewMode('notes.md')).toBe('source')
    expect(preferredViewMode('notes.go')).toBeNull() // 无点文件名/未记录扩展
  })

  it('无扩展名路径不落键（Makefile 等无点名）', () => {
    rememberViewMode('Makefile', 'preview')
    expect(preferredViewMode('Makefile')).toBeNull()
  })
})

describe('defaultViewMode（打开链分流默认态）', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('二进制 + 预览 Kind 命中 → 默认 preview（「binary not previewable」退场）', () => {
    expect(defaultViewMode('docs/spec.docx', 'docx', true)).toBe('preview')
    expect(defaultViewMode('diagram.png', 'image', true)).toBe('preview')
    expect(defaultViewMode('page.html', 'html', true)).toBe('preview')
  })

  it('二进制 + markdown/text/info → 默认 source（信息卡现状，防空缓冲渲染）', () => {
    expect(defaultViewMode('x.md', 'markdown', true)).toBe('source')
    expect(defaultViewMode('blob.bin', 'info', true)).toBe('source')
    expect(defaultViewMode('blob.xyz', undefined, true)).toBe('source')
  })

  it('文本文件恒 source（编辑工作流零回归）', () => {
    expect(defaultViewMode('main.go', 'text', false)).toBe('source')
    expect(defaultViewMode('README.md', 'markdown', false)).toBe('source')
  })

  it('偏好覆盖 kind 默认（记住上次选择，VS Code/GitHub 惯例）', () => {
    rememberViewMode('spec.docx', 'source')
    expect(defaultViewMode('docs/spec.docx', 'docx', true)).toBe('source')
    rememberViewMode('main.go', 'preview')
    expect(defaultViewMode('main.go', 'text', false)).toBe('preview')
  })
})
