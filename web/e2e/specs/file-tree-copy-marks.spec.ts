import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件树一键复制 agent 改动清单 E2E（P-20261003-52）：
 *   1. agent 会话（cwd=项目根）改 2 个文件 → 树头部「复制改动清单」可用，
 *      点击后剪贴板为 markdown 行式清单（- path (runtime)，目录排序，
 *      归属边界同 marks：仅 cwd=项目根会话）。
 *   2. 无 marks（唯一会话 cwd≠项目根）时按钮禁用态（可发现不可点）。
 * 会话播种与 changes-agent-marks.spec.ts 同源：API 直建 kind=agent +
 * runtime=shell（一等选项，免装真实智能体 CLI）；runtime 标注自
 * P-20261003-238 起经 GET /terminals 快照解析为创建时的 shell（不再降级
 * 「未知运行时」）。自备临时仓库，afterAll 清理。
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-ft-copy-marks-a')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-ft-copy-marks-b')
// 会话 B 的工作目录：故意不是任何项目根——cwd≠项目根不参与归属（useAgentMarks 收口）
const SCRATCH_DIR = path.join(os.tmpdir(), 'sc-e2e-ft-copy-marks-cwd')
const PROJ_A = 'e2e-ft-copy-marks'
const PROJ_B = 'e2e-ft-copy-marks-nomarks'
const README = 'readme-marks.md'
// 子目录 untracked：目录分组排序 + marks 不依赖树展开（未展开子目录文件也在清单）
const NESTED = 'notes/agent-notes.txt'
const SESSION_A = 'ft-copy-marks-agent-a'
const SESSION_B = 'ft-copy-marks-agent-b'
const COPY_BTN = '[data-testid="ft-copy-marks"]'

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

function initRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir }) // 双路径：Windows 服务端 git 也不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
}

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  const id = body.data?.id || ''
  expect(id).not.toBe('')
  return id
}

/** 经 API 直建 agent 会话（runtime=shell 一等选项，确定性可跑） */
async function createAgentSession(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/terminals`, {
    method: 'POST', headers, body: JSON.stringify({ kind: 'agent', name, runtime: 'shell', dir: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  const id = body.data?.id || ''
  expect(id).not.toBe('')
  return id
}

/** 等会话产出基线落库（saveAgentSessionMeta 异步）：startHead 就位后写入的
 *  文件才确定落在 diff 窗口内——先等基线再写 agent 文件，消除竞态 */
async function waitActivityBaseline(headers: Record<string, string>, id: string): Promise<void> {
  const deadline = Date.now() + 15000
  for (;;) {
    try {
      const res = await fetch(`${API_BASE}/api/terminals/${id}/activity`, { headers })
      if (res.ok) {
        const body = (await res.json()) as { data?: { baseline?: boolean } }
        if (body.data?.baseline === true) return
      }
    } catch { /* 轮询忽略 */ }
    if (Date.now() > deadline) throw new Error(`activity baseline not ready in 15s (session ${id})`)
    await new Promise(r => setTimeout(r, 300))
  }
}

let projectIdA = ''
let projectIdB = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名/会话名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_A || p.name === PROJ_B) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  const terms = await (await fetch(`${API_BASE}/api/terminals`, { headers })).json()
  for (const s of ((terms?.data || []) as { id: string; name: string }[])) {
    if (s.name === SESSION_A || s.name === SESSION_B) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
  for (const dir of [REPO_A, REPO_B, SCRATCH_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  fs.mkdirSync(SCRATCH_DIR, { recursive: true })

  // —— 项目 A：agent 会话（cwd=仓库根）改两个文件（子目录 untracked + 根 tracked）——
  initRepo(REPO_A)
  fs.writeFileSync(path.join(REPO_A, README), 'ft copy marks baseline\n')
  git(REPO_A, ['add', '.'])
  git(REPO_A, ['commit', '-m', 'root: 复制改动清单基线'])
  projectIdA = await registerProject(headers, PROJ_A, REPO_A)
  const sessionAId = await createAgentSession(headers, SESSION_A, REPO_A)
  await waitActivityBaseline(headers, sessionAId)
  fs.mkdirSync(path.join(REPO_A, 'notes'), { recursive: true })
  fs.writeFileSync(path.join(REPO_A, NESTED), 'nested agent output\n')
  fs.appendFileSync(path.join(REPO_A, README), 'appended by agent session\n')

  // —— 项目 B：唯一会话 cwd≠项目根 → marks 空 → 按钮禁用 ——
  initRepo(REPO_B)
  fs.writeFileSync(path.join(REPO_B, 'readme.md'), 'nomarks baseline\n')
  git(REPO_B, ['add', '.'])
  git(REPO_B, ['commit', '-m', 'root: 归属边界基线'])
  fs.writeFileSync(path.join(REPO_B, 'human.txt'), 'human content\n')
  projectIdB = await registerProject(headers, PROJ_B, REPO_B)
  await createAgentSession(headers, SESSION_B, SCRATCH_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  for (const id of [projectIdA, projectIdB]) {
    if (id) await fetch(`${API_BASE}/api/projects/${id}`, { method: 'DELETE', headers })
  }
  const terms = await (await fetch(`${API_BASE}/api/terminals`, { headers })).json()
  for (const s of ((terms?.data || []) as { id: string; name: string }[])) {
    if (s.name === SESSION_A || s.name === SESSION_B) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
  for (const dir of [REPO_A, REPO_B, SCRATCH_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  // uiState 归零收尾（防布局恢复污染后续 spec）
  const token = headers['X-Lock-Token']
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** rail「变更」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到可见；
 *  CommitPanel 挂载侧有 sessions store 引导拉取（loaded 幂等）——marks 前置条件 */
async function openCommitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-changes"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

/** rail「文件」同样 toggle 语义 → 循环归一化到文件树可见 */
async function openFilesPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree').isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.file-tree').isVisible()).toBe(true)
}

async function enterProject(page: import('@playwright/test').Page, projectName: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: projectName }).first().click()
  await page.waitForURL('**/project')
}

test('agent 改 2 文件 → 复制改动清单：剪贴板两行 markdown（目录排序 + runtime 标注）', async ({ page }) => {
  test.setTimeout(90000)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await enterProject(page, PROJ_A)

  // CommitPanel 引导拉取 sessions store（FileTreeView 无独立拉取点，marks 消费
  // 同一 store）→ 切回文件树，FileTreeView 挂载即触发 marks 刷新链
  await openCommitPanel(page)
  await openFilesPanel(page)

  // marks 异步到达（3s 防抖 + activity 聚合）：README 打上 agent 点标即信号
  const readmeDot = page.locator('.tree-item').filter({ hasText: README }).locator('.item-agent-dot')
  await expect(readmeDot).toHaveCount(1, { timeout: 20000 })

  // 按钮可用（marks 非空）→ 点击 → 成功 toast
  const btn = page.locator(COPY_BTN)
  await expect(btn).toBeEnabled()
  await btn.click()
  await expect(page.locator('.n-message').filter({ hasText: '改动清单已复制' })).toBeVisible({ timeout: 5000 })

  // 剪贴板 = 两行 markdown 清单，目录序（notes/… 在 readme-marks.md 前）；
  // runtime 标注：自 P-20261003-238 起 GET /terminals 快照携 runtime
  //（applySessionMetaSnapshot 服务端 meta 一读同携），归属链解析出创建时的
  // shell，不再「未知运行时」降级（fulle2e run7 实测形态，spec 期望随产品演化更新）
  const clip = await page.evaluate(() => navigator.clipboard.readText()).then(s => s.replace(/\r\n/g, '\n'))
  const lineNested = `- ${NESTED} (shell)`
  const lineReadme = `- ${README} (shell)`
  expect(clip).toContain(lineNested)
  expect(clip).toContain(lineReadme)
  expect(clip.indexOf(lineNested)).toBeLessThan(clip.indexOf(lineReadme))
  const lines = clip.split('\n').filter(l => l.trim() !== '')
  expect(lines).toHaveLength(2)
})

test('无 marks（唯一会话 cwd≠项目根）时按钮禁用：不产生可点空转入口', async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page, PROJ_B)
  await openCommitPanel(page)
  await openFilesPanel(page)

  // 等 marks 判定窗口走完（会话列表已拉 + 3s 防抖 + activity 聚合）：
  // cwd≠项目根的会话不参与归属——树内无点标（窗口给足，误归属实现最迟 ~5s 现形）
  await page.waitForTimeout(6000)
  await expect(page.locator('.item-agent-dot')).toHaveCount(0)

  // 按钮保持禁用态（可发现不可点），点击无副作用
  const btn = page.locator(COPY_BTN)
  await expect(btn).toBeDisabled()
})
