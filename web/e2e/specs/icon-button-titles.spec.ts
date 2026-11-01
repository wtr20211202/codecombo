import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * icon-only 按钮微提示抽样 E2E（P-20261005-213）：全仓 icon-only 按钮的
 * title/aria-label 覆盖由静态门禁 scripts/check-icon-button-titles.mjs 把守
 * （npm run check:icon-titles，已接入 check/check:fast），本 spec 只在真实
 * DOM 抽样数例，守「静态识别面漏网 / 运行期属性没落 DOM」两面：
 *   ①首页项目卡「移除」icon 按钮（n-button title/aria-label 透传 DOM）；
 *   ②设置 → 安全 → 替换历史 的刷新 icon 按钮（common.refresh 文案落 title）。
 * 自备注册项目（无 git 依赖，仅路径存在即可出卡），beforeEach 防残留重名、afterEach 清理。
 */

const PROJ_DIR = path.join(os.tmpdir(), 'sc-e2e-icon-titles')
const PROJ = 'e2e-icon-titles'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function cleanupProject(request: import('@playwright/test').APIRequestContext) {
  const headers = await unlockHeaders()
  const list = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
    }
  }
  try { fs.rmSync(PROJ_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
}

test.beforeEach(async ({ request }) => {
  // 上次运行残留的项目/目录先清掉，防重名注册失败
  await cleanupProject(request)
})

test.afterEach(async ({ request }) => {
  await cleanupProject(request)
})

test('首页项目卡移除按钮：title 与 aria-label 均落 DOM', async ({ page, request }) => {
  // 注册一个项目（路径存在即可出卡，无 git 语义依赖）
  const headers = await unlockHeaders()
  fs.mkdirSync(PROJ_DIR, { recursive: true })
  fs.writeFileSync(path.join(PROJ_DIR, 'readme.md'), 'icon titles e2e\n')
  const create = await request.post(`${API_BASE}/api/projects`, {
    headers, data: { name: PROJ, path: serverPath(PROJ_DIR).replace(/\\/g, '/') },
  })
  expect(create.ok()).toBeTruthy()

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 项目卡按名整词定位（tests/helpers 纪律：禁止整卡 hasText 子串匹配）
  const card = projectCardByName(page, PROJ)
  await expect(card).toBeVisible({ timeout: 5000 })

  // 移除入口是 hover 才显示的纯图标按钮——CSS 显隐不影响属性断言，直接读 DOM
  const removeBtn = card.locator('.project-remove-btn')
  await expect(removeBtn).toHaveAttribute('title', '移除项目')
  await expect(removeBtn).toHaveAttribute('aria-label', '移除项目')
})

test('设置安全替换历史刷新按钮：title 与 aria-label 均落 DOM', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '替换历史' }).click()

  const refresh = page.getByTestId('replace-history-refresh')
  await expect(refresh).toBeVisible({ timeout: 3000 })
  await expect(refresh).toHaveAttribute('title', '刷新')
  await expect(refresh).toHaveAttribute('aria-label', '刷新')
})
