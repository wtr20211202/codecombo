import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { createAgentSessionApi } from '../../tests/e2e-api'
import { dualTmpClean, dualTmpDir, serverPath } from '../../tests/dualpath'

/**
 * AgentGuard 统一审计切面（P-20261006-45）E2E：强制面三出口的裁决维度台账
 * 经既有 GET /api/audit 可查（纯 API 链路，agent 是 API 调用方无前端页面）：
 *   1. allow 规则命中直放行 → agentguard.allow（Detail 含 actor=agent/
 *      route/op/target/session + rule=<命中规则>）；
 *   2. deny 规则命中 → 403 + agentguard.deny（result=denied，rule= 归属）；
 *   3. 无规则 428 → 人工允许 → 携 X-Approval-ID 重试 → agentguard.
 *      approval_pass（approval=<一次性消费的卡 id>），同 id 重放不二次记账。
 * 审计查询面复用既有 List（服务端不做参数过滤）：用例按 action + Detail 的
 * session= 段过滤本项目专属会话，不依赖台账全局序。push 落真实本地 bare
 * origin（范式同 git-push-rejected-hint，无网络依赖）；规则/档位是服务端
 * 共享状态，beforeEach/afterEach 归位 ask + 清空规则表防污染后续用例。
 */

const PROJ = 'e2e-agentguard-audit'
let fixture: { win: string; server: string } | null = null
let projectId = ''
let sessionId = ''
let agentToken = ''

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function setApprovalMode(request: APIRequestContext, mode: 'ask' | 'allow'): Promise<void> {
  await request.put(`${API_BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalMode: mode },
  })
}

async function setRules(
  request: APIRequestContext,
  rules: Array<{ opPattern: string; effect: string }>,
): Promise<void> {
  const res = await request.put(`${API_BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalRules: rules },
  })
  expect(res.ok()).toBeTruthy()
}

async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${API_BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

const agentHeaders = () => ({
  'Content-Type': 'application/json',
  'X-Lock-Token': agentToken,
  'X-Session-ID': sessionId,
})

interface AuditEntry {
  action: string
  result: string
  detail?: string
}

async function auditEntries(request: APIRequestContext, action: string): Promise<AuditEntry[]> {
  const res = await request.get(`${API_BASE}/api/audit?limit=200`, { headers: await unlockHeaders(request) })
  expect(res.ok()).toBeTruthy()
  const all = ((await res.json()) as { data?: AuditEntry[] }).data || []
  return all.filter(e => e.action === action)
}

/** 审计经 Append 尽力而为写入（同步落盘，但留轮询余量吸收慢盘抖动） */
async function waitForAudit(
  request: APIRequestContext,
  action: string,
  pred: (e: AuditEntry) => boolean,
): Promise<AuditEntry> {
  for (let i = 0; i < 20; i++) {
    const hit = (await auditEntries(request, action)).find(pred)
    if (hit) return hit
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`audit entry ${action} not found`)
}

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const existing = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((existing?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
    }
  }

  // 临时工作仓 + bare origin（双形态夹具；交服务端的路径经 serverPath 翻译）
  fixture = dualTmpDir('sc-e2e-agentguard-audit-')
  const bare = path.join(fixture.win, 'origin.git')
  const work = path.join(fixture.win, 'work')
  execFileSync('git', ['init', '--bare', '-b', 'main', bare])
  execFileSync('git', ['clone', bare, work], { stdio: 'ignore' })
  fs.writeFileSync(path.join(work, 'seed.txt'), 'seed\n')
  git(work, ['add', '.'])
  git(work, ['commit', '-m', 'audit e2e baseline'])
  git(work, ['push', '-u', 'origin', 'main'])
  // origin 改写为服务端形态（跨拓扑下服务端 git 要能解析该路径）
  git(work, ['remote', 'set-url', 'origin', serverPath(bare)])

  const created = await request.post(`${API_BASE}/api/projects`, {
    headers, data: { name: PROJ, path: serverPath(work).replace(/\\/g, '/') },
  })
  expect(created.ok()).toBeTruthy()
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId).not.toBe('')

  const session = await createAgentSessionApi(request, { name: 'e2e-gaudit', runtime: 'shell' })
  sessionId = session.id

  const revealed = await request.post(`${API_BASE}/api/agent-token/reveal`, { headers })
  agentToken = ((await revealed.json()) as { data?: { token?: string } }).data?.token || ''
  expect(agentToken.startsWith('sca_'), 'agent token should be sca_ prefixed').toBeTruthy()
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  await setApprovalMode(request, 'ask')
  await setRules(request, [])
  await cleanupApprovals(request)
  if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`, { headers })
  if (sessionId) await request.delete(`${API_BASE}/api/terminals/${sessionId}`, { headers })
  if (fixture) dualTmpClean(fixture.win)
})

test.beforeEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await setRules(request, [])
  await cleanupApprovals(request)
})

test('allow 规则直放行落 agentguard.allow（rule= 归属）', async ({ request }) => {
  await setRules(request, [{ opPattern: 'git push', effect: 'allow' }])

  const push = await request.post(`${API_BASE}/api/projects/${projectId}/push`, {
    headers: agentHeaders(), data: { remote: 'origin', branch: 'main' },
  })
  expect(push.status()).toBe(200)

  const entry = await waitForAudit(request, 'agentguard.allow',
    e => (e.detail || '').includes(`session=${sessionId}`))
  expect(entry.result).toBe('success')
  expect(entry.detail).toContain('actor=agent')
  expect(entry.detail).toContain('route=/api/projects/:id/push')
  expect(entry.detail).toContain('op=git push')
  expect(entry.detail).toContain(`target=/api/projects/${projectId}/push`)
  expect(entry.detail).toContain('rule=git push')

  // allow 直放行不建审批卡（审计走台账不走审批域，既有语义不变）
  const cards = await (await request.get(`${API_BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
  })).json() as { data?: { sessionId?: string; status?: string }[] }
  const mine = (cards.data || []).filter(a => a.sessionId === sessionId && a.status === 'pending')
  expect(mine).toEqual([])
})

test('deny 规则拒绝落 agentguard.deny（result=denied）', async ({ request }) => {
  await setRules(request, [{ opPattern: 'git reset', effect: 'deny' }])

  const reset = await request.post(`${API_BASE}/api/projects/${projectId}/reset`, {
    headers: agentHeaders(), data: { mode: '--hard' },
  })
  expect(reset.status()).toBe(403)

  const entry = await waitForAudit(request, 'agentguard.deny',
    e => (e.detail || '').includes(`session=${sessionId}`))
  expect(entry.result).toBe('denied')
  expect(entry.detail).toContain('actor=agent')
  expect(entry.detail).toContain('route=/api/projects/:id/reset')
  expect(entry.detail).toContain('rule=git reset')
})

test('审批通过重试落 agentguard.approval_pass（approval= 一次性归属）', async ({ request }) => {
  const first = await request.post(`${API_BASE}/api/projects/${projectId}/push`, {
    headers: agentHeaders(), data: { remote: 'origin', branch: 'main' },
  })
  expect(first.status()).toBe(428)
  const approvalId = ((await first.json()) as { approvalId?: string }).approvalId || ''
  expect(approvalId, '428 body should carry approvalId').toBeTruthy()

  const resolved = await request.post(`${API_BASE}/api/ops-confirm/${approvalId}/resolve`, {
    headers: await unlockHeaders(request), data: { allow: true },
  })
  expect(resolved.ok()).toBeTruthy()

  const retry = await request.post(`${API_BASE}/api/projects/${projectId}/push`, {
    headers: { ...agentHeaders(), 'X-Approval-ID': approvalId },
    data: { remote: 'origin', branch: 'main' },
  })
  expect(retry.status()).toBe(200)

  const entry = await waitForAudit(request, 'agentguard.approval_pass',
    e => (e.detail || '').includes(`approval=${approvalId}`))
  expect(entry.result).toBe('success')
  expect(entry.detail).toContain('actor=agent')
  expect(entry.detail).toContain(`session=${sessionId}`)

  // 同 ID 重放：卡已消费 → 重新 428，不二次记账
  const replay = await request.post(`${API_BASE}/api/projects/${projectId}/push`, {
    headers: { ...agentHeaders(), 'X-Approval-ID': approvalId },
    data: { remote: 'origin', branch: 'main' },
  })
  expect(replay.status()).toBe(428)
  const passes = (await auditEntries(request, 'agentguard.approval_pass'))
    .filter(e => (e.detail || '').includes(`approval=${approvalId}`))
  expect(passes.length).toBe(1)
})
