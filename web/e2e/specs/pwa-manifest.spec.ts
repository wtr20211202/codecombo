import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * PWA 可安装形态静态断言（P-20261004-134）：
 *   - /manifest.webmanifest 可达 + 核心字段（name/display/图标 192+512/主题色）
 *   - index.html 头部引用齐全（manifest link / theme-color / apple-touch-icon /
 *     apple-mobile-web-app-capable）
 *   - theme-color 随主题联动：无 theme-settings 存储时跟随 OS 深浅色（三段式
 *     初始主题的 OS 跟随路径），emulateMedia 翻转 → meta content 同步换色——
 *     安装态状态栏色随主题联动的运行期链路（early-init + store.apply 双接线）
 */

test('manifest 可达 + 核心字段 + 图标派生齐备 —', async ({ request }) => {
  const resp = await request.get(`${API_BASE}/manifest.webmanifest`)
  expect(resp.status()).toBe(200)
  expect(resp.headers()['content-type']).toContain('application/manifest+json')

  const manifest = (await resp.json()) as {
    name?: string
    short_name?: string
    start_url?: string
    display?: string
    theme_color?: string
    background_color?: string
    icons?: Array<{ src?: string; sizes?: string; type?: string }>
  }
  // 可安装性最小集：name + start_url + display + 图标（Chrome 安装判据）
  expect(manifest.name).toBe('Codecombo')
  expect(manifest.short_name).toBeTruthy()
  expect(manifest.start_url).toBe('/')
  expect(manifest.display).toBe('standalone')
  // 主题色：manifest 静态值仅作安装默认（运行期 meta 随主题动态），但须是合法 hex
  expect(manifest.theme_color).toMatch(/^#[0-9a-fA-F]{6}$/)
  expect(manifest.background_color).toMatch(/^#[0-9a-fA-F]{6}$/)

  // 图标：192/512 两档必在，src 与 sizes 对得上且文件真实可达
  const icons = manifest.icons ?? []
  expect(icons.map((i) => i.sizes)).toContain('192x192')
  expect(icons.map((i) => i.sizes)).toContain('512x512')
  for (const icon of icons) {
    expect(icon.type).toBe('image/png')
    const iconResp = await request.get(`${API_BASE}${icon.src}`)
    expect(iconResp.status()).toBe(200)
    expect(iconResp.headers()['content-type']).toContain('image/png')
  }
  // iOS 主屏图标（apple-touch-icon 不入 manifest icons，单独可达性）
  const appleIcon = await request.get(`${API_BASE}/icons/apple-touch-icon.png`)
  expect(appleIcon.status()).toBe(200)
})

test.use({ colorScheme: 'light' })

test('index.html 头部引用齐全 + theme-color 随主题联动 —', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  // 四处静态引用（index.html 为 vite 模板，构建后原样透传）
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest')
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png')
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes')

  // 浅色主题（无存储 → 跟随 OS light）→ 主形态 bg-primary #ffffff
  const themeColor = page.locator('meta[name="theme-color"]')
  await expect(themeColor).toHaveAttribute('content', '#ffffff')

  // OS 深浅翻转 → 三段式 OS 跟随链换主题 → theme-color 同步换深色主形态 #0d1117
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(themeColor).toHaveAttribute('content', '#0d1117')
})
