import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器 tab 栏滚轮横向滚动 E2E（P-20261002-99）：开多 tab 至溢出 →
 *   ① 悬停标签栏纵向滚轮转 scrollLeft（自然方向：下滚右移，上滚左移）
 *   ② 横向分量（Shift+wheel 的原生形态）走浏览器原生滚动，处理器不拦截
 * 自备临时仓库，afterAll 清理。
 */

// 窄视口压小标签行可用宽度，长文件名撑满单个 tab（名称截到 ~160px/标签），
// 6 个标签必然溢出（溢出信号以应用自身的 .tabs-overflow-btn 出现为准）
test.use({ viewport: { width: 900, height: 700 } })

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tab-wheel')
const PROJ = 'e2e-tab-wheel'
const FILES = Array.from({ length: 6 }, (_, i) => ({
  name: `wheel-tab-very-long-name-${i + 1}-overflow.txt`,
  content: `wheel tab overflow file ${i + 1}`,
}))

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
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  for (const f of FILES) fs.writeFileSync(path.join(REPO_DIR, f.name), f.content + '\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: tab 滚轮横滚基线'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 打开项目并经文件树打开全部 6 个文件，等到标签溢出信号（溢出按钮出现） */
async function openProjectAndOverflowTabs(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILES[0]!.name }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  for (const f of FILES) {
    await page.locator('.file-tree .item-name', { hasText: f.name }).first().click()
  }
  await expect(page.locator('.editor-tab')).toHaveCount(FILES.length)
  // 应用自身的溢出判定（checkTabOverflow > 4px）渲染溢出按钮——以此为准
  await expect(page.locator('.tabs-overflow-btn')).toBeVisible({ timeout: 5000 })
}

test('纵向滚轮悬停标签栏：deltaY 转 scrollLeft 横向步进（自然方向）', async ({ page }) => {
  await openProjectAndOverflowTabs(page)

  const tabs = page.locator('.editor-tabs')
  const left = () => tabs.evaluate((el) => el.scrollLeft)
  const before = await left()

  // 下滚（deltaY>0）→ 右移：scrollLeft 增大
  await tabs.hover()
  await page.mouse.wheel(0, 400)
  await expect.poll(left, { timeout: 3000 }).toBeGreaterThan(before)
  const afterDown = await left()

  // 上滚（deltaY<0）→ 左移：scrollLeft 回落
  await page.mouse.wheel(0, -400)
  await expect.poll(left, { timeout: 3000 }).toBeLessThan(afterDown)
})

test('横向分量（Shift+wheel 原生形态）：走浏览器原生滚动不被拦截', async ({ page }) => {
  await openProjectAndOverflowTabs(page)

  const tabs = page.locator('.editor-tabs')
  const left = () => tabs.evaluate((el) => el.scrollLeft)
  const before = await left()

  // deltaX>0 由浏览器原生横向滚动（处理器对 deltaX 直接放行）
  await tabs.hover()
  await page.mouse.wheel(400, 0)
  await expect.poll(left, { timeout: 3000 }).toBeGreaterThan(before)
})
