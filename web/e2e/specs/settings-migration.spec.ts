import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 换机迁移——实例配置包导出/导入 E2E（P-20261003-147）：
 *   1. API 轻装往返：export（信封附件）→ 错口令统一 400 → preview（预览载荷
 *      + 票据，无秘密明文）→ apply（计数报告）→ 审计 migration.export/import 行
 *   2. UI 双向冒烟：设置·迁移分区可见 → 轻装导出走浏览器下载（.scpkg）→
 *      同文件 setInputFiles 导入 → 预览 → 应用 → 结果报告
 * 轻装包只迁设置/实例注册表两块（凭据/令牌块不勾，避免动共享实例的安全面）；
 * 导入以 merge 策略落地，对共享实例的持久化影响仅限「实例注册表空集 + 设置
 * 快照写回」（快照即导出时刻本机现值，幂等）。
 */

const PASS = 'e2e-passphrase-9527'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function openMigrationPane(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="settings-nav-migration"]').click()
  await expect(page.locator('[data-testid="settings-pane-migration"]')).toBeVisible()
}

test('API 轻装往返：导出 → 错口令统一 400 → 预览 → 应用 → 审计入账', async ({ request }) => {
  const headers = await unlockHeaders(request)

  // 导出（settings + instances 两块；口令进请求体不过 URL——访问日志面无口令）
  const exp = await request.post(`${API_BASE}/api/migration/export`, {
    headers,
    data: {
      mode: 'light',
      passphrase: PASS,
      blocks: { credentials: false, tokens: false, settings: true, instances: true },
    },
  })
  expect(exp.ok()).toBeTruthy()
  expect(exp.headers()['content-disposition']).toContain('.scpkg')
  const pkgText = await exp.text()
  // v1 轻装包是单 JSON 信封：明文头只带格式/版本/KDF 参数
  const env = JSON.parse(pkgText) as { format?: string; version?: number; ciphertext?: string }
  expect(env.format).toBe('simple-coding.migration')
  expect(env.version).toBe(1)
  expect(env.ciphertext ?? '').toBeTruthy()

  // 错口令：与文件损坏同一条统一文案（防 oracle）
  const badForm = new FormData()
  badForm.append('passphrase', 'wrong-passphrase-000')
  badForm.append('file', new Blob([pkgText], { type: 'application/json' }), 'm.scpkg')
  const bad = await request.post(`${API_BASE}/api/migration/import/preview`, { headers: { 'X-Lock-Token': headers['X-Lock-Token'] }, multipart: badForm })
  expect(bad.status()).toBe(400)
  const badBody = (await bad.json()) as { error?: string }
  expect(badBody.error).toContain('wrong passphrase or corrupted')

  // 正确口令预览：块清单 + 票据；载荷无秘密明文（轻装包只迁设置/实例）
  const goodForm = new FormData()
  goodForm.append('passphrase', PASS)
  goodForm.append('file', new Blob([pkgText], { type: 'application/json' }), 'm.scpkg')
  const prev = await request.post(`${API_BASE}/api/migration/import/preview`, { headers: { 'X-Lock-Token': headers['X-Lock-Token'] }, multipart: goodForm })
  expect(prev.ok()).toBeTruthy()
  const prevBody = (await prev.json()) as { data?: { mode?: string; ticket?: string; blocks?: Record<string, boolean> } }
  expect(prevBody.data?.mode).toBe('light')
  expect(prevBody.data?.ticket).toBeTruthy()
  expect(prevBody.data?.blocks?.settings).toBe(true)

  // 应用（settings 以包为准 = 本机现值幂等写回；instances 空集合并）
  const apply = await request.post(`${API_BASE}/api/migration/import/apply`, {
    headers,
    data: {
      ticket: prevBody.data?.ticket,
      blocks: { settings: 'package', instances: 'merge' },
    },
  })
  expect(apply.ok()).toBeTruthy()
  const applyBody = (await apply.json()) as { data?: { rolledBack?: boolean; blocks?: Record<string, { imported?: number; failed?: number }> } }
  expect(applyBody.data?.rolledBack).toBe(false)
  expect(applyBody.data?.blocks?.settings?.failed ?? 0).toBe(0)

  // 审计入账（元数据）：导出与导入各一行
  const audit = await request.get(`${API_BASE}/api/audit?limit=50`, { headers })
  const auditText = await audit.text()
  expect(auditText).toContain('migration.export')
  expect(auditText).toContain('migration.import')
})

test('UI：迁移分区可见 → 轻装导出下载 .scpkg → 导入预览 → 应用出报告', async ({ page }) => {
  await openMigrationPane(page)

  // 双卡片 + 模式档 + 四块勾选可见（新入口可发现面）
  await expect(page.locator('[data-testid="settings-migration-export"]')).toBeVisible()
  await expect(page.locator('[data-testid="settings-migration-import"]')).toBeVisible()
  await expect(page.locator('[data-testid="settings-migration-mode-light"]')).toBeVisible()
  await expect(page.locator('[data-testid="settings-migration-mode-full"]')).toBeVisible()
  await expect(page.locator('[data-test="settings-migration-block-credentials"]')).toBeVisible()
  await expect(page.locator('[data-test="settings-migration-block-instances"]')).toBeVisible()

  // 口令未达 8 位：导出按钮禁用（强度门槛前置反馈）
  await page.locator('[data-test="settings-migration-pass"] input').fill('short')
  await expect(page.locator('[data-test="settings-migration-export-btn"]')).toBeDisabled()
  await page.locator('[data-test="settings-migration-pass"] input').fill(PASS)
  await page.locator('[data-test="settings-migration-pass2"] input').fill(PASS)
  await expect(page.locator('[data-test="settings-migration-export-btn"]')).toBeEnabled()

  // UI 导出：浏览器下载事件拿 .scpkg 落临时目录
  const dlPromise = page.waitForEvent('download')
  await page.locator('[data-test="settings-migration-export-btn"]').click()
  const dl = await dlPromise
  expect(dl.suggestedFilename()).toContain('.scpkg')
  const pkgPath = await dl.path()
  expect(pkgPath).toBeTruthy()

  // 导入卡：选同一文件 + 口令 → 预览（包元数据行出现）
  await page.locator('[data-test="settings-migration-file"]').setInputFiles(pkgPath!)
  await page.locator('[data-test="settings-migration-import-pass"] input').fill(PASS)
  await page.locator('[data-test="settings-migration-preview-btn"]').click()
  await expect(page.locator('[data-test="settings-migration-pkg-meta"]')).toBeVisible({ timeout: 15000 })

  // 应用（策略表按包内块缺省勾选：settings=以包为准，instances=合并）
  await page.locator('[data-test="settings-migration-apply-btn"]').click()
  await expect(page.locator('[data-test="settings-migration-report"]')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-test="settings-migration-report"]')).not.toContainText('导入失败')
})
