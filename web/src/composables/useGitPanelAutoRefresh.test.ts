import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, onUnmounted } from 'vue'
import {
  CATCHUP_DELAY_MS,
  GIT_PANEL_AUTO_REFRESH,
  GIT_PANEL_REFRESH_DEBOUNCE_MS,
  isGitWriteCommand,
  useGitPanelAutoRefresh,
} from './useGitPanelAutoRefresh'

describe('isGitWriteCommand', () => {
  it.each([
    ['git branch feature-x', true],
    ['git checkout main', true],
    ['git switch -c feat/auto', true],
    ['git commit -m "fix: something"', true],
    ['git tag v1.0.0', true],
    ['git push origin main', true],
    ['git pull --rebase', true],
    ['git merge feat', true],
    ['git rebase -i HEAD~3', true],
    ['git stash', true],
    ['git stash pop', true],
    ['git add -A && git commit -m "x"', true], // 复合命令切段命中
    ['cd /repo && git push', true], // 复合命令第二段
    ['GIT_AUTHOR_NAME=x git commit -m y', true], // VAR=value 前缀
    ['git -c core.autocrlf=false commit -m x', true], // 全局选项跳过
    ['  git branch  ', true], // 空白容忍
  ])('%s → %s', (line, want) => {
    expect(isGitWriteCommand(line)).toBe(want)
  })

  it.each([
    ['git status', false],
    ['git log --oneline', false],
    ['git diff HEAD', false],
    ['git branchless', false], // 前缀相同但非同一词元
    ['ls -la', false],
    ['npm run build', false],
    ['', false],
  ])('%s → %s', (line, want) => {
    expect(isGitWriteCommand(line)).toBe(false)
  })
})

describe('useGitPanelAutoRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  /** 最小可挂载宿主：composable 要求组件 setup 上下文（onBeforeUnmount 生效） */
  function mountWith(refresh: () => unknown | Promise<unknown>) {
    const root = document.createElement('div')
    document.body.appendChild(root)
    let unmounted = false
    const Host = defineComponent({
      setup() {
        useGitPanelAutoRefresh(refresh)
        onUnmounted(() => { unmounted = true })
        return () => h('div')
      },
    })
    const app = createApp(Host)
    app.mount(root)
    return {
      dispatch: () => window.dispatchEvent(new CustomEvent(GIT_PANEL_AUTO_REFRESH)),
      unmount: () => {
        app.unmount()
        return unmounted
      },
    }
  }

  it('命中事件去抖后刷新一次，TTL 外兜底轮保证收敛（且不无限续排）', async () => {
    const refresh = vi.fn()
    const ctx = mountWith(refresh)
    ctx.dispatch()
    expect(refresh).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(GIT_PANEL_REFRESH_DEBOUNCE_MS)
    expect(refresh).toHaveBeenCalledTimes(1)
    // 兜底轮：治服务端 3s 状态缓存窗口内的旧值命中
    await vi.advanceTimersByTimeAsync(CATCHUP_DELAY_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    // 兜底轮不再续排：收敛即止，不变成轮询
    await vi.advanceTimersByTimeAsync(CATCHUP_DELAY_MS * 3)
    expect(refresh).toHaveBeenCalledTimes(2)
    ctx.unmount()
  })

  it('连续事件合并为单次拉取（尾沿去抖）', async () => {
    const refresh = vi.fn()
    const ctx = mountWith(refresh)
    ctx.dispatch()
    await vi.advanceTimersByTimeAsync(400)
    ctx.dispatch()
    await vi.advanceTimersByTimeAsync(400)
    ctx.dispatch()
    await vi.advanceTimersByTimeAsync(GIT_PANEL_REFRESH_DEBOUNCE_MS)
    expect(refresh).toHaveBeenCalledTimes(1)
    ctx.unmount()
  })

  it('in-flight 期间的命中不丢：完成后补一轮', async () => {
    // 对象持有者规避 TS 闭包赋值的 null 窄化（release 须经回调赋值后再调用）
    const releaseRef: { fn?: () => void } = {}
    const refresh = vi.fn(() => new Promise<void>((resolve) => { releaseRef.fn = resolve }))
    const ctx = mountWith(refresh)
    ctx.dispatch()
    await vi.advanceTimersByTimeAsync(GIT_PANEL_REFRESH_DEBOUNCE_MS)
    expect(refresh).toHaveBeenCalledTimes(1)
    ctx.dispatch() // 上轮仍在途：不并发、不丢弃
    ctx.dispatch()
    await vi.advanceTimersByTimeAsync(GIT_PANEL_REFRESH_DEBOUNCE_MS)
    expect(refresh).toHaveBeenCalledTimes(1)
    releaseRef.fn?.()
    await vi.advanceTimersByTimeAsync(0)
    // 补拉仍走去抖：等待一个去抖窗口
    await vi.advanceTimersByTimeAsync(GIT_PANEL_REFRESH_DEBOUNCE_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    ctx.unmount()
  })

  it('卸载后移除监听，不再刷新', async () => {
    const refresh = vi.fn()
    const ctx = mountWith(refresh)
    expect(ctx.unmount()).toBe(true)
    ctx.dispatch()
    await vi.advanceTimersByTimeAsync(GIT_PANEL_REFRESH_DEBOUNCE_MS * 2)
    expect(refresh).not.toHaveBeenCalled()
  })

  it('refresh 抛错不冒泡（下次事件仍可触发）', async () => {
    const refresh = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined)
    const ctx = mountWith(refresh)
    ctx.dispatch()
    await vi.advanceTimersByTimeAsync(GIT_PANEL_REFRESH_DEBOUNCE_MS)
    ctx.dispatch()
    await vi.advanceTimersByTimeAsync(GIT_PANEL_REFRESH_DEBOUNCE_MS)
    expect(refresh).toHaveBeenCalledTimes(2)
    ctx.unmount()
  })
})
