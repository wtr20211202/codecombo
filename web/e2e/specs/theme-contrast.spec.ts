import { expect, test, type Page } from '@playwright/test'
import { API_BASE } from '../../tests/api-base'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 辅助文字对比度 E2E（P-20261019-4）：
 * 校验器把门槛按实际字号绑定（常规文本 4.5、大字号/图形 3）后，运行时面必须
 * 同口径达标——单测守令牌表与阈值函数，本 spec 守「浏览器里真的算出来的色」：
 *   ① 六主题 --text-secondary/muted/dim/label 在 bg-primary/bg-panel 双底
 *      实测 ≥4.5，且 muted 恒弱于 secondary（提亮后层级差仍在）；
 *   ② 设置弹窗导航（secondary）与搜索占位符（Naive placeholderColor =
 *      text-muted）计算色达标；占位符色与 --text-muted 完全一致（防回退默认
 *      低对比档）；
 *   ③ 提交面板/ Git 面板的占位符与 .section-count/.sidebar-header 实际计算
 *      色对达标（key 面覆盖，不只信令牌表）。
 * 主题切换走 storage 事件（与 settings-sync 同链路），不刷新页面。
 */

const THEMES = [
  { key: 'dark', panel: '#161b22' },
  { key: 'light', panel: '#f6f8fa' },
  { key: 'one-dark', panel: '#2c313a' },
  { key: 'dracula', panel: '#44475a' },
  { key: 'dsh-light', panel: '#f5f6f7' },
  { key: 'dsh-dark', panel: '#1b1b1c' },
] as const

type Rgba = { r: number; g: number; b: number; a: number }

/** 浏览器计算色（rgb/rgba/color(srgb …)）→ 归一化通道；无法解析返回 null */
function parseCssColor(value: string): Rgba | null {
  const v = value.trim()
  let m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (m) {
    return {
      r: Number(m[1]), g: Number(m[2]), b: Number(m[3]),
      a: m[4] === undefined ? 1 : Number(m[4]),
    }
  }
  m = v.match(/^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/)
  if (m) {
    return {
      r: Number(m[1]) * 255, g: Number(m[2]) * 255, b: Number(m[3]) * 255,
      a: m[4] === undefined ? 1 : Number(m[4]),
    }
  }
  m = v.match(/^#([0-9a-f]{6})$/i)
  if (m) {
    const n = (i: number) => parseInt(m![1].slice(i, i + 2), 16)
    return { r: n(0), g: n(2), b: n(4), a: 1 }
  }
  m = v.match(/^#([0-9a-f]{3})$/i)
  if (m) {
    const n = (i: number) => parseInt(m![1][i] + m![1][i], 16)
    return { r: n(0), g: n(1), b: n(2), a: 1 }
  }
  return null
}

function luminance({ r, g, b }: Rgba): number {
  const lin = (c: number) => {
    const x = c / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(fgRaw: string, bgRaw: string): number {
  const fg = parseCssColor(fgRaw)
  const bg = parseCssColor(bgRaw)
  expect(fg, `前景色不可解析：${fgRaw}`).not.toBeNull()
  expect(bg, `背景色不可解析：${bgRaw}`).not.toBeNull()
  const blend = (c: Rgba): Rgba => ({
    r: c.a * c.r + (1 - c.a) * bg!.r,
    g: c.a * c.g + (1 - c.a) * bg!.g,
    b: c.a * c.b + (1 - c.a) * bg!.b,
    a: 1,
  })
  const [l1, l2] = [luminance(blend(fg!)), luminance(bg!)].sort((a, b) => b - a)
  return (l1 + 0.05) / (l2 + 0.05)
}

async function setTheme(page: Page, key: string, expectedPanel: string): Promise<void> {
  await page.evaluate((k) => {
    localStorage.setItem('theme-settings', k)
    // 同页写入不派发 storage 事件；按他页写入的真实事件形状手动派发，
    // 走 settingsSync → themeStore.syncFromStorage 的正式链路
    window.dispatchEvent(new StorageEvent('storage', { key: 'theme-settings', newValue: k }))
  }, key)
  await expect.poll(
    () => page.evaluate(() => document.documentElement.style.getPropertyValue('--bg-panel').trim()),
    { message: `主题 ${key} 未应用` },
  ).toBe(expectedPanel)
  // 设置面 .nav-item 等带 `transition: all var(--motion-base)`，颜色过渡中读到的是
  // 旧主题值（前景已切换、背景未变会造成假红）——等最长动效档落定再断言
  await page.waitForTimeout(300)
}

async function tokenPair(page: Page, fgToken: string, bgToken: string): Promise<{ fg: string; bg: string }> {
  return page.evaluate(({ f, b }) => {
    const root = getComputedStyle(document.documentElement)
    return { fg: root.getPropertyValue(f).trim(), bg: root.getPropertyValue(b).trim() }
  }, { f: `--${fgToken}`, b: `--${bgToken}` })
}

/**
 * 读取元素计算色，并把祖先背景链按 alpha 自下而上叠成实际底色。
 * 例：设置搜索框聚焦时 .n-input 是 rgba(88,166,255,0.1) 焦点层，下面才是
 * input 底色——只看首个非透明层会把「半透明蓝」当成不透明底算假红。
 * 占位符→.n-input 焦点层，导航项→.settings-nav，均为真实渲染面。
 */
async function readPair(page: Page, selector: string): Promise<{ fg: string; bg: string }> {
  const pair = await page.evaluate((sel) => {
    type Rgba = { r: number; g: number; b: number; a: number }
    const parse = (value: string): Rgba | null => {
      const v = value.trim()
      let m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
      if (m) {
        return {
          r: Number(m[1]), g: Number(m[2]), b: Number(m[3]),
          a: m[4] === undefined ? 1 : Number(m[4]),
        }
      }
      m = v.match(/^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/)
      if (m) {
        return {
          r: Number(m[1]) * 255, g: Number(m[2]) * 255, b: Number(m[3]) * 255,
          a: m[4] === undefined ? 1 : Number(m[4]),
        }
      }
      return null
    }
    const el = document.querySelector(sel)
    if (!el) return null
    const fg = getComputedStyle(el).color
    const layers: Rgba[] = []
    let base: Rgba | null = null
    for (let node: Element | null = el; node; node = node.parentElement) {
      const c = parse(getComputedStyle(node).backgroundColor)
      if (!c || c.a === 0) continue
      if (c.a >= 1) { base = c; break }
      layers.push(c) // 半透明层：自顶向下收集，合成时反序
    }
    if (!base) base = parse(getComputedStyle(document.body).backgroundColor)
    if (!base) return null
    let out = base
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i]!
      out = {
        r: l.a * l.r + (1 - l.a) * out.r,
        g: l.a * l.g + (1 - l.a) * out.g,
        b: l.a * l.b + (1 - l.a) * out.b,
        a: 1,
      }
    }
    return { fg, bg: `rgb(${out.r}, ${out.g}, ${out.b})` }
  }, selector)
  expect(pair, `找不到选择器：${selector}`).not.toBeNull()
  return pair!
}

/** 轮询到动效落定后断言对比度（主题切换含 color transition，直读会拿到过渡中间值） */
async function expectContrastAtLeast(page: Page, selector: string, min: number, label: string): Promise<void> {
  await expect.poll(async () => {
    const pair = await readPair(page, selector)
    return Number(contrast(pair.fg, pair.bg).toFixed(2))
  }, { message: label, timeout: 5000 }).toBeGreaterThanOrEqual(min)
}

async function enterProject(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
}

/** rail 面板是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见 */
async function ensurePanel(page: Page, railTestId: string, rootSelector: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (await page.locator(rootSelector).isVisible().catch(() => false)) return
    await page.locator(`[data-testid="${railTestId}"]`).click()
    await page.waitForTimeout(500)
  }
  await expect(page.locator(rootSelector)).toBeVisible()
}

test('六主题辅助文字令牌在双底 ≥4.5，且 muted 弱于 secondary（层级不塌）', async ({ page }) => {
  await enterProject(page)
  for (const theme of THEMES) {
    await setTheme(page, theme.key, theme.panel)
    for (const token of ['text-secondary', 'text-muted', 'text-dim', 'text-label'] as const) {
      for (const bgToken of ['bg-primary', 'bg-panel'] as const) {
        const pair = await tokenPair(page, token, bgToken)
        const ratio = contrast(pair.fg, pair.bg)
        expect(
          ratio,
          `${theme.key} --${token} / --${bgToken} = ${ratio.toFixed(2)}（原始 ${pair.fg} on ${pair.bg}）`,
        ).toBeGreaterThanOrEqual(4.5)
      }
    }
    // muted 提亮后仍低于 secondary（辅助信息主次分层）
    const muted = contrast((await tokenPair(page, 'text-muted', 'bg-panel')).fg, theme.panel)
    const secondary = contrast((await tokenPair(page, 'text-secondary', 'bg-panel')).fg, theme.panel)
    expect(muted, `${theme.key} muted 不应亮于 secondary`).toBeLessThan(secondary)
  }
})

test('设置占位符/导航与提交、Git 面板实际计算色对达标（占位符与 muted 同源）', async ({ page }) => {
  await enterProject(page)
  await page.locator('[data-testid="rail-settings"]').click()
  const settings = page.locator('.n-modal.settings-modal')
  await expect(settings).toBeVisible({ timeout: 3000 })

  // 设置面逐主题：导航项（secondary）与搜索占位符（Naive placeholderColor）
  for (const theme of THEMES) {
    await setTheme(page, theme.key, theme.panel)
    await expectContrastAtLeast(page, '.settings-nav .nav-item:not(.active)', 4.5, `${theme.key} 设置导航文字`)
    await expectContrastAtLeast(page, '.settings-nav .n-input__placeholder', 4.5, `${theme.key} 设置搜索占位符`)

    // 占位符必须就是 --text-muted（而不是 Naive 默认的 alpha 档）
    const muted = parseCssColor((await tokenPair(page, 'text-muted', 'bg-primary')).fg)!
    await expect.poll(async () => {
      const placeholder = await readPair(page, '.settings-nav .n-input__placeholder')
      const c = parseCssColor(placeholder.fg)
      return c ? `${c.r},${c.g},${c.b}` : 'unparsed'
    }, { message: `${theme.key} 占位符色未对齐 --text-muted`, timeout: 5000 })
      .toBe(`${muted.r},${muted.g},${muted.b}`)
  }

  await page.locator('.settings-close').click()
  // 直接改 theme-settings 会让外观分区的 pendingTheme 与 store 不一致（脏态护栏），
  // 关闭时确认丢弃即可；主题本身已生效，不做保存
  const discard = page.getByRole('button', { name: '丢弃并关闭' })
  if (await discard.isVisible({ timeout: 1000 }).catch(() => false)) await discard.click()
  await expect(settings).toBeHidden()

  // 提交面板：始终存在的提交信息 textarea 占位符；Git 面板：section-count（muted）
  // 与 sidebar-header（secondary）分别覆盖两档辅助文字
  for (const key of ['dark', 'light'] as const) {
    const theme = THEMES.find((t) => t.key === key)!
    await setTheme(page, theme.key, theme.panel)

    await ensurePanel(page, 'rail-changes', '.commit-panel')
    await expectContrastAtLeast(page, '.commit-panel .n-input__placeholder', 4.5, `${key} 提交占位符`)

    await ensurePanel(page, 'rail-git', '.git-panel')
    await expectContrastAtLeast(page, '.git-panel .section-count', 4.5, `${key} Git 分支计数`)
    await expectContrastAtLeast(page, '.git-panel .sidebar-header', 4.5, `${key} Git 侧栏标题`)
  }
})
