import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 敏感文件读取审计观测 E2E（P-20261003-315）：
 *   - ReadFile 路径命中敏感模式清单（.env*、id_rsa*、*.pem、*.key、credentials*、secrets*）
 *     → 审计入账 file.sensitive_read：成功态，Detail 携项目名 + 归一路径 +
 *       X-Session-ID 会话归属，绝不含文件内容
 *   - 纯观测不拦截：.env 读取 200 且内容照常返回（拦截属 AgentGuard 高危面，不混入）
 *   - 不命中（readme.md）零记录；去重窗口内同会话同路径只记一条；换会话照常入账
 *   - 审计页自然可见：前端打开 .env 后设置·安全·审计日志出现「读取敏感文件」行
 * 自备临时仓库，afterAll 清理（path-traversal 范式）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-sensread')
const PROJ = 'e2e-sensread'
const SECRET_MARK = 'SENSREAD_E2E_SECRET'
const SESSION_A = 'sc-e2e-sensread-a'
const SESSION_B = 'sc-e2e-sensread-b'

let projectId = ''

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

// 审计台账里的 file.sensitive_read 事件（窗口 500 = 服务端单页上限）
async function sensitiveReadEvents(headers: Record<string, string>) {
  const res = await fetch(`${API_BASE}/api/audit?limit=500&offset=0`, { headers })
  expect(res.ok).toBeTruthy()
  const body = (await res.json()) as { data?: { action: string; detail?: string }[] }
  return (body.data || []).filter(e => e.action === 'file.sensitive_read')
}

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders()
  const stale = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(path.join(REPO_DIR, 'config'), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'sensitive read audit e2e\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: sensread 基线'])
  // 敏感样例不入库（未跟踪）：.env 裸名 + 嵌套 secrets（basename 命中验证）
  fs.writeFileSync(path.join(REPO_DIR, '.env'), `${SECRET_MARK}=1\n`)
  fs.writeFileSync(path.join(REPO_DIR, 'config', 'secrets.yaml'), 'token: placeholder\n')

  const created = await request.post(`${API_BASE}/api/projects`, {
    headers, data: { name: PROJ, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  expect(created.status()).toBeLessThan(300)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders()
  if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('API：命中入账带会话归属 + 纯观测不拦截 + 不命中零记录 + 窗口去重 + 嵌套路径', async ({ request }) => {
  const headers = await unlockHeaders()
  // 会话 id 每次尝试唯一：retries=1 的重跑不被 5min 去重窗口吞记首读
  const sessionA = `${SESSION_A}-${Date.now()}`
  const sessionB = `${SESSION_B}-${Date.now()}`

  // 命中：读取 .env（agent 形态携 X-Session-ID）——200 且内容照常返回（纯观测）
  const read = await request.get(`${API_BASE}/api/projects/${projectId}/file?path=.env`, {
    headers: { 'X-Session-ID': sessionA },
  })
  expect(read.status()).toBe(200)
  expect(await read.text()).toContain(SECRET_MARK)

  let events = await sensitiveReadEvents(headers)
  const mine = events.filter(e => (e.detail || '').includes('.env') && (e.detail || '').includes(`session ${sessionA}`))
  expect(mine.length, '读取 .env 应入账一条带会话归属的 sensitive_read').toBe(1)
  expect(mine[0].detail, 'Detail 只含项目名+路径+会话，不含文件内容').not.toContain(SECRET_MARK)

  const countAfterFirst = events.length

  // 不命中：readme.md 读取零新增
  const plain = await request.get(`${API_BASE}/api/projects/${projectId}/file?path=readme.md`)
  expect(plain.status()).toBe(200)
  expect((await sensitiveReadEvents(headers)).length).toBe(countAfterFirst)

  // 去重：窗口内同会话同路径重读不再入账
  const reread = await request.get(`${API_BASE}/api/projects/${projectId}/file?path=.env`, {
    headers: { 'X-Session-ID': sessionA },
  })
  expect(reread.status()).toBe(200)
  expect((await sensitiveReadEvents(headers)).length).toBe(countAfterFirst)

  // 换会话照常入账；嵌套路径按归一相对路径记录
  const nested = await request.get(`${API_BASE}/api/projects/${projectId}/file?path=config/secrets.yaml`, {
    headers: { 'X-Session-ID': sessionB },
  })
  expect(nested.status()).toBe(200)
  events = await sensitiveReadEvents(headers)
  const nestedEvents = events.filter(e => (e.detail || '').includes('config/secrets.yaml') && (e.detail || '').includes(`session ${sessionB}`))
  expect(nestedEvents.length, '嵌套敏感路径读取应入账').toBe(1)
  expect(events.length, '换会话/换路径不受去重窗口吞记').toBe(countAfterFirst + 1)
})

test('审计页自然可见：前端打开 .env → 审计日志出现「读取敏感文件」行', async ({ page }) => {
  test.setTimeout(90000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 文件树打开 .env（人类浏览器读取，无 X-Session-ID——Detail 不带会话段）。
  // 树默认隐藏点文件（FileTreeView showHidden 过滤），先开「显示隐藏文件」再点
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  const hiddenToggle = page.locator('button.tree-action-btn[title="显示隐藏文件"]')
  if (await hiddenToggle.isVisible().catch(() => false)) {
    await hiddenToggle.click()
  }
  await page.locator('.file-tree .item-name').filter({ hasText: '.env' }).first().click()
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 15000 })

  // 设置 → 安全 → 审计日志：观测面走既有审计页（P-13），动作选项从实际事件派生
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审计日志' }).click()
  await expect(page.getByTestId('audit-pane')).toBeVisible({ timeout: 5000 })

  const row = page
    .locator('[data-testid="audit-pane"] .n-data-table-tr')
    .filter({ hasText: '读取敏感文件' })
    .filter({ hasText: '.env' }) // API 用例的会话行也可能在窗口内，锚定本次 .env 读取
  await expect(row.first()).toBeVisible({ timeout: 5000 })
})
