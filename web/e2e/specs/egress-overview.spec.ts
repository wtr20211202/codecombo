import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 数据出域面总览 E2E（P-20261003-20）：设置·安全分区「数据出域面」卡——
 *   - 配 webhook + share → 总览卡两者可见，URL 脱敏展示（host+掩码路径），
 *     query 密钥与路径 key 原文零回显；审计计数随 share.create 入账增长
 *   - 每行直达管理入口：设置内分区/页签切换 + 分享管理主区视图（先收起弹层）
 * 前置：实例已 setup（e2e-seed）；seed 项目 simple-coding 指向仓库根（README.md 可分享）。
 * webhook 偏好为实例全局态：用例后恢复关闭空端点，避免污染 webhook-test 类用例。
 */

// seed 项目按名定位（e2e-seed.sh 播种的 simple-coding = 仓库根）
async function seedProjectId(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const proj = list.find(p => p.name === 'simple-coding')
  if (!proj) throw new Error('seed project simple-coding not found')
  return proj.id
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

// webhook 偏好种子/复原（P-20261002-31 偏好端点，整体覆盖语义）
async function setWebhook(request: APIRequestContext, url: string, enabled: boolean): Promise<void> {
  const headers = await unlockHeaders(request)
  await request.put(`${API_BASE}/api/notifications/prefs`, {
    headers,
    data: { webhook: { enabled, mode: 'post', url, scope: 'important' } },
  })
}

const SEED_URL = 'https://api.day.app/AbCdEf1234567890123456/?tokens=secretXYZ'

test.describe('数据出域面总览', () => {
  test.beforeAll(async ({ request }) => {
    // URL 同时埋两处密钥形状：query 密钥 + Bark 式路径 key（脱敏双路径）
    await setWebhook(request, SEED_URL, true)
  })

  test.afterAll(async ({ request }) => {
    await setWebhook(request, '', false)
    // 撤销用例分享（GET 列表含 token，按 seed 项目过滤后逐条撤销）
    const headers = await unlockHeaders(request)
    const pid = await seedProjectId(request)
    const res = await request.get(`${API_BASE}/api/share`, { headers })
    const list = ((await res.json()) as { data?: { token: string; projectId: string; path: string }[] }).data || []
    for (const s of list.filter(x => x.projectId === pid && x.path === 'README.md')) {
      await request.delete(`${API_BASE}/api/share/${s.token}`, { headers })
    }
  })

  test('配 webhook+share → 总览卡可见、URL 脱敏、审计计数入账', async ({ page, request }) => {
    // 播种分享：仓库根 README.md（非敏感名，扫描无警告直接落库）
    const headers = await unlockHeaders(request)
    const pid = await seedProjectId(request)
    const created = await request.post(`${API_BASE}/api/share`, {
      headers, data: { projectId: pid, path: 'README.md' },
    })
    expect(created.ok()).toBeTruthy()

    await fixedLocale(page)
    await page.goto(`${API_BASE}/`)
    await waitForAppReady(page)
    await unlockIfNeeded(page)

    // 设置 → 安全：总览卡常显于 Tabs 上方
    await page.getByRole('button', { name: '设置' }).click()
    await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
    await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
    const card = page.locator('[data-testid="egress-card"]')
    await expect(card).toBeVisible({ timeout: 5000 })

    // webhook 端点脱敏展示：路径 key 打码 + query 剥除占位；原文零回显
    const endpoint = page.locator('[data-testid="egress-webhook-endpoint"]')
    await expect(endpoint).toHaveText('https://api.day.app/***/?…', { timeout: 5000 })
    await expect(page.getByText('AbCdEf1234567890123456')).toHaveCount(0)
    await expect(page.getByText('secretXYZ')).toHaveCount(0)

    // 活跃分享：计数与目标可见（文件分享无过期时点）
    const sharesValue = page.locator('[data-testid="egress-shares-value"]')
    await expect(sharesValue).toContainText('1 条活跃链接', { timeout: 5000 })
    await expect(sharesValue).toContainText('README.md')

    // Agent Token 行：存在性口径渲染（seed 实例自动播种 → 签发于；前缀掩码形态）
    const tokenValue = page.locator('[data-testid="egress-agent-token-value"]')
    await expect(tokenValue).toContainText(/sca_\w{4}\*\*\*|未签发/)

    // 审计计数：share.create 已入账 → ≥1 条
    await expect(page.locator('[data-testid="egress-audit-value"]')).toContainText(/^[1-9]/, { timeout: 5000 })
  })

  test('每行直达管理入口：设置内切换 + 分享管理收起弹层进主区', async ({ page }) => {
    await fixedLocale(page)
    await page.goto(`${API_BASE}/`)
    await waitForAppReady(page)
    await unlockIfNeeded(page)

    // 从项目页打开设置（分享管理是 /project 主区视图，先落项目页）
    await page.locator('.project-card').first().click()
    await page.waitForURL('**/project')
    await page.locator('[data-testid="rail-settings"]').click()
    await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
    await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
    await expect(page.locator('[data-testid="egress-card"]')).toBeVisible({ timeout: 5000 })

    // webhook → 通知分区
    await page.locator('[data-testid="egress-manage-webhook"]').click()
    await expect(page.locator('[data-testid="settings-pane-notifications"]')).toBeVisible({ timeout: 3000 })

    // Agent Token → 安全分区内 Agent Token 页签
    await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
    await page.locator('[data-testid="egress-manage-agent-token"]').click()
    await expect(page.locator('[data-testid="agent-token-boundary"]')).toBeVisible({ timeout: 3000 })

    // 审计 → 安全分区内审计日志页签
    await page.locator('[data-testid="egress-manage-audit"]').click()
    await expect(page.getByTestId('audit-pane')).toBeVisible({ timeout: 3000 })

    // 远程主机 → 远程部署分区
    await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
    await page.locator('[data-testid="egress-manage-remote-hosts"]').click()
    await expect(page.locator('[data-testid="settings-pane-deploy"]')).toBeVisible({ timeout: 3000 })

    // 分享管理 → 弹层收起 + 主区分享管理视图打开（?view=shares 通道）
    await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
    await page.locator('[data-testid="egress-manage-shares"]').click()
    await expect(page.locator('.settings-modal')).toBeHidden({ timeout: 3000 })
    await expect(page.locator('.share-manager-embedded')).toBeVisible({ timeout: 5000 })
  })
})
