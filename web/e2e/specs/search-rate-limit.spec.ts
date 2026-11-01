import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 搜索端点限流 E2E（P-20261004-124）：
 * 内容搜索端点每查询起 rg/git grep 子进程，限流是子进程风暴防线——
 * 连打 31 次 → 前 30 次 200、第 31 次 429（稳定标记 search rate limited +
 * code search.rate_limited + retry_after 体字段 + Retry-After 头）→
 * 项目维度隔离（A 触限 B 不受扰）→ 窗口滑动自动恢复（轮询至 200）。
 * 纯 API 用例：限流是服务端行为，前端映射由 check:errmarkers 对账守门。
 * 自备临时仓库，afterAll 清理（范式与 search-projects 对称）。
 * 注：本 spec 只打 /projects/:id/search（key=项目 id，id 随注册即新，不污染
 * 其他 spec 的限流桶）；批量端点 /search/projects（key=IP）的 429 由 Go 单测
 * 覆盖，避免烧掉共享 IP 桶殃及同套件后续 spec。
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-search-rl-a')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-search-rl-b')
const PROJ_A = 'e2e-srl-a'
const PROJ_B = 'e2e-srl-b'

let projIdA = ''
let projIdB = ''

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

// unlock 头缓存：连打用例要发 31+ 次请求，逐次重解锁既浪费又可能撞锁端点
// 自身的失败计数面（成功不计数，但无谓放大请求面）；token 会话内有效
let cachedHeaders: Record<string, string> | null = null

async function unlockHeaders(): Promise<Record<string, string>> {
  if (cachedHeaders) return cachedHeaders
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  cachedHeaders = { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  return cachedHeaders
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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: 搜索限流基线'])
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
  makeRepo(REPO_A, { 'na.txt': 'needle alpha\n' })
  makeRepo(REPO_B, { 'nb.txt': 'needle gamma\n' })
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
})

async function searchProject(id: string): Promise<Response> {
  const headers = await unlockHeaders()
  return fetch(`${API_BASE}/api/projects/${id}/search?q=needle`, { headers })
}

test('连打超限：30 次放行 → 第 31 次 429 带稳定标记与 Retry-After', async () => {
  test.setTimeout(60_000)
  for (let i = 0; i < 30; i++) {
    const res = await searchProject(projIdA)
    if (res.status !== 200) {
      throw new Error(`search #${i + 1} status = ${res.status}, want 200 (budget should last)`)
    }
  }
  const limited = await searchProject(projIdA)
  expect(limited.status).toBe(429)
  // Retry-After 头（秒，窗口末前恒 >0、≤60）
  const raHeader = Number(limited.headers.get('retry-after'))
  expect(raHeader).toBeGreaterThanOrEqual(1)
  expect(raHeader).toBeLessThanOrEqual(60)
  const body = (await limited.json()) as { error?: string; code?: string; retry_after?: number }
  // 稳定标记（errmarkers.SearchRateLimited 对外契约）+ 结构化 code + retry_after 体字段
  expect(body.error).toBe('search rate limited')
  expect(body.code).toBe('search.rate_limited')
  expect(body.retry_after).toBeGreaterThanOrEqual(1)
  expect(body.retry_after).toBeLessThanOrEqual(60)
  // 限流窗口内持续 429
  expect((await searchProject(projIdA)).status).toBe(429)
})

test('项目维度隔离：A 触限不拖累 B', async () => {
  const res = await searchProject(projIdB)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data?: unknown[] }
  expect((body.data || []).length).toBeGreaterThanOrEqual(1)
})

test('窗口滑动自动恢复：轮询至 200（最长 ~70s）', async () => {
  test.setTimeout(120_000)
  // 前一用例已把 A 打到 429：窗口滑动后同 key 恢复 200
  await expect.poll(async () => (await searchProject(projIdA)).status, {
    timeout: 75_000,
    intervals: [2_000, 2_000, 2_000, 5_000],
  }).toBe(200)
})
