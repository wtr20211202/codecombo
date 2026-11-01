import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件批量操作端点 E2E（P-20261006-39）：POST /api/projects/:id/files/batch
 * move/delete/rename 三形态单请求收口。纯 API 链路（agent 是 API 调用方，
 * agent-sensitive-write-guard 同款形态）：
 *   1. agent 令牌批量删除 3 文件 → 单审批卡（428 + approvalId，op「删除文件
 *      （批量 3 个）」）→ 零副作用（文件原样在盘）→ 用户裁决允许 → 携
 *      X-Approval-ID 重试放行 → 全删 + 逐条结果清单 results 全 ok
 *   2. 放行一次性：同 ID 二次重试重新 428（不重复执行删除面）
 *   3. 用户令牌（scl_）批量移动 3 文件一次调用全成 + 逐条结果（零审批打扰）
 * 环境敏感点同 agent-sensitive-write-guard.spec.ts：仓库放系统临时目录、
 * 服务端形态路径注册。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const REPO_DIR = path.join(process.env.TEMP || os.tmpdir(), 'sc-e2e-batch-files')
const PROJ_NAME = 'agent-batch-files-demo'

function git(cwd: string, args: string[], input?: string) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], {
    cwd, encoding: 'utf8', input,
  })
}

async function unlockHeaders(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''
let agentToken = ''

const probeNames = ['e2e-batch-a.md', 'e2e-batch-b.md', 'e2e-batch-c.md']
// 移动用例独立探针（与删除用例互不污染：test 1 会把 probeNames 删光）
const moveNames = ['e2e-batch-m1.md', 'e2e-batch-m2.md', 'e2e-batch-m3.md']
const agentHeaders = () => ({ 'Content-Type': 'application/json', 'X-Lock-Token': agentToken })
const batchURL = () => `${BASE}/api/projects/${projectId}/files/batch`

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const list = await (await request.get(`${BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_NAME) await request.delete(`${BASE}/api/projects/${p.id}`, { headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'batch files demo\n')
  for (const n of [...probeNames, ...moveNames]) fs.writeFileSync(path.join(REPO_DIR, n), `content of ${n}\n`)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'base'])

  const created = await request.post(`${BASE}/api/projects`, {
    headers,
    data: { name: PROJ_NAME, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  if (!projectId) throw new Error('project registration failed')

  // agent 令牌明文（管理面 reveal，单例播种语义）
  const revealed = await request.post(`${BASE}/api/agent-token/reveal`, { headers })
  expect(revealed.ok()).toBeTruthy()
  agentToken = ((await revealed.json()) as { data?: { token?: string } }).data?.token || ''
  expect(agentToken.startsWith('sca_'), 'agent token should be sca_ prefixed').toBeTruthy()
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await request.delete(`${BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 清账 pending 审批（agent-sensitive-write-guard 同纪律）：pending 是跨用例
 *  共享的服务端状态，每例收尾统一放行清账防泄漏到字母序紧随的审批族用例 */
async function cleanupPendingApprovals(request: import('@playwright/test').APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

test.afterEach(async ({ request }) => {
  await cleanupPendingApprovals(request)
})

test('agent 令牌批量删除 → 单审批卡 → 放行 → 全删 + 逐条结果清单', async ({ request }) => {
  // 首发请求 → 428 + approvalId，未删盘零副作用（3 个探针原样在盘）
  const first = await request.post(batchURL(), {
    headers: agentHeaders(),
    data: { action: 'delete', entries: probeNames },
  })
  expect(first.status()).toBe(428)
  const guard = (await first.json()) as { approvalId?: string; code?: string }
  expect(guard.approvalId, '428 body should carry approvalId').toBeTruthy()
  expect(guard.code).toBe('ops.approval_required')
  for (const n of probeNames) {
    expect(fs.existsSync(path.join(REPO_DIR, n)), `${n} should survive the 428`).toBeTruthy()
  }

  // 单审批卡：op 保既有「删除文件」前缀 + 批量形态注记（存量规则前缀匹配兼容）
  const uh = await unlockHeaders(request)
  const detail = await (await request.get(`${BASE}/api/ops-confirm/${guard.approvalId}`, { headers: uh })).json() as { data?: { op?: string; status?: string } }
  expect(detail.data?.status).toBe('pending')
  expect(detail.data?.op?.startsWith('删除文件')).toBeTruthy()
  expect(detail.data?.op).toContain('批量 3 个')

  // 用户裁决允许 → 携 X-Approval-ID 重试放行 → 全删 + 逐条结果全 ok
  const resolved = await request.post(`${BASE}/api/ops-confirm/${guard.approvalId}/resolve`, {
    headers: uh, data: { allow: true },
  })
  expect(resolved.ok()).toBeTruthy()
  const retry = await request.post(batchURL(), {
    headers: { ...agentHeaders(), 'X-Approval-ID': guard.approvalId! },
    data: { action: 'delete', entries: probeNames },
  })
  expect(retry.status()).toBe(200)
  const body = (await retry.json()) as {
    ok?: number; failed?: number
    results?: Array<{ path: string; status: string; error?: string }>
  }
  expect(body.ok).toBe(3)
  expect(body.failed).toBe(0)
  expect(body.results?.map(r => r.path).sort()).toEqual([...probeNames].sort())
  expect(body.results?.every(r => r.status === 'ok')).toBeTruthy()
  for (const n of probeNames) {
    expect(fs.existsSync(path.join(REPO_DIR, n)), `${n} should be deleted`).toBeFalsy()
  }

  // 一次性语义：同 ID 二次重试 → 已消费，重新 428（删除面不重复执行）
  const replay = await request.post(batchURL(), {
    headers: { ...agentHeaders(), 'X-Approval-ID': guard.approvalId! },
    data: { action: 'delete', entries: probeNames },
  })
  expect(replay.status()).toBe(428)
})

test('用户令牌批量移动 3 文件：一次调用全成 + 逐条结果（零审批）', async ({ request }) => {
  const uh = await unlockHeaders(request)
  // 目标目录先落位（move 形态目标目录须存在，与单条 rename 同语义）
  const mk = await request.post(`${BASE}/api/projects/${projectId}/file/mkdir`, {
    headers: uh, data: { path: 'e2e-batch-dest' },
  })
  expect(mk.ok()).toBeTruthy()

  const res = await request.post(batchURL(), {
    headers: uh,
    data: { action: 'move', entries: moveNames, destDir: 'e2e-batch-dest' },
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as {
    ok?: number; failed?: number
    results?: Array<{ path: string; status: string }>
  }
  expect(body.ok).toBe(3)
  expect(body.failed).toBe(0)
  expect(body.results?.every(r => r.status === 'ok')).toBeTruthy()
  // 单请求 N 条挪动：磁盘一次到位（叶子名保持，全部落进目标目录）
  for (const n of moveNames) {
    expect(fs.existsSync(path.join(REPO_DIR, 'e2e-batch-dest', n))).toBeTruthy()
    expect(fs.existsSync(path.join(REPO_DIR, n))).toBeFalsy()
  }

  // rename 形态走同一端点：批内逐对改名全成
  const rn = await request.post(batchURL(), {
    headers: uh,
    data: {
      action: 'rename',
      renames: [
        { oldPath: `e2e-batch-dest/${moveNames[0]}`, newPath: `e2e-batch-dest/e2e-batch-r1.md` },
        { oldPath: `e2e-batch-dest/${moveNames[1]}`, newPath: `e2e-batch-dest/e2e-batch-r2.md` },
      ],
    },
  })
  expect(rn.status()).toBe(200)
  const rnBody = (await rn.json()) as { ok?: number; failed?: number }
  expect(rnBody.ok).toBe(2)
  expect(rnBody.failed).toBe(0)
  expect(fs.existsSync(path.join(REPO_DIR, 'e2e-batch-dest', 'e2e-batch-r1.md'))).toBeTruthy()
})
