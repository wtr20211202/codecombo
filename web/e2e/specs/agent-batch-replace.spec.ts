import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 批量替换服务端执行 API E2E（P-20261004-114）：agent 批量编辑原语——纯 API
 * 链路（agent 是 API 调用方，无前端页面；conflict-agent-resolve 同款形态）：
 *   1. 预览免审批：agent 令牌 POST /replace/preview 直达（读面开放，与
 *      GET /search 同敏感级）——文件×行 before→after + sensitiveHits 回告
 *   2. 执行走 428 审批链：agent 令牌 POST /replace → 428 + approvalId
 *      （code=ops.approval_required，审批卡 op 以「批量替换」为前缀）→
 *      用户裁决允许 → 携 X-Approval-ID 重试放行 → 文件替换落盘
 *   3. 备份可查可回滚：响应携 backup.name；GET /replace/backups 清单在列，
 *      ?name= 取回的 patch 携替换前未提交内容；git checkout + apply 组合
 *      真跑还原替换前工作区
 *   4. 敏感闸：.env 命中 → 预览回告 sensitiveHits；执行不带 confirmSensitive
 *      → 409 files.sensitive_confirm_required（用户解锁令牌直达 409，免审批
 *      路径同样受闸）→ 带 confirmSensitive=true 经审批放行后替换
 * 环境敏感点同 conflict-hunks.spec.ts：仓库放系统临时目录、服务端形态路径注册。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const REPO_DIR = path.join(process.env.TEMP || os.tmpdir(), 'sc-e2e-agent-replace')
const PROJ_NAME = 'agent-batch-replace-demo'
const SERVICE = 'service.txt'
const UTIL = 'util.txt'
const ENV_FILE = '.env'

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
  fs.writeFileSync(path.join(REPO_DIR, SERVICE), 'call LegacyApi(v1)\nlegacy helper\n')
  fs.writeFileSync(path.join(REPO_DIR, UTIL), 'wrap LegacyApi here\n')
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

const agentHeaders = () => ({ 'Content-Type': 'application/json', 'X-Lock-Token': agentToken })

test('agent 令牌全链：预览免审批 → 执行 428→批准→放行 → 文件落盘 → 备份可查可回滚', async ({ request }) => {
  // 替换前留一笔未提交改动：备份 patch 携替换前工作区内容（回滚点非空）
  const before = 'call LegacyApi(v1)\nlegacy helper\nuncommitted marker\n'
  fs.writeFileSync(path.join(REPO_DIR, SERVICE), before)

  // ① 预览免审批直达（读面开放）：文件×行 before→after
  const pv = await request.post(`${BASE}/api/projects/${projectId}/replace/preview`, {
    headers: agentHeaders(), data: { pattern: 'LegacyApi', replacement: 'ModernApi' },
  })
  expect(pv.status()).toBe(200)
  const preview = ((await pv.json()) as { data?: { files?: { path: string; hits: number; rows: { line: number; before: string; after: string }[] }[]; totalHits?: number } }).data || {}
  const paths = (preview.files || []).map((f) => f.path).sort()
  expect(paths).toEqual([SERVICE, UTIL].sort())
  expect(preview.totalHits).toBe(2)
  const svcPreview = (preview.files || []).find((f) => f.path === SERVICE)
  expect(svcPreview?.rows.some((r) => r.before.includes('LegacyApi') && r.after.includes('ModernApi'))).toBeTruthy()
  // 预览不写盘
  expect(fs.readFileSync(path.join(REPO_DIR, SERVICE), 'utf8')).toBe(before)

  // ② agent 令牌执行 → 428 + approvalId（高危审批，不是错误）
  const first = await request.post(`${BASE}/api/projects/${projectId}/replace`, {
    headers: agentHeaders(), data: { pattern: 'LegacyApi', replacement: 'ModernApi' },
  })
  expect(first.status()).toBe(428)
  const guard = (await first.json()) as { approvalId?: string; code?: string }
  expect(guard.approvalId, '428 body should carry approvalId').toBeTruthy()
  expect(guard.code).toBe('ops.approval_required')

  // 审批卡 op 以「批量替换」为前缀（规则一条前缀覆盖替换面的契约）
  const uh = await unlockHeaders(request)
  const detail = await (await request.get(`${BASE}/api/ops-confirm/${guard.approvalId}`, { headers: uh })).json() as { data?: { op?: string; status?: string } }
  expect(detail.data?.status).toBe('pending')
  expect(detail.data?.op?.startsWith('批量替换')).toBeTruthy()

  // ③ 用户裁决允许 → agent 携 X-Approval-ID 重试放行（一次性消费）
  const resolved = await request.post(`${BASE}/api/ops-confirm/${guard.approvalId}/resolve`, {
    headers: uh, data: { allow: true },
  })
  expect(resolved.ok()).toBeTruthy()
  const retry = await request.post(`${BASE}/api/projects/${projectId}/replace`, {
    headers: { ...agentHeaders(), 'X-Approval-ID': guard.approvalId! },
    data: { pattern: 'LegacyApi', replacement: 'ModernApi' },
  })
  expect(retry.status()).toBe(200)
  const done = (await retry.json()) as { data?: { backup?: { name?: string }, changed?: { path: string; hits: number }[] } }
  expect((done.data?.changed || []).map((c) => c.path).sort()).toEqual([SERVICE, UTIL].sort())

  // 放行效果：文件替换落盘（含替换前未提交行——不吞外部改动）
  expect(fs.readFileSync(path.join(REPO_DIR, SERVICE), 'utf8')).toBe('call ModernApi(v1)\nlegacy helper\nuncommitted marker\n')

  // ④ 备份可查：清单在列，内容取回携替换前未提交改动（回滚点非空）
  const backupName = done.data?.backup?.name || ''
  expect(backupName).toBeTruthy()
  const list = await request.get(`${BASE}/api/projects/${projectId}/replace/backups`, { headers: uh })
  const entries = ((await list.json()) as { data?: { name: string }[] }).data || []
  expect(entries.some((e) => e.name === backupName)).toBeTruthy()
  const fetched = await request.get(`${BASE}/api/projects/${projectId}/replace/backups?name=${backupName}`, { headers: uh })
  const patch = ((await fetched.json()) as { data?: string }).data || ''
  expect(patch).toContain('+uncommitted marker')

  // ⑤ 回滚组合真跑：checkout 丢弃替换后改动 → apply 备份 → 替换前工作区还原
  git(REPO_DIR, ['checkout', '--', SERVICE])
  git(REPO_DIR, ['apply', '--allow-empty', '-'], patch)
  expect(fs.readFileSync(path.join(REPO_DIR, SERVICE), 'utf8')).toBe(before)
})

test('敏感闸：预览回告 sensitiveHits；未确认 409（解锁令牌直达）；确认后经审批替换', async ({ request }) => {
  fs.writeFileSync(path.join(REPO_DIR, ENV_FILE), 'API_TOKEN=LegacyApi\n')
  git(REPO_DIR, ['add', '-A'])
  git(REPO_DIR, ['commit', '-m', 'env'])
  const uh = await unlockHeaders(request)

  // 预览回告敏感命中（执行前观测点）
  const pv = await request.post(`${BASE}/api/projects/${projectId}/replace/preview`, {
    headers: agentHeaders(), data: { pattern: 'LegacyApi', replacement: 'ModernApi' },
  })
  expect(pv.status()).toBe(200)
  const preview = ((await pv.json()) as { data?: { sensitiveHits?: string[] } }).data || {}
  expect(preview.sensitiveHits || []).toContain(ENV_FILE)

  // 未确认执行：用户解锁令牌免审批直达 409 稳定码 + 清单（闸在 handler，与令牌无关）
  const gated = await request.post(`${BASE}/api/projects/${projectId}/replace`, {
    headers: uh, data: { pattern: 'LegacyApi', replacement: 'ModernApi' },
  })
  expect(gated.status()).toBe(409)
  const gatedBody = (await gated.json()) as { code?: string; sensitiveHits?: string[] }
  expect(gatedBody.code).toBe('files.sensitive_confirm_required')
  expect(gatedBody.sensitiveHits || []).toContain(ENV_FILE)
  expect(fs.readFileSync(path.join(REPO_DIR, ENV_FILE), 'utf8')).toBe('API_TOKEN=LegacyApi\n')

  // 确认后 agent 执行：428 → 批准 → 放行替换（含 .env）
  const first = await request.post(`${BASE}/api/projects/${projectId}/replace`, {
    headers: agentHeaders(), data: { pattern: 'LegacyApi', replacement: 'ModernApi', confirmSensitive: true },
  })
  expect(first.status()).toBe(428)
  const guard = (await first.json()) as { approvalId?: string }
  expect(guard.approvalId).toBeTruthy()
  await request.post(`${BASE}/api/ops-confirm/${guard.approvalId}/resolve`, {
    headers: uh, data: { allow: true },
  })
  const retry = await request.post(`${BASE}/api/projects/${projectId}/replace`, {
    headers: { ...agentHeaders(), 'X-Approval-ID': guard.approvalId! },
    data: { pattern: 'LegacyApi', replacement: 'ModernApi', confirmSensitive: true },
  })
  expect(retry.status()).toBe(200)
  expect(fs.readFileSync(path.join(REPO_DIR, ENV_FILE), 'utf8')).toBe('API_TOKEN=ModernApi\n')
})
