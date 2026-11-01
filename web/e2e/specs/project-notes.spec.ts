import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 项目笔记 E2E（P-20261002-110，人机共享便签层）：
 * 活动栏「项目笔记」面板（textarea 编辑 + 防抖自动保存 + markdown 预览）与
 * agent 通道（GET/PUT /api/projects/:id/notes，ops 手册登记）读写同一份：
 *   1. 面板写入 → 防抖落盘 → API 读到（人写交接 agent 可读）→ 刷新仍在
 *   2. agent 写回（API 直写模拟 curl）→ 面板重新打开可见（agent 结论人可看）
 *   3. 另一项目独立：项目 B 的笔记与 A 互不串扰
 *   4. 256KB 上限：恰好 256KB 放行 / +1 字节 413（API）
 * 自备临时仓库，afterAll 清理（范式与 todo-panel 对称）。
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-notes-a')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-notes-b')
const PROJ_A = 'e2e-project-notes-a'
const PROJ_B = 'e2e-project-notes-b'
const HUMAN_NOTE = '# 交接说明\n\n- 待办：修复登录超时\n- 决策：暂不升级依赖\n'
const AGENT_NOTE = '## agent 阶段性结论\n\n已修复登录超时（见 a1b2c3），遗留：补充单测。\n'

let projIdA = ''
let projIdB = ''

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

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

/** agent 通道读（与面板同源）：GET /api/projects/:id/notes */
async function apiGetNotes(headers: Record<string, string>, pid: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects/${pid}/notes`, { headers })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data?: { content?: string } }
  return body.data?.content ?? ''
}

/** agent 通道写：PUT /api/projects/:id/notes（返回状态码供边界断言） */
async function apiPutNotes(headers: Record<string, string>, pid: string, content: string): Promise<number> {
  const res = await fetch(`${API_BASE}/api/projects/${pid}/notes`, {
    method: 'PUT', headers, body: JSON.stringify({ content }),
  })
  return res.status
}

function makeRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# notes e2e\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: 项目笔记基线'])
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_A || p.name === PROJ_B) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [REPO_A, REPO_B]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  makeRepo(REPO_A)
  makeRepo(REPO_B)
  projIdA = await registerProject(headers, PROJ_A, REPO_A)
  projIdB = await registerProject(headers, PROJ_B, REPO_B)
  expect(projIdA).toBeTruthy()
  expect(projIdB).toBeTruthy()
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_A || p.name === PROJ_B) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  for (const dir of [REPO_A, REPO_B]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 面板开关是 toggle 语义：先查可见（uiState 可能恢复为已开），未开再点；
 *  点后仍不可见（基线本开着被点关）则再点一次 */
async function openNotesPanel(page: import('@playwright/test').Page) {
  const panel = page.locator('[data-testid="notes-panel"]')
  if (!(await panel.isVisible().catch(() => false))) {
    await page.locator('[data-testid="rail-notes"]').click()
  }
  try {
    await panel.waitFor({ state: 'visible', timeout: 2500 })
  } catch {
    await page.locator('[data-testid="rail-notes"]').click()
    await panel.waitFor({ state: 'visible', timeout: 5000 })
  }
  return panel
}

async function enterProject(page: import('@playwright/test').Page, name: string) {
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: name }).first().click()
  await page.waitForURL('**/project')
}

test('面板写入 → 防抖落盘 → API 读到 → 刷新仍在 → 预览渲染', async ({ page }) => {
  await fixedLocale(page)
  await enterProject(page, PROJ_A)

  const panel = await openNotesPanel(page)
  const editor = panel.locator('[data-testid="notes-editor"]')
  await editor.fill(HUMAN_NOTE)
  // 触发防抖自动保存：状态徽标从 dirty/saving 回到 idle 即落盘完成
  await expect(panel.locator('[data-testid="notes-status"]')).toHaveCount(0, { timeout: 8000 })

  // agent 通道（API）读到面板写的内容：人写交接 → agent 可读
  const headers = await unlockHeaders()
  await expect.poll(() => apiGetNotes(headers, projIdA), { timeout: 8000 })
    .toContain('修复登录超时')

  // 刷新页面 → 面板重开 → 笔记仍在
  await page.reload()
  await page.waitForURL('**/project')
  const panel2 = await openNotesPanel(page)
  await expect(panel2.locator('[data-testid="notes-editor"]')).toHaveValue(HUMAN_NOTE, { timeout: 8000 })

  // markdown 预览：标题渲染为 h1（marked+DOMPurify 管线）
  await panel2.locator('[data-testid="notes-mode-preview"]').click()
  await expect(panel2.locator('[data-testid="notes-preview"] h1')).toHaveText('交接说明')
})

test('agent 写回 → 面板刷新可见；另一项目独立', async ({ page }) => {
  const headers = await unlockHeaders()

  // agent 直写项目 A（模拟 ops 手册登记的 REST 通道）
  expect(await apiPutNotes(headers, projIdA, AGENT_NOTE)).toBe(200)

  await fixedLocale(page)
  await enterProject(page, PROJ_A)
  const panel = await openNotesPanel(page)
  // 面板重新挂载即读盘最新（last-writer-wins：agent 后写覆盖，人可看）
  await expect(panel.locator('[data-testid="notes-editor"]')).toHaveValue(AGENT_NOTE, { timeout: 8000 })

  // 项目 B 独立：B 写入自己的笔记后，B 面板只有 B 的内容
  expect(await apiPutNotes(headers, projIdB, 'B 项目专属笔记\n')).toBe(200)
  await enterProject(page, PROJ_B)
  const panelB = await openNotesPanel(page)
  await expect(panelB.locator('[data-testid="notes-editor"]')).toHaveValue('B 项目专属笔记\n', { timeout: 8000 })
})

test('256KB 上限：恰好 256KB 放行 / +1 字节 413（API）', async () => {
  const headers = await unlockHeaders()

  // 恰好 256KB（262144 字节）→ 200
  expect(await apiPutNotes(headers, projIdA, 'a'.repeat(256 * 1024))).toBe(200)

  // 超限 413，且原内容不被半截覆盖
  expect(await apiPutNotes(headers, projIdA, 'a'.repeat(256 * 1024 + 1))).toBe(413)
  const after = await apiGetNotes(headers, projIdA)
  expect(after).toBe('a'.repeat(256 * 1024))
})
