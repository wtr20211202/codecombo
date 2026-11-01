import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 多实例会话总览 E2E：
 *   1. 命令面板打开总览 → 本机块渲染 + 会话行出现
 *   2. 关键字过滤：命中保留 / 无匹配隐藏
 *   3. 「查看输出」只读查看器打开（本机会话，零副作用）
 *
 * 环境说明：远程块（wsl-server 等）依赖外部实例可达，断言全部落在本机块，
 * 远程块仅做存在性观察不做内容断言。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const TERM_NAME = 'e2e-iso-check'

let unlockToken = ''
let createdTerminalId = ''
let createdTerminalName = ''
let projectId = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await unlockRes.json()) as { token?: string }).token || ''

  // 终端会话挂在项目下：取 simple-coding 项目 id
  const plist = await (await api('GET', '/api/projects')).json()
  const proj = (plist?.data || []).find((p: { name: string }) => p.name === 'simple-coding')
  expect(proj, 'simple-coding 项目应存在').toBeTruthy()
  projectId = proj.id

  const created = await (await api('POST', '/api/terminals', { projectId, rows: 24, cols: 80 })).json()
  createdTerminalId = created?.data?.id || ''
  expect(createdTerminalId).toBeTruthy()
  // 经 API 重命名为唯一名：列表混有远端真实终端（Terminal 1 是
  // Terminal 11/15/18 的子串），唯一名让行定位无歧义
  await api('PUT', `/api/terminals/${createdTerminalId}/rename`, { name: TERM_NAME })
  createdTerminalName = TERM_NAME
})

test.afterAll(async () => {
  if (createdTerminalId) await api('DELETE', `/api/terminals/${createdTerminalId}`)
})

/** 命令面板打开总览 */
async function openOverview(page: import('@playwright/test').Page) {
  await page.keyboard.press('Control+Shift+p')
  await page.locator('.palette input, [class*="palette"] input').first().waitFor({ state: 'visible', timeout: 5000 })
  // 「会话总览」而非「总览」：实例族总览（P-20261003-56）入列后单词「总览」
  // 模糊分不再唯一命中多实例会话总览
  await page.keyboard.type('会话总览')
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  const modal = page.locator('.n-modal').filter({ hasText: '多实例会话总览' }).first()
  await expect(modal).toBeVisible({ timeout: 8000 })
  return modal
}

test('总览打开：标题 + 本机块 + 会话行渲染', async ({ page }) => {
  await page.goto(BASE + '/project')
  await page.waitForTimeout(1200)
  await page.keyboard.press('Control+Shift+p')
  await page.waitForTimeout(600)
  const modal = await openOverview(page)

  await expect(modal).toContainText('本机', { timeout: 8000 })
  // 本机块有会话行（beforeAll 建的那条，按名称匹配）
  const row = modal.locator('.iso-row').filter({ hasText: TERM_NAME }).first()
  await expect(row).toBeVisible({ timeout: 8000 })
})

test('关键字过滤：命中保留、无匹配隐藏', async ({ page }) => {
  await page.goto(BASE + '/project')
  await page.waitForTimeout(1200)
  const modal = await openOverview(page)

  const filter = modal.locator('input').first()
  await filter.fill(TERM_NAME)
  await page.waitForTimeout(600)
  await expect(modal.locator('.iso-row').filter({ hasText: TERM_NAME }).first()).toBeVisible()

  await filter.fill('不可能存在的会话名-xyz')
  await page.waitForTimeout(600)
  await expect(modal.locator('.iso-row')).toHaveCount(0)
})

test('查看输出：只读查看器打开且渲染内容', async ({ page }) => {
  await page.goto(BASE + '/project')
  await page.waitForTimeout(1200)
  const modal = await openOverview(page)

  const row = modal.locator('.iso-row').filter({ hasText: TERM_NAME }).first()
  await expect(row).toBeVisible({ timeout: 8000 })
  const viewBtn = row.locator('button').first()
  await viewBtn.click()
  // 输出查看器为独立弹层：出现 pre 渲染区
  const pre = page.locator('.n-modal pre, pre').first()
  await expect(pre).toBeVisible({ timeout: 8000 })
})

test('重命名：行内编辑生效', async ({ page }) => {
  await page.goto(BASE + '/project')
  await page.waitForTimeout(1200)
  const modal = await openOverview(page)

  const row = modal.locator('.iso-row').filter({ hasText: TERM_NAME }).first()
  await expect(row).toBeVisible({ timeout: 8000 })
  // 重命名按钮 = 行内第 3 个（查看输出/去操作之后）
  await row.locator('button[title="重命名"]').click()
  // 注意：row 定位器按名字过滤——进入行内编辑态后名字被输入框替换，
  // row 定位器失配，故输入框必须挂 modal 作用域
  const input = modal.locator('.iso-row input').first()
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('e2e-iso-renamed')
  await input.press('Enter')
  await page.waitForTimeout(800)
  await expect(modal.locator('.iso-row').filter({ hasText: 'e2e-iso-renamed' }).first()).toBeVisible()
})

test('结束会话：两击确认后行消失', async ({ page }) => {
  await page.goto(BASE + '/project')
  await page.waitForTimeout(1200)
  const modal = await openOverview(page)

  const row = modal.locator('.iso-row').filter({ hasText: 'e2e-iso-renamed' }).first()
  await expect(row).toBeVisible({ timeout: 8000 })
  // 两击确认：第一击进入确认态（title 变「再点一次确认结束」），第二击执行
  const endBtn = row.locator('button[title="结束会话"]')
  await endBtn.click()
  await page.waitForTimeout(300)
  const confirmBtn = row.locator('button[title="再点一次确认结束"]')
  await expect(confirmBtn).toBeVisible()
  await confirmBtn.click()
  await page.waitForTimeout(1200)
  await expect(modal.locator('.iso-row').filter({ hasText: 'e2e-iso-renamed' })).toHaveCount(0)
})


test('实例下拉菜单直达总览（免命令面板）', async ({ page }) => {
  // 实例当前为解锁态（与其他用例一致），直达项目页
  await page.goto(BASE + '/project')
  await page.waitForTimeout(1200)

  // 点活动栏顶部实例徽标 → 下拉 → 「多实例会话总览」行
  await page.locator('.rail-instance').first().click()
  const row = page.locator('.action-row').filter({ hasText: '多实例会话总览' })
  await expect(row).toBeVisible({ timeout: 3000 })
  await row.click()

  const modal = page.locator('.n-modal').filter({ hasText: '多实例会话总览' }).first()
  await expect(modal).toBeVisible({ timeout: 5000 })
})
