import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 分享入口补齐 E2E（P-20261020-8）：
 *   ① 命令面板「分享当前文件」→ 创建弹层（目标 = 当前 tab 文件名）
 *   ② 编辑器 tab 右键「分享」→ 同一创建弹层
 *   ③ 分享管理器工具条/空态「新建分享」CTA → 打开文件树回项目根并聚焦
 * 多选「分享选中」不在本件（待 P-20261008-1 落地接入）。
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'
const SHARE_FILE = 'polish-rounds.md'
const SHARE_PATH = 'docs/design/polish-rounds.md'

/** 清空全部分享，保证管理器空态 CTA 可见（服务端全局状态，用例确定性） */
async function cleanupShares(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  const listRes = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await listRes.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  }
}

/** 进项目并经 Quick Open 打开目标文件（避免逐层展开 docs/design 的长链路） */
async function openProjectWithFile(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')

  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(SHARE_FILE)
  const item = page.locator('.palette-item').filter({ hasText: SHARE_FILE }).first()
  await expect(item).toBeVisible({ timeout: 10_000 })
  await item.click()

  await expect(page.locator('.editor-tab', { hasText: SHARE_FILE })).toBeVisible({ timeout: 10_000 })
  // 等 Monaco 内容就绪：loading 期间 OpenFile 不算「已保存」，分享入口按设计不注册
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 20_000 })
}

test('命令面板「分享当前文件」打开创建弹层', async ({ page }) => {
  await openProjectWithFile(page)

  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>分享当前文件')
  const item = page.locator('.palette-item').filter({ hasText: '分享当前文件' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  const modal = page.locator('.share-create-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })
  await expect(modal.locator('.target-name')).toHaveText(SHARE_FILE)
  await expect(modal.locator('.target-path')).toHaveText(SHARE_PATH)
  await modal.locator('[data-testid="share-create-cancel"]').click()
  await expect(modal).toBeHidden()
})

test('编辑器 tab 右键「分享」打开创建弹层', async ({ page }) => {
  await openProjectWithFile(page)

  await page.locator('.editor-tab', { hasText: SHARE_FILE }).click({ button: 'right' })
  const shareItem = page.locator('[data-testid="tab-share"]')
  await expect(shareItem).toBeVisible({ timeout: 5000 })
  await shareItem.click()

  const modal = page.locator('.share-create-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })
  await expect(modal.locator('.target-name')).toHaveText(SHARE_FILE)
  await modal.locator('[data-testid="share-create-cancel"]').click()
  await expect(modal).toBeHidden()
})

test('管理器工具条与空态「新建分享」CTA 打开文件树并聚焦', async ({ page, request }) => {
  await cleanupShares(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')

  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.share-manager')).toBeVisible({ timeout: 10_000 })

  // 空态 CTA：无分享时也给出可行动的下一步
  const emptyCta = page.locator('[data-testid="sm-new-share-empty"]')
  await expect(emptyCta).toBeVisible({ timeout: 10_000 })
  await emptyCta.click()
  await expect(page.locator('.tree-list')).toBeVisible()
  await expect(page.locator('.tree-list')).toBeFocused()

  // 工具条 CTA 同链可达（列表非空时也有入口）
  const toolbarCta = page.locator('[data-testid="sm-new-share"]')
  await expect(toolbarCta).toBeVisible()
  await toolbarCta.click()
  await expect(page.locator('.tree-list')).toBeFocused()
})
