import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, waitForAppReady, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 语言包只载当前语言 E2E（P-20261001-18）：
 *   - 默认中文启动只下载 zh-CN 语言包 chunk，en-US 包不进主链（原先双包必全载）
 *   - 设置里切英文 → 英文文案生效（首次切换才补载 en 包）
 *   - 刷新后仍是英文，且不再下载 zh-CN 包（激活语言单包在载）
 * 自备临时目录注册项目（设置入口在项目页 Layout 内），用后经 API 清理注册。
 */

const PROJ_PREFIX = 'sc-locale-chunk-'
let projDir = ''

/** 跟踪语言包 chunk 的网络加载（文件名形如 zh-CN-<hash>.js / en-US-<hash>.js；
 *  monaco 的 nls.messages.zh-cn-*.js 前缀不同不会误中） */
function trackLocaleChunks(page: Page) {
  const hits = { zh: 0, en: 0 }
  page.on('response', (res) => {
    const name = res.url().split('/').pop() ?? ''
    if (/^zh-CN-[A-Za-z0-9_-]+\.js/.test(name)) hits.zh++
    if (/^en-US-[A-Za-z0-9_-]+\.js/.test(name)) hits.en++
  })
  return {
    get zh() { return hits.zh },
    get en() { return hits.en },
    reset() {
      hits.zh = 0
      hits.en = 0
    },
  }
}

/** 解锁遮罩（中英文文案均兼容：填密码回车提交，不依赖按钮文案） */
async function unlockIfLocked(page: Page) {
  const overlay = page.locator('.lock-overlay')
  // boot 竞态：遮罩可能略晚于 ready 出现，短轮询等待；未启用锁定则直接返回
  const deadline = Date.now() + 5000
  while ((await overlay.count()) === 0) {
    if (Date.now() > deadline) return
    await page.waitForTimeout(200)
  }
  const input = overlay.locator('.lock-form input').first()
  await input.fill(DEFAULT_PASSWORD)
  await input.press('Enter')
  await expect(overlay).toHaveCount(0, { timeout: 10000 })
  // 解锁后可能弹「建议修改默认密码」，点「稍后提醒 / Remind Later」关掉
  const laterBtn = page.getByRole('button', { name: /稍后提醒|Remind Later/ })
  if ((await laterBtn.count()) > 0) {
    await laterBtn.click()
    await expect(laterBtn).toHaveCount(0, { timeout: 3000 })
  }
}

/** 确保至少一个项目存在并进入项目页（设置弹窗入口在项目页 Layout 内） */
async function enterProject(page: Page) {
  if ((await page.locator('.project-card').count()) === 0) {
    await page.getByRole('button', { name: '添加项目' }).first().click()
    const modal = page.locator('.n-modal').filter({ hasText: '添加项目' })
    await expect(modal).toBeVisible({ timeout: 3000 })
    const pathInput = modal.locator('input').first()
    await pathInput.fill(serverPath(projDir))
    await pathInput.press('Enter')
    await expect(modal).toBeHidden({ timeout: 10000 })
  }
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
}

test.beforeAll(async () => {
  projDir = fs.mkdtempSync(path.join(os.tmpdir(), PROJ_PREFIX))
  fs.writeFileSync(path.join(projDir, 'README.md'), 'locale single load probe\n')
})

test.afterAll(async () => {
  // 清理本 spec 注册的项目（按目录名前缀匹配），失败不阻塞
  try {
    const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: DEFAULT_PASSWORD }),
    })
    const token = ((await unlockRes.json()) as { token?: string }).token || ''
    const headers = { 'X-Lock-Token': token }
    const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
    for (const p of ((list?.data || []) as { id: string; name: string }[])) {
      if (p.name.startsWith(PROJ_PREFIX)) {
        await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
      }
    }
  } catch { /* 清理失败不阻塞用例 */ }
  try { fs.rmSync(projDir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('默认中文启动只载 zh-CN 包，en-US 包不进主链', async ({ page }) => {
  await fixedLocale(page)
  const chunks = trackLocaleChunks(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await waitForAppReady(page)

  // 中文文案生效（首页「添加项目」按钮为 zh 包文案）
  await expect(page.getByRole('button', { name: '添加项目' }).first()).toBeVisible({ timeout: 5000 })
  expect(chunks.zh).toBeGreaterThan(0)
  expect(chunks.en).toBe(0)
})

test('切英文→文案生效→刷新仍是英文且不再载 zh 包', async ({ page }) => {
  // 不用 fixedLocale（其 init script 会在 reload 时把 locale 覆写回 zh-CN，
  // 破坏持久化断言）：全新 context 无存储默认即 zh-CN，等效
  const chunks = trackLocaleChunks(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await waitForAppReady(page)
  await enterProject(page)

  // 切换前 en 包不在载
  expect(chunks.en).toBe(0)

  // 打开设置 → 外观 → 语言选 English → 保存（外观属保存型页签，footer 有保存钮）
  await page.locator('[data-testid="rail-settings"]').click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  await expect(page.locator('.settings-modal .content-pane:visible .pane-title')).toHaveText('外观')

  const localeGroup = page.locator('.appearance-settings .form-group').filter({ hasText: '语言' })
  await localeGroup.locator('.n-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: 'English' }).click()
  await page.locator('.settings-footer').getByRole('button', { name: '保存' }).click()
  await expect(modal).toBeHidden({ timeout: 5000 })

  // 英文文案生效：rail 设置按钮的即时 title/aria-label 翻为英文（首次切换补载 en 包）
  await expect(page.locator('[data-testid="rail-settings"]')).toHaveAttribute('aria-label', 'Settings', { timeout: 10000 })
  expect(chunks.en).toBeGreaterThan(0)

  // 刷新：locale 持久化仍是英文，且 zh-CN 包不再被下载
  chunks.reset()
  await page.reload()
  await waitForAppReady(page)
  await unlockIfLocked(page)
  await expect(page.locator('[data-testid="rail-settings"]')).toHaveAttribute('aria-label', 'Settings', { timeout: 10000 })
  expect(chunks.zh).toBe(0)
})
