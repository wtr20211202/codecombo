import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 搜索结果「导出 CSV」E2E（P-20261003-272）：
 *   1. 单项目多文件命中 → 结果头小钮 → 下载 search-<查询词>-<yyyymmdd>.csv，
 *      数据行数 = 结果处数（行数与结果一致）；UTF-8 BOM + 语言中立小写表头
 *      （file,line,content）+ RFC 4180（逗号/引号字段加引号、内部引号翻倍）
 *      + =开头单元格单引号前缀转义（导出族注入防护惯例）。
 *   2. glob 过滤后导出 → 行集收敛到过滤后范围。
 *   3. 跨项目模式 → 文件列带项目名前缀（P-149 复制路径同款，跨仓同名不互斥）。
 * 下载断言经 page.waitForEvent('download')（blob 下载链），自备临时仓库，
 * afterAll 清理。
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-search-export-csv-a')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-search-export-csv-b')
const PROJ_A = 'e2e-secsv-a'
const PROJ_B = 'e2e-secsv-b'
const SCOPE_KEY = 'project-search-scope'
// 单项目用例独占关键词：命中行覆盖 裸行/=开头（注入防护）/含逗号/含引号 四形态
const NEEDLE = 'expcsv'
// 跨项目用例独占关键词：与 NEEDLE 结果集互不干扰
const XNEEDLE = 'secsvneedlex'

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
  git(dir, ['commit', '-m', 'root: 导出CSV基线'])
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
  // a.txt 四形态命中行：行号 1-4 各不相同（CSV line 列可断言）；b.md 供 glob 用例收敛
  makeRepo(REPO_A, {
    'a.txt': `${NEEDLE} plain one\n=cmd ${NEEDLE} escaped\n${NEEDLE} has,comma inside\nhe said "${NEEDLE}" quoted\n`,
    'b.md': `${NEEDLE} second file\n`,
    // 跨项目用例：两仓同名文件
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

const EXPORT_BTN = '[data-testid="ps-export-csv"]'

/** 数据行视图：BOM 剥除后按行拆（首行=表头），空尾行滤除 */
function csvRows(csv: string): string[] {
  expect(csv.startsWith('\uFEFF')).toBe(true) // UTF-8 BOM（Excel 非 ASCII 列防 ANSI 误读）
  const lines = csv.slice(1).replace(/\n$/, '').split('\n')
  expect(lines[0]).toBe('file,line,content') // 语言中立小写表头（审计 CSV 同惯例）
  return lines.slice(1)
}

/**
 * 收起查询历史下拉（P-20261003-48）：搜索落地时输入框仍聚焦，历史下拉
 * 悬浮在选项行上方会拦截其下按钮点击——Esc 分层关闭（只收下拉不关面板）
 */
async function dismissHistoryDropdown(page: Page, card: ReturnType<Page['locator']>) {
  await page.keyboard.press('Escape')
  await expect(card.locator('.ps-history')).toHaveCount(0, { timeout: 3000 })
}

/** 触发导出并取回 CSV 文本（blob 下载 → waitForEvent 捕获） */
async function exportCsvText(page: Page, card: ReturnType<Page['locator']>, expectedName: RegExp): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    card.locator(EXPORT_BTN).click(),
  ])
  expect(download.suggestedFilename()).toMatch(expectedName)
  return fs.readFileSync(await download.path(), 'utf8')
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

test('多文件命中 → 导出：行数与结果一致 + =开头转义 + RFC 4180 引号', async ({ page }) => {
  test.setTimeout(60000)
  const card = await searchInProject(page, PROJ_A, NEEDLE)

  const btn = card.locator(EXPORT_BTN)
  await expect(btn).toBeVisible()
  // tooltip i18n（zh 直译含范围口径）
  await expect(btn).toHaveAttribute('title', /导出结果 CSV/)

  await dismissHistoryDropdown(page, card)
  const csv = await exportCsvText(page, card, /^search-expcsv-\d{8}\.csv$/)
  // 下载反馈（成功回告）
  await expect(page.locator('.n-message').filter({ hasText: '已导出' })).toBeVisible({ timeout: 5000 })

  const rows = csvRows(csv)
  // 行数与结果一致：a.txt 4 处 + b.md 1 处 = 5 行
  expect(rows).toHaveLength(5)
  // 顺序不绑后端（git grep 返回序），按集合断言；line 列 = 文件内 1 基行号
  expect([...rows].sort()).toEqual([
    'a.txt,1,expcsv plain one',
    "a.txt,2,'=cmd expcsv escaped", // =开头单元格单引号前缀（表格软件公式注入防护）
    'a.txt,3,"expcsv has,comma inside"', // 含逗号字段加引号（RFC 4180）
    'a.txt,4,"he said ""expcsv"" quoted"', // 含引号字段加引号且内部引号翻倍
    'b.md,1,expcsv second file',
  ])
})

test('glob 过滤后导出：行集收敛到过滤后范围（*.md 只剩 b.md）', async ({ page }) => {
  test.setTimeout(60000)
  const card = await searchInProject(page, PROJ_A, NEEDLE)

  // glob 输入即时重搜（无防抖）：等 a.txt 组消失 = 过滤后结果已落地
  await card.locator('.ps-glob input').fill('*.md')
  await expect(card.locator('.ps-file-header').filter({ hasText: 'a.txt' })).toHaveCount(0, { timeout: 8000 })
  await expect(card.locator('.ps-file-header').filter({ hasText: 'b.md' })).toHaveCount(1)

  // 焦点已在 glob 输入 → 查询输入 blur 历史下拉已收（copy-paths 同款），无需也不可
  // Esc 收起——历史下拉不可见时 Esc 会经 onKeydown 关掉整个面板
  const csv = await exportCsvText(page, card, /^search-expcsv-\d{8}\.csv$/)
  expect(csvRows(csv)).toEqual(['b.md,1,expcsv second file'])
})

test('跨项目模式：文件列带项目名前缀，跨仓同名文件不互斥', async ({ page }) => {
  test.setTimeout(60000)
  // 范围记忆种子（P-20261003-69 的 localStorage 键）：面板打开即恢复两项目范围
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
  // 跨项目流式上屏（P-20261003-94）：统计行「处匹配」仅在 loading 结束后渲染 = 全部组已落定
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })

  await dismissHistoryDropdown(page, card)
  const csv = await exportCsvText(page, card, /^search-secsvneedlex-\d{8}\.csv$/)
  const rows = csvRows(csv)
  // 前缀=项目名：同名 relative path 各保留一行；组序=范围选择序
  expect([...rows].sort()).toEqual([
    `${PROJ_A}/same.txt,1,${XNEEDLE} from-a`,
    `${PROJ_B}/same.txt,1,${XNEEDLE} from-b`,
  ])
})
