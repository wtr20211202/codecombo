import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知条目复制 E2E（P-20261003-188）：条目 hover 浮现「复制标题与内容」钮，
 * title+body 纯文本入剪贴板（走展示面渲染链 notifTitle/notifBody——所见即所
 * 复制）——错误类通知（部署失败摘要）转述给 agent/记录的顺手出口（errorLog
 * 有复制、通知此前没有）。
 *   ① title+body 条目：剪贴板 = 标题\n正文
 *   ② 仅标题条目（无 body）：剪贴板 = 标题（无尾随换行）
 *   ③ 聚合组行：全体成员 title+body 全同（groupKey 含两者），组行复制代表
 *      条目即组内容；展开组员逐条复制同源
 * 通知经 POST /api/notifications 播种（共享实例用例开头先清空、afterAll
 * 再清空，不残留测试数据）；打开项目页取 TopBar 铃铛入口。
 */

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function clearNotifications(): Promise<void> {
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers: await unlockHeaders() })
}

async function seed(headers: Record<string, string>, notes: Array<{ title: string; body?: string; type?: string; category?: string }>) {
  for (const n of notes) {
    const res = await fetch(`${API_BASE}/api/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: n.type ?? 'info', category: n.category ?? 'system', title: n.title, body: n.body ?? '' }),
    })
    expect(res.ok).toBeTruthy()
  }
}

async function openPanel(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 解锁后延迟出现的默认密码提醒先收起（遮罩会拦铃铛/卡片点击，notification-center 同款兜底）
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
}

/** 剪贴板回读换行归一：应用侧恒写 LF，Windows 的 Chromium 剪贴板 readText
 *  会把写入的 \n 规范化回 \r\n（OS 剪贴板层行为、应用侧不可控，search-copy-paths
 *  /session-copy-message 同款归一）——断言前剥 \r，与粘贴消费方语义一致 */
async function readClipboard(page: import('@playwright/test').Page): Promise<string> {
  return (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r/g, '')
}

/** hover 条目行浮现复制钮 → 点击 → 断言成功 toast 与剪贴板内容 */
async function copyRowAndRead(page: import('@playwright/test').Page, row: ReturnType<import('@playwright/test').Page['locator']>): Promise<string> {
  await row.hover()
  await row.locator('[data-testid^="notif-copy-"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '通知内容已复制' })).toBeVisible({ timeout: 5000 })
  return readClipboard(page)
}

test.describe('通知条目复制（P-20261003-188）', () => {
  test.beforeEach(async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  })

  test.afterAll(async () => {
    await clearNotifications()
  })

  test('title+body 条目：剪贴板 = 标题\\n正文（所见即所复制）', async ({ page }) => {
    const headers = await unlockHeaders()
    await clearNotifications()
    await seed(headers, [{
      title: 'e2e-复制-部署失败',
      body: '步骤 3/4: npm run build 退出码 1',
      type: 'error',
      category: 'error',
    }])

    await openPanel(page)
    const row = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-复制-部署失败' })
    await expect(row).toHaveCount(1, { timeout: 3000 })

    expect(await copyRowAndRead(page, row))
      .toBe('e2e-复制-部署失败\n步骤 3/4: npm run build 退出码 1')
    // 复制不出域副作用：条目保留、未读不变（复制是只读出口）
    await expect(row).toHaveCount(1)
  })

  test('仅标题条目：剪贴板 = 标题，无尾随换行', async ({ page }) => {
    const headers = await unlockHeaders()
    await clearNotifications()
    await seed(headers, [{ title: 'e2e-复制-仅标题' }])

    await openPanel(page)
    const row = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-复制-仅标题' })
    await expect(row).toHaveCount(1, { timeout: 3000 })

    expect(await copyRowAndRead(page, row)).toBe('e2e-复制-仅标题')
  })

  test('聚合组行复制：代表条目即组内容，展开组员同源', async ({ page }) => {
    const headers = await unlockHeaders()
    await clearNotifications()
    // 同 title+body 甲×2 → 折叠为一组（groupKey 含 title+body，全组同文）
    await seed(headers, [
      { title: 'e2e-复制-组甲', body: 'same-body' },
      { title: 'e2e-复制-组甲', body: 'same-body' },
    ])

    await openPanel(page)
    const group = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-复制-组甲' })
    await expect(group).toContainText('×2', { timeout: 3000 })

    // 组行复制：代表条目 title+body 即全组内容
    expect(await copyRowAndRead(page, group)).toBe('e2e-复制-组甲\nsame-body')

    // 展开后组员逐条复制同源
    await group.click()
    const members = page.locator('.nc-sub')
    await expect(members).toHaveCount(2)
    expect(await copyRowAndRead(page, members.first())).toBe('e2e-复制-组甲\nsame-body')
  })
})
