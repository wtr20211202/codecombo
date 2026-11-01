import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 运行书序贯执行器（P-20261004-13）状态机单测：
// e2e 只能覆盖 stop/continue 主链（runbook-onfailure.spec.ts）；这里收编帧时序
// 类分支——降级判定、超时视为完成、迟到 D 不消费、重放跳过、会话不可写——
// 这些路径在真实终端里无法稳定复现

import { useRunbookRunner } from '@/composables/useRunbookRunner'
import type { OscEvent } from '@/composables/useTerminalSession'

function dFrame(command: string | undefined, exitCode: number, durationMs = 1): OscEvent {
  return { type: 'D', command, exitCode, durationMs }
}

/** 组装执行器 + 记录写入序列的夹具（write 可按会话置 false 模拟不可写） */
function setup(writeOk = true) {
  const written: string[] = []
  const runner = useRunbookRunner((sessionId, data) => {
    void sessionId
    written.push(data)
    return writeOk
  })
  const start = (onFailure: 'continue' | 'stop', fromIndex = 0) =>
    runner.start({ bookId: 'b1', commands: ['a', 'b', 'c'], onFailure, fromIndex }, 's1')
  return { runner, written, start }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useRunbookRunner continue 模式', () => {
  it('节流连发全部命令，D 帧按 FIFO 回填状态；失败标红但不拦截', () => {
    const { runner, written, start } = setup()
    start('continue')

    // 节流间隔推进：三命令 350ms 间隔依次写出（a@0 / b@350 / c@700）
    awaitableAdvance(800)
    expect(written).toEqual(['a\r', 'b\r', 'c\r'])
    // 末条发送后的节流器再走完（cursor 越过末尾）才 finished
    awaitableAdvance(400)
    expect(runner.run.value?.phase).toBe('finished')

    // D 帧回填：b 失败 → 标红（failedIndex=1）但不拦截——c 已在飞、phase 仍 finished
    runner.onOscEvent(dFrame('a', 0), 's1')
    runner.onOscEvent(dFrame('b', 7), 's1')
    expect(runner.run.value?.states).toEqual(['done', 'failed', 'running'])
    expect(runner.run.value?.failedIndex).toBe(1)
    expect(runner.run.value?.phase).toBe('finished')

    runner.onOscEvent(dFrame('c', 0), 's1')
    expect(runner.run.value?.states).toEqual(['done', 'failed', 'done'])
  })

  it('命令文本对不上的 D（人工命令/迟到帧）不消费', () => {
    const { runner, start } = setup()
    start('continue')
    awaitableAdvance(800)
    runner.onOscEvent(dFrame('human-cmd', 0), 's1')
    expect(runner.run.value?.states).toEqual(['running', 'running', 'running'])
  })

  it('其他会话与重放段的 D 不消费', () => {
    const { runner, start } = setup()
    start('continue')
    awaitableAdvance(800)
    runner.onOscEvent(dFrame('a', 0), 'other-session')
    runner.onOscEvent({ type: 'D', command: 'a', exitCode: 0, replayed: true }, 's1')
    expect(runner.run.value?.states).toEqual(['running', 'running', 'running'])
  })
})

describe('useRunbookRunner stop 模式', () => {
  it('单飞行等退出码：非 0 停在失败项，后续命令不发送', () => {
    const { runner, written, start } = setup()
    start('stop')

    expect(written).toEqual(['a\r'])
    expect(runner.run.value?.phase).toBe('awaitingExit')

    // a 成功 → 推进发送 b
    runner.onOscEvent(dFrame('a', 0), 's1')
    expect(written).toEqual(['a\r', 'b\r'])

    // b 失败 → 停在第 2 步，c 不发送
    runner.onOscEvent(dFrame('b', 3), 's1')
    expect(written).toEqual(['a\r', 'b\r'])
    expect(runner.run.value?.phase).toBe('failed')
    expect(runner.run.value?.failedIndex).toBe(1)
    expect(runner.run.value?.cursor).toBe(1)
    expect(runner.run.value?.states).toEqual(['done', 'failed', 'pending'])
  })

  it('从失败项继续：重跑失败步并跑完全程', () => {
    const { runner, written, start } = setup()
    start('stop')
    runner.onOscEvent(dFrame('a', 0), 's1')
    runner.onOscEvent(dFrame('b', 3), 's1')
    expect(runner.run.value?.phase).toBe('failed')

    // 从失败项（index 1）重启：states 重建，重跑 b → 成功 → c → 完成
    start('stop', 1)
    expect(written).toEqual(['a\r', 'b\r', 'b\r'])
    expect(runner.run.value?.states).toEqual(['pending', 'running', 'pending'])
    runner.onOscEvent(dFrame('b', 0, 999), 's1')
    runner.onOscEvent(dFrame('c', 0, 999), 's1')
    expect(runner.run.value?.phase).toBe('finished')
    expect(runner.run.value?.states).toEqual(['pending', 'done', 'done'])
  })

  it('整轮无帧：首条等待超时降级连续发送并置 degraded（诚实注记）', () => {
    const { runner, written, start } = setup()
    start('stop')

    // 30s 无任何 C/D 帧 → 降级：余下步骤节流连发
    vi.advanceTimersByTime(30_000)
    expect(runner.run.value?.degraded).toBe(true)
    expect(runner.run.value?.phase).toBe('running')
    awaitableAdvance(800)
    expect(written).toEqual(['a\r', 'b\r', 'c\r'])
    expect(runner.run.value?.phase).toBe('finished')
  })

  it('有集成但队头超时：视为完成继续（迟到 D 经文本对账不误标后续步）', () => {
    const { runner, written, start } = setup()
    start('stop')

    runner.onOscEvent({ type: 'C' }, 's1') // a 已开始（集成在位）
    runner.onOscEvent(dFrame('a', 0), 's1') // a 完成 → 发 b
    expect(written).toEqual(['a\r', 'b\r'])

    // b 是长任务：30s 无 D → 视为完成继续发 c
    vi.advanceTimersByTime(30_000)
    expect(written).toEqual(['a\r', 'b\r', 'c\r'])
    expect(runner.run.value?.states).toEqual(['done', 'done', 'running'])

    // b 的迟到 D 到达：文本对上的是队头 c 之外的历史 → 不消费，c 仍 awaitingExit
    runner.onOscEvent(dFrame('b', 5, 31_000), 's1')
    expect(runner.run.value?.states).toEqual(['done', 'done', 'running'])
    expect(runner.run.value?.phase).toBe('awaitingExit')

    // c 正常完成
    runner.onOscEvent(dFrame('c', 0), 's1')
    expect(runner.run.value?.phase).toBe('finished')
  })

  it('用户停止：未决步骤回 pending，phase=stopped', () => {
    const { runner, start } = setup()
    start('stop')
    runner.stop()
    expect(runner.run.value?.phase).toBe('stopped')
    expect(runner.run.value?.states).toEqual(['pending', 'pending', 'pending'])

    // 停止后迟到的 D 不再推进
    runner.onOscEvent(dFrame('a', 0), 's1')
    expect(runner.run.value?.phase).toBe('stopped')
  })
})

describe('useRunbookRunner 边界', () => {
  it('会话不可写：如实停在该步（failed + failedIndex）', () => {
    const { runner, start } = setup(false)
    start('stop')
    expect(runner.run.value?.phase).toBe('failed')
    expect(runner.run.value?.failedIndex).toBe(0)
    expect(runner.run.value?.states).toEqual(['failed', 'pending', 'pending'])
  })

  it('fromIndex 越界钳制在末步', () => {
    const { runner, written, start } = setup()
    start('continue', 99)
    expect(written).toEqual(['c\r'])
  })
})

/** 推进假时钟的显式封装（保持用例行短） */
function awaitableAdvance(ms: number): void {
  vi.advanceTimersByTime(ms)
}
