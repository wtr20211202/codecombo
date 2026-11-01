import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * tab 脏点「保存并关闭」E2E（P-20261003-138，对标 VS Code 点脏点顺手保存）：
 * 脏文件点脏点 → 确认弹窗「保存并关闭」→ 确认后落盘且标签关闭；
 * 取消则原地不动；干净文件无脏点（纯指示形态不回归）。
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tab-dot-saveclose')
const PROJ = 'e2e-tab-dot-saveclose'
const FILE = 'dot-target.txt'
const ORIGINAL = 'dirty dot e2e line1\n'
const APPEND = 'appended-via-dirty-dot'

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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'])
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), ORIGINAL)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 脏点保存关闭基线'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
})

// 夹具逐用例复位：确认用例会把 APPEND 落盘（真实保存链路的断言点），顺序
// 在后的取消用例断言「磁盘不变 = ORIGINAL」必须从 ORIGINAL 起步——三用例
// 各自独立成立，不依赖声明序
test.beforeEach(async () => {
  fs.writeFileSync(path.join(REPO_DIR, FILE), ORIGINAL)
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

/** 进项目并打开目标文件（文件树可见性重试，uiState 面板开合跑序不定） */
async function enterAndOpenFile(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')

  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('dirty dot e2e line1', { timeout: 8000 })
}

/** 键入追加一行使文件变脏（Monaco 行尾定位 → 回车 → 输入） */
async function makeDirty(page: import('@playwright/test').Page) {
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(APPEND)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(APPEND)
  await expect(page.locator('.editor-tab .tab-dot')).toBeVisible()
}

/** 脏点「保存并关闭」确认弹窗（标题与确认按钮同文案，锚定按钮区定位） */
function saveCloseDialog(page: import('@playwright/test').Page) {
  return page.locator('.n-dialog').filter({ hasText: '保存并关闭' })
}

test('干净文件无脏点', async ({ page }) => {
  await enterAndOpenFile(page)
  await expect(page.locator('.editor-tab')).toHaveCount(1)
  await expect(page.locator('.editor-tab .tab-dot')).toHaveCount(0)
})

test('脏文件点脏点→确认→关闭且内容已保存', async ({ page }) => {
  await enterAndOpenFile(page)
  await makeDirty(page)

  // 点脏点（click.stop 不切换 tab）→「保存并关闭」确认弹窗
  await page.locator('.editor-tab .tab-dot').click()
  await expect(saveCloseDialog(page)).toBeVisible()
  await saveCloseDialog(page).locator('.n-dialog__action button').filter({ hasText: '保存并关闭' }).click()

  // 内容已落盘（轮询：保存请求异步落盘）
  await expect.poll(async () => fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8'), { timeout: 5000 })
    .toContain(APPEND)
  // 保存成功后才关闭：标签清空回到欢迎态，脏点随之消失
  await expect(page.locator('.editor-tab')).toHaveCount(0)
  await expect(page.locator('.editor-tab .tab-dot')).toHaveCount(0)
})

test('脏文件点脏点→取消→标签原地不动、磁盘不变', async ({ page }) => {
  await enterAndOpenFile(page)
  await makeDirty(page)

  await page.locator('.editor-tab .tab-dot').click()
  await expect(saveCloseDialog(page)).toBeVisible()
  await saveCloseDialog(page).locator('.n-dialog__action button').filter({ hasText: '取消' }).click()

  // 标签保留仍为脏态，磁盘保持原内容
  await expect(page.locator('.editor-tab')).toHaveCount(1)
  await expect(page.locator('.editor-tab .tab-dot')).toBeVisible()
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).toBe(ORIGINAL)
})
