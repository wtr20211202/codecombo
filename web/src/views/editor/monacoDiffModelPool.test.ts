// monacoDiffModelPool 单测（P-20261004-100 diff 标签切文件实例热切）
//
// 覆盖四层语义：命中复用（往返免重建/内容对齐 setValue）、双侧独立键、
// 引用计数护栏（在挂 model 不做淘汰候选，双组同挂引用归零前不清）、
// LRU 淘汰与软上限、视图状态 FIFO 封顶与键隔离。池为模块级单例，
// 各用例独立键前缀隔离 + afterEach 重置。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as monaco from 'monaco-editor'

// monaco-editor 全量入口在 jsdom 无法导入（monacoModelCache.test.ts 同款结论）：
// 池层运行时只消费 Uri.parse().toString() 的键推导与 editor.getModel/createModel，
// 按同构行为 stub——用例键均为普通 ASCII，与真 Uri 序列化结果一致
vi.mock('monaco-editor', () => ({
  Uri: { parse: (s: string) => ({ toString: () => s }) },
  editor: {
    getModel: () => null,
    createModel: (content: string, _lang: string, _uri: unknown) => makeFakeModel(content),
  },
}))

import {
  acquireDiffModel, releaseDiffModel, diffSideModelUriKey,
  saveDiffEditorViewState, peekDiffEditorViewState, diffViewStateKey,
  resetDiffModelPoolForTest, DIFF_MODEL_POOL_PAIRS,
} from './monacoDiffModelPool'

/** 假 model：池层触碰 getValue/setValue/isDisposed/onWillDispose/dispose */
function makeFakeModel(content: string): monaco.editor.ITextModel {
  let value = content
  const onWillDispose = vi.fn()
  return {
    getValue: vi.fn(() => value),
    setValue: vi.fn((v: string) => { value = v }),
    isDisposed: vi.fn(() => false),
    dispose: vi.fn(() => { for (const h of onWillDispose.mock.calls) (h[0] as () => void)() }),
    onWillDispose,
  } as unknown as monaco.editor.ITextModel
}

beforeEach(() => {
  // LRU 以 Date.now() 排新旧：单调递增假钟保证淘汰顺序确定
  let now = 0
  vi.spyOn(Date, 'now').mockImplementation(() => ++now)
})

afterEach(() => {
  resetDiffModelPoolForTest()
  vi.restoreAllMocks()
})

describe('monacoDiffModelPool 命中复用与内容对齐', () => {
  it('同键往返复用同一 model（不重建），双侧键独立', () => {
    const oldKey = diffSideModelUriKey('diff:c1:wt:a.ts', 'old')
    const modKey = diffSideModelUriKey('diff:c1:wt:a.ts', 'mod')
    expect(oldKey).not.toBe(modKey)

    const first = acquireDiffModel(oldKey, 'go', 'content-v1')
    releaseDiffModel(first)
    const second = acquireDiffModel(oldKey, 'go', 'content-v1')
    expect(second).toBe(first)

    // 两侧互不影响：同一伪键的 old/mod 是两个 model
    const mod = acquireDiffModel(modKey, 'go', 'content-v1')
    expect(mod).not.toBe(first)
  })

  it('同键内容变化走 setValue 对齐（剪贴板对比同键重开路径）', () => {
    const key = diffSideModelUriKey('diff:clipboard:wt:b.ts', 'old')
    const first = acquireDiffModel(key, 'md', 'old-content')
    releaseDiffModel(first)
    const second = acquireDiffModel(key, 'md', 'new-content')
    expect(second).toBe(first)
    expect(second.getValue()).toBe('new-content')
  })
})

describe('monacoDiffModelPool 引用计数与淘汰', () => {
  it('超限淘汰只清引用归零的最旧条目，在挂 model 不动', () => {
    const pooled: monaco.editor.ITextModel[] = []
    for (let i = 1; i <= DIFF_MODEL_POOL_PAIRS * 2; i++) {
      const m = acquireDiffModel(`file:///d-${i}`, 'txt', `c-${i}`)
      releaseDiffModel(m)
      pooled.push(m)
    }
    // 第 17 条：满 16 后进新条目，淘汰最旧且引用归零的 d-1
    const extra = acquireDiffModel('file:///d-17', 'txt', 'c-17')
    releaseDiffModel(extra)
    expect(pooled[0]!.dispose).toHaveBeenCalledTimes(1)

    // 在挂（引用 >0）的条目即使最旧也不做候选
    const pinned = acquireDiffModel('file:///pinned', 'txt', 'pinned')
    // 挤满池并反复触发淘汰：pinned 引用未归还，必须存活
    for (let i = 100; i < 100 + DIFF_MODEL_POOL_PAIRS * 2 + 4; i++) {
      const m = acquireDiffModel(`file:///x-${i}`, 'txt', `x-${i}`)
      releaseDiffModel(m)
    }
    expect(pinned.dispose).not.toHaveBeenCalled()
    releaseDiffModel(pinned)
  })

  it('同 model 双引用（双组同挂）归还一次仍受护栏保护', () => {
    const key = diffSideModelUriKey('diff:c1:wt:shared.ts', 'old')
    const m1 = acquireDiffModel(key, 'txt', 'shared')
    const m2 = acquireDiffModel(key, 'txt', 'shared')
    expect(m2).toBe(m1)
    releaseDiffModel(m1) // 组 1 换代，组 2 仍挂
    for (let i = 200; i < 200 + DIFF_MODEL_POOL_PAIRS * 2 + 4; i++) {
      const m = acquireDiffModel(`file:///y-${i}`, 'txt', `y-${i}`)
      releaseDiffModel(m)
    }
    expect(m1.dispose).not.toHaveBeenCalled()
    releaseDiffModel(m2)
  })

  it('候选耗尽（全部在挂）时放弃淘汰，池暂超上限不 dispose', () => {
    const models: monaco.editor.ITextModel[] = []
    for (let i = 1; i <= DIFF_MODEL_POOL_PAIRS * 2 + 2; i++) {
      const m = acquireDiffModel(`file:///open-${i}`, 'txt', `c-${i}`)
      models.push(m) // 全程不归还
    }
    for (const m of models) expect(m.dispose).not.toHaveBeenCalled()
  })

  it('model 经外部 dispose 后出池，再取用得新 model', () => {
    const key = diffSideModelUriKey('diff:c1:wt:gone.ts', 'old')
    const first = acquireDiffModel(key, 'txt', 'v1')
    releaseDiffModel(first)
    vi.mocked(first.dispose)() // 模拟池外销毁路径
    const second = acquireDiffModel(key, 'txt', 'v1')
    expect(second).not.toBe(first)
  })
})

describe('monacoDiffModelPool 视图状态', () => {
  it('按组号/项目/伪键隔离存取', () => {
    const state = { originalState: {}, modifiedState: {}, onlyA: true } as unknown as monaco.editor.IDiffEditorViewState
    const key0 = diffViewStateKey(0, 'p1', 'diff:c1:wt:a.ts')
    const key1 = diffViewStateKey(1, 'p1', 'diff:c1:wt:a.ts')
    saveDiffEditorViewState(key0, state)
    expect(peekDiffEditorViewState(key0)).toBe(state)
    expect(peekDiffEditorViewState(key1)).toBeUndefined()
    expect(peekDiffEditorViewState(diffViewStateKey(0, 'p2', 'diff:c1:wt:a.ts'))).toBeUndefined()
    // 重写同一键 = 提到队尾更新
    const newer = { onlyA: false } as unknown as monaco.editor.IDiffEditorViewState
    saveDiffEditorViewState(key0, newer)
    expect(peekDiffEditorViewState(key0)).toBe(newer)
  })

  it('FIFO 封顶：最旧先出', () => {
    for (let i = 0; i < 48; i++) saveDiffEditorViewState(`vs-${i}`, {} as monaco.editor.IDiffEditorViewState)
    const extra = {} as monaco.editor.IDiffEditorViewState
    saveDiffEditorViewState('vs-48', extra)
    expect(peekDiffEditorViewState('vs-0')).toBeUndefined()
    expect(peekDiffEditorViewState('vs-48')).toBe(extra)
  })
})
