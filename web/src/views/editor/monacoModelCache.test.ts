// monacoModelCache 打开集保活单测（P-20261002-90）
//
// 覆盖三层语义：打开集内的 model 超限免淘汰（保活）；路径退出打开集
// （文件关闭）后恢复 LRU 候选；总量上限行为（未注册打开集 = 纯 LRU 原行为，
// 全为打开集 = 软上限不 dispose）。cache 为模块级单例，各用例以独立路径
// 前缀隔离 + afterEach 重置。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as monaco from 'monaco-editor'

// monaco-editor 全量入口（editor.main）在 jsdom 缺 document.queryCommandSupported
// 等 API 无法导入（浏览器里靠 EditorGroupPane 懒加载规避）。缓存层运行时只消费
// Uri.parse().toString() 的键推导，按同构行为 stub——用例路径均为普通 ASCII，
// 与真 Uri 序列化结果一致
vi.mock('monaco-editor', () => ({
  Uri: { parse: (s: string) => ({ toString: () => s }) },
}))

import {
  getCachedMonacoModel,
  retainMonacoModel,
  disposeCachedMonacoModel,
  resetMonacoModelCacheForTest,
} from './monacoModelCache'
import {
  setMonacoModelOpenPathProvider,
  clearMonacoModelOpenPathProvider,
} from './monacoModelOpenSet'

/** 假 model：缓存层只触碰 dispose，无需真 monaco editor 实例 */
function fakeModel(): monaco.editor.ITextModel {
  return { dispose: vi.fn() } as unknown as monaco.editor.ITextModel
}

beforeEach(() => {
  // retain 以 Date.now() 排 LRU 新旧：单调递增假钟保证淘汰顺序确定
  let now = 0
  vi.spyOn(Date, 'now').mockImplementation(() => ++now)
})

afterEach(() => {
  clearMonacoModelOpenPathProvider()
  resetMonacoModelCacheForTest()
  vi.restoreAllMocks()
})

describe('monacoModelCache 打开集保活', () => {
  it('超限淘汰跳过打开集内的 model，只清已关闭文件', () => {
    const openPaths = new Set(['keep-a.ts', 'keep-b.ts'])
    setMonacoModelOpenPathProvider(() => openPaths)

    const keepA = fakeModel()
    retainMonacoModel('file:///keep-a.ts', keepA, keepA)
    const keepB = fakeModel()
    retainMonacoModel('file:///keep-b.ts', keepB, keepB)
    const closed: monaco.editor.ITextModel[] = []
    for (let i = 1; i <= 6; i++) {
      const m = fakeModel()
      closed.push(m)
      retainMonacoModel(`file:///closed-${i}.ts`, m, m)
    }
    // 第 9 条进缓存：淘汰最旧的已关闭文件 closed-1，打开集两条驻留
    retainMonacoModel('file:///closed-7.ts', fakeModel(), fakeModel())

    expect(closed[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(getCachedMonacoModel('file:///closed-1.ts')).toBeUndefined()
    expect(getCachedMonacoModel('file:///keep-a.ts')).toBe(keepA)
    expect(getCachedMonacoModel('file:///keep-b.ts')).toBe(keepB)

    // 继续增压：淘汰沿已关闭文件 LRU 顺延，打开集始终驻留
    retainMonacoModel('file:///closed-8.ts', fakeModel(), fakeModel())
    retainMonacoModel('file:///closed-9.ts', fakeModel(), fakeModel())
    expect(closed[1]!.dispose).toHaveBeenCalledTimes(1)
    expect(closed[2]!.dispose).toHaveBeenCalledTimes(1)
    expect(getCachedMonacoModel('file:///keep-a.ts')).toBe(keepA)
    expect(getCachedMonacoModel('file:///keep-b.ts')).toBe(keepB)
  })

  it('候选耗尽（全为打开集）时放弃淘汰，缓存暂超上限但不 dispose', () => {
    const openPaths = new Set<string>()
    for (let i = 1; i <= 10; i++) openPaths.add(`open-${i}.ts`)
    setMonacoModelOpenPathProvider(() => openPaths)

    const models: monaco.editor.ITextModel[] = []
    for (let i = 1; i <= 10; i++) {
      const m = fakeModel()
      models.push(m)
      retainMonacoModel(`file:///open-${i}.ts`, m, m)
    }
    for (const m of models) expect(m.dispose).not.toHaveBeenCalled()
    for (let i = 1; i <= 10; i++) {
      expect(getCachedMonacoModel(`file:///open-${i}.ts`)).toBe(models[i - 1])
    }
  })

  it('文件关闭退出打开集后恢复 LRU 候选（软上限重新收敛）', () => {
    const openPaths = new Set<string>()
    for (let i = 1; i <= 9; i++) openPaths.add(`dyn-${i}.ts`)
    setMonacoModelOpenPathProvider(() => openPaths)
    const models: monaco.editor.ITextModel[] = []
    for (let i = 1; i <= 9; i++) {
      const m = fakeModel()
      models.push(m)
      retainMonacoModel(`file:///dyn-${i}.ts`, m, m)
    }
    // 9 条全为打开集：超上限 1 条但候选耗尽，无人被淘汰
    expect(models[0]!.dispose).not.toHaveBeenCalled()

    // dyn-1 关闭退出打开集：下一次超限 retain 即淘汰它（最旧）
    openPaths.delete('dyn-1.ts')
    retainMonacoModel('file:///dyn-new.ts', fakeModel(), fakeModel())
    expect(models[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(getCachedMonacoModel('file:///dyn-1.ts')).toBeUndefined()
    expect(getCachedMonacoModel('file:///dyn-new.ts')).toBeDefined()
  })
})

describe('monacoModelCache 上限与关闭行为', () => {
  it('未注册打开集时退化为纯 LRU：超限淘汰最旧条目（原行为）', () => {
    const models: monaco.editor.ITextModel[] = []
    for (let i = 1; i <= 8; i++) {
      const m = fakeModel()
      models.push(m)
      retainMonacoModel(`file:///lru-${i}.ts`, m, m)
    }
    const ninth = fakeModel()
    retainMonacoModel('file:///lru-9.ts', ninth, ninth)

    expect(models[0]!.dispose).toHaveBeenCalledTimes(1)
    expect(getCachedMonacoModel('file:///lru-1.ts')).toBeUndefined()
    expect(getCachedMonacoModel('file:///lru-9.ts')).toBe(ninth)
  })

  it('disposeCachedMonacoModel 关闭语义不变：dispose 并移除缓存', () => {
    setMonacoModelOpenPathProvider(() => new Set(['close-me.ts']))
    const m = fakeModel()
    retainMonacoModel('file:///close-me.ts', m, m)

    expect(disposeCachedMonacoModel('file:///close-me.ts')).toBe(true)
    expect(m.dispose).toHaveBeenCalledTimes(1)
    expect(getCachedMonacoModel('file:///close-me.ts')).toBeUndefined()
    expect(disposeCachedMonacoModel('file:///close-me.ts')).toBe(false)
  })
})
