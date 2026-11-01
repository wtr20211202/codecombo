import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知正文路径链接化（P-20261004-61）E2E：
 * 播种一条 body 携「相对路径:行号」的通知（任务失败摘要形态）→ 通知中心
 * 行内路径片段渲染为可点态 → 点击 → 通知面板关闭 + 编辑器打开对应文件并
 * 滚动定位到锚点行。覆盖：
 *   1. 相对路径 src/app.go:55 点击直达编辑器行（60 行夹具锚点在第 55 行，
 *      未滚动时 Monaco 视口不渲染该行，出现即证明行定位生效）
 *   2. 无路径 body 零可点态（既有呈现零变化）；绝对路径 body 不渲染死链接
 *      （打开链按项目根解析，形态守卫拒绝绝对路径——单测同口径的端到端面）
 *   3. 点击反馈：面板关闭（与条目主动作点击同 UX，露出底下发生的编辑器）
 * 通知经 POST /api/notifications 播种（用例开头先清空、afterAll 再清空）；
 * 夹具项目 spec 内自备、afterAll 删除，不残留测试数据。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-notify-path-link'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-notify-path-link')
const APP_GO = path.join(REPO_DIR, 'src', 'app.go')
const ANCHOR = 'notify-path-anchor-55'
const REL_PATH = 'src/app.go:55'

let unlockToken = ''
let projId = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

async function clearNotifications(): Promise<void> {
  await api('POST', '/api/notifications/clear')
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  await clearNotifications()
  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) await api('DELETE', `/api/projects/${oldProj.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(path.dirname(APP_GO), { recursive: true })
  // 60 行夹具：锚点在第 55 行——视口未滚动时 Monaco 不渲染该行，
  // 点击通知内路径链接后可见即证明行定位生效
  const lines: string[] = ['package main', '']
  for (let i = 2; i < 60; i++) {
    lines.push(i === 55 ? `// ${ANCHOR}` : `// pad line ${i}`)
  }
  fs.writeFileSync(APP_GO, lines.join('\n') + '\n')
  // 注册项目：路径交给服务端一律 serverPath 折算（跨拓扑口径）
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
  const list = await api('GET', '/api/projects')
  projId = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)!.id
  expect(projId).toBeTruthy()

  // 播种三条通知（同 category 但 title 各异不聚合）：路径形（主场景）、
  // 无路径形（零变化回归）、绝对路径形（不渲染死链接）
  for (const n of [
    { type: 'error', category: 'task', title: 'e2e-路径通知-主场景', body: `构建失败：${REL_PATH}: undefined: Foo`, projectId: projId, projectName: PROJ_NAME },
    { type: 'error', category: 'task', title: 'e2e-路径通知-无路径', body: '退出码 1（耗时 3.2s）' },
    { type: 'error', category: 'task', title: 'e2e-路径通知-绝对路径', body: 'panic: /usr/local/go/src/app/main.go:12 +0x3a' },
  ]) {
    const res = await api('POST', '/api/notifications', n)
    expect(res.status).toBe(200)
  }
})

test.afterAll(async () => {
  await clearNotifications()
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

async function openPanelAndFindRow(page: import('@playwright/test').Page, title: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 解锁后延迟出现的默认密码提醒先收起（遮罩拦点击，notify-copy 同款兜底）
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
  await projectCardByName(page, PROJ_NAME).first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const row = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: title })
  await expect(row).toHaveCount(1, { timeout: 3000 })
  return row
}

test('通知正文路径链接：播种通知 → 片段可点 → 点击直达编辑器锚点行', async ({ page }) => {
  test.setTimeout(120000)
  const row = await openPanelAndFindRow(page, 'e2e-路径通知-主场景')

  // body 内路径:行号片段渲染为可点态（既有正文文本仍在）
  const link = row.locator('[data-testid^="notif-body-path-"]')
  await expect(link).toHaveCount(1)
  await expect(link).toHaveText(REL_PATH)
  await expect(row).toContainText('构建失败：')

  // 点击：标已读 + 关面板（与条目主动作同 UX）+ OPS_OPEN_FILE_AT 直达
  await link.click()
  await expect(page.locator('.nc-card')).toHaveCount(0, { timeout: 5000 })
  await expect(page.locator('.editor-tab').filter({ hasText: 'app.go' })).toBeVisible({ timeout: 15000 })
  // 60 行夹具锚点在第 55 行：未滚动视口不渲染该行，可见即证明行定位生效
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(ANCHOR, { timeout: 15000 })
})

test('无路径 body 零可点态；绝对路径 body 不渲染死链接', async ({ page }) => {
  const plainRow = await openPanelAndFindRow(page, 'e2e-路径通知-无路径')
  await expect(plainRow.locator('[data-testid^="notif-body-path-"]')).toHaveCount(0)
  await expect(plainRow).toContainText('退出码 1（耗时 3.2s）')

  const absRow = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-路径通知-绝对路径' })
  await expect(absRow).toHaveCount(1, { timeout: 3000 })
  await expect(absRow.locator('[data-testid^="notif-body-path-"]')).toHaveCount(0)
  await expect(absRow).toContainText('/usr/local/go/src/app/main.go:12')
})
