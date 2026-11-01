import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 入口面总览 E2E（P-20261004-11）：设置·安全分区「入口面」卡——
 *   - 聚合形状：锁定态 + 解锁失败计数（含内存态注记）/ Agent Token / TLS 与
 *     回环辅助口 / 活跃分享计数 / 远程主机 五行齐备
 *   - 敏感值零回显：错误密码原文、来源 IP、分享路径/token 均不出现在卡内
 *     （分享只出计数——明细在出域卡与分享管理承载）
 *   - 每行直达管理入口：锁定/TLS/Agent Token 页签切换 + 分享管理主区视图
 * 前置：实例已 setup 且锁定功能关闭（e2e-seed），--no-tls 启动（TLS 行呈
 * 「未启用」态）；seed 项目 simple-coding 指向仓库根（README.md 可分享）。
 * 解锁失败计数为服务端进程内存态：用例播种一次错误密码（共享实例上 ≤10 次/分
 * 不触发封禁，且 e2e 数据面锁定功能关闭、不影响其他用例的浏览器侧）。
 */

// 错误密码原文（脱敏反例：绝不允许出现在卡内任何位置）
const WRONG_PASSWORD = 'e2e-wrong-password-p11'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function seedProjectId(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const proj = list.find(p => p.name === 'simple-coding')
  if (!proj) throw new Error('seed project simple-coding not found')
  return proj.id
}

// 播种一次解锁失败（Unlock 既有计数面）：响应 401 即计数已入账
async function seedUnlockFailure(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: WRONG_PASSWORD },
  })
  expect(res.status()).toBe(401)
}

test.describe('入口面总览', () => {
  test.afterAll(async ({ request }) => {
    // 撤销用例分享（GET 列表含 token，按 seed 项目过滤后逐条撤销）
    const headers = await unlockHeaders(request)
    const pid = await seedProjectId(request)
    const res = await request.get(`${API_BASE}/api/share`, { headers })
    const list = ((await res.json()) as { data?: { token: string; projectId: string; path: string }[] }).data || []
    for (const s of list.filter(x => x.projectId === pid && x.path === 'README.md')) {
      await request.delete(`${API_BASE}/api/share/${s.token}`, { headers })
    }
  })

  test('聚合形状：五行齐备、失败计数入账、敏感值零回显', async ({ page, request }) => {
    // 播种：分享入口计数 1 + 解锁失败 ≥1（服务端内存态聚合）
    const headers = await unlockHeaders(request)
    const pid = await seedProjectId(request)
    const created = await request.post(`${API_BASE}/api/share`, {
      headers, data: { projectId: pid, path: 'README.md' },
    })
    expect(created.ok()).toBeTruthy()
    await seedUnlockFailure(request)

    await fixedLocale(page)
    await page.goto(`${API_BASE}/`)
    await waitForAppReady(page)
    await unlockIfNeeded(page)

    // 设置 → 安全：入口面卡常显于 Tabs 上方（与出域卡并列）
    await page.getByRole('button', { name: '设置' }).click()
    await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
    await page.locator('[data-testid="settings-nav-security"]').click()
    const card = page.locator('[data-testid="ingress-card"]')
    await expect(card).toBeVisible({ timeout: 5000 })

    // 锁定行：seed 为锁定关闭 → 未启用；失败计数聚合 ≥1 + 内存态语义注记
    const lockValue = page.locator('[data-testid="ingress-lock-value"]')
    await expect(lockValue).toContainText('未启用', { timeout: 5000 })
    const failures = page.locator('[data-testid="ingress-failures-value"]')
    await expect(failures).toContainText(/解锁失败 [1-9]\d* 次/, { timeout: 5000 })
    await expect(card).toContainText('限流计数为内存态，重启清零')

    // Agent Token 行：存在性口径渲染（seed 实例自动播种 → 前缀掩码形态）
    await expect(page.locator('[data-testid="ingress-agent-token-value"]')).toContainText(/sca_\w{4}\*\*\*|未签发/, { timeout: 5000 })

    // TLS 行：--no-tls 实例 → 未启用（明文 HTTP）；回环辅助口仅 TLS 启用期存在
    await expect(page.locator('[data-testid="ingress-tls-value"]')).toContainText(/TLS (已启用|未启用)/, { timeout: 5000 })

    // 分享行：只出计数；路径/token 明细零回显（计数与明细分流是本卡纪律）
    const sharesValue = page.locator('[data-testid="ingress-shares-value"]')
    await expect(sharesValue).toContainText('1 条活跃链接', { timeout: 5000 })
    await expect(page.locator('[data-testid="ingress-row-shares"]')).not.toContainText('README.md')

    // 零回显总检：错误密码原文与来源 IP 形态不出现在卡内任何位置
    const cardText = await card.innerText()
    expect(cardText).not.toContain(WRONG_PASSWORD)
    expect(cardText).not.toContain('127.0.0.1')

    // 远程主机行：计数形态（{n} 台）
    await expect(page.locator('[data-testid="ingress-remote-hosts-value"]')).toContainText(/\d+ 台/, { timeout: 5000 })
  })

  test('行直达管理入口：锁定/TLS/Agent Token 页签切换 + 分享管理主区视图', async ({ page }) => {
    await fixedLocale(page)
    await page.goto(`${API_BASE}/`)
    await waitForAppReady(page)
    await unlockIfNeeded(page)

    // 从项目页打开设置（分享管理是 /project 主区视图，先落项目页）
    await page.locator('.project-card').first().click()
    await page.waitForURL('**/project')
    await page.locator('[data-testid="rail-settings"]').click()
    await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
    await page.locator('[data-testid="settings-nav-security"]').click()
    await expect(page.locator('[data-testid="ingress-card"]')).toBeVisible({ timeout: 5000 })

    const securityPane = page.locator('[data-testid="settings-pane-security"]')

    // 锁定 → 安全分区内锁定页签（LockSettingsPane 挂载，含全局锁定开关行）
    await page.locator('[data-testid="ingress-manage-lock"]').click()
    await expect(securityPane.locator('.cred-row').filter({ hasText: '启用全局锁定' })).toBeVisible({ timeout: 3000 })

    // TLS → 安全分区内 TLS 页签（传输加密分区标题）
    await page.locator('[data-testid="ingress-manage-tls"]').click()
    await expect(securityPane).toContainText('HTTPS / WSS', { timeout: 3000 })

    // Agent Token → 安全分区内 Agent Token 页签（长效边界说明锚点）
    await page.locator('[data-testid="ingress-manage-agent-token"]').click()
    await expect(page.locator('[data-testid="agent-token-boundary"]')).toBeVisible({ timeout: 3000 })

    // 分享入口 → 弹层收起 + 主区分享管理视图打开（?view=shares 通道）
    await page.locator('[data-testid="settings-nav-security"]').click()
    await page.locator('[data-testid="ingress-manage-shares"]').click()
    await expect(page.locator('.settings-modal')).toBeHidden({ timeout: 3000 })
    await expect(page.locator('.share-manager-embedded')).toBeVisible({ timeout: 5000 })
  })
})
