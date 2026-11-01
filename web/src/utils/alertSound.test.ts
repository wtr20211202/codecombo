import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { playAlert, bindAudioUnlock, resetAlertSoundForTest } from '@/utils/alertSound'
import { useLockStore } from '@/stores/lock'
import { useDndStore } from '@/stores/dnd'
import { useSoundStore } from '@/stores/sound'

// 等待音效合成器门控矩阵（P-20261003-33）：总开关（默认开）/免打扰时段（P-40
// 同守卫位，例外类别穿透 P-20261003-115：approval 默认放行、ask 照旧静默）/
// 锁定态（P-5 同守卫位）/自动播放未解锁 四门串联；门控只吞声音不吞
// 卡（卡片入账链在 approvals/asks store，不经本模块——e2e approval-sound.spec
// 断言卡片照常弹出）。AudioContext 用记录型替身（createOscillator 计数）——
// jsdom 无 Web Audio，断言落在「合成器是否被调用」这一可测边界
function stubAudioContext(initialState = 'running') {
  const instances: Array<{ state: string; resume: () => Promise<void> }> = []
  let oscCount = 0
  class FakeOsc {
    type = ''
    frequency = { value: 0 }
    connect = vi.fn()
    start = vi.fn()
    stop = vi.fn()
  }
  class FakeGain {
    gain = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }
    connect = vi.fn()
  }
  class FakeAudioContext {
    destination = {}
    state = initialState
    currentTime = 0
    resume = vi.fn(async () => { this.state = 'running' })
    constructor() {
      instances.push(this)
    }
    createOscillator() {
      oscCount++
      return new FakeOsc()
    }
    createGain() {
      return new FakeGain()
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
  return { count: () => oscCount, instances }
}

// 首次用户手势（真实链路同款：pointerdown / keydown 事件 → bindAudioUnlock）
function gesture() {
  window.dispatchEvent(new Event('pointerdown'))
}

describe('playAlert 门控矩阵', () => {
  let audio: ReturnType<typeof stubAudioContext>

  beforeEach(() => {
    resetAlertSoundForTest()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // 免打扰用例的「窗口内」锚定：isWithinDnd 是分钟精度半开区间 [start, end)
  //（utils/dndSchedule.ts），用例窗口 end:'23:59' 意味着墙钟走到 23:59 这一
  // 分钟时窗口恰好不活跃——真实时钟下全表绿红随跑点翻转（2026-10-07 深夜
  // 23:59 实测 2 例假红）。钉在窗口正午，跑点无关
  function pinClockInsideWindow() {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 15, 10, 30))
  }

  it('门控全开 + 已手势解锁：振荡器被调用（上行双音 = 2 次创建）', () => {
    audio = stubAudioContext()
    useLockStore().isLocked = false
    bindAudioUnlock()
    gesture()
    playAlert('approval')
    expect(audio.count()).toBe(2)
  })

  it('总开关关（默认开语义的关闭态）：不调用', () => {
    audio = stubAudioContext()
    useLockStore().isLocked = false
    useSoundStore().set(false)
    bindAudioUnlock()
    gesture()
    playAlert('approval')
    expect(audio.count()).toBe(0)
  })

  it('免打扰时段内 ask（非例外类别）：静默（P-40 同守卫位语义不回归）', () => {
    audio = stubAudioContext()
    useLockStore().isLocked = false
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59' })
    pinClockInsideWindow()
    bindAudioUnlock()
    gesture()
    playAlert('ask')
    expect(audio.count()).toBe(0)
  })

  it('免打扰时段内 approval（默认例外类别）：穿透照响（P-20261003-115）', () => {
    audio = stubAudioContext()
    useLockStore().isLocked = false
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59' })
    pinClockInsideWindow()
    bindAudioUnlock()
    gesture()
    playAlert('approval')
    expect(audio.count()).toBe(2)
  })

  it('免打扰时段内 approval：例外清空后恢复静默（例外表可关）', () => {
    audio = stubAudioContext()
    useLockStore().isLocked = false
    useDndStore().set({ enabled: true, start: '00:00', end: '23:59', except: [] })
    pinClockInsideWindow()
    bindAudioUnlock()
    gesture()
    playAlert('approval')
    expect(audio.count()).toBe(0)
  })

  it('锁定态：静默（P-5 同守卫位语义不回归；锁定门不被例外穿透）', () => {
    audio = stubAudioContext()
    useLockStore().isLocked = true
    bindAudioUnlock()
    gesture()
    playAlert('approval')
    expect(audio.count()).toBe(0)
  })

  it('未手势解锁：上下文根本不创建，静默跳过（自动播放策略边界）', () => {
    audio = stubAudioContext()
    useLockStore().isLocked = false
    playAlert('approval') // 未 bindAudioUnlock / 未手势
    expect(audio.count()).toBe(0)
    expect(audio.instances).toHaveLength(0)
  })

  it('手势把 suspended 上下文拉成 running；解锁前到达的事件静默跳过不排队', async () => {
    audio = stubAudioContext('suspended')
    useLockStore().isLocked = false
    bindAudioUnlock()
    playAlert('approval') // 未解锁：静默跳过（不排队，下一事件正常响）
    expect(audio.count()).toBe(0)
    window.dispatchEvent(new Event('keydown')) // 纯键盘流也算手势
    await Promise.resolve() // resume 微任务落定
    expect(audio.instances[0]?.resume).toHaveBeenCalled()
    playAlert('approval')
    expect(audio.count()).toBe(2)
  })
})
