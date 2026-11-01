import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useGitOpsStore, GIT_SPINNER_DELAY_MS } from '@/stores/gitOps'

/**
 * git 操作 in-flight 记账面（P-20261005-211）单测：计数配对 / tryBegin 去重 /
 * spinner 延迟显示（快操作不亮）/ per 项目 per 操作隔离。定时器走 fake timers
 * 确定性地覆盖 150ms 阈值两侧。
 */

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('begin/end 计数配对', () => {
  it('begin 后 isBusy 真,end 后复位;计数并发下只在最后一笔 end 复位', () => {
    const s = useGitOpsStore()
    expect(s.isBusy('p1', 'push')).toBe(false)
    s.begin('p1', 'push')
    s.begin('p1', 'push') // 合法并发(分支右键推送与快捷推送同飞)
    expect(s.isBusy('p1', 'push')).toBe(true)
    s.end('p1', 'push')
    expect(s.isBusy('p1', 'push')).toBe(true)
    s.end('p1', 'push')
    expect(s.isBusy('p1', 'push')).toBe(false)
  })

  it('end 多记(超过 begin)不产生负计数', () => {
    const s = useGitOpsStore()
    s.begin('p1', 'fetch')
    s.end('p1', 'fetch')
    s.end('p1', 'fetch')
    expect(s.isBusy('p1', 'fetch')).toBe(false)
  })
})

describe('tryBegin 去重闸', () => {
  it('空闲放行并记账;飞行中拒绝且不叠加计数', () => {
    const s = useGitOpsStore()
    expect(s.tryBegin('p1', 'commit')).toBe(true)
    expect(s.tryBegin('p1', 'commit')).toBe(false)
    expect(s.inflight['p1|commit']).toBe(1)
    s.end('p1', 'commit')
    expect(s.tryBegin('p1', 'commit')).toBe(true) // 复位后可再次放行
  })
})

describe('spinner 延迟显示(快操作零感知)', () => {
  it('阈值内结束:spinner 从未亮起(不抖动)', () => {
    const s = useGitOpsStore()
    s.begin('p1', 'stage')
    vi.advanceTimersByTime(GIT_SPINNER_DELAY_MS - 1)
    expect(s.spinnerOn('p1', 'stage')).toBe(false)
    s.end('p1', 'stage')
    vi.advanceTimersByTime(GIT_SPINNER_DELAY_MS * 10)
    expect(s.spinnerOn('p1', 'stage')).toBe(false)
  })

  it('超过阈值仍 in-flight:spinner 亮起,end 后熄灭', () => {
    const s = useGitOpsStore()
    s.begin('p1', 'pull')
    vi.advanceTimersByTime(GIT_SPINNER_DELAY_MS)
    expect(s.spinnerOn('p1', 'pull')).toBe(true)
    s.end('p1', 'pull')
    expect(s.spinnerOn('p1', 'pull')).toBe(false)
  })

  it('慢操作期间新并发 begin 不重启已亮 spinner(定时器不重复挂)', () => {
    const s = useGitOpsStore()
    s.begin('p1', 'fetch')
    vi.advanceTimersByTime(GIT_SPINNER_DELAY_MS + 100)
    expect(s.spinnerOn('p1', 'fetch')).toBe(true)
    s.begin('p1', 'fetch')
    s.end('p1', 'fetch') // 并发中撤走一笔,仍有在飞
    vi.advanceTimersByTime(GIT_SPINNER_DELAY_MS * 5)
    expect(s.isBusy('p1', 'fetch')).toBe(true)
    expect(s.spinnerOn('p1', 'fetch')).toBe(true)
  })
})

describe('per 项目 per 操作隔离', () => {
  it('同操作跨项目互不影响,同项目跨操作互不影响', () => {
    const s = useGitOpsStore()
    s.begin('p1', 'pull')
    expect(s.isBusy('p2', 'pull')).toBe(false)
    expect(s.isBusy('p1', 'push')).toBe(false)
    expect(s.tryBegin('p2', 'pull')).toBe(true)
    expect(s.tryBegin('p1', 'push')).toBe(true)
  })
})
