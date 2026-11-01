import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 跨标签草稿写竞争保护 E2E（P-20261006-08）：双标签同开一文件，A 标签编辑防抖
 * 落库（localStorage 信标）后，B 标签不经刷新实时重载较新草稿并轻提示；双侧
 * 交替写（乒乓）触发「另一标签页也在编辑」的关一处提示。
 * 形态适配：任务书原文「双 context 模拟双 tab」在浏览器存储模型下不成立——
 * 双 context 各持独立 localStorage/IndexedDB，storage 事件跨 context 不派发；
 * 同一 context 的两个 page 才是同一浏览器的两个标签（settings-sync.spec 同款
 * 形态选择，单测层已用双实例模拟覆盖判定编排）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-draft-x-tab')
const PROJ = 'e2e-editor-draft-x-tab'
const FILE = 'x-tab-draft.txt'
const ORIGINAL = 'cross tab draft baseline\n'
const MARKER_A1 = 'tab-a-round-one'
const MARKER_B2 = 'tab-b-round-two'
const MARKER_A3 = 'tab-a-round-three'
const MARKER_B4 = 'tab-b-round-four'
const MARKER_A5 = 'tab-a-round-five'
const SYNC_TOAST = '已同步另一标签页的较新草稿'
const PINGPONG_TOAST = '正在另一标签页中编辑'

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

/** 进项目并从文件树打开目标文件（侧栏可能未开，rail-files 兜底重试 3 次） */
async function openProjectFile(page: Page) {
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('cross tab draft baseline', { timeout: 10000 })
}

/** 在当前激活编辑器尾部键入未保存内容（Ctrl+End 定位文末 + 换行追加） */
async function dirtyActiveEditor(page: Page, marker: string) {
  await page.bringToFront()
  await page.locator('.monaco-editor').last().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(marker)
  await expect(page.locator('.monaco-editor').last()).toContainText(marker)
}

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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE), ORIGINAL)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 跨标签草稿基线'])
  await registerProject(headers, PROJ, REPO_DIR)
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

test('A 标签编辑落库 → B 标签实时重载较新草稿并轻提示（不经刷新）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await openProjectFile(page)

  // B 标签：同 context 新 page（与 A 共享 localStorage/IndexedDB），同开该文件
  const tabB = await page.context().newPage()
  await fixedLocale(tabB)
  await gotoAndUnlock(tabB, `${API_BASE}/`)
  await openProjectFile(tabB)

  // A 编辑（防抖 2s 落库 + 信标），B 不经刷新跟到较新草稿
  await dirtyActiveEditor(page, MARKER_A1)
  await expect(tabB.locator('.monaco-editor .view-lines')).toContainText(MARKER_A1, { timeout: 15000 })
  await expect(tabB.locator('.n-message').filter({ hasText: SYNC_TOAST })).toBeVisible({ timeout: 5000 })

  // 磁盘未动：同步的是未保存草稿不是落盘内容
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).not.toContain(MARKER_A1)

  // B 重载后保持脏态（originalContent 不变），编辑态可见（脏点渲染）
  await expect(tabB.locator('.pane-primary .editor-tab', { hasText: FILE }).locator('.tab-dot')).toBeVisible()

  await tabB.close()
})

test('乒乓检测：双侧交替写互覆 → 「另一标签页也在编辑」提示关一处', async ({ page }) => {
  test.setTimeout(120_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await openProjectFile(page)
  const tabB = await page.context().newPage()
  await fixedLocale(tabB)
  await gotoAndUnlock(tabB, `${API_BASE}/`)
  await openProjectFile(tabB)

  // 五轮交替写（A,B,A,B,A）：信标只在「自己键入后防抖落库」时发——接收方的
  // 重载走 Monaco 外部同步路径（suppressNextModelEvent），不回灌 updateContent、
  // 不产生二次回写，所以 B 收到的对方信标数 = A 的键入轮数。乒乓第 3 帽对应
  // A 的第 3 次落库 = 第 5 轮。轮间相隔 ≥4s（上轮键入距本轮 > 2s 静默窗），
  // 同步每轮都可落地
  await dirtyActiveEditor(page, MARKER_A1)
  await expect(tabB.locator('.monaco-editor .view-lines')).toContainText(MARKER_A1, { timeout: 15000 })
  await dirtyActiveEditor(tabB, MARKER_B2)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(MARKER_B2, { timeout: 15000 })
  await dirtyActiveEditor(page, MARKER_A3)
  await expect(tabB.locator('.monaco-editor .view-lines')).toContainText(MARKER_A3, { timeout: 15000 })
  await dirtyActiveEditor(tabB, MARKER_B4)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(MARKER_B4, { timeout: 15000 })
  await dirtyActiveEditor(page, MARKER_A5)
  await expect(tabB.locator('.monaco-editor .view-lines')).toContainText(MARKER_A5, { timeout: 15000 })

  // 第 3 次收到同一文件的对方更新（A1/A3/A5）→ 乒乓 warning 提示关一处
  await expect(tabB.locator('.n-message').filter({ hasText: PINGPONG_TOAST })).toBeVisible({ timeout: 10000 })

  await tabB.close()
})
