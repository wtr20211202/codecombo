import { test, expect, type Page } from '@playwright/test'
import {
  LOCK_OVERLAY, fixedLocale, gotoAndUnlock, projectCardByName, setLockEnabled, unlockIfNeeded,
} from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 低特效档与默认降级 E2E（P-20261125-2 S1/S2/S3）
 *
 * 远控（UU 等串流）下设置/分享弹层与锁屏持续闪烁，根因高置信假设为「全屏遮罩
 * backdrop-filter 逐帧整层重采样」，在远控合成/捕获链路上被放大。本 spec 钉住
 * 三层交付面：
 *   ① S1 默认降级（零视觉变化面）：.n-modal-mask / .glass-panel 默认 computed
 *      backdrop-filter === 'none'；锁屏默认仍保留 blur(20px)（防窥安全面不降级）；
 *   ② S2 低特效档（设备本地开关 / ?__lowfx=1）：根属性 data-low-fx="1"、六处收口面
 *      （锁屏/命令面板/项目搜索/异常信号条/NModal 遮罩/glass 兜底——后两处 S1 已默认
 *      去模糊，此处再断言实底/兜底）backdrop-filter 全 none 且锁屏遮罩 alpha=1.0 实底、
 *      装饰动画停而功能性 spinner 仍在跑（反向断言防全杀）、scroll-behavior:auto、刷新后保持；
 *   ③ 设置·外观「视觉特效」行直存直生效（切标准即摘根属性）。
 *
 * 诚实边界：监控页 .attn-bar 只在有异常信号时挂载（构造成本高），本 spec 对它
 * 只断言样式表规则存在（选择器 + 声明在包内）；其余五处均对真实挂载元素断言。
 */

/** computed 样式读取（真实挂载元素；lock 用 CSS.supports 口径的字符串直比） */
async function computed(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((el) => {
    const cs = getComputedStyle(el)
    return {
      backdropFilter: cs.backdropFilter,
      backgroundColor: cs.backgroundColor,
      animationName: cs.animationName,
    }
  })
}

/** rgba 串 → alpha（'rgba(0, 0, 0, 0.55)' → 0.55；rgb(...) → 1；解析失败 null） */
function alphaOf(color: string): number | null {
  const m = color.match(/rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(?:,\s*([\d.]+)\s*)?\)/)
  if (!m) return null
  return m[1] === undefined ? 1 : Number(m[1])
}

/** 样式表规则存在性：低特效档收口规则（选择器各片段命中同一条规则的 selectorText，
 *  且该规则声明里某属性等于期望值）在包内。断言走 CSSOM 属性读取而非 cssText 子串：
 *  Chromium 会把 `animation: none` 序列化成简写全展开（`animation: auto ease 0s 1
 *  normal none running none`），按文本比对必假阴 */
async function hasLowFxRule(
  page: Page, selectorParts: string[], prop: string, value: string,
): Promise<boolean> {
  return page.evaluate(([parts, property, expected]) => {
    const squash = (s: string) => s.replace(/\s+/g, '')
    const walk = (rules: CSSRuleList): boolean => {
      for (const rule of Array.from(rules)) {
        const styleRule = rule as CSSStyleRule
        const selector = squash(styleRule.selectorText || '')
        if (selector && (parts as string[]).every(p => selector.includes(squash(p)))) {
          const got = styleRule.style?.getPropertyValue(property as string).trim()
          if (got === expected) return true
        }
        const nested = styleRule.cssRules
        if (nested && walk(nested)) return true
      }
      return false
    }
    return Array.from(document.styleSheets).some((sheet) => {
      try {
        return !!sheet.cssRules && walk(sheet.cssRules)
      } catch {
        return false // 跨源样式表读不到（本项目产物同源，仅防御）
      }
    })
  }, [selectorParts, prop, value] as const)
}

/** 进项目页（TopBar/设置弹窗只在 Layout 内） */
async function enterProject(page: Page) {
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.ide-root').first().waitFor({ state: 'visible', timeout: 15000 })
}

/** 打开设置·外观分区，返回遮罩 computed 样式（读完即关） */
async function openAppearancePane(page: Page) {
  await page.locator('.rail-btn[title="设置"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  await expect(page.locator('[data-testid="settings-low-fx"]')).toBeVisible({ timeout: 5000 })
}

test.describe('默认档（S1 默认降级，零视觉变化面）', () => {
  test('NModal 遮罩与 glass-panel 默认无模糊，锁屏默认保留防窥 blur', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    await enterProject(page)

    // 默认档 AppLogo 装饰动画在跑（对照低特效档的 none）。scoped 编译会给 keyframes
    // 名加 hash 后缀（logo-orbit-cw-b94b3db5），故只断言「有动画在跑」不硬编码名
    expect((await computed(page, '.logo-animated .logo-orbit-outer')).animationName).not.toBe('none')

    // 设置弹窗：全 NModal 遮罩吃 .n-modal-mask（S1 删 blur，底色 0.5→0.55）
    await openAppearancePane(page)
    const mask = await computed(page, '.n-modal-mask')
    expect(mask.backdropFilter).toBe('none')
    expect(alphaOf(mask.backgroundColor)).toBeCloseTo(0.55, 2)

    // 「视觉特效」行存在且默认标准档（根属性未设）
    await expect(page.locator('[data-testid="settings-low-fx"]')).toContainText('视觉特效')
    await expect(page.locator('html')).not.toHaveAttribute('data-low-fx', '1')
    await page.keyboard.press('Escape')
    await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })

    // .glass-panel 消费点（通知中心卡片）：S1 删 blur 后仍不透明可读
    await page.locator('.notify-wrap button').first().click()
    const nc = page.locator('[data-testid="notif-center"]')
    await expect(nc).toBeVisible({ timeout: 5000 })
    expect((await computed(page, '.nc-card.glass-panel')).backdropFilter).toBe('none')
    expect(alphaOf((await nc.evaluate(el => getComputedStyle(el).backgroundColor))) ?? 0).toBe(1)
    await page.keyboard.press('Escape')

    // 锁屏默认保留 blur（防窥不降级）：开锁 → reload → 断言 → 关锁复原
    await setLockEnabled(page, true)
    try {
      await page.reload()
      const overlay = page.locator(LOCK_OVERLAY)
      await expect(overlay).toBeVisible({ timeout: 15000 })
      expect((await computed(page, LOCK_OVERLAY)).backdropFilter).toContain('blur(20px)')
      // overlay 底色保持六主题 0.85 半透明（默认档不动）
      expect(alphaOf((await computed(page, LOCK_OVERLAY)).backgroundColor)).toBeCloseTo(0.85, 2)

      // 解锁后再关锁，避免锁定态泄入后续用例
      await unlockIfNeeded(page)
      await setLockEnabled(page, false)
    } finally {
      // 断言中途失败也尽力复原（unlockIfNeeded 已容忍未锁定态）
      await unlockIfNeeded(page).catch(() => {})
      await setLockEnabled(page, false).catch(() => {})
    }
  })
})

test.describe('低特效档（S2，?__lowfx=1 冷启动）', () => {
  test('根属性首帧生效、六处收口面 none、装饰动画停而 spinner 仍转、scroll auto、刷新保持', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/?__lowfx=1`)

    // 首帧即落位（early-init 在 mount 前读 query 并落盘）
    await expect(page.locator('html')).toHaveAttribute('data-low-fx', '1')
    expect((await computed(page, '.logo-animated .logo-orbit-outer')).animationName).toBe('none')
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe('auto')

    await enterProject(page)

    // ① 全 NModal 遮罩：去模糊 + 半透明加深到 0.8（下层动画不可见）
    await openAppearancePane(page)
    const mask = await computed(page, '.n-modal-mask')
    expect(mask.backdropFilter).toBe('none')
    expect(alphaOf(mask.backgroundColor)).toBeCloseTo(0.8, 2)
    // 设置行联动：query 已把档位落盘，行内选中「减弱」
    await expect(page.locator('[data-testid="settings-low-fx"] .n-radio-button--checked')).toContainText('减弱')
    await page.keyboard.press('Escape')
    await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })

    // ② 命令面板遮罩：去模糊 + 不透明画布底（alpha=1.0）
    await page.keyboard.press('Control+k')
    const palette = page.locator('.palette-mask')
    await expect(palette).toBeVisible({ timeout: 10000 })
    expect((await computed(page, '.palette-mask')).backdropFilter).toBe('none')
    expect(alphaOf((await computed(page, '.palette-mask')).backgroundColor)).toBe(1)
    await page.keyboard.press('Escape')
    await expect(palette).toBeHidden({ timeout: 5000 })

    // ③ 项目搜索遮罩（.ps-mask）：同口径
    await page.keyboard.press('Control+Shift+f')
    const psMask = page.locator('.ps-mask')
    await expect(psMask).toBeVisible({ timeout: 10000 })
    expect((await computed(page, '.ps-mask')).backdropFilter).toBe('none')
    expect(alphaOf((await computed(page, '.ps-mask')).backgroundColor)).toBe(1)
    await page.keyboard.press('Escape')
    await expect(psMask).toBeHidden({ timeout: 5000 })

    // ④ 全局 .glass-panel 兜底 + 通知中心卡片（非 NModal，单独一道）
    await page.locator('.notify-wrap button').first().click()
    const nc = page.locator('[data-testid="notif-center"]')
    await expect(nc).toBeVisible({ timeout: 5000 })
    expect((await computed(page, '.nc-card.glass-panel')).backdropFilter).toBe('none')
    await page.keyboard.press('Escape')
    await expect(nc).toBeHidden({ timeout: 5000 })

    // ⑤ 骨架屏/更新进度/异常分诊条：装饰动画收口规则在包内（attn-bar 无法低成本挂载，见文件头边界）
    expect(await hasLowFxRule(page, ['html[data-low-fx', '.skeleton'], 'animation-name', 'none')).toBe(true)
    expect(await hasLowFxRule(page, ['.upd-bar--indeterminate .upd-fill'], 'animation-name', 'none')).toBe(true)
    expect(await hasLowFxRule(page, ['html[data-low-fx', '.attn-bar'], 'backdrop-filter', 'none')).toBe(true)
    // 真实骨架元素：停流动但静态块保留（合成一份 .skeleton 探针读真实级联）
    const skeletonAnim = await page.evaluate(() => {
      const el = document.createElement('div')
      el.className = 'skeleton'
      document.body.appendChild(el)
      const name = getComputedStyle(el).animationName
      el.remove()
      return name
    })
    expect(skeletonAnim).toBe('none')

    // ⑥ 反向断言：功能性 spinner 未被冻死（.spinning 是 App.vue 全局类，探针即真实级联）
    const spinnerAnim = await page.evaluate(() => {
      const el = document.createElement('span')
      el.className = 'spinning'
      document.body.appendChild(el)
      const name = getComputedStyle(el).animationName
      el.remove()
      return name
    })
    expect(spinnerAnim).toBe('app-boot-spin')

    // ⑦ 刷新后偏好保持（存储轨；根属性在首帧重放）
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-low-fx', '1')
    await expect(page.locator('.ide-root').first()).toBeVisible({ timeout: 15000 }).catch(() => {})
  })

  test('设置·外观行切换直存直生效：减弱 → 根属性在，切回标准 → 根属性摘除', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    await enterProject(page)
    await openAppearancePane(page)

    const group = page.locator('[data-testid="settings-low-fx"]')
    await group.locator('.n-radio-button').filter({ hasText: '减弱' }).click()
    await expect(page.locator('html')).toHaveAttribute('data-low-fx', '1')
    expect(await page.evaluate(() => localStorage.getItem('sc.appearance.lowFx'))).toContain('true')

    await group.locator('.n-radio-button').filter({ hasText: '标准' }).click()
    await expect(page.locator('html')).not.toHaveAttribute('data-low-fx', '1')
    expect(await page.evaluate(() => localStorage.getItem('sc.appearance.lowFx'))).toContain('false')

    // 关闭弹窗恢复默认档观感（S1 面：遮罩无模糊）
    await page.keyboard.press('Escape')
    await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })
  })

  test('锁屏低特效档：去模糊且 overlay alpha=1.0 实底（防窥不降级）', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/?__lowfx=1`)
    await enterProject(page)
    await setLockEnabled(page, true)
    try {
      await page.reload()
      const overlay = page.locator(LOCK_OVERLAY)
      await expect(overlay).toBeVisible({ timeout: 15000 })
      const lock = await computed(page, LOCK_OVERLAY)
      expect(lock.backdropFilter).toBe('none')
      expect(alphaOf(lock.backgroundColor)).toBe(1)
      await unlockIfNeeded(page)
      await setLockEnabled(page, false)
    } finally {
      await unlockIfNeeded(page).catch(() => {})
      await setLockEnabled(page, false).catch(() => {})
    }
  })
})
