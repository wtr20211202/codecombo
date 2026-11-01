import { describe, it, expect, vi } from 'vitest'
import {
  registerEditorFormatter, unregisterEditorFormatter, runEditorFormatter,
} from './editorFormatters'

/**
 * 保存前格式化注册表单测（P-20261004-139 全部保存链）：挂载/换签/卸载生命周期
 * 的注册簿记正确性——泄漏（卸载不注销）与误摘（双宿主同路径按身份摘除）是本
 * 注册表的两大风险面。
 */

/** 造一个可断言调用史的格式化实现（立即 resolve 模拟格式化完成） */
function makeFormatter() {
  return vi.fn(async () => { /* 模拟格式化：无操作 */ })
}

describe('editorFormatters（P-20261004-139 全部保存格式化注册表）', () => {
  it('无注册实现时 no-op：resolve 且不调用任何实现', async () => {
    await expect(runEditorFormatter('/no-such-path.ts')).resolves.toBeUndefined()
  })

  it('注册后查表调用：await 到实现 resolve 才返回', async () => {
    const fmt = makeFormatter()
    registerEditorFormatter('/a.ts', fmt)
    try {
      await runEditorFormatter('/a.ts')
      expect(fmt).toHaveBeenCalledTimes(1)
    } finally {
      unregisterEditorFormatter('/a.ts', fmt)
    }
  })

  it('卸载后查表 no-op（卸载必注销，无泄漏）', async () => {
    const fmt = makeFormatter()
    registerEditorFormatter('/leak.ts', fmt)
    unregisterEditorFormatter('/leak.ts', fmt)
    await runEditorFormatter('/leak.ts')
    expect(fmt).not.toHaveBeenCalled()
  })

  it('换签迁移语义：旧路径摘除、新路径在册（MonacoEditor path watcher 同构）', async () => {
    const fmt = makeFormatter()
    registerEditorFormatter('/old.ts', fmt)
    // 模拟 path watcher：旧路径注销 + 新路径注册（同实现身份）
    unregisterEditorFormatter('/old.ts', fmt)
    registerEditorFormatter('/new.ts', fmt)
    try {
      await runEditorFormatter('/old.ts')
      expect(fmt).not.toHaveBeenCalled()
      await runEditorFormatter('/new.ts')
      expect(fmt).toHaveBeenCalledTimes(1)
    } finally {
      unregisterEditorFormatter('/new.ts', fmt)
    }
  })

  it('双宿主同路径：按实现身份摘除，一组卸载另一份仍在册不误摘', async () => {
    const host0 = makeFormatter()
    const host1 = makeFormatter()
    registerEditorFormatter('/shared.ts', host0)
    registerEditorFormatter('/shared.ts', host1)
    unregisterEditorFormatter('/shared.ts', host0) // 组 0 卸载
    try {
      await runEditorFormatter('/shared.ts') // 组 1 仍显示该文件
      expect(host0).not.toHaveBeenCalled()
      expect(host1).toHaveBeenCalledTimes(1)
    } finally {
      unregisterEditorFormatter('/shared.ts', host1)
    }
    // 两份都注销后查表回到 no-op（Map 键清干净）
    await runEditorFormatter('/shared.ts')
    expect(host1).toHaveBeenCalledTimes(1)
  })

  it('同实现重复注册幂等：注销一次即全部摘除（Set 语义）', async () => {
    const fmt = makeFormatter()
    registerEditorFormatter('/dup.ts', fmt)
    registerEditorFormatter('/dup.ts', fmt)
    unregisterEditorFormatter('/dup.ts', fmt)
    await runEditorFormatter('/dup.ts')
    expect(fmt).not.toHaveBeenCalled()
  })

  it('实现抛错被兜住：resolve 不阻断保存链（失败降级直接保存语义）', async () => {
    const boom = vi.fn(async () => { throw new Error('formatter exploded') })
    registerEditorFormatter('/boom.ts', boom)
    try {
      await expect(runEditorFormatter('/boom.ts')).resolves.toBeUndefined()
      expect(boom).toHaveBeenCalledTimes(1)
    } finally {
      unregisterEditorFormatter('/boom.ts', boom)
    }
  })
})
