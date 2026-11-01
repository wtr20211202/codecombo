import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * ops-notify 内置事件 open-file-at E2E（P-20261003-287）：
 *   agent 改完文件后把用户注意力引导到具体位置——POST /api/ops-notify 播种
 *   open-file-at（真实前端链路：ops-channel WS → useOpsChannel 对未列举 type
 *   直通分发 sc-ops:open-file-at，恰与既有常量 OPS_OPEN_FILE_AT 精确一致 →
 *   useLayoutViews 既有接收链「必要时切项目 → 打开文件 → 行定位」）：
 *   1. 合法载荷 {path, projectId, line, col} → 编辑器打开目标文件且锚点行可见
 *      （锚点在第 55/60 行，视口未滚动时 Monaco 不渲染该行，出现即证明
 *      revealLineInCenter 行定位生效——terminal-file-links 同款断言）
 *   2. 坏载荷（缺 projectId / 非正整数 line）→ 发布口 400 退回不进广播流，
 *      编辑器不开 tab（服务端就地校验纪律的端到端面）
 * 夹具项目 spec 内自备/自清，不残留测试数据
 */

const PROJ_NAME = 'e2e-ops-open-file-at'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-ops-open-file-at')
const APP_GO = path.join(REPO_DIR, 'src', 'app.go')
// 60 行夹具：锚点在第 55 行——未滚动视口不渲染该行，打开后可见即行定位生效
const ANCHOR = 'ops-open-file-at-anchor-55'
const REL_PATH = 'src/app.go'

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

async function lookupProjectId(): Promise<string> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  return list.find(p => p.name === PROJ_NAME)?.id || ''
}

test.beforeAll(async () => {
  // 清掉前次运行残留（崩溃遗留的旧项目/旧夹具）
  const staleId = await lookupProjectId()
  if (staleId) await fetch(`${API_BASE}/api/projects/${staleId}`, { method: 'DELETE', headers: await unlockHeaders() })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留占用 */ }
  fs.mkdirSync(path.dirname(APP_GO), { recursive: true })
  const lines: string[] = ['package main', '']
  for (let i = 2; i < 60; i++) {
    lines.push(i === 55 ? `// ${ANCHOR}` : `// pad line ${i}`)
  }
  fs.writeFileSync(APP_GO, lines.join('\n') + '\n')
  // 注册项目：路径交给服务端一律 serverPath 折算（跨拓扑口径）
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST',
    headers: await unlockHeaders(),
    body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(res.status)
  projectId = await lookupProjectId()
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const id = await lookupProjectId()
  if (id) await fetch(`${API_BASE}/api/projects/${id}`, { method: 'DELETE', headers: await unlockHeaders() })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用时忽略 */ }
})

// 进项目页（接收链挂在 Layout）：路上留出 WS 建立窗口再播种
async function enterProject(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)
}

test('open-file-at → 编辑器打开目标文件且定位到目标行', async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page)
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers: await unlockHeaders(),
    data: { type: 'open-file-at', payload: { path: REL_PATH, projectId, line: 55, col: 3 } },
  })
  // type 名与前端常量精确一致：sc-ops:open-file-at 直通分发命中既有接收链
  await expect(page.locator('.editor-tab').filter({ hasText: 'app.go' })).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(ANCHOR, { timeout: 15000 })
})

test('坏载荷 400 退回：不进广播流，编辑器不开 tab', async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page)
  const bad = [
    { payload: { path: REL_PATH } },                                   // 缺 projectId
    { payload: { projectId } },                                        // 缺 path
    { payload: { path: '/abs/app.go', projectId } },                   // 绝对路径
    { payload: { path: REL_PATH, projectId, line: 0 } },               // line 非正整数
  ]
  for (const body of bad) {
    const res = await page.request.post(`${API_BASE}/api/ops-notify`, {
      headers: await unlockHeaders(),
      data: { type: 'open-file-at', ...body },
    })
    expect(res.status()).toBe(400)
    expect(await res.text()).toContain('invalid open-file-at payload')
  }
  // 无事件进广播流：接收链零触发，编辑器无该文件 tab
  await expect(page.locator('.editor-tab').filter({ hasText: 'app.go' })).toHaveCount(0, { timeout: 3000 })
})
