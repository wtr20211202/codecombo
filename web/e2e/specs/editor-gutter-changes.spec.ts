import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'
import { OPS_FILES_EXTERNAL_CHANGE } from '../../src/utils/opsEvents'

/**
 * 编辑器 gutter 变更条 E2E（P-20261003-14）：打开文件即可见相对上次提交
 * 动过的行——改行蓝条（modified）、新增行绿条（added）；打开/保存/外部改写
 * 三条失效链与 untracked 文件跳过。
 * 自备临时仓库，afterAll 清理。untracked 文件在注册项目前落盘，首载即入树。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-gutter')
const PROJ = 'e2e-editor-gutter'
const FILE = 'gutter-target.txt'
const UNTRACKED = 'gutter-untracked.txt'
const BASE_LINES = 'gutter line1\n' + 'gutter line2\n' + 'gutter line3\n'
const MODIFY_WORD = 'gutter line1-modified'
const ADD_WORD = 'gutter line4-added'
const EXTERNAL_WORD = 'gutter external-line'

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
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE), BASE_LINES)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: gutter 变更条基线'])
  // untracked 文件（提案④ MVP 跳过标记）：提交后落盘、注册项目前就位——
  // 首次加载文件树即包含，无需树内刷新
  fs.writeFileSync(path.join(REPO_DIR, UNTRACKED), 'untracked seed\n')
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

/** 打开项目并进入目标文件，等待打开时的 hunks 拉取完成（与装饰应用解耦的确定性锚点） */
async function openFile(page: import('@playwright/test').Page, file: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: file }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  const hunksLoaded = page.waitForResponse((r) => r.url().includes('/file/hunks'), { timeout: 8000 }).catch(() => null)
  await page.locator('.file-tree .item-name', { hasText: file }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(file === FILE ? 'gutter line1' : 'untracked seed', { timeout: 8000 })
  await hunksLoaded
}

const bar = (page: import('@playwright/test').Page, kind: 'added' | 'modified') =>
  page.locator('.pane-primary .monaco-editor').locator(`.sc-gutter-${kind}`)

test('干净文件无条；改行保存→蓝条、新增行保存→绿条', async ({ page }) => {
  await openFile(page, FILE)

  // 干净文件：打开拉取完成后仍无任何变更条（有 3s 窗口供误标现形）
  await expect(bar(page, 'added')).toHaveCount(0, { timeout: 3000 })
  await expect(bar(page, 'modified')).toHaveCount(0, { timeout: 3000 })

  // 改第 1 行（Ctrl+Home → Shift+End 全选行内容 → 覆盖输入）
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+End')
  await page.keyboard.type(MODIFY_WORD)
  // 文末新增一行：基线文件带尾换行，Ctrl+End 落在末尾空行——先 Backspace
  // 退回上一行行尾再 Enter，确保只插一行（否则多出空行被计为 added）
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Enter')
  await page.keyboard.type(ADD_WORD)

  // 保存触发失效链刷新：等刷新拉取返回再断言（确定性，不赌装饰时机）
  const refreshLoaded = page.waitForResponse((r) => r.url().includes('/file/hunks'), { timeout: 8000 })
  await page.keyboard.press('Control+s')
  await expect(page.locator('.n-message').filter({ hasText: '文件已保存' })).toBeVisible({ timeout: 5000 })
  await refreshLoaded

  // 分类正确：改行=蓝条 ×1，新增行=绿条 ×1
  await expect(bar(page, 'modified')).toHaveCount(1, { timeout: 5000 })
  await expect(bar(page, 'added')).toHaveCount(1)
})

test('打开既有变更文件直显条目；外部改写事件后刷新', async ({ page }) => {
  // 上一用例落盘的变更（1 改 + 1 增）：打开即见，无需保存动作
  await openFile(page, FILE)
  await expect(bar(page, 'modified')).toHaveCount(1, { timeout: 5000 })
  await expect(bar(page, 'added')).toHaveCount(1)

  // 外部改写磁盘 + 广播外部变更事件（与 GitPanel/分支切换等广播方同契约），
  // 新增一行 → 干净打开文件被重读，绿条 +1
  fs.writeFileSync(
    path.join(REPO_DIR, FILE),
    `${MODIFY_WORD}\ngutter line2\ngutter line3\n${ADD_WORD}\n${EXTERNAL_WORD}\n`,
  )
  await page.evaluate(([ev, target]) => {
    window.dispatchEvent(new CustomEvent(ev, { detail: { paths: [target] } }))
  }, [OPS_FILES_EXTERNAL_CHANGE, FILE])

  // 重读链：编辑器内容跟上磁盘；失效链：外部新增行落为绿条
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(EXTERNAL_WORD, { timeout: 8000 })
  await expect(bar(page, 'added')).toHaveCount(2, { timeout: 5000 })
  await expect(bar(page, 'modified')).toHaveCount(1)
})

test('untracked 文件无条不报错：编辑保存正常，标记跳过', async ({ page }) => {
  await openFile(page, UNTRACKED)

  // 编辑 + 保存闭环正常（保存成功消息可见），全程无错误提示
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('untracked appended')
  const refreshLoaded = page.waitForResponse((r) => r.url().includes('/file/hunks'), { timeout: 8000 })
  await page.keyboard.press('Control+s')
  await expect(page.locator('.n-message').filter({ hasText: '文件已保存' })).toBeVisible({ timeout: 5000 })
  await refreshLoaded

  // untracked 无 git diff → 不标条（提案④ MVP），且无错误 toast/通知
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('untracked appended')
  await expect(bar(page, 'added')).toHaveCount(0, { timeout: 3000 })
  await expect(bar(page, 'modified')).toHaveCount(0, { timeout: 3000 })
  await expect(page.locator('.n-message').filter({ hasText: '失败' })).toHaveCount(0)
})
