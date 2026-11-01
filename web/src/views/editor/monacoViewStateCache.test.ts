// monacoViewStateCache「复制引用」跨层读数口单测（P-20261006-17）
//
// 覆盖注册表语义：未注册（编辑器 chunk 未加载）= undefined；注册后透传实现
// 读数；实现抛错按无光标态降级 undefined；重复注册幂等覆盖。快照数据经公开
// 写入口 saveEditorViewState 落桶（假 editor：uri 键 + saveViewState 快照，
// 运行时零 monaco 依赖——cache 模块对 monaco 仅类型依赖，同 monacoModelCache
// 测试的免导入口径）
import { describe, expect, it, vi } from 'vitest'
import type * as monaco from 'monaco-editor'
import {
  saveEditorViewState,
  peekViewStateCursorLine,
  setViewStateCursorLineReader,
  viewStateCursorLineOf,
} from './monacoViewStateCache'

/** 假 editor：视图快照落桶只需要 model uri 键 + saveViewState 载荷
 *  （onWillDispose 为 dispose 清理钩挂点，桩成 no-op 即可） */
function fakeEditor(uriKey: string, cursorLine: number): monaco.editor.IStandaloneCodeEditor {
  return {
    getModel: () => ({
      uri: { toString: () => uriKey },
      isDisposed: () => false,
      onWillDispose: vi.fn(),
    }),
    saveViewState: () => ({
      cursorState: [{
        inSelectionMode: false,
        selectionStart: { lineNumber: cursorLine, column: 1 },
        position: { lineNumber: cursorLine, column: 5 },
      }],
    }),
  } as unknown as monaco.editor.IStandaloneCodeEditor
}

/** 编辑器侧注册的实现的测试替身：键推导按普通 ASCII 路径与真 monaco.Uri
 *  序列化同构（同 monacoModelCache.test 的 stub 口径） */
function installAsciiReader() {
  setViewStateCursorLineReader((gi, path) => peekViewStateCursorLine(gi, `file:///${path}`))
}

describe('viewStateCursorLineOf（复制引用读数注册表）', () => {
  it('未注册（编辑器 chunk 未加载）= undefined，主 chunk 降级纯路径', () => {
    expect(viewStateCursorLineOf(0, 'a.txt')).toBeUndefined()
  })

  it('注册后读该 tab viewState 快照的最后已知光标行', () => {
    installAsciiReader()
    saveEditorViewState(0, fakeEditor('file:///a.txt', 12))
    expect(viewStateCursorLineOf(0, 'a.txt')).toBe(12)
    // 按组分桶：同路径他组无快照互不串位
    expect(viewStateCursorLineOf(1, 'a.txt')).toBeUndefined()
  })

  it('实现抛错（键推导异常等）按无光标态降级，不阻断复制', () => {
    setViewStateCursorLineReader(() => {
      throw new Error('boom')
    })
    expect(viewStateCursorLineOf(0, 'a.txt')).toBeUndefined()
  })

  it('重复注册幂等覆盖（MonacoEditor 重挂同款），且快照越界行号拒绝', () => {
    saveEditorViewState(0, fakeEditor('file:///b.txt', 0))
    installAsciiReader()
    expect(viewStateCursorLineOf(0, 'b.txt')).toBeUndefined()
    saveEditorViewState(0, fakeEditor('file:///b.txt', 3))
    installAsciiReader()
    expect(viewStateCursorLineOf(0, 'b.txt')).toBe(3)
  })
})
