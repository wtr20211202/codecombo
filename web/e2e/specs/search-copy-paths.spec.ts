import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 搜索结果「复制全部路径」E2E（P-20261003-149）：
 *   1. 单项目多文件命中 → 结果头小钮 → 剪贴板 = 换行分隔唯一路径
 *      （同文件多命中去重为一行）；无结果时按钮不渲染。
 *   2. glob 过滤后重搜 → 复制面收敛到过滤后的当前范围。
 *   3. 跨项目模式 → 路径带项目名前缀，跨仓同名文件不互斥。
 * 剪贴板断言经 grantPermissions + navigator.clipboard.readText
 * （approval-card-copy 同款）。自备临时仓库，afterAll 清理。
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-search-copy-paths-a')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-search-copy-paths-b')
const PROJ_A = 'e2e-scp-a'
const PROJ_B = 'e2e-scp-b'
const SCOPE_KEY = 'project-search-scope'
const NEEDLE = 'foo'
// 跨项目用例独占关键词：与用例 1/2 的 foo 结果集互不干扰
const XNEEDLE = 'scpneedlex'

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

function makeRepo(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir }) // 双路径：Windows 服务端 git 也不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: 复制全部路径基线'])
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
  // a.txt 两处命中：验证按文件去重；三扩展名供 glob 过滤用例收敛
  makeRepo(REPO_A, {
    'a.txt': `${NEEDLE} alpha\n${NEEDLE} beta\n`,
    'notes.md': `${NEEDLE} gamma\n`,
    'c.log': `${NEEDLE} delta\n`,
    // 跨项目用例：两仓同名文件，无前缀会互斥、有前缀两行
    'same.txt': `${XNEEDLE} from-a\n`,
  })
  makeRepo(REPO_B, {
    'same.txt': `${XNEEDLE} from-b\n`,
  })
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

const COPY_BTN = '[data-testid="ps-copy-paths"]'

/**
 * 剪贴板回读换行归一：应用侧恒写 LF（组件注释为显式约定），但 Windows 的
 * Chromium 剪贴板 readText 会把写入的 \n 规范化回 \r\n（本机 40/40 实测，
 * OS 剪贴板层行为、应用侧不可控）——断言前剥 \r，与粘贴消费方语义一致
 */
async function readClipboard(page: Page): Promise<string> {
  const raw = await page.evaluate(() => navigator.clipboard.readText())
  return raw.replace(/\r/g, '')
}

/**
 * 收起查询历史下拉（P-20261003-48）：搜索落地时输入框仍聚焦，历史下拉
 * 悬浮在选项行上方（z-index 30），会拦截其下所有点击——Esc 分层关闭
 * （只收下拉不关面板，onKeydown 同链），真实用户同此操作路径
 */
async function dismissHistoryDropdown(page: Page, card: ReturnType<Page['locator']>) {
  await page.keyboard.press('Escape')
  await expect(card.locator('.ps-history')).toHaveCount(0, { timeout: 3000 })
}

/** 进项目 → 开搜索面板 → 搜索 → 等统计行落地（=按钮已可发现） */
async function searchInProject(page: Page, projectName: string, needle: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: projectName }).first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await card.locator('input').first().fill(needle)
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })
  return card
}

test('多文件命中 → 复制：剪贴板换行分隔唯一路径（同文件多命中去重）', async ({ page }) => {
  test.setTimeout(60000)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const card = await searchInProject(page, PROJ_A, NEEDLE)

  const btn = card.locator(COPY_BTN)
  await expect(btn).toBeVisible()
  // tooltip i18n（zh 直译含范围口径）
  await expect(btn).toHaveAttribute('title', /复制全部路径/)

  await dismissHistoryDropdown(page, card)
  await btn.click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })

  const clip = await readClipboard(page)
  const lines = clip.split('\n')
  expect(lines).toHaveLength(3)
  // 去重：a.txt 两处命中只出现一次
  expect(new Set(lines).size).toBe(3)
  // 顺序不绑后端（git grep/rg 返回序），按集合断言
  expect([...lines].sort()).toEqual(['a.txt', 'c.log', 'notes.md'])
})

test('glob 过滤后复制当前范围：*.md 只剩 notes.md', async ({ page }) => {
  test.setTimeout(60000)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const card = await searchInProject(page, PROJ_A, NEEDLE)

  // glob 输入即时重搜（无防抖）：等 a.txt 组消失 = 过滤后结果已落地
  await card.locator('.ps-glob input').fill('*.md')
  await expect(card.locator('.ps-file-header').filter({ hasText: 'a.txt' })).toHaveCount(0, { timeout: 8000 })
  await expect(card.locator('.ps-file-header').filter({ hasText: 'notes.md' })).toHaveCount(1)

  await card.locator(COPY_BTN).click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await readClipboard(page)
  expect(clip).toBe('notes.md')
})

test('跨项目模式：路径带项目名前缀，跨仓同名文件不互斥', async ({ page }) => {
  test.setTimeout(60000)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  // 范围记忆种子（P-20261003-69 的 localStorage 键）：面板打开即恢复两项目范围；
  // 多选交互本身由 project-search-scope-memory.spec 覆盖，这里只借恢复路径
  await page.addInitScript(([key, ids]) => {
    window.localStorage.setItem(key as string, ids as string)
  }, [SCOPE_KEY, JSON.stringify([projIdA, projIdB])])
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_A }).first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await card.locator('input').first().fill(XNEEDLE)
  // 跨项目流式上屏（P-20261003-94）：组头是即时占位（转圈也算可见），不能作
  // 完成信号——统计行「处匹配」仅在 loading 结束后渲染 = 全部组已落定
  await expect(card.locator('.ps-project-header').filter({ hasText: PROJ_A })).toBeVisible({ timeout: 8000 })
  await expect(card.locator('.ps-project-header').filter({ hasText: PROJ_B })).toBeVisible({ timeout: 8000 })
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })

  await dismissHistoryDropdown(page, card)
  await card.locator(COPY_BTN).click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await readClipboard(page)
  // 前缀=项目名：同名 relative path 各保留一行；组序=范围选择序
  expect(clip).toBe(`${PROJ_A}/same.txt\n${PROJ_B}/same.txt`)
})
