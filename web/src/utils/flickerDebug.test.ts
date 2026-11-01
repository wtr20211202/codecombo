import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FLICKER_LOG_CAP,
  FLICKER_LOG_PREFIX,
  FLICKER_WATCH_SELECTORS,
  formatFlickerEvent,
  parseTransitionPhase,
  setFlickerDebug,
  startFlickerDebug,
  type FlickerEvent,
} from './flickerDebug'

// 闪烁自诊断（P-20261011-1 ④）：纯函数（阶段解析/行格式）+ jsdom 真实
// MutationObserver 事件流。诊断模式零侵入（只读观测），激活/停止/幂等语义
// 与环形缓冲上限一并在此守卫。

/** 等待 MutationObserver 微任务投递（jsdom 以 microtask 派发回调） */
function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** 取当前缓冲（start 后挂到 window 上） */
function buf(): FlickerEvent[] {
  return (window as unknown as { __scFlickerLog: FlickerEvent[] }).__scFlickerLog
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  setFlickerDebug(false)
  const w = window as unknown as { __scFlickerLog?: unknown; __scFlickerDump?: unknown }
  delete w.__scFlickerLog
  delete w.__scFlickerDump
  vi.restoreAllMocks()
})

describe('parseTransitionPhase 过渡阶段解析（P-20261011-1）', () => {
  it('boot 遮罩离场态（诊断现场实测类名组合）→ leave-active', () => {
    expect(parseTransitionPhase('app-boot-loading boot-fade-leave-active boot-fade-leave-to')).toBe('leave-active')
  })

  it('入场类取最后一个命中', () => {
    expect(parseTransitionPhase('lock-overlay lock-fade-enter-from lock-fade-enter-active')).toBe('enter-active')
  })

  it('无过渡类 → idle', () => {
    expect(parseTransitionPhase('instance-switch-overlay')).toBe('idle')
    expect(parseTransitionPhase('')).toBe('idle')
  })
})

describe('formatFlickerEvent 行格式', () => {
  it('前缀+相对时间+种类+目标+阶段+类名（e2e 按此 grep）', () => {
    const line = formatFlickerEvent({ t: 10, dt: 1234, kind: 'phase', target: '.lock-overlay', phase: 'leave-active', classes: 'lock-overlay lock-fade-leave-active' })
    expect(line).toBe(`${FLICKER_LOG_PREFIX} +1234ms phase .lock-overlay phase=leave-active classes="lock-overlay lock-fade-leave-active"`)
  })
})

describe('startFlickerDebug 事件流观测', () => {
  it('遮罩显隐与过渡阶段全链路入流：show → leave 阶段 → hide', async () => {
    startFlickerDebug()
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining(`${FLICKER_LOG_PREFIX} session start`),
    )

    const el = document.createElement('div')
    el.className = 'lock-overlay'
    document.body.appendChild(el)
    await flush()
    expect(buf().at(-1)).toMatchObject({ kind: 'show', target: '.lock-overlay', phase: 'idle' })

    el.classList.add('lock-fade-leave-active', 'lock-fade-leave-to')
    await flush()
    expect(buf().at(-1)).toMatchObject({ kind: 'phase', target: '.lock-overlay', phase: 'leave-active' })

    el.remove()
    await flush()
    expect(buf().at(-1)).toMatchObject({ kind: 'hide', target: '.lock-overlay' })

    // 控制台流与缓冲同源同格式（远控现场 F12 复制即得）
    const lines = vi.mocked(console.log).mock.calls.map(c => String(c[0]))
    expect(lines.some(l => l.startsWith(`${FLICKER_LOG_PREFIX} +`) && l.includes('hide .lock-overlay'))).toBe(true)
  })

  it('modal 包装 div：插入即携阶段类记 show（本体直击）→ 类切换记 phase → 内层 .n-modal-mask 显隐（后代扫描）', async () => {
    startFlickerDebug()
    const wrap = document.createElement('div')
    wrap.className = 'fade-in-scale-up-transition-enter-active'
    const mask = document.createElement('div')
    mask.className = 'n-modal-mask'
    wrap.appendChild(mask)
    document.body.appendChild(wrap)
    await flush()
    // 插入事件本体命中阶段类选择器 → show（包装 div 的 target 即阶段类）
    expect(buf().some(e => e.kind === 'show' && e.target === '.fade-in-scale-up-transition-enter-active')).toBe(true)
    expect(buf().some(e => e.kind === 'show' && e.target === '.n-modal-mask')).toBe(true)

    // 类切换（enter→leave）经 attribute 突变记 phase
    wrap.className = 'fade-in-scale-up-transition-leave-active'
    await flush()
    expect(buf().some(e => e.kind === 'phase' && e.target === '.fade-in-scale-up-transition-leave-active')).toBe(true)

    wrap.remove()
    await flush()
    expect(buf().some(e => e.kind === 'hide' && e.target === '.n-modal-mask')).toBe(true)
  })

  it('类名未变的重复突变不打（Vue 批量 patch 去重）', async () => {
    startFlickerDebug()
    const el = document.createElement('div')
    el.className = 'app-boot-loading'
    document.body.appendChild(el)
    await flush()
    const before = buf().length
    el.setAttribute('class', 'app-boot-loading') // 同值重写
    await flush()
    expect(buf().length).toBe(before)
    el.remove()
  })

  it('环形缓冲上限：超出丢最旧，防振荡风暴打爆内存', async () => {
    startFlickerDebug()
    const el = document.createElement('div')
    el.className = 'instance-switch-overlay'
    document.body.appendChild(el)
    await flush()
    const first = buf()[0]!
    // 用「每元素一条 show」驱动触顶：show 事件不参与同值去重，且批量 append
    // 在同一次回调投递内逐记录处理——确定性触顶。真实振荡风暴（同一元素反复
    // 进出）的类名变更分属不同任务（Vue 过渡类经 rAF 分帧挂摘），回调读到的
    // 类名逐帧不同，不会被去重吞掉——jsdom 同步循环读到的恒为终态，不可复现
    for (let i = 0; i < FLICKER_LOG_CAP + 50; i++) {
      const storm = document.createElement('div')
      storm.className = 'instance-switch-overlay'
      document.body.appendChild(storm)
    }
    await flush()
    expect(buf().length).toBe(FLICKER_LOG_CAP)
    expect(buf().includes(first)).toBe(false)
    el.remove()
  })

  it('幂等：重复 start 返回同一 stop；stop 后停流可安全重入', async () => {
    const stop1 = startFlickerDebug()
    const stop2 = startFlickerDebug()
    expect(stop2).toBe(stop1)
    stop1()
    expect(() => stop1()).not.toThrow() // 重入守卫
    const before = buf().length
    const el = document.createElement('div')
    el.className = 'lock-overlay'
    document.body.appendChild(el)
    await flush()
    expect(buf().length).toBe(before) // 已停流，不再记录
    el.remove()
  })

  it('setFlickerDebug 开关幂等；__scFlickerDump 导出全文供智能体回传', async () => {
    setFlickerDebug(true)
    setFlickerDebug(true) // 同向重复无副作用
    const el = document.createElement('div')
    el.className = 'lock-overlay'
    document.body.appendChild(el)
    await flush()
    setFlickerDebug(false)
    setFlickerDebug(false) // 同向重复无副作用
    const dump = (window as unknown as { __scFlickerDump: () => string }).__scFlickerDump()
    expect(dump).toContain('show .lock-overlay')
    expect(dump.split('\n').every(l => l.startsWith(FLICKER_LOG_PREFIX))).toBe(true)
    el.remove()
  })

  it('选择器清单覆盖全屏遮罩族与顶层弹层（锚点类名漂移即红）', () => {
    expect(FLICKER_WATCH_SELECTORS).toEqual(expect.arrayContaining([
      '.app-boot-loading',
      '.instance-switch-overlay',
      '.lock-overlay',
      '.n-modal-mask',
    ]))
  })
})
