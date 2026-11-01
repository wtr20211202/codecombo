import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 提交拓扑泳道封顶的呈现诚实性与可配置 E2E（P-20261006-29）：
 *   - >16 活跃分支仓库（20 支并行分支逐个 --no-ff 合入）→ 图区出
 *     「拓扑已压缩：N 泳道并入末道」注记 + 末道虚线「容器道」区分
 *   - 16 内小仓库（线性 5 提交单泳道）→ 零注记零虚线（常规仓库零感）
 *   - 外观档位切换 16→32 生效：保存后 20 道拓扑在上限内完整绘制，注记消失，
 *     localStorage 落 graph-lane-settings
 * 自备临时仓库，afterAll 清理（含 uiState 归零）。
 */

const REPO_CAP = path.join(os.tmpdir(), 'sc-e2e-graph-lane-cap')
const REPO_SMALL = path.join(os.tmpdir(), 'sc-e2e-graph-lane-small')
const PROJ_CAP = 'e2e-graph-lane-cap'
const PROJ_SMALL = 'e2e-graph-lane-small'
const BRANCH_COUNT = 20

function git(cwd: string, args: string[], dates?: { author: string; committer: string }) {
  const env: NodeJS.ProcessEnv = { ...process.env }
  if (dates) {
    env.GIT_AUTHOR_DATE = dates.author
    env.GIT_COMMITTER_DATE = dates.committer
  }
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], {
    cwd, encoding: 'utf8', env,
  }).trim()
}

/** 第 i 号提交的显式时间戳：单调递增保 git log 次序确定（快跑提交同秒会乱序，
 *  泳道数/N 值断言才稳）。git log 缺省按 commit-time 序且保证子先于父。 */
function stampAt(i: number) {
  const v = `2026-10-13T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')} +0800`
  return { author: v, committer: v }
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

let capProjectId = ''
let smallProjectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_CAP || p.name === PROJ_SMALL) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_CAP, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  try { fs.rmSync(REPO_SMALL, { recursive: true, force: true }) } catch { /* 残留忽略 */ }

  // CAP 仓库：root 后 20 支并行分支各自单提交，逐个 --no-ff 合回 master——
  // 渲染窗口内活跃泳道 21 道（master 道 + 20 分支道），16 封顶并入 5 道
  fs.mkdirSync(REPO_CAP, { recursive: true })
  git(REPO_CAP, ['init', '-b', 'master'])
  git(REPO_CAP, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge
  fs.writeFileSync(path.join(REPO_CAP, 'base.txt'), 'base\n')
  git(REPO_CAP, ['add', '.'], stampAt(0))
  git(REPO_CAP, ['commit', '-m', 'root: 泳道封顶基线'], stampAt(0))
  for (let i = 1; i <= BRANCH_COUNT; i++) {
    const ts = stampAt(i * 2 - 1)
    git(REPO_CAP, ['checkout', '-b', `lane${i}`], ts)
    fs.writeFileSync(path.join(REPO_CAP, `f${i}.txt`), `${i}\n`)
    git(REPO_CAP, ['add', '.'], ts)
    git(REPO_CAP, ['commit', '-m', `lane: 分支 ${i} 独有提交`], ts)
    const mts = stampAt(i * 2)
    git(REPO_CAP, ['checkout', 'master'], mts)
    git(REPO_CAP, ['merge', '--no-ff', '-m', `merge: 并入分支 ${i}`, `lane${i}`], mts)
  }
  expect(Number(git(REPO_CAP, ['rev-list', '--count', 'master']))).toBe(1 + BRANCH_COUNT * 2)

  // SMALL 仓库：线性 5 提交单泳道（远在 16 上限内）
  fs.mkdirSync(REPO_SMALL, { recursive: true })
  git(REPO_SMALL, ['init', '-b', 'master'])
  git(REPO_SMALL, ['config', 'core.autocrlf', 'false'])
  for (let i = 1; i <= 5; i++) {
    fs.writeFileSync(path.join(REPO_SMALL, `f${i}.txt`), `${i}\n`)
    git(REPO_SMALL, ['add', '.'], stampAt(i))
    git(REPO_SMALL, ['commit', '-m', `线性提交 ${i}`], stampAt(i))
  }

  capProjectId = await registerProject(headers, PROJ_CAP, REPO_CAP)
  smallProjectId = await registerProject(headers, PROJ_SMALL, REPO_SMALL)
  expect(capProjectId).not.toBe('')
  expect(smallProjectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_CAP || p.name === PROJ_SMALL) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_CAP, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  try { fs.rmSync(REPO_SMALL, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 点击 rail 直到 Git 面板提交区可见（toggle 语义，最多 3 轮；回归探针同款） */
async function openCommitsPanel(page: import('@playwright/test').Page) {
  const toolbar = page.locator('.commits-toolbar')
  for (let i = 0; i < 3; i++) {
    if (await toolbar.isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    for (let w = 0; w < 6; w++) {
      await page.waitForTimeout(500)
      if (await toolbar.isVisible().catch(() => false)) break
    }
  }
  await expect(toolbar).toBeVisible({ timeout: 5000 })
  // 提交行已渲染（面板打开 ≠ 数据就绪）
  await expect(page.locator('.commit-item:visible').first()).toBeVisible({ timeout: 10000 })
}

async function enterProject(page: import('@playwright/test').Page, name: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: name }).first().click()
  await page.waitForURL('**/project')
  await openCommitsPanel(page)
}

test('>16 分支仓库：压缩注记出现 + 末道虚线容器道区分', async ({ page }) => {
  await enterProject(page, PROJ_CAP)

  // 注记可见且携带并入道数（20 分支拓扑 21 道上限 16 → 5 道并入末道；
  // 不锚死 5 以防 git log 排序在 git 版本间的边缘差异，只锚「有 N」形态；
  // toContainText 非全文相等——注记内嵌的 <title> hover 文案不计入）
  const note = page.locator('[data-testid="graph-lane-compressed"]')
  await expect(note).toBeVisible({ timeout: 5000 })
  await expect(note).toContainText(/拓扑已压缩：\d+ 泳道并入末道/)

  // 末道「容器道」虚线区分：普通泳道无此线，仅封顶生效时渲染
  const capLine = page.locator('[data-testid="graph-lane-cap-line"]')
  await expect(capLine).toBeVisible()
  await expect(capLine).toHaveAttribute('class', /bg-cap-lane/)

  // 悬停说明（②）：注记携带封顶语义与调整入口的 title
  const tip = await note.locator('title').textContent()
  expect(tip).toContain('泳道上限')

  // 提交行仍占主导（封顶的意义：行区宽度有界、列表可用）
  expect(await page.locator('.commit-item:visible').count()).toBeGreaterThan(0)
})

test('16 内小仓库：零注记零虚线（常规仓库零感）', async ({ page }) => {
  await enterProject(page, PROJ_SMALL)

  await expect(page.locator('[data-testid="graph-lane-compressed"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="graph-lane-cap-line"]')).toHaveCount(0)
  // 图形本体照常渲染
  await expect(page.locator('.commits-graph-rows svg circle').first()).toBeVisible({ timeout: 5000 })
})

test('外观档位切换 16→32 生效：保存后注记消失并落 localStorage', async ({ page }) => {
  await enterProject(page, PROJ_CAP)
  await expect(page.locator('[data-testid="graph-lane-compressed"]')).toBeVisible({ timeout: 5000 })

  // 设置 → 外观 → 提交拓扑泳道上限 → 32 → 保存
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  const laneRow = page.locator('[data-testid="settings-graph-lanes"]')
  await expect(laneRow).toBeVisible({ timeout: 3000 })

  // 默认 16 = 无「已修改」标记（出厂默认行零标记，P-20261003-171 惯例）
  await expect(laneRow.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)

  await laneRow.locator('.n-radio-button', { hasText: '32' }).click()
  await expect(laneRow.locator('[data-testid="settings-modified-mark"]')).toBeVisible()
  await page.locator('.settings-footer').getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })

  // 即时生效：20 道拓扑在 32 上限内完整绘制 → 无封顶 → 注记与虚线消失
  await expect(page.locator('[data-testid="graph-lane-compressed"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="graph-lane-cap-line"]')).toHaveCount(0)
  const stored = await page.evaluate(() => localStorage.getItem('graph-lane-settings'))
  expect(JSON.parse(stored || '{}')?.limit).toBe(32)
})
