import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 审计表 sticky 表头（P-20261004-136）E2E：
 * 长审计（滚动加载多页）滚到深处后表头仍钉在滚动容器顶——「第几列是什么」
 * 不靠记忆（列义保持）。断言几何量而非快照：
 *   - 未滚动：表头与容器顶对齐（基线）；
 *   - 滚到底：表头 top 仍 ≈ 容器可视顶（未钉住时随内容滚出为负），且首行
 *     已滚入表头之下 + scrollTop > 0（排除「没滚所以没出」的假绿）。
 * 几何取数收口单次 evaluate（容器/表头同一瞬间的视口位）——容器在设置弹窗
 * 内容区（自身是 scrollport）内，跨时刻分别取值会被中途的祖先滚动/表体
 * 重渲染污染，sticky 明明生效却量出假偏差。
 * 种子 = 凭据保存事件（audit-cursor-scroll.spec 同款：一次 POST 一条审计、
 * host 唯一行文本唯一），45 条 ≥ 3 页保证容器溢出，afterAll 清理凭据。
 */

interface AuditCredBody { data?: { id: string; host: string }[] }

async function unlockToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  if (!res.ok()) throw new Error(`unlock failed: ${res.status()}`)
  return ((await res.json()) as { token: string }).token
}

async function seedAuditEvents(request: APIRequestContext, headers: object, n: number, prefix: string): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await request.post(`${API_BASE}/api/credentials`, {
      headers,
      data: { host: `${prefix}-${i}.example.com`, username: 'sticky-e2e', secret: 'irrelevant' },
    })
    expect(res.ok()).toBeTruthy()
  }
}

async function cleanupSeededCredentials(request: APIRequestContext, headers: object, prefix: string): Promise<void> {
  const list = await request.get(`${API_BASE}/api/credentials`, { headers })
  if (!list.ok()) return
  const creds = ((await list.json()) as AuditCredBody).data || []
  for (const c of creds) {
    if (c.host.startsWith(prefix)) {
      await request.delete(`${API_BASE}/api/credentials/${c.id}`, { headers })
    }
  }
}

test.describe('审计表 sticky 表头（P-20261004-136）', () => {
  const seedPrefix = 'sticky-header-seed'

  test.afterAll(async ({ request }) => {
    const token = await unlockToken(request)
    await cleanupSeededCredentials(request, { 'X-Lock-Token': token }, seedPrefix)
  })

  test('滚动加载到深处表头仍钉在滚动容器顶', async ({ page, request }) => {
    const token = await unlockToken(request)
    // 70 条 ≥ 4 页：即使金态实例审计存量很少（e2e-seed 基线事件 ≈ 十几条），
    // 也保证 ≥60 行（3 页）的滚动深度与实例年龄无关
    await seedAuditEvents(request, { 'X-Lock-Token': token }, 70, seedPrefix)

    await openAuditPane(page)

    const scrollBox = page.getByTestId('audit-scroll')
    await expect(page.locator('[data-testid="audit-pane"] .n-data-table-tr:has(td)').first()).toBeVisible({ timeout: 5000 })

    // 同一瞬间几何：容器顶 / 表头顶 / 首行顶 / 滚动位一次取回（跨时刻取值会被
    // 祖先滚动污染——sticky 断言必须在同一渲染帧内对位）
    const geo = () => scrollBox.evaluate((el) => {
      const th = el.querySelector('.n-data-table-thead .n-data-table-th')
      const firstRow = el.querySelector('.n-data-table-tr:has(td)')
      return {
        containerTop: el.getBoundingClientRect().top,
        thTop: th ? th.getBoundingClientRect().top : Number.NaN,
        firstRowTop: firstRow ? firstRow.getBoundingClientRect().top : Number.NaN,
        scrollTop: el.scrollTop,
      }
    })

    // 基线：未滚动时表头与容器顶对齐
    const base = await geo()
    expect(base.scrollTop).toBe(0)
    expect(Math.abs(base.thTop - base.containerTop)).toBeLessThanOrEqual(2)

    // 近底滚动续翻至 ≥60 行（3 页，滚动本身即 P-223 链的回归面）
    const rows = page.locator('[data-testid="audit-pane"] .n-data-table-tr:has(td)')
    await expect.poll(async () => {
      if (await rows.count() < 60) {
        await scrollBox.evaluate((el) => { el.scrollTop = el.scrollHeight })
      }
      return rows.count()
    }, { timeout: 20000, intervals: [400] }).toBeGreaterThanOrEqual(60)

    // 续翻静默（loadingMore NSpin 消退）后再取终态几何，防表体重渲染中途取样
    await expect(page.getByTestId('audit-more-loading')).toBeHidden({ timeout: 5000 })
    const deep = await geo()
    expect(deep.scrollTop).toBeGreaterThan(0)
    // 表头仍钉在容器可视顶（sticky 生效——未钉住时 thTop = 容器顶 - scrollTop，强负值）
    expect(Math.abs(deep.thTop - deep.containerTop)).toBeLessThanOrEqual(2)
    // 首行已滚入表头之下（排除「容器没滚」的假绿）
    expect(deep.firstRowTop).toBeLessThan(deep.thTop)
  })
})

// 设置 → 安全 → 审计日志 Tab（audit-cursor-scroll.spec 同款入口）
async function openAuditPane(page: Page): Promise<void> {
  await fixedLocale(page)
  await page.goto(`${API_BASE}/`)
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审计日志' }).click()
  await expect(page.getByTestId('audit-pane')).toBeVisible({ timeout: 5000 })
}
