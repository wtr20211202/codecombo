import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 一键全部拉取 E2E（P-20261002-41）：
 * 三个项目：两个以本地 bare 为 origin 的 git 仓库（各被「队友」推进一步）+
 * 一个 origin 指向已删 bare 的死远端仓库。首页工具栏「全部拉取」→
 *   1. 部分失败 toast 摘要（成功 2 · 失败 1）
 *   2. 通知中心逐项结果：✓ A、✓ B、✗ C（含原因）——失败隔离不拖垮其余
 *   3. 项目卡 behind 徽章出现（fetch 真实带回远端提交，非纸面成功）
 * 另覆盖批量端点 API 契约（逐项 ok/error 字段）。自备临时仓库，afterAll
 * 清理（范式同 search-projects）。
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-fetchall-a')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-fetchall-b')
const REPO_C = path.join(os.tmpdir(), 'sc-e2e-fetchall-c')
const BARE_A = path.join(os.tmpdir(), 'sc-e2e-fetchall-bare-a')
const BARE_B = path.join(os.tmpdir(), 'sc-e2e-fetchall-bare-b')
const BARE_C = path.join(os.tmpdir(), 'sc-e2e-fetchall-bare-c')
const PROJ_A = 'e2e-fa-a'
const PROJ_B = 'e2e-fa-b'
const PROJ_C = 'e2e-fa-c'

let projIdA = ''
let projIdB = ''
let projIdC = ''

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

/** makeRepoWithBare：bare + clone 工作区（已设 upstream），可再挂「队友」提交 */
function makeRepoWithBare(work: string, bare: string) {
  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  fs.mkdirSync(work, { recursive: true })
  execFileSync('git', ['clone', bare, work], { stdio: 'ignore' })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: work }) // 双路径：Windows 服务端 git 也不 smudge
  git(work, ['commit', '--allow-empty', '-m', 'root: 全部拉取基线'])
  git(work, ['push', '-u', 'origin', 'main'])
  // origin URL 改写为服务端形态（P-20261005-187）：UI「全部拉取」由服务端 git
  // 执行，Windows 形态路径跨拓扑不可解析（C 的 origin 随 bare 删除同形失效，
  // 失败样本语义不变）；测试侧播种/断言用 bare 原形态不受影响
  git(work, ['remote', 'set-url', 'origin', serverPath(bare)])
}

/** teammatePush：从 bare clone 种子仓推进一步，模拟队友的新提交 */
function teammatePush(bare: string) {
  const seed = `${bare}-seed`
  fs.rmSync(seed, { recursive: true, force: true })
  execFileSync('git', ['clone', bare, seed], { stdio: 'ignore' })
  fs.writeFileSync(path.join(seed, 'morning.txt'), `teammate ${Date.now()}\n`)
  git(seed, ['add', '.'])
  git(seed, ['commit', '-m', 'teammate: 晨间新提交'])
  git(seed, ['push'])
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if ([PROJ_A, PROJ_B, PROJ_C].includes(p.name)) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [REPO_A, REPO_B, REPO_C, BARE_A, BARE_B, BARE_C]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  makeRepoWithBare(REPO_A, BARE_A)
  makeRepoWithBare(REPO_B, BARE_B)
  makeRepoWithBare(REPO_C, BARE_C)
  // C 的 origin 指向已删 bare：批量拉取的逐项失败样本（网络类错误，隔离验证）
  fs.rmSync(BARE_C, { recursive: true, force: true })
  // 队友提交由 UI 用例开头自推（重试幂等：每次尝试推一步新提交，保证
  // 「拉取前 behind=0 → 拉取后 behind=1」的基线在重试时同样成立）
  projIdA = await registerProject(headers, PROJ_A, REPO_A)
  projIdB = await registerProject(headers, PROJ_B, REPO_B)
  projIdC = await registerProject(headers, PROJ_C, REPO_C)
  expect(projIdA).toBeTruthy()
  expect(projIdB).toBeTruthy()
  expect(projIdC).toBeTruthy()
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if ([PROJ_A, PROJ_B, PROJ_C].includes(p.name)) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  for (const dir of [REPO_A, REPO_B, REPO_C, BARE_A, BARE_B, BARE_C]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test('首页全部拉取：部分失败 toast 摘要 + 通知中心逐项结果 + behind 徽章出现', async ({ page }) => {
  // 重试幂等前置：上次尝试可能已 fetch 过（tracking 前移 → behind 徽章已在、
  // 远端无新提交 → 「拉取前无徽章/拉取后 behind=1」双断言永假）。夹具仓库
  // 归一：再推一步队友提交 + 工作区 reset 到 tracking，恢复「拉取前 behind=0」
  // 基线（仓库为本 spec 自备夹具，reset 只动本地分支与工作区）
  teammatePush(BARE_A)
  teammatePush(BARE_B)
  git(REPO_A, ['reset', '--hard', 'origin/main'])
  git(REPO_B, ['reset', '--hard', 'origin/main'])

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  // 拉取前：A/B 的 tracking ref 停在旧提交，behind 徽章不出现
  await expect(page.locator('.project-card').filter({ hasText: PROJ_A }).locator('.badge-behind')).toHaveCount(0, { timeout: 8000 })

  // 首页工具栏「全部拉取」→ 进行态按钮 → 完成后部分失败摘要
  //（实例上还有播种项目，成功数随实例状态浮动，不断言具体成功数）
  const btn = page.locator('.toolbar-fetch-all')
  await expect(btn).toBeVisible({ timeout: 8000 })
  await btn.click()
  await expect(
    page.locator('.n-message').filter({ hasText: '部分拉取失败' }).filter({ hasText: '失败 1' }),
  ).toBeVisible({ timeout: 15000 })

  // 通知中心逐项结果：✓ A、✓ B、✗ C（含原因）——逐项报告而非整批成败
  await page.locator('.home-action-btn[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const body = page.locator('.nc-item-body', { hasText: PROJ_A })
  await expect(body).toHaveCount(1, { timeout: 8000 })
  await expect(body).toContainText(`✓ ${PROJ_A}`)
  await expect(body).toContainText(`✓ ${PROJ_B}`)
  await expect(body).toContainText(`✗ ${PROJ_C}`)

  // fetch 真实生效：A 卡片 behind 徽章出现（队友的提交已被拉回到本地 tracking ref）
  await expect(
    page.locator('.project-card').filter({ hasText: PROJ_A }).locator('.badge-behind'),
  ).toHaveText('1', { timeout: 8000 })
})

test('批量端点契约：逐项 ok/error 字段 + 失败隔离（API）', async ({ page }) => {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/fetch-all`, { method: 'POST', headers })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    data?: Array<{ projectId: string; name?: string; ok?: boolean; error?: string }>
  }
  const items = body.data || []
  // 批量作用于全部注册项目（含实例播种项目），只按 id 圈定本 spec 的三项
  const mine = items.filter(i => [projIdA, projIdB, projIdC].includes(i.projectId))
  expect(mine).toHaveLength(3)
  const byId = new Map(mine.map(i => [i.projectId, i]))
  // A/B 成功无错误标记
  expect(byId.get(projIdA)?.ok).toBe(true)
  expect(byId.get(projIdA)?.error || '').toBe('')
  expect(byId.get(projIdB)?.ok).toBe(true)
  // C 死远端：逐项失败标记，且失败隔离 = C 的失败不拖垮本 spec 的其余项目
  //（失败集按本 spec 三项圈定：批量端点作用于全部注册项目，其余项目的健康
  // 状况属共享实例的全局状态——前序 spec 遗留的失效项目不在本契约内）
  expect(byId.get(projIdC)?.ok).toBe(false)
  expect((byId.get(projIdC)?.error || '').length).toBeGreaterThan(0)
  const mineFailed = mine.filter(i => !i.ok)
  expect(mineFailed).toHaveLength(1)
  expect(mineFailed[0]?.projectId).toBe(projIdC)
})
