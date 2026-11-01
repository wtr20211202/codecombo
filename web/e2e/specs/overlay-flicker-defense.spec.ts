import { devices, test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, LOCK_OVERLAY, fixedLocale, unlockIfNeeded, waitForAppReady } from '../../tests/helpers'

/**
 * 全屏遮罩过渡卡死防御与闪烁自诊断 E2E（P-20261011-1）
 *
 * 覆盖（任务书验证面逐项）：
 * - 遮罩离场后 DOM 移除：boot / lock 遮罩离场过渡最终把元素从 DOM 拿掉
 *   （v-if 收起），不在低帧率环境下永久残留
 * - pointer-events 断言：离场期（*-leave-active 在场时）computed
 *   pointer-events = none——离场余韵不吞全页点击（串流残留可用性兜底）；
 *   三遮罩族的豁免规则均在产物样式表中（scoped 规则扫描）
 * - debug 参数事件流断言：?__debug-flicker=1 冷启动/负例（无参数不激活），
 *   console `[flicker]` 流含 boot 遮罩 show/leave-active/hide，window.__scFlickerLog
 *   与 __scFlickerDump() 可供智能体回传
 * - coarse 模拟下动画减弱断言：coarse 指针（触屏/串流形态）下 boot 离场
 *   transition-duration 减半（0.2s→0.1s）；模拟不可得时以样式表规则存在性
 *   兜底断言（诚实边界，见用例内注记）
 *
 * 实现注记：离场期快照经 addInitScript 注入 MutationObserver——leave-active
 * 类挂上/摘下的瞬间即被捕获（微任务级），无轮询竞态；类存在窗口最短 100ms
 * （coarse 减半后），快照读取必落在窗口内。
 */

const BOOT_OVERLAY = '.app-boot-loading'

interface OverlayLeaveSnapshot {
  cls: string
  pointerEvents: string
  transitionDuration: string
}

/** 注入离场期快照记录器：三遮罩族任一进入过渡阶段类即记 computed pointer-events/时长 */
async function installOverlayTraceRecorder(page: Page): Promise<void> {
  // addInitScript 必须传函数（Playwright 序列化后执行）；传字符串形式的箭头
  // 函数只会被求值不会被调用——首轮真机验证 __overlayTrace 恒 undefined 即此因
  await page.addInitScript(() => {
    const w = window as unknown as {
      __overlayTrace: Array<{ cls: string; pointerEvents: string; transitionDuration: string }>
    }
    w.__overlayTrace = []
    const SEL = '.app-boot-loading, .instance-switch-overlay, .lock-overlay'
    const PHASE_RE = /-(enter|leave)-(active|from|to)/
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type !== 'attributes') continue
        const el = m.target
        if (!(el instanceof Element) || !el.matches(SEL)) continue
        const cls = el.className
        if (!PHASE_RE.test(cls)) continue
        const cs = getComputedStyle(el)
        w.__overlayTrace.push({
          cls,
          pointerEvents: cs.pointerEvents,
          transitionDuration: cs.transitionDuration,
        })
      }
    })
    const arm = (): void => {
      if (document.body) {
        mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] })
      } else {
        setTimeout(arm, 0)
      }
    }
    arm()
  })
}

/** 收集页面 console 里的 [flicker] 诊断行 */
function collectFlickerLines(page: Page): string[] {
  const lines: string[] = []
  page.on('console', (m) => {
    if (m.text().includes('[flicker]')) lines.push(m.text())
  })
  return lines
}

/** 扫描产物样式表：遮罩族离场 pointer-events 豁免规则 + coarse 减半规则是否在包 */
async function scanOverlayCssRules(page: Page) {
  return await page.evaluate(() => {
    const found = {
      bootPointerExempt: false,
      lockPointerExempt: false,
      switchPointerExempt: false,
      coarseBootHalved: false,
      coarseLockHalved: false,
      coarseSwitchHalved: false,
    }
    const walk = (rules: CSSRuleList): void => {
      for (const rule of rules) {
        if (rule instanceof CSSMediaRule) {
          if (/pointer\s*:\s*coarse/.test(rule.conditionText)) {
            for (const inner of rule.cssRules) {
              const style = inner as CSSStyleRule
              const sel = style.selectorText ?? ''
              const dur = style.style?.transitionDuration ?? ''
              if (sel.includes('.boot-fade-leave-active') && dur === '0.1s') found.coarseBootHalved = true
              if (sel.includes('.lock-fade-leave-active') && dur === '0.15s') found.coarseLockHalved = true
              if (sel.includes('.instance-switch-fade-leave-active') && dur === '0.1s') found.coarseSwitchHalved = true
            }
          }
          walk(rule.cssRules)
          continue
        }
        if (rule instanceof CSSStyleRule) {
          const sel = rule.selectorText ?? ''
          if (rule.style.pointerEvents === 'none') {
            if (sel.includes('.boot-fade-leave-active')) found.bootPointerExempt = true
            if (sel.includes('.lock-fade-leave-active')) found.lockPointerExempt = true
            if (sel.includes('.instance-switch-fade-leave-active')) found.switchPointerExempt = true
          }
        }
      }
    }
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules)
      } catch {
        // 跨源样式表不可读：本应用全部同源，防御 continue
      }
    }
    return found
  })
}

test.describe('全屏遮罩过渡防御与闪烁自诊断', () => {
  test('boot 遮罩：离场 pointer-events 豁免 + DOM 移除 + 诊断事件流（冷启动激活）', async ({ page }) => {
    await fixedLocale(page)
    await installOverlayTraceRecorder(page)
    const flickerLines = collectFlickerLines(page)

    await page.goto('/?__debug-flicker=1')

    // 离场收尾：元素从 DOM 移除（v-if 收起），非永久残留
    await expect(page.locator(BOOT_OVERLAY)).toHaveCount(0, { timeout: 15000 })
    await waitForAppReady(page)

    // 离场期快照：leave-active 在场时 computed pointer-events=none（①层防御）。
    // 属性读取必须在 evaluate 回调体内——写在 Promise 上取到的恒为 undefined
    const trace = await page.evaluate(() => (window as unknown as { __overlayTrace: OverlayLeaveSnapshot[] }).__overlayTrace)
    expect(trace, '快照记录器已注入（addInitScript 生效）').toBeDefined()
    const leaveSnapshots = trace!.filter(t => t.cls.includes('boot-fade-leave-active'))
    expect(leaveSnapshots.length, 'boot 离场阶段类至少被捕获一次').toBeGreaterThan(0)
    for (const snap of leaveSnapshots) {
      expect(snap.pointerEvents, `离场期 pointer-events（classes=${snap.cls}）`).toBe('none')
    }
    // 桌面基线时长未被 coarse 规则影响
    expect(leaveSnapshots.some(s => s.transitionDuration === '0.2s')).toBe(true)

    // 诊断事件流：show → leave 阶段 → hide 全链路 + 智能体取数口
    expect(flickerLines.some(l => l.includes('show') && l.includes('.app-boot-loading'))).toBe(true)
    expect(flickerLines.some(l => l.includes('phase=leave-active') && l.includes('.app-boot-loading'))).toBe(true)
    expect(flickerLines.some(l => l.includes('hide') && l.includes('.app-boot-loading'))).toBe(true)
    const dump = await page.evaluate(() => {
      const w = window as unknown as { __scFlickerLog?: unknown[]; __scFlickerDump?: () => string }
      return { log: w.__scFlickerLog, text: w.__scFlickerDump?.() ?? '' }
    })
    expect((dump.log ?? []).length).toBeGreaterThan(0)
    expect(dump.text).toContain('app-boot-loading')

    // 全屏遮罩族离场豁免规则 + coarse 减半规则均已随构建出包（scoped 规则扫描）
    const css = await scanOverlayCssRules(page)
    expect(css.bootPointerExempt).toBe(true)
    expect(css.lockPointerExempt).toBe(true)
    expect(css.switchPointerExempt).toBe(true)
    expect(css.coarseBootHalved).toBe(true)
    expect(css.coarseLockHalved).toBe(true)
    expect(css.coarseSwitchHalved).toBe(true)
  })

  test('无诊断参数不激活事件流（负例）', async ({ page }) => {
    await fixedLocale(page)
    const flickerLines = collectFlickerLines(page)
    await page.goto('/')
    await waitForAppReady(page)
    await page.waitForTimeout(500)
    expect(flickerLines, '无参数时不得有 [flicker] 输出').toHaveLength(0)
    const armed = await page.evaluate(() => {
      return '__scFlickerLog' in window
    })
    expect(armed).toBe(false)
  })

  test('lock 遮罩：解锁离场 pointer-events 豁免 + DOM 移除 + 诊断事件流', async ({ page, request }) => {
    await fixedLocale(page)
    await installOverlayTraceRecorder(page)
    const flickerLines = collectFlickerLines(page)

    // 前置：开启锁定（种子默认关闭）——API 解锁取 token → PUT config 启用
    //（config 更新会撤销全部 token，故 UI 解锁后用页面侧 token 恢复）。
    // 用独立 request fixture（独立 cookie jar）：P-20261019-2 起解锁响应下发
    // HttpOnly 会话 cookie，page.request 与浏览器共享 jar 会把会话「赠予」
    // 页面，遮罩永不出现——独立 jar 保持浏览器上下文无会话
    {
      const unlock = await request.post('/api/lock/unlock', {
        data: { password: DEFAULT_PASSWORD },
        failOnStatusCode: false,
      })
      expect(unlock.ok(), 'API 解锁（默认密码）').toBeTruthy()
      const token = ((await unlock.json()) as { token?: string }).token ?? ''
      const enable = await request.put('/api/lock/config', {
        headers: { 'X-Lock-Token': token },
        data: { enabled: true, currentPassword: DEFAULT_PASSWORD, autoLockEnabled: false, autoLockMinutes: 120, tokenTTLMinutes: 120 },
        failOnStatusCode: false,
      })
      expect(enable.ok(), '启用锁定开关').toBeTruthy()
    }

    try {
      await page.goto('/?__debug-flicker=1')
      await expect(page.locator(LOCK_OVERLAY)).toBeVisible({ timeout: 15000 })
      await unlockIfNeeded(page) // 含遮罩 count→0 断言（dwell 150ms + 淡出 300ms 内完成）

      const trace = await page.evaluate(() => (window as unknown as { __overlayTrace: OverlayLeaveSnapshot[] }).__overlayTrace)
      expect(trace, '快照记录器已注入（addInitScript 生效）').toBeDefined()
      const leaveSnapshots = trace!.filter(t => t.cls.includes('lock-fade-leave-active'))
      expect(leaveSnapshots.length, 'lock 离场阶段类至少被捕获一次').toBeGreaterThan(0)
      for (const snap of leaveSnapshots) {
        expect(snap.pointerEvents, `离场期 pointer-events（classes=${snap.cls}）`).toBe('none')
      }
      expect(flickerLines.some(l => l.includes('show') && l.includes('.lock-overlay'))).toBe(true)
      expect(flickerLines.some(l => l.includes('phase=leave-active') && l.includes('.lock-overlay'))).toBe(true)
      expect(flickerLines.some(l => l.includes('hide') && l.includes('.lock-overlay'))).toBe(true)
    } finally {
      // 恢复种子态（锁定关闭）：unlockIfNeeded 后会话在 HttpOnly cookie 里，
      // 页内同源 fetch 自动携带（P-20261019-2 起无 X-Lock-Token 头可带）
      await unlockIfNeeded(page).catch(() => {})
      const restore = await page.evaluate(async (pw) => {
        const resp = await fetch('/api/lock/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: false, currentPassword: pw, autoLockEnabled: false, autoLockMinutes: 120, tokenTTLMinutes: 120 }),
        })
        return resp.ok
      }, DEFAULT_PASSWORD)
      expect(restore, '恢复锁定开关为关闭（种子态）').toBe(true)
    }
  })

  test('coarse 指针（触屏/串流形态）下 boot 离场过渡减半', async ({ browser }) => {
    // 独立 context 做移动模拟（isMobile+hasTouch → 主指针 coarse）：不影响
    // 共享桌面 context 的其余用例。模拟不可得时按诚实边界 skip——减半规则的
    // 出包断言已在首个用例中无条件覆盖
    const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'zh-CN' })
    const page = await ctx.newPage()
    await installOverlayTraceRecorder(page)
    try {
      await page.goto('/?__debug-flicker=1')
      const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches)
      test.skip(!coarse, '当前 Chromium 移动模拟未翻转 pointer:coarse（环境边界），样式表规则断言已另行覆盖')
      await expect(page.locator(BOOT_OVERLAY)).toHaveCount(0, { timeout: 15000 })
      const trace = await page.evaluate(() => (window as unknown as { __overlayTrace: OverlayLeaveSnapshot[] }).__overlayTrace)
      expect(trace, '快照记录器已注入（addInitScript 生效）').toBeDefined()
      const leaveSnapshots = trace!.filter(t => t.cls.includes('boot-fade-leave-active'))
      expect(leaveSnapshots.length).toBeGreaterThan(0)
      for (const snap of leaveSnapshots) {
        expect(snap.transitionDuration, `coarse 下离场时长减半（classes=${snap.cls}）`).toBe('0.1s')
        expect(snap.pointerEvents).toBe('none')
      }
    } finally {
      await ctx.close()
    }
  })
})
