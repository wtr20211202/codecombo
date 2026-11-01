import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 冲突解决域 agent 协议面 E2E（P-20261004-30）：resolve 族端点对 sca_ 智能体
 * 令牌接 AgentGuard 高危审批——纯 API 链路（agent 是 API 调用方，无前端页面）：
 *   1. 读面开放：agent 令牌 GET /conflicts 直达（看到冲突清单是按手册规范
 *      先问用户偏好的前提，不设防）
 *   2. 整文件 resolve 审批链：agent 令牌调 POST /conflicts/resolve →
 *      428 + approvalId（code=ops.approval_required，审批卡 op 以「冲突解决」
 *      为前缀）→ 用户裁决允许 → 携 X-Approval-ID 重试放行，文件按 ours 落盘
 *   3. 合成写回双路径：agent 令牌调 resolve-content 同样 428（裁决关口）；
 *      用户解锁令牌（冲突面板 UI 操作）免审批直达——写回内容精确落盘
 * 环境敏感点同 conflict-hunks.spec.ts：仓库放系统临时目录、服务端形态路径注册。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const REPO_DIR = path.join(process.env.TEMP || os.tmpdir(), 'sc-e2e-conflict-agent')
const PROJ_NAME = 'conflict-agent-resolve-demo'
const F1 = 'whole.txt'
const F2 = 'synth.txt'

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], {
    cwd, encoding: 'utf8',
  })
}

async function unlockHeaders(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''
let agentToken = ''
let mainEditHash = ''

// 重建两文件合并冲突（abort → 回 main → 再 merge）：retry 重跑用例时仓库已被
// 上一次尝试部分解决，先回到已知冲突态再断言（conflict-hunks 同款幂等模式）
function seedConflicts() {
  try { git(REPO_DIR, ['merge', '--abort']) } catch { /* 非合并中忽略 */ }
  git(REPO_DIR, ['reset', '--hard', mainEditHash])
  let merged = false
  try {
    git(REPO_DIR, ['merge', 'feature'])
    merged = true
  } catch { /* 冲突即预期：非零退出 */ }
  if (merged) throw new Error('expected merge conflict did not happen')
  const status = git(REPO_DIR, ['status', '--porcelain'])
  if (!status.includes('UU')) throw new Error('expected UU conflict entry, got: ' + status)
}

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

  // 两个独立文件各双侧修改 → merge 产出一个文件一条 UU 冲突 ×2
  // f1 整文件走 ours 放行链；f2 走合成写回（agent 428 / 用户免审批）双路径
  const baseContent = (name: string) => `${name}: base line\nshared tail\n`
  for (const name of [F1, F2]) fs.writeFileSync(path.join(REPO_DIR, name), baseContent(name))
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'base'])
  git(REPO_DIR, ['checkout', '-b', 'feature'])
  for (const name of [F1, F2]) fs.writeFileSync(path.join(REPO_DIR, name), `${name}: feature side\nshared tail\n`)
  git(REPO_DIR, ['commit', '-qam', 'feature edit'])
  git(REPO_DIR, ['checkout', 'main'])
  for (const name of [F1, F2]) fs.writeFileSync(path.join(REPO_DIR, name), `${name}: main side\nshared tail\n`)
  git(REPO_DIR, ['commit', '-qam', 'main edit'])
  mainEditHash = git(REPO_DIR, ['rev-parse', 'HEAD']).trim()
  seedConflicts()

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

const agentHeaders = () => ({ 'Content-Type': 'application/json', 'X-Lock-Token': agentToken })

test('agent 令牌：读面直达；整文件 resolve 走 428→审批→放行链，文件按 ours 落盘', async ({ request }) => {
  seedConflicts()

  // 读面（冲突清单）不设防：agent 看到冲突才能按手册规范先问用户偏好
  const list = await request.get(`${BASE}/api/projects/${projectId}/conflicts`, { headers: agentHeaders() })
  expect(list.status()).toBe(200)
  const conflicts = ((await list.json()) as { data?: { path: string }[] }).data || []
  expect(conflicts.map((c) => c.path).sort()).toEqual([F1, F2].sort())

  // agent 令牌调整文件 resolve → 428 + approvalId（审批必需，不是错误）
  const first = await request.post(`${BASE}/api/projects/${projectId}/conflicts/resolve`, {
    headers: agentHeaders(), data: { file: F1, strategy: 'ours' },
  })
  expect(first.status()).toBe(428)
  const body = (await first.json()) as { approvalId?: string; code?: string }
  expect(body.approvalId, '428 body should carry approvalId').toBeTruthy()
  expect(body.code).toBe('ops.approval_required')

  // 审批卡 op 以「冲突解决」为前缀（规则一条前缀覆盖冲突解决族的契约）
  const uh = await unlockHeaders(request)
  const detail = await (await request.get(`${BASE}/api/ops-confirm/${body.approvalId}`, { headers: uh })).json() as { data?: { op?: string; status?: string } }
  expect(detail.data?.status).toBe('pending')
  expect(detail.data?.op?.startsWith('冲突解决')).toBeTruthy()

  // 用户裁决允许 → agent 携 X-Approval-ID 重试放行（一次性消费）
  const resolved = await request.post(`${BASE}/api/ops-confirm/${body.approvalId}/resolve`, {
    headers: uh, data: { allow: true },
  })
  expect(resolved.ok()).toBeTruthy()
  const retry = await request.post(`${BASE}/api/projects/${projectId}/conflicts/resolve`, {
    headers: { ...agentHeaders(), 'X-Approval-ID': body.approvalId! },
    data: { file: F1, strategy: 'ours' },
  })
  expect(retry.status()).toBe(200)

  // 放行效果：f1 按我方（main 侧）落盘且标记已解决（f1 的 UU 消失；
  // f2 尚未解决仍 UU，归属下一个用例）。f1 内容==HEAD（我方即 HEAD）时
  // porcelain 不再显示 M——「已解决且入索引」的精确口径是 ls-files 单条
  // stage 0 条目（冲突期是 1/2/3 三条）
  expect(fs.readFileSync(path.join(REPO_DIR, F1), 'utf8')).toBe(`${F1}: main side\nshared tail\n`)
  const status = git(REPO_DIR, ['status', '--porcelain'])
  expect(status.split('\n').some((l) => l.includes(F1) && l.includes('U'))).toBeFalsy()
  const stages = git(REPO_DIR, ['ls-files', '-s', F1]).trim().split('\n')
  expect(stages).toHaveLength(1)
  expect(stages[0]!.split('\t')[0]!.trim().split(/\s+/)[2]).toBe('0')
})

test('合成写回：agent 令牌同样 428；用户解锁令牌（UI 路径）免审批直达', async ({ request }) => {
  seedConflicts()
  const uh = await unlockHeaders(request)
  const synthesized = `${F2}: merged by hand\nshared tail\n`

  // agent 令牌调 resolve-content → 428（合成写回同为「决定文件最终内容」的裁决关口）
  const guarded = await request.post(`${BASE}/api/projects/${projectId}/conflicts/resolve-content`, {
    headers: agentHeaders(), data: { file: F2, content: synthesized },
  })
  expect(guarded.status()).toBe(428)
  const approvalId = ((await guarded.json()) as { approvalId?: string }).approvalId || ''
  expect(approvalId).toBeTruthy()

  // 无需放行（本用例走用户路径）——裁决拒绝收掉这张卡，不留 pending 垃圾
  const denied = await request.post(`${BASE}/api/ops-confirm/${approvalId}/resolve`, {
    headers: uh, data: { allow: false, reason: 'e2e: 用户选择自己在冲突面板处理' },
  })
  expect(denied.ok()).toBeTruthy()

  // 用户解锁令牌（冲突面板 UI 同款调用形态）免审批直达
  const exempt = await request.post(`${BASE}/api/projects/${projectId}/conflicts/resolve-content`, {
    headers: uh, data: { file: F2, content: synthesized },
  })
  expect(exempt.status()).toBe(200)
  expect(fs.readFileSync(path.join(REPO_DIR, F2), 'utf8')).toBe(synthesized)
  const status = git(REPO_DIR, ['status', '--porcelain'])
  expect(status.split('\n').some((l) => l.includes(F2) && l.includes('U'))).toBeFalsy()
})
