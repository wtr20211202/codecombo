import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * guarded 审批卡服务端 impact 自动填充 E2E（P-20261006-35）——纯 API 链路
 * （agent 是 API 调用方，无前端页面；agent-sensitive-write-guard 同款形态）：
 *   1. agent 令牌 DELETE /api/projects/:id（guardedRoutes 删除项目）→ 428 +
 *      approvalId，审批自动填充结构化影响面：轮询 GET /api/ops-confirm/:id
 *      响应 data.impact = {kind:"delete", summary:"将终止该项目 N 个终端会话"}
 *      ——N 与该项目现存终端会话数一致（DeleteProject 级联关闭同源判定）
 *   2. Summary 随 Accept-Language 双语：zh 系中文 / 缺省英文
 * 审批卡徽标行渲染本身由 approval-impact.spec.ts 覆盖（agent 自附路径同卡面
 * 数据源）；本 spec 验服务端拦截路径的填充、轮询可见性与计数口径。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const REPO_DIR = path.join(process.env.TEMP || os.tmpdir(), 'sc-e2e-guard-impact')
const PROJ_NAME = 'approval-guard-impact-demo'

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

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const list = await (await request.get(`${BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_NAME) await request.delete(`${BASE}/api/projects/${p.id}`, { headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'guard impact demo\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'base'])

  const created = await request.post(`${BASE}/api/projects`, {
    headers,
    data: { name: PROJ_NAME, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  if (!projectId) throw new Error('project registration failed')

  // 项目绑定终端会话 ×1（kind=shell 项目会话）：删除项目将级联终止它——
  // 影响面计数的锚点。afterAll 删项目时服务端级联关闭，无需单独清理
  const term = await request.post(`${BASE}/api/terminals`, {
    headers, data: { name: 'guard-impact-session', projectId, kind: 'shell' },
  })
  expect(term.ok(), `terminal create failed: ${term.status()}`).toBeTruthy()

  // agent 令牌明文（管理面 reveal，单例播种语义）
  const revealed = await request.post(`${BASE}/api/agent-token/reveal`, { headers })
  expect(revealed.ok()).toBeTruthy()
  agentToken = ((await revealed.json()) as { data?: { token?: string } }).data?.token || ''
  expect(agentToken.startsWith('sca_'), 'agent token should be sca_ prefixed').toBeTruthy()
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  // 用户令牌删项目：不走审批面，顺带级联关闭上面建的终端会话
  if (projectId) await request.delete(`${BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 清账 pending 审批（agent-sensitive-write-guard 同款纪律）：本 spec 的 428
 *  用例只拦不解，pending 卡入服务端全局队列会污染紧随其后的审批族用例；
 *  收尾统一拒绝清账（delete 语义安全侧——即使泄漏也不会被误放行） */
async function cleanupPendingApprovals(request: import('@playwright/test').APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: false },
    })
  }
}

test.afterEach(async ({ request }) => {
  await cleanupPendingApprovals(request)
})

const agentHeaders = (lang?: string) => {
  const h: Record<string, string> = { 'X-Lock-Token': agentToken }
  if (lang) h['Accept-Language'] = lang
  return h
}

async function guardDelete(request: import('@playwright/test').APIRequestContext, lang?: string) {
  return request.delete(`${BASE}/api/projects/${projectId}`, { headers: agentHeaders(lang) })
}

async function pollApproval(request: import('@playwright/test').APIRequestContext, id: string) {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers })
  return (await res.json()) as {
    data?: { id?: string; status?: string; op?: string; impact?: { kind?: string; summary?: string } }
  }
}

test('删除项目 428 → 轮询响应携自动填充 impact（zh 系中文计数）', async ({ request }) => {
  const res = await guardDelete(request, 'zh-CN')
  expect(res.status()).toBe(428)
  const guard = (await res.json()) as { approvalId?: string; code?: string }
  expect(guard.approvalId, '428 body should carry approvalId').toBeTruthy()
  expect(guard.code).toBe('ops.approval_required')

  // 轮询响应：pending + op 文案 + 自动填充的 delete 影响面（计数 = 绑定会话 1）
  const detail = await pollApproval(request, guard.approvalId!)
  expect(detail.data?.status).toBe('pending')
  expect(detail.data?.op).toBe('删除项目')
  expect(detail.data?.impact?.kind).toBe('delete')
  expect(detail.data?.impact?.summary).toBe('将终止该项目 1 个终端会话')

  // 拒绝清账（项目保留，afterAll 统一删）
  const headers = await unlockHeaders(request)
  const deny = await request.post(`${BASE}/api/ops-confirm/${guard.approvalId}/resolve`, {
    headers, data: { allow: false },
  })
  expect(deny.ok()).toBeTruthy()
})

test('缺省 Accept-Language → 英文摘要；列表端点读同一份 impact', async ({ request }) => {
  const res = await guardDelete(request)
  expect(res.status()).toBe(428)
  const guard = (await res.json()) as { approvalId?: string }

  const detail = await pollApproval(request, guard.approvalId!)
  expect(detail.data?.impact?.kind).toBe('delete')
  expect(detail.data?.impact?.summary).toBe('Will terminate 1 terminal session(s) of this project')

  // 列表端点（卡片补账/大屏同源）读到同一份 impact
  const headers = await unlockHeaders(request)
  const list = await (await request.get(`${BASE}/api/ops-confirm`, { headers })).json() as {
    data?: { id?: string; impact?: { summary?: string } }[]
  }
  const row = (list.data || []).find(x => x.id === guard.approvalId)
  expect(row?.impact?.summary).toBe('Will terminate 1 terminal session(s) of this project')

  const deny = await request.post(`${BASE}/api/ops-confirm/${guard.approvalId}/resolve`, {
    headers, data: { allow: false },
  })
  expect(deny.ok()).toBeTruthy()
})
