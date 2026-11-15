import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器 tab 按钮区光标语义 + dragstart 守卫 E2E（P-20261114-5）：
 *   ① tab 本体 hover 默认箭头（grab 收敛为专用拖柄语义，VS Code/Chrome 标签条
 *      惯例）、按住不动时 :active grabbing 兜底可拖性可发现性
 *   ② 关闭钮 hover pointer（tab 内按钮自持光标语义，不被拖拽面光标盖住）
 *   ③ 点击关闭钮关闭成功（干净文件无确认弹窗直达）
 *   ④ 按住微动数像素仍关闭成功——dragstart 守卫钉：按压起点在按钮区则
 *      preventDefault 不启动拖拽（dragstart 的 target 恒为最近 draggable 祖先，
 *      看不到子按钮——守卫经 mousedown 标记读按压起点），click 不被 dragstart
 *      抢占吞掉（「点不了」根因回归面；拖拽主链路 tab 本体不涉，跨组/重排由
 *      editor-tab-cross-drag 钉）
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tab-close-cursor')
const PROJ = 'e2e-tab-close-cursor'
const FILE = 'close-cursor.txt'
const CONTENT = 'tab close cursor e2e baseline\n'

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
  fs.writeFileSync(path.join(REPO_DIR, FILE), CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: tab 关闭钮光标守卫基线'])
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

/** 进项目并经文件树打开目标文件（文件树可见性重试，uiState 面板开合跑序不定） */
async function enterAndOpenFile(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE })).toBeVisible()
}

test('关闭钮 hover pointer、tab 本体默认箭头 + :active grabbing 兜底', async ({ page }) => {
  await enterAndOpenFile(page)
  const tab = page.locator('.pane-primary .editor-tab', { hasText: FILE })

  // 关闭钮自持 pointer（P-20261114-5：无声明会被拖拽面光标继承盖住）
  await tab.locator('.tab-close').hover()
  await expect.poll(() => tab.locator('.tab-close').evaluate((el) => getComputedStyle(el).cursor)).toBe('pointer')

  // tab 本体 hover 默认箭头（grab 收敛为专用拖柄语义，条目型拖拽面惯例）
  await tab.locator('.tab-name').hover()
  await expect.poll(() => tab.locator('.tab-name').evaluate((el) => getComputedStyle(el).cursor)).toBe('default')

  // 按住不动 = 拖动中抓手收紧（:active grabbing 可拖性兜底，勿删回归钉）
  const box = await tab.boundingBox()
  if (!box) throw new Error('tab boundingBox 不可得')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect.poll(() => tab.evaluate((el) => getComputedStyle(el).cursor)).toBe('grabbing')
  await page.mouse.up()
})

test('点击关闭钮关闭成功（干净文件直达无弹窗）', async ({ page }) => {
  await enterAndOpenFile(page)
  await page.locator('.pane-primary .editor-tab', { hasText: FILE }).locator('.tab-close').click()
  await expect(page.locator('.pane-primary .editor-tab')).toHaveCount(0)
})

test('按住微动数像素仍关闭成功（dragstart 守卫：按钮区不启动拖拽）', async ({ page }) => {
  await enterAndOpenFile(page)
  // 关闭钮按住 + 微动数像素（drag 移动阈值内）：dragstart 若不被守卫短路会
  // 启动拖拽吞掉 click；守卫 preventDefault 后 click 恒可达
  const close = page.locator('.pane-primary .editor-tab', { hasText: FILE }).locator('.tab-close')
  const box = await close.boundingBox()
  if (!box) throw new Error('tab-close boundingBox 不可得')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 4, box.y + box.height / 2 + 2, { steps: 2 })
  await page.mouse.up()
  await expect(page.locator('.pane-primary .editor-tab')).toHaveCount(0)
})
