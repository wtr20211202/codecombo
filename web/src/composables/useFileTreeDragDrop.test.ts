import { beforeEach, describe, expect, it, vi } from 'vitest'

// 文件域 API mock：批量移动走 batchFiles（P-20261006-39，单请求 + 逐条结果）；
// 单文件拖放仍调 renameFile；上传（P-20261003-117）逐个调 uploadFiles（各自
// 链路的唯一外部依赖）；同名检测（P-20261003-230）先调 fileTree 拉目标目录清单求交
vi.mock('../api/client', () => ({
  projectApi: {
    renameFile: vi.fn(),
    batchFiles: vi.fn(),
    uploadFiles: vi.fn(),
    fileTree: vi.fn(),
  },
}))

import { ref } from 'vue'
import { projectApi } from '../api/client'
import { AppError } from '../api/error-types'
import { MOVE_BATCH_CAP, useFileTreeDragDrop } from './useFileTreeDragDrop'

const mockedRename = vi.mocked(projectApi.renameFile)
const mockedBatch = vi.mocked(projectApi.batchFiles)
const mockedUpload = vi.mocked(projectApi.uploadFiles)
const mockedFileTree = vi.mocked(projectApi.fileTree)

/** 构造被测组合式：t 直返 key（断言 i18n 键），message 收集进数组供断言；
 *  confirmSameName 可注入同名确认替身（缺省 null = 不注入，走真实对话框——
 *  无同名场景不会触发） */
function setup(selected: string[] = [], confirmSameName?: (names: string[], dest: string) => Promise<'skip' | 'overwrite' | 'cancel'>) {
  const messages: Array<{ kind: string; msg: string; params?: Record<string, unknown> }> = []
  const dd = useFileTreeDragDrop({
    projectId: () => 'p1',
    selectedPaths: ref(new Set(selected)),
    refreshTargetPath: vi.fn(),
    refreshRoot: vi.fn(),
    message: {
      success: (m) => messages.push({ kind: 'success', msg: m }),
      warning: (m) => messages.push({ kind: 'warning', msg: m }),
      error: (m) => messages.push({ kind: 'error', msg: m }),
    },
    t: (k, p) => (p ? `${k}?${JSON.stringify(p)}` : k),
    confirmSameName,
  })
  return { dd, messages }
}

beforeEach(() => {
  vi.resetAllMocks()
  // 业务形态经拦截器解包，测试桩直接给业务体（apiRes 同款 any 豁免）
  mockedRename.mockResolvedValue({ message: 'renamed' } as any)
  mockedBatch.mockResolvedValue({ message: 'batch done', ok: 0, skipped: 0, failed: 0, results: [] } as any)
  mockedUpload.mockResolvedValue({ message: 'uploaded', saved: [], skipped: [] } as any)
  // 目标目录清单缺省为空（无同名）：既有用例不感知同名检测的存在
  mockedFileTree.mockResolvedValue({ data: [] } as any)
})

/** 按 paths×ok 构造批量端点逐条结果桩（path 提交原样回传） */
function batchResults(entries: string[], okPaths: string[], errorPaths: string[] = []) {
  return {
    message: 'batch done',
    ok: okPaths.length,
    skipped: 0,
    failed: errorPaths.length,
    results: [
      ...entries.map(p => ({ path: p, status: okPaths.includes(p) ? 'ok' : 'error', ...(errorPaths.includes(p) ? { error: 'boom' } : {}) })),
    ],
  }
}

describe('useFileTreeDragDrop 批量移动（P-20261003-160 / P-20261006-39 批量端点收口）', () => {
  it('onDragStart：锚点在 ≥2 多选集合内整组随行，否则单文件', () => {
    const { dd } = setup(['a', 'b'])
    dd.onDragStart(makeDrag() as unknown as DragEvent, { name: 'a', path: 'a', isDir: false })
    expect(dd.draggingPaths.value).toEqual(['a', 'b'])

    // 锚点不在集合内（未选中直接拖）：单文件语义
    dd.onDragStart(makeDrag() as unknown as DragEvent, { name: 'c', path: 'c', isDir: false })
    expect(dd.draggingPaths.value).toEqual(['c'])
  })

  it('moveEntries：嵌套条目随父目录去重，批量端点单请求收口', async () => {
    const { dd, messages } = setup()
    mockedBatch.mockResolvedValue(batchResults(['x', 'y'], ['x', 'y']) as any)
    await dd.moveEntries(['x', 'x/sub', 'y'], 'dst')
    // 单请求 N 条：action=move、嵌套子项不送出、目标目录随批
    expect(mockedBatch).toHaveBeenCalledTimes(1)
    expect(mockedBatch.mock.calls[0]![1]).toEqual({ action: 'move', entries: ['x', 'y'], destDir: 'dst' })
    expect(messages[0]).toMatchObject({ kind: 'success', msg: expect.stringContaining('fileTree.batchMove.done') })
  })

  it('moveEntries：移入自身子目录预筛就地跳过，不送出注定 no-op 条目', async () => {
    const { dd } = setup()
    mockedBatch.mockResolvedValue(batchResults(['x'], ['x']) as any)
    await dd.moveEntries(['dst/sub', 'x'], 'dst')
    const body = mockedBatch.mock.calls[0]![1]
    expect(body.entries).toEqual(['x'])
  })

  it('moveEntries：重名逐条结果映射「目标已存在同名」跳过报告，批次不中断', async () => {
    const { dd, messages } = setup()
    mockedBatch.mockResolvedValue({
      message: 'batch done', ok: 1, skipped: 0, failed: 1,
      results: [
        { path: 'dup.md', status: 'error', error: 'file already exists' },
        { path: 'ok.md', status: 'ok' },
      ],
    } as any)
    await dd.moveEntries(['dup.md', 'ok.md'], 'dst')
    expect(mockedBatch).toHaveBeenCalledTimes(1)
    // 重名项报告「目标已存在同名」（服务端逐条 error 稳定原文映射），批次完成
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      kind: 'warning',
      msg: expect.stringContaining('fileTree.batchMove.skipExists'),
    })
  })

  it('moveEntries：单批上限封顶，超出部分不动并报告', async () => {
    const { dd, messages } = setup()
    const paths = Array.from({ length: MOVE_BATCH_CAP + 3 }, (_, i) => `f${i}.md`)
    mockedBatch.mockResolvedValue(batchResults(paths.slice(0, MOVE_BATCH_CAP), paths.slice(0, MOVE_BATCH_CAP)) as any)
    await dd.moveEntries(paths, 'dst')
    expect(mockedBatch).toHaveBeenCalledTimes(1)
    expect(mockedBatch.mock.calls[0]![1].entries).toHaveLength(MOVE_BATCH_CAP)
    expect(messages.some(m => m.msg.startsWith('fileTree.batchMove.cap'))).toBe(true)
  })

  it('moveEntries：全部命中冲突时零成功不刷树，仅报跳过清单', async () => {
    const { dd, messages } = setup()
    const refreshRoot = vi.fn()
    const dd2 = useFileTreeDragDrop({
      projectId: () => 'p1',
      refreshTargetPath: vi.fn(),
      refreshRoot,
      message: {
        success: (m) => messages.push({ kind: 'success', msg: m }),
        warning: (m) => messages.push({ kind: 'warning', msg: m }),
        error: (m) => messages.push({ kind: 'error', msg: m }),
      },
      t: (k, p) => (p ? `${k}?${JSON.stringify(p)}` : k),
    })
    mockedBatch.mockResolvedValue({
      message: 'batch done', ok: 0, skipped: 0, failed: 1,
      results: [{ path: 'dup.md', status: 'error', error: 'file already exists' }],
    } as any)
    await dd2.moveEntries(['dup.md'], 'dst')
    expect(refreshRoot).not.toHaveBeenCalled()
    expect(messages[0]).toMatchObject({ kind: 'warning', msg: expect.stringContaining('fileTree.batchMove.skipExists') })
  })

  it('moveEntries：整批请求级失败（网络/5xx）逐条计入跳过清单，不静默吞批', async () => {
    const { dd, messages } = setup()
    mockedBatch.mockRejectedValue(new Error('network down'))
    await dd.moveEntries(['a.md', 'b.md'], 'dst')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      kind: 'warning',
      msg: expect.stringContaining('fileTree.batchMove.skipFailed'),
    })
  })
})

/** DataTransfer 在 jsdom 不可用：拖拽单测只验证拖拽态记录，payload 用桩替身 */
function makeDrag() {
  return { dataTransfer: { effectAllowed: '', setData: vi.fn() } }
}

describe('useFileTreeDragDrop 批量复制（P-20261023-2③a batch copy 形态）', () => {
  it('copyEntries：嵌套去重 + batch 端点 copy 形态单请求收口，根目录 destDir 允许空串', async () => {
    const { dd, messages } = setup()
    mockedBatch.mockResolvedValue(batchResults(['x', 'y'], ['x', 'y']) as any)
    await dd.copyEntries(['x', 'x/sub', 'y'], '')
    expect(mockedBatch).toHaveBeenCalledTimes(1)
    expect(mockedBatch.mock.calls[0]![1]).toEqual({ action: 'copy', entries: ['x', 'y'], destDir: '' })
    expect(messages[0]).toMatchObject({ kind: 'success', msg: expect.stringContaining('fileTree.batchCopy.done') })
  })

  it('copyEntries：目标目录在源条目子树内预筛就地跳过（复制自吞方向，与 move 相反）', async () => {
    const { dd, messages } = setup()
    mockedBatch.mockResolvedValue(batchResults(['other.md'], ['other.md']) as any)
    await dd.copyEntries(['x', 'x/sub', 'other.md'], 'x/inner')
    // x 子树内目标被预筛（服务端同判定兜底），只送出健康条目
    expect(mockedBatch.mock.calls[0]![1].entries).toEqual(['other.md'])
    expect(messages[0]).toMatchObject({
      kind: 'warning',
      msg: expect.stringContaining('fileTree.batchCopy.skipInsideSelf'),
    })
  })

  it('copyEntries：服务端逐条 error（如目录超限）映射跳过清单，批次不中断', async () => {
    const { dd, messages } = setup()
    mockedBatch.mockResolvedValue({
      message: 'batch done', ok: 1, skipped: 0, failed: 1,
      results: [
        { path: 'big/', status: 'error', error: 'directory too large to copy (max 20000 entries)' },
        { path: 'ok.md', status: 'ok' },
      ],
    } as any)
    await dd.copyEntries(['big/', 'ok.md'], 'dst')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ kind: 'warning', msg: expect.stringContaining('fileTree.batchCopy.skipFailed') })
  })

  it('copyEntries：整批请求级失败逐条计入跳过清单，不静默吞批', async () => {
    const { dd, messages } = setup()
    mockedBatch.mockRejectedValue(new Error('network down'))
    await dd.copyEntries(['a.md'], 'dst')
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ kind: 'warning', msg: expect.stringContaining('fileTree.batchCopy.skipFailed') })
  })
})

describe('useFileTreeDragDrop 目录拖入子路径（P-20261023-2③b）', () => {
  it('含子路径的展平文件（name 带 /）：请求携 paths 旁挂字段，落位 dest 不变', async () => {
    mockedUpload.mockResolvedValue({ saved: ['sub/a.txt'], skipped: [] } as any)
    const { dd } = setup()
    await dd.uploadExternalFiles([new File(['a'], 'mydir/sub/a.txt')], 'docs')
    expect(mockedUpload).toHaveBeenCalledTimes(1)
    expect(mockedUpload.mock.calls[0]?.[5]).toEqual(['mydir/sub/a.txt'])
  })

  it('单段名文件：不带 paths 字段（既有请求零变化）', async () => {
    mockedUpload.mockResolvedValue({ saved: ['a.txt'], skipped: [] } as any)
    const { dd } = setup()
    await dd.uploadExternalFiles([new File(['a'], 'a.txt')], 'docs')
    expect(mockedUpload.mock.calls[0]?.[5]).toBeUndefined()
  })
})

describe('useFileTreeDragDrop 上传进度与失败重试（P-20261003-117）', () => {
  /** jsdom File 可直接构造；上传链路只消费 name（FormData 在 api 层，已 mock） */
  function makeFile(name: string) {
    return new File(['e2e probe'], name)
  }

  it('逐文件串行上传：N 文件 N 请求，全部成功后计数归零撤浮条 + 聚合成功 toast', async () => {
    mockedUpload.mockResolvedValue({ saved: ['x'], skipped: [] } as any)
    const { dd, messages } = setup()
    await dd.uploadExternalFiles([makeFile('a.md'), makeFile('b.md'), makeFile('c.md')], 'docs')
    // 每文件独立请求（原单发大请求 = 1 次调 3 个 File）
    expect(mockedUpload).toHaveBeenCalledTimes(3)
    expect(mockedUpload.mock.calls.every(c => c[1].length === 1)).toBe(true)
    expect(mockedUpload.mock.calls.every(c => c[2] === 'docs')).toBe(true)
    // 完成即撤：done/total 归零、无失败、浮条隐
    expect(dd.uploadDone.value).toBe(0)
    expect(dd.uploadTotal.value).toBe(0)
    expect(dd.uploadFailed.value).toHaveLength(0)
    expect(dd.uploadVisible.value).toBe(false)
    expect(dd.uploading.value).toBe(false)
    // 成功 toast 沿用聚合文案（一批一条，不逐文件刷）
    expect(messages).toEqual([
      { kind: 'success', msg: expect.stringContaining('fileTree.uploadSuccess') },
    ])
  })

  it('进度按文件粒度推进：泵送中 total/done/current 可见', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    mockedUpload.mockImplementationOnce(() => gate.then(() => ({ saved: ['a.md'], skipped: [] } as any)))
    const { dd } = setup()
    const p = dd.uploadExternalFiles([makeFile('a.md'), makeFile('b.md')], 'docs')
    await vi.waitFor(() => expect(dd.uploading.value).toBe(true))
    expect(dd.uploadTotal.value).toBe(2)
    expect(dd.uploadDone.value).toBe(0)
    expect(dd.uploadCurrent.value).toBe('a.md')
    expect(dd.uploadVisible.value).toBe(true)
    release()
    await p
    expect(dd.uploadVisible.value).toBe(false)
  })

  it('失败隔离：失败文件进清单不拦截器 toast，其余文件继续落地', async () => {
    mockedUpload.mockImplementation((_pid, files) =>
      files[0]!.name === 'bad.md'
        ? Promise.reject(new AppError('network', 'boom', 0, '/u', 'POST'))
        : Promise.resolve({ saved: [files[0]!.name], skipped: [] } as any),
    )
    const { dd, messages } = setup()
    await dd.uploadExternalFiles([makeFile('ok.md'), makeFile('bad.md'), makeFile('ok2.md')], 'docs')
    expect(mockedUpload).toHaveBeenCalledTimes(3)
    expect(dd.uploadFailed.value.map(f => f.file.name)).toEqual(['bad.md'])
    expect(dd.uploadVisible.value).toBe(true)
    // 批内有失败：成功 toast 不发（浮条清单已如实呈现），也无一文件级 error toast
    expect(messages).toEqual([])
  })

  it('重试全部：失败集再入队，成功后清单清空浮条撤下并结算 toast', async () => {
    mockedUpload.mockRejectedValueOnce(new AppError('network', 'boom', 0, '/u', 'POST'))
      .mockResolvedValue({ saved: ['bad.md'], skipped: [] } as any)
    const { dd, messages } = setup()
    await dd.uploadExternalFiles([makeFile('bad.md')], 'docs')
    expect(dd.uploadFailed.value).toHaveLength(1)
    await dd.retryUploadAllFailed()
    // 重试按原 dest 再入队；成功后走完整结算（toast + 撤浮条）
    expect(mockedUpload).toHaveBeenCalledTimes(2)
    expect(mockedUpload.mock.calls[1]?.[2]).toBe('docs')
    expect(dd.uploadFailed.value).toHaveLength(0)
    expect(dd.uploadVisible.value).toBe(false)
    expect(messages).toEqual([
      { kind: 'success', msg: expect.stringContaining('fileTree.uploadSuccess') },
    ])
  })

  it('逐个重试：只再入队选中项，其余失败项留在清单', async () => {
    mockedUpload.mockRejectedValue(new AppError('network', 'boom', 0, '/u', 'POST'))
    const { dd } = setup()
    await dd.uploadExternalFiles([makeFile('f1.md'), makeFile('f2.md')], 'docs')
    expect(dd.uploadFailed.value).toHaveLength(2)
    mockedUpload.mockResolvedValue({ saved: ['f1.md'], skipped: [] } as any)
    await dd.retryUploadOne(dd.uploadFailed.value[0]!)
    expect(mockedUpload).toHaveBeenCalledTimes(3)
    expect(dd.uploadFailed.value.map(f => f.file.name)).toEqual(['f2.md'])
    expect(dd.uploadVisible.value).toBe(true)
  })

  it('手动关闭（放弃失败项）：清单清零浮条撤下，不再发起请求', async () => {
    mockedUpload.mockRejectedValue(new AppError('network', 'boom', 0, '/u', 'POST'))
    const { dd } = setup()
    await dd.uploadExternalFiles([makeFile('f1.md')], 'docs')
    expect(dd.uploadVisible.value).toBe(true)
    dd.dismissUploadPanel()
    expect(dd.uploadFailed.value).toHaveLength(0)
    expect(dd.uploadDone.value).toBe(0)
    expect(dd.uploadVisible.value).toBe(false)
    expect(mockedUpload).toHaveBeenCalledTimes(1)
  })

  it('服务端 skipped：沿用逐条 warning 不入失败清单，零成功不刷树不发成功 toast', async () => {
    mockedUpload.mockResolvedValue({ saved: [], skipped: [{ name: 'big.md', reason: 'file too large (max 10GB)' }] } as any)
    const refreshTargetPath = vi.fn()
    const messages: Array<{ kind: string; msg: string }> = []
    const dd = useFileTreeDragDrop({
      projectId: () => 'p1',
      refreshTargetPath,
      refreshRoot: vi.fn(),
      message: {
        success: (m) => messages.push({ kind: 'success', msg: m }),
        warning: (m) => messages.push({ kind: 'warning', msg: m }),
        error: (m) => messages.push({ kind: 'error', msg: m }),
      },
      t: (k, p) => (p ? `${k}?${JSON.stringify(p)}` : k),
    })
    await dd.uploadExternalFiles([makeFile('big.md')], 'docs')
    expect(messages).toEqual([
      { kind: 'warning', msg: 'big.md: file too large (max 10GB)' },
    ])
    expect(dd.uploadFailed.value).toHaveLength(0)
    expect(dd.uploadVisible.value).toBe(false)
    expect(refreshTargetPath).not.toHaveBeenCalled()
  })

  it('上传中再入队：汇入同一泵循环逐个排空，不并发请求', async () => {
    let release1!: () => void
    const gate1 = new Promise<void>(r => { release1 = r })
    mockedUpload.mockImplementationOnce(() => gate1.then(() => ({ saved: ['a.md'], skipped: [] } as any)))
    const { dd } = setup()
    const p1 = dd.uploadExternalFiles([makeFile('a.md')], 'docs')
    await vi.waitFor(() => expect(dd.uploading.value).toBe(true))
    // 第一文件仍在途时入队第二批（P-230 起入队前多一步清单检测，promise 对象
    // 不再是同一泵引用）：汇入同一泵循环的语义断言 = 第二批就位后仍零并发请求
    const p2 = dd.uploadExternalFiles([makeFile('b.md')], 'docs')
    await vi.waitFor(() => expect(dd.uploadTotal.value).toBe(2))
    expect(mockedUpload).toHaveBeenCalledTimes(1)
    release1()
    await Promise.all([p1, p2])
    expect(mockedUpload).toHaveBeenCalledTimes(2)
    expect(dd.uploadVisible.value).toBe(false)
  })
})

describe('useFileTreeDragDrop 同名覆盖确认（P-20261003-230）', () => {
  function makeFile(name: string) {
    return new File(['e2e probe'], name)
  }

  it('命中同名：确认框携同名名单弹起，选「跳过」→ 只传其余文件且请求不带覆盖档', async () => {
    mockedFileTree.mockResolvedValue({ data: [{ name: 'a.md', path: 'a.md', isDir: false }] } as any)
    mockedUpload.mockResolvedValue({ saved: ['b.md'], skipped: [] } as any)
    const confirm = vi.fn().mockResolvedValue('skip')
    const { dd, messages } = setup([], confirm)
    await dd.uploadExternalFiles([makeFile('a.md'), makeFile('b.md')], 'docs')
    // 确认框收到同名名单与目标目录
    expect(confirm).toHaveBeenCalledWith(['a.md'], 'docs')
    // 跳过档：a.md 不发请求，b.md 照常（第 5 参 overwrite=false）
    expect(mockedUpload).toHaveBeenCalledTimes(1)
    expect(mockedUpload.mock.calls[0]?.[1][0]!.name).toBe('b.md')
    expect(mockedUpload.mock.calls[0]?.[4]).toBe(false)
    // 跳过清单即时反馈 + 其余文件成功结算
    expect(messages.some(m => m.kind === 'warning' && m.msg.startsWith('fileTree.uploadSameNameSkipped'))).toBe(true)
    expect(messages.some(m => m.kind === 'success' && m.msg.startsWith('fileTree.uploadSuccess'))).toBe(true)
  })

  it('命中同名：选「覆盖」→ 全量上传且请求带覆盖档', async () => {
    mockedFileTree.mockResolvedValue({ data: [{ name: 'a.md', path: 'a.md', isDir: false }] } as any)
    const confirm = vi.fn().mockResolvedValue('overwrite')
    const { dd, messages } = setup([], confirm)
    await dd.uploadExternalFiles([makeFile('a.md'), makeFile('b.md')], 'docs')
    expect(mockedUpload).toHaveBeenCalledTimes(2)
    // 覆盖档：每个请求 overwrite=true，无跳过 toast
    expect(mockedUpload.mock.calls.every(c => c[4] === true)).toBe(true)
    expect(messages.some(m => m.msg.startsWith('fileTree.uploadSameNameSkipped'))).toBe(false)
  })

  it('命中同名：取消 → 整批不动，零请求零浮条', async () => {
    mockedFileTree.mockResolvedValue({ data: [{ name: 'a.md', path: 'a.md', isDir: false }] } as any)
    const confirm = vi.fn().mockResolvedValue('cancel')
    const { dd, messages } = setup([], confirm)
    await dd.uploadExternalFiles([makeFile('a.md'), makeFile('b.md')], 'docs')
    expect(mockedUpload).not.toHaveBeenCalled()
    expect(dd.uploadVisible.value).toBe(false)
    expect(messages).toEqual([])
  })

  it('全部同名且跳过：零请求，仅跳过反馈不立批次', async () => {
    mockedFileTree.mockResolvedValue({ data: [{ name: 'a.md', path: 'a.md', isDir: false }] } as any)
    const confirm = vi.fn().mockResolvedValue('skip')
    const { dd, messages } = setup([], confirm)
    await dd.uploadExternalFiles([makeFile('a.md')], 'docs')
    expect(mockedUpload).not.toHaveBeenCalled()
    expect(dd.uploadVisible.value).toBe(false)
    expect(messages).toEqual([
      { kind: 'warning', msg: expect.stringContaining('fileTree.uploadSameNameSkipped') },
    ])
  })

  it('无同名：不弹确认框直接上传（检测请求发过一次）', async () => {
    const confirm = vi.fn().mockResolvedValue('skip')
    const { dd } = setup([], confirm)
    await dd.uploadExternalFiles([makeFile('b.md')], 'docs')
    expect(confirm).not.toHaveBeenCalled()
    expect(mockedUpload).toHaveBeenCalledTimes(1)
    expect(mockedFileTree).toHaveBeenCalledTimes(1)
  })

  it('清单失败降级：目录清单拉取失败视为无同名直传（服务端默认跳过是安全网），确认框不弹', async () => {
    mockedFileTree.mockRejectedValue(new AppError('network', 'boom', 0, '/u', 'GET'))
    const confirm = vi.fn().mockResolvedValue('skip')
    const { dd, messages } = setup([], confirm)
    await dd.uploadExternalFiles([makeFile('a.md')], 'docs')
    expect(confirm).not.toHaveBeenCalled()
    expect(mockedUpload).toHaveBeenCalledTimes(1)
    expect(mockedUpload.mock.calls[0]?.[4]).toBe(false)
    expect(messages.some(m => m.msg.startsWith('fileTree.uploadSameNameSkipped'))).toBe(false)
  })

  it('覆盖档失败重试：再入队保持覆盖意图，不退回跳过档', async () => {
    mockedFileTree.mockResolvedValue({ data: [{ name: 'a.md', path: 'a.md', isDir: false }] } as any)
    const confirm = vi.fn().mockResolvedValue('overwrite')
    mockedUpload.mockRejectedValueOnce(new AppError('network', 'boom', 0, '/u', 'POST'))
      .mockResolvedValue({ saved: ['a.md'], skipped: [] } as any)
    const { dd } = setup([], confirm)
    await dd.uploadExternalFiles([makeFile('a.md')], 'docs')
    expect(dd.uploadFailed.value).toHaveLength(1)
    await dd.retryUploadAllFailed()
    expect(mockedUpload).toHaveBeenCalledTimes(2)
    expect(mockedUpload.mock.calls[1]?.[4]).toBe(true)
    expect(dd.uploadFailed.value).toHaveLength(0)
  })
})
