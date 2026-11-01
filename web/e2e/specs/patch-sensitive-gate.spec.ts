import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 补丁导出出域敏感闸 E2E（P-20261004-97，与分享面安全对称）：
 *   - API：.env 改动导出 → 首请求 200 JSON {warnings:[".env"]}（无附件头）；
 *     confirm=1 / {"confirm":true} 确认后真出，补丁内容完整（可 apply）；
 *   - UI：导出 → 警示弹层点名 .env → 取消零下载，确认「仍然导出」后下载
 *     到达且内容完整；
 *   - 无敏感文件零打扰直下（警示弹层不出现）。
 * 自备临时仓库（core.autocrlf false，三平台行尾语义对齐），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-patch-gate')
const PROJ = 'e2e-patch-gate'
const ENV = '.env'
const PLAIN = 'plain.txt'

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, ENV), 'A=1\n')
  fs.writeFileSync(path.join(REPO_DIR, PLAIN), 'v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 敏感闸基线'])

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  for (const p of [
    path.join(os.tmpdir(), 'sc-e2e-patch-gate-clone'),
    path.join(os.tmpdir(), 'sc-e2e-patch-gate-plain.patch'),
  ]) { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* 占用忽略 */ } }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test('API：.env 改动导出拦回 warnings 清单，confirm 后内容完整（可 apply 还原）', async ({ request }) => {
  fs.writeFileSync(path.join(REPO_DIR, ENV), 'SECRET=1\n')
  const headers = await unlockHeaders()
  const url = `${API_BASE}/api/projects/${projectId}/patch`

  // 首请求（未确认）：200 JSON {warnings}，不出附件头
  const blocked = await request.get(`${url}?scope=worktree`, { headers })
  expect(blocked.ok()).toBeTruthy()
  expect(blocked.headers()['content-type']).toContain('application/json')
  expect(blocked.headers()['content-disposition']).toBeUndefined()
  const body = (await blocked.json()) as { warnings?: string[] }
  expect(body.warnings).toEqual(['.env'])

  // 确认二段：confirm=1 真出补丁，内容完整——干净克隆 apply 后 .env 还原为确认版
  const ok = await request.get(`${url}?scope=worktree&confirm=1`, { headers })
  expect(ok.ok()).toBeTruthy()
  expect(ok.headers()['content-type']).toContain('text/x-patch')
  const patchPath = path.join(os.tmpdir(), 'sc-e2e-patch-gate-plain.patch')
  fs.writeFileSync(patchPath, await ok.body())

  const cloneDir = path.join(os.tmpdir(), 'sc-e2e-patch-gate-clone')
  try { fs.rmSync(cloneDir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  execFileSync('git', ['clone', '--no-checkout', REPO_DIR, cloneDir])
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: cloneDir })
  execFileSync('git', ['checkout', 'HEAD'], { cwd: cloneDir })
  execFileSync('git', ['apply', patchPath], { cwd: cloneDir })
  expect(fs.readFileSync(path.join(cloneDir, ENV), 'utf8')).toBe('SECRET=1\n')

  // POST /patch/export 同闸同契约：未确认回 warnings，confirm=true 出内容
  const pBlocked = await request.post(`${url}/export`, { headers, data: { staged: false } })
  expect(pBlocked.ok()).toBeTruthy()
  expect(((await pBlocked.json()) as { warnings?: string[] }).warnings).toEqual(['.env'])
  const pOk = await request.post(`${url}/export`, { headers, data: { staged: false, confirm: true } })
  expect(pOk.ok()).toBeTruthy()
  const pBody = (await pOk.json()) as { data?: string; sensitiveHits?: string[] }
  expect(pBody.data).toContain('+SECRET=1')
  expect(pBody.sensitiveHits).toEqual(['.env'])
})

test('UI：警示弹层点名 .env → 取消零下载 → 确认「仍然导出」后下载内容完整', async ({ page }) => {
  fs.writeFileSync(path.join(REPO_DIR, ENV), 'SECRET=1\n')
  // status 接口走服务端 3s TTL 缓存——CLI 改仓不触发失效，静置后进页面首拉必见改动
  await page.waitForTimeout(3300)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  // rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  const panel = page.locator('.commit-panel')
  await expect(panel.locator('.cp-node').filter({ hasText: ENV })).toBeVisible({ timeout: 10000 })

  const exportBtn = panel.locator('[data-testid="export-patch"]')
  await expect(exportBtn).toBeEnabled()
  await exportBtn.click()
  await page.locator('.n-dropdown-option').filter({ hasText: '工作区（未暂存）' }).click()

  // 警示弹层：标题 + 命中文件名点名
  const dialog = page.locator('.n-modal').filter({ hasText: '导出补丁前安全扫描' })
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(dialog).toContainText('.env')

  // 取消：零下载（服务端未出补丁，客户端零落盘）
  let downloaded = false
  page.waitForEvent('download', { timeout: 2000 }).then(() => { downloaded = true }).catch(() => { /* 未下载即预期 */ })
  await dialog.locator('button').filter({ hasText: '取消' }).click()
  await expect(dialog).toBeHidden()
  await page.waitForTimeout(2500)
  expect(downloaded).toBeFalsy()

  // 再来一次：确认「仍然导出」→ confirm=1 二次请求 → 下载到达且内容完整
  await exportBtn.click()
  await page.locator('.n-dropdown-option').filter({ hasText: '工作区（未暂存）' }).click()
  const dialog2 = page.locator('.n-modal').filter({ hasText: '导出补丁前安全扫描' })
  await expect(dialog2).toBeVisible({ timeout: 5000 })
  const dlPromise = page.waitForEvent('download', { timeout: 15000 })
  await dialog2.locator('button').filter({ hasText: '仍然导出' }).click()
  const dl = await dlPromise
  expect(dl.suggestedFilename()).toMatch(/^main-\d{8}\.patch$/)
  const patchBody = fs.readFileSync(await dl.path(), 'utf8')
  expect(patchBody).toContain('diff --git a/.env b/.env')
  expect(patchBody).toContain('+SECRET=1')
})

test('无敏感文件零打扰：普通文件导出直下（弹层不出现）', async ({ page, request }) => {
  // .env 改动提交掉，只留普通文件改动并暂存（staged scope 只有 plain.txt）
  fs.writeFileSync(path.join(REPO_DIR, ENV), 'A=1\n')
  fs.writeFileSync(path.join(REPO_DIR, PLAIN), 'v2\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '--allow-empty', '-m', 'chore: 清空敏感改动'])
  fs.writeFileSync(path.join(REPO_DIR, PLAIN), 'v3\n')
  git(REPO_DIR, ['add', PLAIN])

  // API 契约：无命中不拦直下（响应无 warnings 键）
  const headers = await unlockHeaders()
  const direct = await request.get(`${API_BASE}/api/projects/${projectId}/patch?scope=staged`, { headers })
  expect(direct.ok()).toBeTruthy()
  expect(direct.headers()['content-type']).toContain('text/x-patch')
  expect(await direct.text()).toContain('+v3')

  // UI：staged 导出直下，警示弹层不出现
  await page.waitForTimeout(3300)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  const panel = page.locator('.commit-panel')
  await panel.locator('.cp-tab-refresh').click()
  await expect(panel.locator('.cp-node').filter({ hasText: PLAIN })).toBeVisible({ timeout: 10000 })

  const exportBtn = panel.locator('[data-testid="export-patch"]')
  await exportBtn.click()
  await page.locator('.n-dropdown-option').filter({ hasText: '暂存区' }).click()
  const dl = await page.waitForEvent('download', { timeout: 15000 })
  expect(dl.suggestedFilename()).toMatch(/^main-\d{8}\.patch$/)
  expect(fs.readFileSync(await dl.path(), 'utf8')).toContain('+v3')
  await expect(page.locator('.n-modal').filter({ hasText: '导出补丁前安全扫描' })).toBeHidden()
})
