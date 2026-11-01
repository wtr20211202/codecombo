import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 合并审批 E2E（P-20261006-26）：AgentGuard 同类高危操作的合并审批——批量裁决
 * 一次完成。纯 API 链路（agent 是 API 调用方，agent-sensitive-write-guard 同款
 * 形态，复用其敏感写入闸作聚合载体——op 内嵌归一路径，同路径即同 op）：
 *   1. 合并建卡：同会话+同 op 的两次 agent 写入各得 428+自己的 approvalId（轮询
 *      语义零变化），但 pending 面只有一张主卡（挂起条目被列表过滤，主卡 merged
 *      清单承载）——裁决从 N 次点按变 1 次
 *   2. 批量放行联动：主卡允许 → 挂起条目轮询即见 allowed（各自 5min 重试窗口），
 *      各自携 X-Approval-ID 重试一次性消费（语义逐请求保持）
 *   3. 边界：不同会话同 op 不聚合（同会话是信任边界），各留独立卡
 * 环境敏感点同 agent-sensitive-write-guard.spec.ts：仓库放系统临时目录、服务端
 * 形态路径注册；pending 跨用例共享，每例收尾统一清账。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const REPO_DIR = path.join(process.env.TEMP || os.tmpdir(), 'sc-e2e-approval-merge')
const PROJ_NAME = 'agent-approval-merge-demo'
const HOOK_PATH = '.git/hooks/pre-commit'
const HOOK_BODY = '#!/bin/sh\necho merge-demo\n'

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
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'approval merge demo\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'base'])

  const created = await request.post(`${BASE}/api/projects`, {
    headers,
    data: { name: PROJ_NAME, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  if (!projectId) throw new Error('project registration failed')

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

/** 清账 pending 审批（agent-sensitive-write-guard 同款纪律）：pending 是跨用例
 *  共享的服务端状态，每例收尾统一裁决清账防泄漏污染后续审批族用例 */
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

const agentHeaders = (session: string) => ({
  'Content-Type': 'application/json',
  'X-Lock-Token': agentToken,
  'X-Session-ID': session,
})
const fileURL = () => `${BASE}/api/projects/${projectId}/file`

test('合并建卡与批量放行：同会话同 op 两请求入队一卡，主卡允许即批量生效（一次性逐请求保持）', async ({ request }) => {
  const session = 'sc-merge-s1'

  // 首写 → 428 主卡；次写（同会话同路径=同 op）→ 428+自己的 approvalId（轮询
  // 语义零变化），但不建第二张卡
  const first = await request.put(fileURL(), {
    headers: agentHeaders(session), data: { path: HOOK_PATH, content: HOOK_BODY },
  })
  expect(first.status()).toBe(428)
  const mainId = ((await first.json()) as { approvalId?: string }).approvalId || ''
  expect(mainId).toBeTruthy()

  const second = await request.put(fileURL(), {
    headers: agentHeaders(session), data: { path: HOOK_PATH, content: HOOK_BODY },
  })
  expect(second.status()).toBe(428)
  const entryId = ((await second.json()) as { approvalId?: string }).approvalId || ''
  expect(entryId).toBeTruthy()
  expect(entryId).not.toBe(mainId)
  expect(fs.existsSync(path.join(REPO_DIR, '.git', 'hooks', 'pre-commit'))).toBeFalsy()

  // pending 面：只有主卡一张（挂起条目被列表过滤，不再弹碎卡）；主卡携带
  // merged 挂起队列快照（+N 徽标数据源）
  const uh = await unlockHeaders(request)
  const pending = await (await request.get(`${BASE}/api/ops-confirm?status=pending`, { headers: uh })).json() as {
    data?: { id: string; merged?: { id: string }[] }[]
  }
  const pendList = pending.data || []
  expect(pendList.map(a => a.id)).toContain(mainId)
  expect(pendList.map(a => a.id)).not.toContain(entryId)
  const main = pendList.find(a => a.id === mainId)
  expect(main?.merged?.map(m => m.id)).toContain(entryId)

  // agent 轮询挂起条目自有 approvalId：pending 在案（协议零破坏）
  const poll = await (await request.get(`${BASE}/api/ops-confirm/${entryId}`, { headers: uh })).json() as {
    data?: { status?: string }
  }
  expect(poll.data?.status).toBe('pending')

  // 主卡允许 → 挂起条目联动放行（轮询即见终态）；轮询面只投影
  // id/status/op/target/agent/reason/ruleHit（GetAgentApproval），resolvedAt
  // 走列表面核对；重试各自放行一次性消费（放行窗 5min 自条目 ResolvedAt 起算
  // ——重试本身即对联动落库的最硬验证）
  const resolved = await request.post(`${BASE}/api/ops-confirm/${mainId}/resolve`, {
    headers: uh, data: { allow: true },
  })
  expect(resolved.ok()).toBeTruthy()

  const entryPoll = await (await request.get(`${BASE}/api/ops-confirm/${entryId}`, { headers: uh })).json() as {
    data?: { status?: string }
  }
  expect(entryPoll.data?.status).toBe('allowed')

  const entryInList = await (await request.get(`${BASE}/api/ops-confirm?status=allowed`, { headers: uh })).json() as {
    data?: { id: string; resolvedAt?: string }[]
  }
  const released = (entryInList.data || []).find(a => a.id === entryId)
  expect(released?.resolvedAt, 'released entry must carry resolvedAt (per-entry 5min retry window)').toBeTruthy()

  const hookFile = path.join(REPO_DIR, '.git', 'hooks', 'pre-commit')
  const retryMain = await request.put(fileURL(), {
    headers: { ...agentHeaders(session), 'X-Approval-ID': mainId },
    data: { path: HOOK_PATH, content: HOOK_BODY },
  })
  expect(retryMain.status()).toBe(200)
  const retryEntry = await request.put(fileURL(), {
    headers: { ...agentHeaders(session), 'X-Approval-ID': entryId },
    data: { path: HOOK_PATH, content: HOOK_BODY },
  })
  expect(retryEntry.status()).toBe(200)
  expect(fs.readFileSync(hookFile, 'utf8')).toBe(HOOK_BODY)

  // 一次性语义逐请求保持：同 ID 二次重试重新 428
  const replay = await request.put(fileURL(), {
    headers: { ...agentHeaders(session), 'X-Approval-ID': entryId },
    data: { path: HOOK_PATH, content: HOOK_BODY },
  })
  expect(replay.status()).toBe(428)
})

test('边界：不同会话同 op 不聚合——各留独立卡（同会话是合并的信任边界）', async ({ request }) => {
  const uh = await unlockHeaders(request)
  const before = await (await request.get(`${BASE}/api/ops-confirm?status=pending`, { headers: uh })).json() as {
    data?: { id: string }[]
  }
  const beforeIds = (before.data || []).map(a => a.id)

  const s1 = await request.put(fileURL(), {
    headers: agentHeaders('sc-merge-s2'), data: { path: HOOK_PATH, content: HOOK_BODY },
  })
  expect(s1.status()).toBe(428)
  const id1 = ((await s1.json()) as { approvalId?: string }).approvalId || ''

  const s2 = await request.put(fileURL(), {
    headers: agentHeaders('sc-merge-s3'), data: { path: HOOK_PATH, content: HOOK_BODY },
  })
  expect(s2.status()).toBe(428)
  const id2 = ((await s2.json()) as { approvalId?: string }).approvalId || ''

  expect(id1).toBeTruthy()
  expect(id2).toBeTruthy()
  const after = await (await request.get(`${BASE}/api/ops-confirm?status=pending`, { headers: uh })).json() as {
    data?: { id: string }[]
  }
  const afterIds = (after.data || []).map(a => a.id)
  // 两张独立卡都在 pending 面（互不入队）
  expect(afterIds).toContain(id1)
  expect(afterIds).toContain(id2)
  // 除这两张外无新增（与用例前的 pending 集合差恰为 2）
  expect(afterIds.filter(x => !beforeIds.includes(x)).sort()).toEqual([id1, id2].sort())
})
