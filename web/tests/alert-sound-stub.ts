import type { Page } from '@playwright/test'

// 审批/提问等待音效桩（approval-sound.spec / notify-dnd-exception.spec 共用）：
// 音频本身不可 e2e 断言（headless 语境无音频输出），以记录型 AudioContext 桩
// （createOscillator 计数）断言「合成器调用发生 / 不发生」的门控矩阵。
// P-20261003-115 从 approval-sound.spec 抽出为共享模块——免打扰例外 spec
// 复用同款桩，避免两份桩漂移。

// 注入记录型 AudioContext 桩：createOscillator 计数暴露在 window 上（门控链在
// 应用侧，桩只回答「合成器是否被调用」）。state 预置 running——手势 resume 链
// 路由 alertSound 单测覆盖，此处桩的职责只有调用计数
export async function installSoundStub(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __soundOscCount?: number }
    w.__soundOscCount = 0
    class FakeOsc {
      type = ''
      frequency = { value: 0 }
      connect() { return this }
      start() { /* noop */ }
      stop() { /* noop */ }
    }
    class FakeGain {
      gain = { setValueAtTime() {}, exponentialRampToValueAtTime() {} }
      connect() { return this }
    }
    class FakeAudioContext {
      destination = {}
      state = 'running'
      currentTime = 0
      sampleRate = 44100
      baseLatency = 0
      resume() { return Promise.resolve() }
      createOscillator() {
        w.__soundOscCount = (w.__soundOscCount ?? 0) + 1
        return new FakeOsc()
      }
      createGain() { return new FakeGain() }
    }
    Object.defineProperty(window, 'AudioContext', {
      value: FakeAudioContext, configurable: true, writable: true,
    })
  })
}

export function soundOscCount(page: Page) {
  return page.evaluate(() => (window as unknown as { __soundOscCount?: number }).__soundOscCount ?? 0)
}

// 首次用户手势解锁音频（真实链路：keydown → bindAudioUnlock 建上下文；Shift
// 单键不匹配任何应用快捷键/终端拦截器）
export async function gestureUnlockAudio(page: Page) {
  await page.keyboard.press('Shift')
}

// 覆盖当前时刻的免打扰窗口：开始 2 分钟前、结束 10 分钟后——任意墙钟时刻
//（含午夜边界的 start>end 跨午夜形态）都是「时段内」，同 notify-dnd.spec
export function dndWindowCoveringNow(): { enabled: boolean; start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return {
    enabled: true,
    start: hm(new Date(Date.now() - 2 * 60_000)),
    end: hm(new Date(Date.now() + 10 * 60_000)),
  }
}
