import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * 变更面板会话归属标注与过滤 E2E（P-20261003-22）：
 *   1. agent 会话（cwd=项目根）产出过的文件 → 变更行出现紫色点标，tooltip 列
 *      运行时/会话数；「仅 Agent / 仅人工」二态按 marks 命中与否切分，且与
 *      路径过滤框叠加（AND）。
 *   2. 无 marks（会话 cwd≠项目根，归属边界收紧语义）时二态不过滤——不产生
 *      误导性空态。
 * agent 会话经 API 直建 kind=agent + runtime=shell（一等选项：纯终端会话，
 * 免装真实智能体 CLI，产物归属链与 claude 会话完全同源——startHead..工作区
 * diff + untracked）。自备临时仓库，afterAll 清理（与 changes-filter 对称）。
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-changes-marks-a')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-changes-marks-b')
// 会话 B 的工作目录：故意不是任何项目根——验证 cwd≠项目根的会话不参与归属
const SCRATCH_DIR = path.join(os.tmpdir(), 'sc-e2e-changes-marks-cwd')
const PROJ_A = 'e2e-changes-marks'
const PROJ_B = 'e2e-changes-marks-offcwd'
const README = 'readme-marks.md'
const AGENT_NEW = 'agent-output.txt'
const HUMAN_B1 = 'human-alpha.txt'
const HUMAN_B2 = 'human-beta.txt'
const SESSION_A = 'marks-agent-a'
const SESSION_B = 'marks-agent-b'

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

// API 直建 agent 会话统一走共享层 createAgentSessionApi（e2e-api，P-20261004-48）

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

test.beforeAll(async ({ request }) => {
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

  // —— 项目 A：agent 会话（cwd=仓库根）产出两个文件 → 徽标 + 二态切分 ——
  initRepo(REPO_A)
  fs.writeFileSync(path.join(REPO_A, README), 'agent marks baseline\n')
  git(REPO_A, ['add', '.'])
  git(REPO_A, ['commit', '-m', 'root: 归属标注基线'])
  projectIdA = await registerProject(headers, PROJ_A, REPO_A)
  const sessionAId = (await createAgentSessionApi(request, { name: SESSION_A, dir: REPO_A })).id
  await waitActivityBaseline(headers, sessionAId)
  // 基线就位后再写 agent 产出：新文件（untracked 走 ls-files）+ 改已跟踪文件
  //（走 diff startHead..工作区）——两条产物路径各验一条
  fs.writeFileSync(path.join(REPO_A, AGENT_NEW), `${AGENT_NEW} by agent session\n`)
  fs.appendFileSync(path.join(REPO_A, README), 'appended by agent session\n')

  // —— 项目 B：变更存在，但唯一会话 cwd≠项目根 → marks 空 → 二态不过滤 ——
  initRepo(REPO_B)
  fs.writeFileSync(path.join(REPO_B, README), 'offcwd baseline\n')
  git(REPO_B, ['add', '.'])
  git(REPO_B, ['commit', '-m', 'root: 归属边界基线'])
  fs.writeFileSync(path.join(REPO_B, HUMAN_B1), `${HUMAN_B1} content\n`)
  fs.writeFileSync(path.join(REPO_B, HUMAN_B2), `${HUMAN_B2} content\n`)
  projectIdB = await registerProject(headers, PROJ_B, REPO_B)
  await createAgentSessionApi(request, { name: SESSION_B, dir: SCRATCH_DIR })
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

/** rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

async function enterProject(page: import('@playwright/test').Page, projectName: string, waitForFile: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: projectName }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: waitForFile })).toBeVisible({ timeout: 15000 })
}

/** 变更列表头部的即时过滤输入框（placeholder 部分匹配，规避省略号字形差异） */
function filterInput(page: import('@playwright/test').Page) {
  return page.locator('.commit-panel input[placeholder*="过滤变更"]')
}

test('agent 产出变更行徽标+tooltip，二态过滤按 marks 切分并与路径过滤叠加', async ({ page }) => {
  test.setTimeout(90000)
  await enterProject(page, PROJ_A, README)
  const panel = page.locator('.commit-panel')

  // 徽标：marks 异步到达（面板侧引导拉会话列表 → 3s 防抖 → activity 聚合），
  // 两个 agent 产出文件各一枚点标
  const dots = panel.locator('[data-testid="cp-agent-dot"]')
  await expect(dots).toHaveCount(2, { timeout: 20000 })

  // tooltip：会话数 + 归属边界注记。runtime 自 P-20261003-238 起随 GET /terminals
  // 快照下发（applySessionMetaSnapshot 服务端 meta 一读同携）——面板侧归属聚合
  // 可直接解析出创建时的 runtime（本例 API 直建时显式 runtime:'shell'），不再
  // 「未知运行时」降级（fulle2e run7 实测形态，spec 期望随产品演化更新）
  const readmeDot = panel.locator('.cp-node').filter({ hasText: README }).locator('[data-testid="cp-agent-dot"]')
  await expect(readmeDot).toHaveAttribute('title', /shell · 1 个会话/)
  await expect(readmeDot).toHaveAttribute('title', /仅统计工作目录为项目根的会话/)

  // 仅 Agent：marks 命中的两行保留，n/总数 计数出现
  await panel.locator('[data-testid="cp-agent-filter-agent"]').click()
  await expect(panel.locator('[data-testid="cp-agent-filter-agent"]')).toHaveClass(/active/)
  await expect(panel.locator('.cp-filter-count')).toHaveText('2/2')
  await expect(panel.locator('.cp-node').filter({ hasText: AGENT_NEW })).toBeVisible()

  // 仅人工：切换互斥（仅 Agent 熄灭）；marks 全命中 → 无剩余行 + 无命中提示
  await panel.locator('[data-testid="cp-agent-filter-human"]').click()
  await expect(panel.locator('[data-testid="cp-agent-filter-human"]')).toHaveClass(/active/)
  await expect(panel.locator('[data-testid="cp-agent-filter-agent"]')).not.toHaveClass(/active/)
  await expect(panel.locator('.cp-node')).toHaveCount(0)
  await expect(panel.locator('.cp-no-match')).toBeVisible()

  // 再点取消：恢复全量两行
  await panel.locator('[data-testid="cp-agent-filter-human"]').click()
  await expect(panel.locator('[data-testid="cp-agent-filter-human"]')).not.toHaveClass(/active/)
  await expect(panel.locator('.cp-node').filter({ hasText: README })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: AGENT_NEW })).toBeVisible()

  // 与 P-142 路径过滤叠加：AND，各筛各的维度（路径 readme ∩ 人工 = ∅；
  // 路径 readme ∩ agent = README 行）
  await filterInput(page).fill('readme')
  await expect(panel.locator('.cp-filter-count')).toHaveText('1/2')
  await panel.locator('[data-testid="cp-agent-filter-human"]').click()
  await expect(panel.locator('.cp-no-match')).toBeVisible()
  await panel.locator('[data-testid="cp-agent-filter-agent"]').click()
  await expect(panel.locator('.cp-node').filter({ hasText: README })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: AGENT_NEW })).toHaveCount(0)
  // 收尾复原（全量视图），防虚拟列表残留影响断言可读性
  await panel.locator('[data-testid="cp-agent-filter-agent"]').click()
  await filterInput(page).fill('')
  await expect(panel.locator('.cp-node').filter({ hasText: AGENT_NEW })).toBeVisible()
})

test('无 marks（唯一会话 cwd≠项目根）时二态不过滤：归属边界收紧语义', async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page, PROJ_B, HUMAN_B1)
  const panel = page.locator('.commit-panel')

  // 等 marks 判定窗口走完（会话列表引导拉取 + 3s 防抖 + activity 聚合）：
  // cwd≠项目根的会话不参与归属——两行始终无点标（窗口给足：实现若误把
  // 非 cwd 会话算进归属，点标最迟 ~5s 出现，6s 窗口必现形）
  await page.waitForTimeout(6000)
  await expect(panel.locator('[data-testid="cp-agent-dot"]')).toHaveCount(0)

  // 仅 Agent：marks 空 → 不过滤，两行俱在（不产生误导性空态）
  await panel.locator('[data-testid="cp-agent-filter-agent"]').click()
  await expect(panel.locator('.cp-node').filter({ hasText: HUMAN_B1 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: HUMAN_B2 })).toBeVisible()
  await expect(panel.locator('.cp-no-match')).toHaveCount(0)

  // 仅人工：同样不过滤
  await panel.locator('[data-testid="cp-agent-filter-human"]').click()
  await expect(panel.locator('.cp-node').filter({ hasText: HUMAN_B1 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: HUMAN_B2 })).toBeVisible()
  await expect(panel.locator('.cp-no-match')).toHaveCount(0)
})
