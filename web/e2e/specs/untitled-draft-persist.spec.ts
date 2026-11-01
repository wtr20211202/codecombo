import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * untitled 草稿热退出持久 E2E（P-20261003-97）：新建草稿 → 键入 → 防抖落
 * IndexedDB untitled 命名空间 → 刷新（模拟崩溃/误刷新）→ 草稿 tab 重建 +
 * 内容在 + 恢复 toast；另存转正 / 确认丢弃后记录清除，刷新不再复活。
 * uiState 剔除维持不变（草稿 tab 不进 opens 清单，持久只走 IndexedDB）。
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-untitled-persist')
const PROJ = 'e2e-untitled-persist'
const SEED_FILE = 'seed.txt'
const SAVE_AS_PATH = 'hot-exit-saved.md'
const DRAFT_TEXT = 'hot exit scratch survives refresh'

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

/** 读取当前项目作用域 untitled 命名空间的全部草稿记录（双 NUL 前缀范围，
 *  与 draftDb untitledKey 同构）。DB 尚未由应用创建时不得预先 open：无版本
 *  open 会凭空建出无 store 的 v1 库，应用按 v1 打开不再触发 onupgradeneeded */
async function readUntitledDrafts(page: Page, projectId: string): Promise<{ content?: string }[]> {
  return await page.evaluate(async (pid) => {
    const known = await indexedDB.databases?.() ?? null
    if (known && !known.some(d => d.name === 'sc-editor-drafts')) return []
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('sc-editor-drafts')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    if (!db.objectStoreNames.contains('drafts')) return []
    return await new Promise<unknown[]>((resolve, reject) => {
      const prefix = `${pid}\u0000\u0000untitled\u0000`
      const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`)
      const req = db.transaction('drafts', 'readonly').objectStore('drafts').getAll(range)
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    }) as Promise<unknown[]>
  }, projectId) as { content?: string }[]
}

async function openProjectPage(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
}

/** Ctrl+Alt+N 新建草稿（重试兜底：项目页 bootstrap 期间全局 keydown 监听可能
 *  未挂载；每次按键后先等 tab 出现再决定是否重试，避免重复新建） */
async function pressNewDraft(page: Page) {
  const draftTab = page.locator('.editor-tab').filter({ hasText: '草稿' }).first()
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Control+Alt+n')
    try {
      await expect(draftTab).toBeVisible({ timeout: 2000 })
      return
    } catch { /* 监听未挂载，重试 */ }
  }
  await expect(draftTab).toBeVisible({ timeout: 5000 })
}

/** 新建草稿并键入内容，轮询等待防抖落 untitled 命名空间（确定性等待） */
async function newDraftAndType(page: Page, projectId: string) {
  await pressNewDraft(page)
  await page.locator('.monaco-editor').click()
  await page.keyboard.type(DRAFT_TEXT)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(DRAFT_TEXT)
  await expect.poll(() => readUntitledDrafts(page, projectId), { timeout: 10000 })
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining(DRAFT_TEXT) }),
    ]))
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
  fs.writeFileSync(path.join(REPO_DIR, SEED_FILE), 'seed line\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: untitled 热退出基线'])
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

test('写草稿 → 刷新 → 草稿 tab 恢复且内容在 + 恢复 toast（热退出）', async ({ page }) => {
  await openProjectPage(page)
  await newDraftAndType(page, projectId)

  // 刷新模拟误刷新/崩溃（IndexedDB 跨导航存活，uiState 不含草稿 tab）
  await page.reload()

  // 启动恢复：草稿 tab 重建（编号重新分配）+ 恢复 toast（与建 tab 同刻出现）
  const draftTab = page.locator('.editor-tab').filter({ hasText: '草稿' }).first()
  await expect(draftTab).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.n-message').filter({ hasText: '已恢复 1 份未保存草稿' })).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(DRAFT_TEXT, { timeout: 10000 })
  await expect(draftTab.locator('.tab-dot')).toBeVisible()

  // 磁盘零写入（untitled 语义不变：恢复 ≠ 落盘）
  expect(fs.readdirSync(REPO_DIR)).not.toContain('untitled')
})

test('另存转正后记录清除：刷新草稿不复活', async ({ page }) => {
  await openProjectPage(page)
  await newDraftAndType(page, projectId)

  // Ctrl+S 拦截转另存为 → 落盘转正（含键入后 2s 内场景：挂起防抖一并取消）
  await page.keyboard.press('Control+s')
  const dialogInput = page.locator('.n-dialog input')
  await expect(dialogInput).toBeVisible({ timeout: 5000 })
  await dialogInput.fill(SAVE_AS_PATH)
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '已保存' })).toBeVisible({ timeout: 5000 })

  // untitled 命名空间记录清除
  await expect.poll(() => readUntitledDrafts(page, projectId), { timeout: 8000 }).toEqual([])

  // 刷新：转正文件按 uiState 恢复，草稿 tab 不复活（记录已清）
  await page.reload()
  await expect(page.locator('.editor-tab').filter({ hasText: SAVE_AS_PATH })).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.editor-tab').filter({ hasText: '草稿' })).toHaveCount(0)
  expect(fs.readFileSync(path.join(REPO_DIR, SAVE_AS_PATH), 'utf8')).toContain(DRAFT_TEXT)
})

test('确认丢弃清记录：刷新草稿不复活', async ({ page }) => {
  await openProjectPage(page)
  await newDraftAndType(page, projectId)

  // 点 × 关闭 → 确认丢弃
  const draftTab = page.locator('.editor-tab').filter({ hasText: '草稿' }).first()
  await draftTab.locator('.tab-close').click()
  await expect(page.locator('.n-dialog')).toBeVisible({ timeout: 5000 })
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.editor-tab').filter({ hasText: '草稿' })).toHaveCount(0, { timeout: 5000 })

  // untitled 命名空间记录清除
  await expect.poll(() => readUntitledDrafts(page, projectId), { timeout: 8000 }).toEqual([])

  // 刷新：无草稿 tab、无恢复 toast
  await page.reload()
  await expect(page.locator('.editor-tab').filter({ hasText: '草稿' })).toHaveCount(0, { timeout: 15000 })
  await expect(page.locator('.n-message').filter({ hasText: '已恢复' })).toHaveCount(0)
})
