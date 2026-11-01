import { beforeEach, describe, expect, it, vi } from 'vitest'

// 任务文件发起面共享助手（P-20261006-44）单测：mock 边界只有文件写 API——
// 阈值内零变化（不触盘）/ 超限写盘 / 写失败退回装箱截断 / 无项目上下文不触盘
const { writeFileMock } = vi.hoisted(() => ({
  writeFileMock: vi.fn<(id: string, path: string, content: string, config?: unknown) =>
    Promise<unknown>>(),
}))

vi.mock('../api/client', () => ({
  projectApi: { writeFile: (id: string, path: string, content: string, config?: unknown) => writeFileMock(id, path, content, config) },
}))

import { resolveTaskLaunchArgs } from './useTaskFileLaunch'
import { TASK_FILE_LAUNCH_ARGS, TASK_FILE_NAME } from '../utils/promptFit'

beforeEach(() => {
  writeFileMock.mockReset()
  writeFileMock.mockResolvedValue(undefined)
})

describe('resolveTaskLaunchArgs 任务文件发起面', () => {
  it('≤500 字节：原文直发零变化，不触盘', async () => {
    const text = '请修复以下 2 处技术债标记：\na.ts:1 // TODO: a'
    const r = await resolveTaskLaunchArgs('p1', text, text)
    expect(r).toEqual({ launchArgs: text, taskFile: false, degraded: false })
    expect(writeFileMock).not.toHaveBeenCalled()
  })

  it('超限：全文（含自述头）写项目根 .sc-task.md，launchArgs 换短引用指令', async () => {
    const full = `请修复以下 30 处技术债标记：\n${'x'.repeat(600)}`
    const r = await resolveTaskLaunchArgs('p1', full, '装箱截断版')
    expect(r).toEqual({ launchArgs: TASK_FILE_LAUNCH_ARGS, taskFile: true, degraded: false })
    expect(writeFileMock).toHaveBeenCalledTimes(1)
    const [id, path, content, config] = writeFileMock.mock.calls[0]!
    expect(id).toBe('p1')
    expect(path).toBe(TASK_FILE_NAME)
    expect(content).toContain('一次性任务载体')
    expect(content).toContain(full.trimEnd())
    // silent：写失败是预期降级分支，不叠拦截器 toast
    expect(config).toEqual({ silent: true })
  })

  it('写盘失败：退回原装箱截断（degraded 标记），发起不中断', async () => {
    writeFileMock.mockRejectedValue(new Error('403 project.locked'))
    const full = `请修复以下任务：\n${'y'.repeat(600)}`
    const r = await resolveTaskLaunchArgs('p1', full, '装箱截断版')
    expect(r).toEqual({ launchArgs: '装箱截断版', taskFile: false, degraded: true })
  })

  it('无项目上下文（projectId 空）：不具备文件面，直接装箱截断不触盘', async () => {
    const full = `请修复以下任务：\n${'z'.repeat(600)}`
    const r = await resolveTaskLaunchArgs('', full, '装箱截断版')
    expect(r).toEqual({ launchArgs: '装箱截断版', taskFile: false, degraded: false })
    expect(writeFileMock).not.toHaveBeenCalled()
  })
})
