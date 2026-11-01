import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath, serverIsRemote } from '../../tests/dualpath'

/**
 * blame 悬停溯源区 E2E（P-20261007-11 变更的会话溯源）：
 *   1. 悬停 blame 徽标 → 摘要卡溯源区列出「该时段活跃会话（n）」（同窗并行
 *      会话全部列出=诚实边界），点条目直达回放弹层并定位到提交时刻前最近一步
 *   2. 悬停另一提交（时刻在全部会话窗口外）→ 溯源区零命中空态（诚实缺失不猜）
 * 数据面：临时 git 仓库两次提交（author date 显式钉死：c1=now-2h、c2=now-1h）
 * + 项目目录下播种两份 transcript（时间窗 [c2-30min, c2+10min]，mtime 控制
 * activeWindow 外），会话标题标记 [e2e-bt]，afterAll 精确清理（范式与
 * blame-hover / approval-replay 对称）。同机拓扑限定（transcript 夹具在
 * 测试侧 homedir，跨拓扑 skip，与 approval-replay 同款门控）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-blame-trace')
const PROJ = 'e2e-blame-trace'
const LIB = 'src/lib.ts'
const MARK = '[e2e-bt]'
const SESSION_A = 'e2e-bt-a1b2c3d4-e5f6'
const SESSION_B = 'e2e-bt-b2c3d4e5-f6a7'

let projectId = ''
let c1 = ''
let c2 = ''

function git(cwd: string, args: string[], dates?: { author: string; committer: string }) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], {
    cwd,
    encoding: 'utf8',
    ...(dates ? { env: { ...process.env, GIT_AUTHOR_DATE: dates.author, GIT_COMMITTER_DATE: dates.committer } } : {}),
  }).trim()
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

function writeFile(rel: string, content: string) {
  const p = path.join(REPO_DIR, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

/** 播种一份 transcript：4 条用户步围绕 c2 提交时刻分布（-30/-5/+5/+10 分钟），
 *  cwd=注册项目路径，mtime 控制 activeWindow(5 分钟) 外—— blame 悬停溯源区
 *  与回放 focusAt 定位共用此窗口 */
function seedTranscript(projPathServer: string, sessionId: string, c2Time: Date, title: string) {
  const claudeDir = path.join(
    os.homedir(), '.claude', 'projects', projPathServer.replace(/[\\/]/g, '-').replace(':', '-'),
  )
  fs.mkdirSync(claudeDir, { recursive: true })
  const file = path.join(claudeDir, `${sessionId}.jsonl`)
  const offsetsMin = [-30, -5, 5, 10]
  const lines = [`{"type":"last-prompt","sessionId":"${sessionId}"}`]
  for (let i = 0; i < offsetsMin.length; i++) {
    const at = new Date(c2Time.getTime() + offsetsMin[i]! * 60_000).toISOString()
    lines.push(JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: `${title} 溯源步骤 ${i}` },
      timestamp: at, cwd: projPathServer, sessionId,
    }))
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  const quiet = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, quiet, quiet)
  return file
}

function fixturePaths(): string[] {
  const claudeDir = path.join(
    os.homedir(), '.claude', 'projects', serverPath(REPO_DIR).replace(/[\\/]/g, '-').replace(':', '-'),
  )
  return [SESSION_A, SESSION_B].map(id => path.join(claudeDir, `${id}.jsonl`))
}

test.skip(serverIsRemote, 'claude transcript 夹具在测试侧 homedir，跨拓扑服务端不可见——仅同机拓扑')

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
  execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'])
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'])

  // 两次提交 author date 显式钉死：c1=now-2h（窗口外，空态用例）、c2=now-1h
  //（窗口内，命中用例）——transcript 时间窗据此确定性设计
  const now = Date.now()
  const d1 = new Date(now - 2 * 60 * 60_000)
  const d2 = new Date(now - 1 * 60 * 60_000)
  const isoGit = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '+00:00')

  writeFile(LIB, 'export function add(a: number, b: number): number {\n  return a + b\n}\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: init library'], { author: isoGit(d1), committer: isoGit(d1) })
  c1 = git(REPO_DIR, ['rev-parse', 'HEAD'])

  writeFile(LIB, 'export function add2(a: number, b: number): number {\n  return a + b\n}\nexport function sub(a: number, b: number): number {\n  return a - b\n}\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: add2 rename + sub'], { author: isoGit(d2), committer: isoGit(d2) })
  c2 = git(REPO_DIR, ['rev-parse', 'HEAD'])

  projectId = await registerProject(headers, PROJ, REPO_DIR)
  // 两份并行会话同窗（诚实边界：并行会话全部列出）
  seedTranscript(serverPath(REPO_DIR), SESSION_A, d2, `${MARK} 会话甲`)
  seedTranscript(serverPath(REPO_DIR), SESSION_B, d2, `${MARK} 会话乙`)
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
  if (!process.env.SC_KEEP_FIXTURES) {
    for (const f of fixturePaths()) {
      try { fs.unlinkSync(f) } catch { /* already gone */ }
    }
    try {
      fs.rmdirSync(path.dirname(fixturePaths()[0]!))
    } catch { /* non-empty or gone */ }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 进项目开 Git 提交面板 → 选中 c2 → 右键 lib.ts「在编辑器中打开」 */
async function openLibInEditor(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.commit-item').filter({ hasText: c2.slice(0, 8) }).first()
    .locator('.commit-meta').click()
  await expect(page.locator('.commits-right .diff-node').first()).toBeVisible({ timeout: 5000 })
  await page.locator('.commits-right .diff-node').filter({ hasText: 'lib.ts' }).first()
    .click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('在编辑器中打开', { exact: true }).click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 10000 })
}

function blameSpans(page: import('@playwright/test').Page) {
  return page.locator('.monaco-editor span.sc-blame-ref')
}

test('悬停窗口内提交：溯源区列出并行会话，点击直达回放并定位提交时刻', async ({ page }) => {
  test.setTimeout(90000)
  await openLibInEditor(page)

  await page.locator('.blame-toggle-btn').click()
  const spans = blameSpans(page)
  const c2Span = spans.filter({ hasText: c2.slice(0, 8) }).first()
  await expect(c2Span).toBeVisible({ timeout: 10000 })

  // 悬停 c2 徽标 → 摘要卡 + 溯源区：两份并行会话全部列出（诚实边界），
  // 标题计数与条目齐备
  await c2Span.hover()
  const pop = page.locator('[data-testid="blame-pop"]')
  await expect(pop).toBeVisible({ timeout: 3000 })
  const trace = page.locator('[data-testid="blame-trace"]')
  await expect(trace).toContainText('该时段活跃会话（2）', { timeout: 10000 })
  await expect(trace.locator('[data-testid="blame-trace-item"]')).toHaveCount(2)
  await expect(trace).toContainText(`${MARK} 会话甲`)
  // 诚实边界注记恒显
  await expect(trace).toContainText('非因果确证')

  // 点击条目 → 回放弹层直达，定位到「最近早于提交时刻」的一步
  // （步骤时刻 -30/-5/+5/+10 分钟 → 提交时刻前最近 = 步骤 1）
  await trace.locator('[data-testid="blame-trace-item"]').first().click()
  const modal = page.locator('.n-modal .cstl-root')
  await expect(modal).toBeVisible({ timeout: 15000 })
  const focus = modal.locator('.cstl-step.is-focus')
  await expect(focus).toHaveCount(1, { timeout: 15000 })
  await expect(focus).toContainText('溯源步骤 1')
})

test('悬停窗口外提交：溯源区零命中空态（诚实缺失不猜）', async ({ page }) => {
  test.setTimeout(90000)
  await openLibInEditor(page)

  await page.locator('.blame-toggle-btn').click()
  const spans = blameSpans(page)
  const c1Span = spans.filter({ hasText: c1.slice(0, 8) }).first()
  await expect(c1Span).toBeVisible({ timeout: 10000 })

  // c1 时刻（now-2h）早于全部会话窗口起点（c2-30min=now-90min）→ 零命中空态
  await c1Span.hover()
  const pop = page.locator('[data-testid="blame-pop"]')
  await expect(pop).toBeVisible({ timeout: 3000 })
  await expect(pop).toContainText('c1: init library')
  const trace = page.locator('[data-testid="blame-trace"]')
  await expect(trace).toBeVisible({ timeout: 10000 })
  await expect(trace.locator('[data-testid="blame-trace-empty"]')).toContainText('没有在跑的 AI 会话')
  await expect(trace.locator('[data-testid="blame-trace-item"]')).toHaveCount(0)
})
