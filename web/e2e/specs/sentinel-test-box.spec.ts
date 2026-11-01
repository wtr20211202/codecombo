import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, waitForAppReady, unlockIfNeeded, projectCardByName } from '../../tests/helpers'

/**
 * 哨兵规则试跑测试框（P-20261004-20 本地档 + P-20261004-107 服务端档）E2E：
 * 设置 → 输出哨兵 → 新建/编辑弹窗「测试」折叠区——贴样例输出双档试命中：
 *   1. 折叠区默认收起，点开展开；样例 3 行命中 2 行 → 计数「命中 2 行 / 共 3 行」
 *      + 恰 2 行带 hit 高亮；模式改为不命中 → 计数切「未命中任何行」
 *   2. RE2→JS 桥：(?i) 前缀模式可试跑（占位符示例同款惯用形）；RE2 专属语法
 *      （命名捕获组）→ 「无法本地试跑」提示且不给误导性 0 命中计数
 *   3. 服务端真跑（精确档）：RE2 专属语法本地档降级提示后，服务端档返回正确
 *      命中 + 命中行摘录；模式变更结果失效（陈旧命中不留存），改不命中模式再跑
 *      → 服务端语义未命中；全程本地逐行档照常（双档并存零回归）
 * 纯前端行为 + 无副作用端点：全程不点保存，服务端零落库，无需清理
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

/** 打开设置·输出哨兵的新建规则弹窗并展开测试折叠区（弹窗 NModal teleport 到 body——页面级定位） */
async function openTestBox(page: Page) {
  await fixedLocale(page)
  await page.goto(`${BASE}/`)
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible()
  await modal.locator('.nav-item').filter({ hasText: '输出哨兵' }).click()
  const manager = modal.locator('[data-testid="sentinel-manager"]')
  await expect(manager).toBeVisible()
  await manager.locator('[data-testid="sentinel-add"]').click()
  // NInput 的 testid 落在包裹层，取内嵌 textarea
  await page.locator('[data-testid="sentinel-form-pattern"] textarea').fill('OOMKilled|out of memory')
  const toggle = page.locator('[data-testid="sentinel-test-toggle"]')
  await expect(page.locator('[data-testid="sentinel-test-sample"]')).toHaveCount(0) // 默认收起
  await toggle.click()
  const sample = page.locator('[data-testid="sentinel-test-sample"] textarea')
  await expect(sample).toBeVisible()
  return sample
}

test('贴样例逐行试命中：命中行高亮 + 计数，模式改动即时切换', async ({ page }) => {
  const sample = await openTestBox(page)

  // 3 行样例，2 行命中（OOMKilled 行 + out of memory 行）
  await sample.fill('service started normally\npanic: container OOMKilled after 3 retries\nlast resort: out of memory killer invoked')
  await expect(page.locator('[data-testid="sentinel-test-count"]')).toContainText('命中 2 行')
  await expect(page.locator('[data-testid="sentinel-test-count"]')).toContainText('共 3 行')
  await expect(page.locator('[data-testid="sentinel-test-line"]')).toHaveCount(3)
  await expect(page.locator('[data-testid="sentinel-test-line"].hit')).toHaveCount(2)

  // 模式改为不命中任何行：计数切「未命中」且高亮清零（反馈即时，无保存按钮）
  await page.locator('[data-testid="sentinel-form-pattern"] textarea').fill('DeadLockGoneNoSuchToken')
  await expect(page.locator('[data-testid="sentinel-test-count"]')).toContainText('未命中任何行')
  await expect(page.locator('[data-testid="sentinel-test-line"].hit')).toHaveCount(0)

  // 再点折叠：结果区整体收起
  await page.locator('[data-testid="sentinel-test-toggle"]').click()
  await expect(page.locator('[data-testid="sentinel-test-sample"]')).toHaveCount(0)
})

test('RE2→JS 桥：(?i) 前缀可试跑；RE2 专属语法如实提示不可本地试跑', async ({ page }) => {
  const sample = await openTestBox(page)

  // (?i) 惯用形（模式占位符示例同款）：剥离映射 JS i 旗标，小写样例命中
  await page.locator('[data-testid="sentinel-form-pattern"] textarea').fill('(?i)oomkilled')
  await sample.fill('service started normally\ngraceful oomkilled shutdown at boot\nall healthy')
  await expect(page.locator('[data-testid="sentinel-test-count"]')).toContainText('命中 1 行')

  // RE2 专属语法（命名捕获组）JS 编译失败：显式提示不可试跑，不出 0 命中计数
  await page.locator('[data-testid="sentinel-form-pattern"] textarea').fill('(?P<word>oom)')
  await expect(page.locator('[data-testid="sentinel-test-unsupported"]')).toBeVisible()
  await expect(page.locator('[data-testid="sentinel-test-count"]')).toHaveCount(0)
})

test('服务端真跑（精确档）：RE2 专属语法本地降级 → 服务端档正确命中；模式变更结果失效', async ({ page }) => {
  const sample = await openTestBox(page)

  // RE2 专属语法：本地档降级提示在先（本地试跑不可用）
  await page.locator('[data-testid="sentinel-form-pattern"] textarea').fill('(?P<word>oom)')
  await sample.fill('service started normally\ngraceful oomkilled shutdown at boot\nall healthy')
  await expect(page.locator('[data-testid="sentinel-test-unsupported"]')).toBeVisible()

  // 服务端真跑：生产同路径 RE2 引擎给出权威结果——命中 + 命中行摘录
  await page.locator('[data-testid="sentinel-test-server-run"]').click()
  const serverResult = page.locator('[data-testid="sentinel-test-server-result"]')
  await expect(serverResult).toContainText('服务端语义：命中')
  await expect(page.locator('[data-testid="sentinel-test-server-matched"]')).toContainText('oomkilled')

  // 模式变更 → 上次真跑结果即时失效（陈旧命中比没有结果更误导），不出误导计数
  await page.locator('[data-testid="sentinel-form-pattern"] textarea').fill('DeadLockGoneNoSuchToken')
  await expect(serverResult).toHaveCount(0)

  // 改不命中模式再真跑：服务端语义未命中；本地逐行档照常（双档并存零回归）
  await page.locator('[data-testid="sentinel-test-server-run"]').click()
  await expect(serverResult).toContainText('服务端语义：未命中')
  await expect(page.locator('[data-testid="sentinel-test-count"]')).toContainText('未命中任何行')
})
