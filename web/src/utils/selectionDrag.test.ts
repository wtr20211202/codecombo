import { describe, expect, it } from 'vitest'
import { buildSelectionDragText, flattenSelectionForPaste, type EditorSelectionDragPayload } from './selectionDrag'

/** 轻量 t 桩：只回填模板里的参数，避免测试耦合 zh/en 文案 */
const t = ((key: string, params?: Record<string, unknown>) => {
  const map: Record<string, string> = {
    'editor.selectionDrag.headerRange': '来自 {path} 第 {start}-{end} 行的选区：',
    'editor.selectionDrag.headerLine': '来自 {path} 第 {line} 行的选区：',
  }
  return (map[key] || key).replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''))
}) as unknown as Parameters<typeof buildSelectionDragText>[1]

function payload(over: Partial<EditorSelectionDragPayload> = {}): EditorSelectionDragPayload {
  return { path: 'src/app.ts', text: 'const a = 1\nconst b = 2\n', startLine: 3, endLine: 4, ...over }
}

describe('buildSelectionDragText', () => {
  it('多行选区：定位头 + 原文，反斜杠归一正斜杠，尾部空白剥除', () => {
    expect(buildSelectionDragText(payload({ path: 'src\\nested\\app.ts' }), t))
      .toBe('来自 src/nested/app.ts 第 3-4 行的选区：\nconst a = 1\nconst b = 2')
  })

  it('单行选区：单行定位文案', () => {
    expect(buildSelectionDragText(payload({ startLine: 7, endLine: 7, text: '  call()\n\n' }), t))
      .toBe('来自 src/app.ts 第 7 行的选区：\n  call()')
  })
})

describe('flattenSelectionForPaste', () => {
  it('换行与连续空白折叠为单空格（无换行 = 无 Enter）', () => {
    expect(flattenSelectionForPaste('a\nb\r\nc')).toBe('a b c')
    expect(flattenSelectionForPaste('  a  \n\n  b  ')).toBe('a b')
  })

  it('单行文本原样（仅修边）', () => {
    expect(flattenSelectionForPaste('  echo hi  ')).toBe('echo hi')
  })
})
