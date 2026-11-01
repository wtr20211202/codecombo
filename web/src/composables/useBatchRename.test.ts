import { beforeEach, describe, expect, it, vi } from 'vitest'

// 文件域 API mock：applyBatchRenames 走批量端点（P-20261006-39，唯一外部依赖）
vi.mock('../api/client', () => ({
  projectApi: {
    batchFiles: vi.fn(),
  },
}))

import { projectApi } from '../api/client'
import { useBatchRename } from './useBatchRename'

const mockedBatch = vi.mocked(projectApi.batchFiles)

/** 构造被测组合式：t 直返 key（断言 i18n 键），message 收集进数组供断言 */
function setup() {
  const messages: Array<{ kind: string; msg: string }> = []
  const refreshRoot = vi.fn(async () => {})
  const br = useBatchRename({
    projectId: () => 'p1',
    refreshRoot,
    message: {
      success: (m) => messages.push({ kind: 'success', msg: m }),
      warning: (m) => messages.push({ kind: 'warning', msg: m }),
      error: (m) => messages.push({ kind: 'error', msg: m }),
    },
    t: (k, p) => (p ? `${k}?${JSON.stringify(p)}` : k),
  })
  return { br, messages, refreshRoot }
}

/** 批量端点逐条结果桩：entries 按给定 status 回传（path = 提交 oldPath 原样） */
function batchResults(entries: Array<{ path: string; status: string; error?: string }>) {
  return {
    message: 'batch done',
    ok: entries.filter(e => e.status === 'ok').length,
    skipped: 0,
    failed: entries.filter(e => e.status !== 'ok').length,
    results: entries,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  // 业务形态经拦截器解包，测试桩直接给业务体（apiRes 同款 any 豁免）
  mockedBatch.mockResolvedValue(batchResults([]) as any)
})

describe('useBatchRename 批量重命名执行链（P-20261003-283 / P-20261006-39 批量端点收口）', () => {
  it('批量端点单请求收口：oldPath 升序（父目录先于子项）按提交序交出对照对', async () => {
    const { br, messages } = setup()
    mockedBatch.mockResolvedValue(batchResults([
      { path: 'pkg/old', status: 'ok' },
      { path: 'pkg/old/a.txt', status: 'ok' },
    ]) as any)
    await br.applyBatchRenames([
      { oldPath: 'pkg/old/a.txt', newPath: 'pkg/old/a.txt' },
      { oldPath: 'pkg/old', newPath: 'pkg/new' },
    ])
    // 单请求 N 对照对，父目录先于子项（服务端按提交序 resolve 子项旧路径）
    expect(mockedBatch).toHaveBeenCalledTimes(1)
    expect(mockedBatch.mock.calls[0]![1]).toEqual({
      action: 'rename',
      renames: [
        { oldPath: 'pkg/old', newPath: 'pkg/new' },
        { oldPath: 'pkg/old/a.txt', newPath: 'pkg/old/a.txt' },
      ],
    })
    expect(messages[0]).toMatchObject({ kind: 'success', msg: expect.stringContaining('fileTree.batchRename.done') })
  })

  it('重名逐条结果映射「目标已存在同名」跳过报告，批次不中断', async () => {
    const { br, messages } = setup()
    mockedBatch.mockResolvedValue(batchResults([
      { path: 'docs/dup.md', status: 'error', error: 'file already exists' },
      { path: 'docs/ok.md', status: 'ok' },
    ]) as any)
    await br.applyBatchRenames([
      { oldPath: 'docs/dup.md', newPath: 'docs/same.md' },
      { oldPath: 'docs/ok.md', newPath: 'docs/ok2.md' },
    ])
    expect(mockedBatch).toHaveBeenCalledTimes(1)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      kind: 'warning',
      msg: expect.stringContaining('fileTree.batchRename.skipExists'),
    })
  })

  it('一般失败逐条映射 skipFailed', async () => {
    const { br, messages } = setup()
    mockedBatch.mockResolvedValue(batchResults([
      { path: 'a.md', status: 'error', error: 'disk full' },
    ]) as any)
    await br.applyBatchRenames([{ oldPath: 'a.md', newPath: 'b.md' }])
    expect(messages[0]).toMatchObject({
      kind: 'warning',
      msg: expect.stringContaining('fileTree.batchRename.skipFailed'),
    })
  })

  it('单批上限封顶：超出部分不动并报告（护栏沿用 MOVE_BATCH_CAP）', async () => {
    const { br, messages } = setup()
    const pairs = Array.from({ length: 55 }, (_, i) => ({
      oldPath: `f${String(i).padStart(2, '0')}.md`,
      newPath: `g${String(i).padStart(2, '0')}.md`,
    }))
    mockedBatch.mockResolvedValue(batchResults(
      pairs.slice(0, 50).map(p => ({ path: p.oldPath, status: 'ok' })),
    ) as any)
    await br.applyBatchRenames(pairs)
    expect(mockedBatch).toHaveBeenCalledTimes(1)
    expect(mockedBatch.mock.calls[0]![1].renames).toHaveLength(50)
    expect(messages.some(m => m.kind === 'warning' && m.msg.includes('fileTree.batchRename.cap'))).toBe(true)
  })

  it('全失败：无成功不刷新整树，partial 跳过清单如实报告', async () => {
    const { br, messages, refreshRoot } = setup()
    mockedBatch.mockResolvedValue(batchResults([
      { path: 'a.md', status: 'error', error: 'disk full' },
    ]) as any)
    await br.applyBatchRenames([{ oldPath: 'a.md', newPath: 'b.md' }])
    expect(refreshRoot).not.toHaveBeenCalled()
    expect(messages[0]).toMatchObject({
      kind: 'warning',
      msg: expect.stringContaining('fileTree.batchRename.skipFailed'),
    })
  })

  it('整批请求级失败（网络/5xx）：逐条计入跳过清单，不静默吞批', async () => {
    const { br, messages } = setup()
    mockedBatch.mockRejectedValue(new Error('network down'))
    await br.applyBatchRenames([
      { oldPath: 'a.md', newPath: 'b.md' },
      { oldPath: 'c.md', newPath: 'd.md' },
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      kind: 'warning',
      msg: expect.stringContaining('fileTree.batchRename.skipFailed'),
    })
  })
})
