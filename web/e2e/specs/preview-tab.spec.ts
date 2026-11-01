import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, setLockEnabled } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 预览标签模式 E2E（P-20261002-50）：Quick Open/命令面板/全工程搜索/深链四类
 * 浏览来源在活跃组复用未编辑的预览位（斜体 tab），不再堆积永久 tab；
 *   ① Quick Open 开 A → 再开 B → 仍单预览 tab（B 换装 A 的槽位）
 *   ② 编辑 B → 转正（斜体/预览类摘除）→ 再开 C → 新预览位与转正 tab 并存
 *   ③ 深链 ?file= 直达打开同样是预览 tab
 *   ④ 文件树打开仍是固定 tab（无预览类），与预览位并存
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-preview-tab')
const PROJ = 'e2e-preview-tab'
const FILES = [
  { name: 'preview-a.txt', content: 'preview alpha content' },
  { name: 'preview-b.txt', content: 'preview beta content' },
  { name: 'preview-c.txt', content: 'preview gamma content' },
]
/** 转正编辑追加的标记文本 */
const APPEND = '-edited'

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
  git(REPO_DIR, ['commit', '-m', 'root: 预览标签基线'])
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

/** 进入项目页并展开文件树（rail 按钮是 toggle，先保证面板可见）。
 *  每个用例先清 uiState 再 reload：bootstrap 的标签恢复是异步逐个 openFileByPath
 *  （按已存在路径幂等激活），前序用例/重试残留的恢复流会与本用例的打开断言竞态
 *  ——清空后进入，行为只由本用例的驱动决定 */
async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.evaluate(async () => {
    // 页内同源 fetch 自动携带 HttpOnly 锁 cookie（P-20261019-2 起无头可带）
    await fetch('/api/ui-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local: null }),
    })
  })
  await page.reload()
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
}

/** Quick Open 打开文件（Ctrl+P → 文件名 → 点击命中项） */
async function quickOpenFile(page: import('@playwright/test').Page, fileName: string) {
  await page.keyboard.press('Control+p')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(fileName)
  const item = page.locator('.palette-item').filter({ hasText: fileName }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
  await expect(page.locator('.editor-tab', { hasText: fileName })).toBeVisible({ timeout: 10000 })
}

test('Quick Open 翻看复用单预览位，编辑转正后再开走新预览位', async ({ page }) => {
  await enterProject(page)

  // 开 A：唯一 tab 且为预览类（斜体样式类 + 悬停提示）
  await quickOpenFile(page, FILES[0]!.name)
  const tabA = page.locator('.editor-tab', { hasText: FILES[0]!.name })
  await expect(tabA).toHaveClass(/preview/)
  await expect(tabA).toHaveAttribute('title', /预览中/)
  await expect(page.locator('.editor-tab')).toHaveCount(1)

  // 再开 B：仍是单 tab（B 换装 A 的预览位）
  await quickOpenFile(page, FILES[1]!.name)
  const tabB = page.locator('.editor-tab', { hasText: FILES[1]!.name })
  await expect(page.locator('.editor-tab')).toHaveCount(1)
  await expect(tabB).toHaveClass(/preview/)

  // 编辑 B：转正（预览类摘除，切换/再开不再替换它）
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 8000 })
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(APPEND)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(APPEND)
  await expect(tabB).not.toHaveClass(/preview/)

  // 再开 C：转正的 B 保留，C 落新预览位（2 tab 并存）
  await quickOpenFile(page, FILES[2]!.name)
  const tabC = page.locator('.editor-tab', { hasText: FILES[2]!.name })
  await expect(page.locator('.editor-tab')).toHaveCount(2)
  await expect(tabB).not.toHaveClass(/preview/)
  await expect(tabC).toHaveClass(/preview/)
})

test('文件深链 ?file= 直达打开同样是预览 tab', async ({ page }) => {
  // enterProject 内已做 uiState 清空重进（深链 bootstrap 恢复落点才确定，
  // file-deeplink 同口径）
  await enterProject(page)
  // 经 API 关掉锁定开关：深链 goto 不走 gotoAndUnlock，遮罩会挡住断言
  await setLockEnabled(page, false)
  // 文件树打开一个文件（固定 tab）制造 openFiles 变化触发持久化，再轮询 projectId 落定
  await page.locator('.file-tree .item-name', { hasText: FILES[0]!.name }).first().click()
  await expect(page.locator('.editor-tab', { hasText: FILES[0]!.name })).toBeVisible({ timeout: 30000 })
  const pollHeaders = await unlockHeaders()
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/api/ui-state`, { headers: pollHeaders })
      const body = (await res.json()) as { data?: { local?: { projectId?: string } } }
      if (body.data?.local?.projectId === projectId) break
    } catch { /* 轮询重试 */ }
    await page.waitForTimeout(500)
  }

  // 深链直达：tab 呈预览类且激活，消费后 URL 清 query
  await page.goto(`${API_BASE}/project?file=${encodeURIComponent(FILES[1]!.name)}`)
  const tabB = page.locator('.editor-tab', { hasText: FILES[1]!.name })
  await expect(tabB).toBeVisible({ timeout: 30000 })
  await expect(tabB).toHaveClass(/preview/)
  await expect(tabB).toHaveClass(/active/)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 10000 })
  await expect(page).toHaveURL(/\/project$/)
})

test('文件树打开仍是固定 tab（无预览类），与 Quick Open 预览位并存', async ({ page }) => {
  await enterProject(page)

  // 文件树开两个：都是固定 tab，无预览类
  for (const f of FILES.slice(0, 2)) {
    await page.locator('.file-tree .item-name', { hasText: f.name }).first().click()
    await expect(page.locator('.editor-tab', { hasText: f.name })).toBeVisible({ timeout: 30000 })
  }
  await expect(page.locator('.editor-tab')).toHaveCount(2)
  for (const f of FILES.slice(0, 2)) {
    await expect(page.locator('.editor-tab', { hasText: f.name })).not.toHaveClass(/preview/)
  }

  // Quick Open 再开 C：追加为预览位，文件树 tab 不受影响
  await quickOpenFile(page, FILES[2]!.name)
  await expect(page.locator('.editor-tab')).toHaveCount(3)
  await expect(page.locator('.editor-tab', { hasText: FILES[2]!.name })).toHaveClass(/preview/)
  for (const f of FILES.slice(0, 2)) {
    await expect(page.locator('.editor-tab', { hasText: f.name })).not.toHaveClass(/preview/)
  }
})
