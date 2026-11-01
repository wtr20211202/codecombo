// monacoInjectedModels 注入池单测（P-20261004-45）
// 覆盖：独立 LRU 上限 24、打开集（注入即打开的 tab）免淘汰与软上限、
// onWillDispose 出池钩子（外部 dispose 路径自动清账）、项目切换清池语义。
// monaco 以 Uri stub 换入（monacoModelCache.test.ts 同款 jsdom 纪律）。
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as monaco from 'monaco-editor'

vi.mock('monaco-editor', () => ({
  Uri: { parse: (s: string) => ({ toString: () => s }) },
}))

import {
  INJECTED_MODEL_MAX,
  clearInjectedMonacoModels,
  getInjectedMonacoModel,
  retainInjectedModel,
  resetInjectedMonacoModelsForTest,
} from './monacoInjectedModels'
import {
  setMonacoModelOpenPathProvider,
  clearMonacoModelOpenPathProvider,
} from './monacoModelOpenSet'

/** 假 model：dispose 可断言，且会触发 onWillDispose 出池钩子（语义对齐真 model） */
function fakeModel(): { model: monaco.editor.ITextModel; dispose: Mock<() => void> } {
  const hooks: Array<() => void> = []
  let disposed = false
  const dispose = vi.fn(() => {
    if (disposed) return
    disposed = true
    for (const fn of hooks) fn()
  })
  const model = {
    onWillDispose: (fn: () => void) => {
      hooks.push(fn)
      return { dispose: vi.fn() }
    },
    dispose,
    isDisposed: () => disposed,
  } as unknown as monaco.editor.ITextModel
  return { model, dispose }
}

beforeEach(() => {
  let now = 0
  vi.spyOn(Date, 'now').mockImplementation(() => ++now)
})

afterEach(() => {
  clearMonacoModelOpenPathProvider()
  resetInjectedMonacoModelsForTest()
  vi.restoreAllMocks()
})

describe('注入池独立 LRU（上限 24）', () => {
  it('超限淘汰最旧注入 model 并 dispose', () => {
    const disposes: Array<Mock<() => void>> = []
    for (let i = 1; i <= INJECTED_MODEL_MAX; i++) {
      const { model, dispose } = fakeModel()
      disposes.push(dispose)
      retainInjectedModel(`file:///inj-${i}.ts`, model)
    }
    const { model: overflow } = fakeModel()
    retainInjectedModel('file:///inj-25.ts', overflow)

    expect(disposes[0]).toHaveBeenCalledTimes(1)
    expect(getInjectedMonacoModel('file:///inj-1.ts')).toBeUndefined()
    expect(getInjectedMonacoModel('file:///inj-25.ts')).toBe(overflow)
    // 与 monacoModelCache 分池不挤占：本池常量独立为 24
    expect(INJECTED_MODEL_MAX).toBe(24)
  })

  it('重复 retain 刷新 LRU 新旧（被复用的注入 model 免淘汰）', () => {
    const { model: a, dispose: aDispose } = fakeModel()
    retainInjectedModel('file:///a.ts', a)
    for (let i = 1; i <= 23; i++) {
      const { model } = fakeModel()
      retainInjectedModel(`file:///fill-${i}.ts`, model)
    }
    retainInjectedModel('file:///a.ts', a) // a 刚被再次注入复用 → 刷新到最新
    const { model: last } = fakeModel()
    retainInjectedModel('file:///fill-25.ts', last)

    expect(aDispose).not.toHaveBeenCalled()
    expect(getInjectedMonacoModel('file:///fill-1.ts')).toBeUndefined()
    expect(getInjectedMonacoModel('file:///a.ts')).toBe(a)
  })
})

describe('打开集免淘汰与软上限', () => {
  it('注入即打开（进打开集）的 model 超限免淘汰；关闭后恢复 LRU 候选', () => {
    const openPaths = new Set<string>(['opened.ts'])
    setMonacoModelOpenPathProvider(() => openPaths)
    const { model: opened, dispose: openedDispose } = fakeModel()
    retainInjectedModel('file:///opened.ts', opened)

    const firstDispose = (() => {
      const { model, dispose } = fakeModel()
      retainInjectedModel('file:///pool-1.ts', model)
      return dispose
    })()
    for (let i = 2; i <= INJECTED_MODEL_MAX; i++) {
      const { model } = fakeModel()
      retainInjectedModel(`file:///pool-${i}.ts`, model)
    }
    // 第 26 条：淘汰最旧的未打开条目 pool-1，opened 驻留
    const { model: p25 } = fakeModel()
    retainInjectedModel('file:///pool-25.ts', p25)
    expect(firstDispose).toHaveBeenCalledTimes(1)
    expect(openedDispose).not.toHaveBeenCalled()
    expect(getInjectedMonacoModel('file:///opened.ts')).toBe(opened)

    // tab 关闭退出打开集 → 恢复 LRU 候选（opened 此时最旧）
    openPaths.delete('opened.ts')
    const { model: p26 } = fakeModel()
    retainInjectedModel('file:///pool-26.ts', p26)
    expect(openedDispose).toHaveBeenCalledTimes(1)
    expect(getInjectedMonacoModel('file:///opened.ts')).toBeUndefined()
  })
})

describe('onWillDispose 出池钩子与项目切换清池', () => {
  it('外部 dispose（tab 关闭链）自动出池，池内不落 disposed 引用', () => {
    const { model, dispose } = fakeModel()
    retainInjectedModel('file:///auto.ts', model)
    expect(getInjectedMonacoModel('file:///auto.ts')).toBe(model)
    dispose() // 模拟 MonacoEditor.disposeModel 命中全局注册表的销毁路径
    expect(getInjectedMonacoModel('file:///auto.ts')).toBeUndefined()
  })

  it('项目切换清池：dispose 全部未打开条目，打开集条目跳过（归 openfiles 切换链）', () => {
    const openPaths = new Set<string>(['stay.ts'])
    setMonacoModelOpenPathProvider(() => openPaths)
    const { model: stay, dispose: stayDispose } = fakeModel()
    retainInjectedModel('file:///stay.ts', stay)
    const { model: gone, dispose: goneDispose } = fakeModel()
    retainInjectedModel('file:///gone.ts', gone)

    expect(clearInjectedMonacoModels()).toBe(1)
    expect(goneDispose).toHaveBeenCalledTimes(1)
    expect(getInjectedMonacoModel('file:///gone.ts')).toBeUndefined()
    // 打开集条目不被本项目清池 dispose（切换时序里 openfiles watcher 先 dispose 它）
    expect(stayDispose).not.toHaveBeenCalled()
    expect(clearInjectedMonacoModels()).toBe(0)
  })

  it('已 dispose 的条目（钩子先清账）不被二次 dispose', () => {
    const openPaths = new Set<string>()
    setMonacoModelOpenPathProvider(() => openPaths)
    const { model, dispose } = fakeModel()
    retainInjectedModel('file:///x.ts', model)
    dispose()
    clearInjectedMonacoModels()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
