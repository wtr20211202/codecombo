import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 敏感写入路径窄表闸 E2E（P-20261005-235）：agent 写敏感路径的事前守卫——
 * 纯 API 链路（agent 是 API 调用方，无前端页面；agent-batch-replace 同款形态）：
 *   1. 命中闸：agent 令牌 PUT file 写 .git/hooks/pre-commit → 428 + approvalId
 *      （code=ops.approval_required，审批卡 op 以「写入敏感路径」为前缀且钉在
 *      路径上）→ 用户裁决允许 → 携 X-Approval-ID 重试放行 → 钩子落盘
 *   2. 零打扰：agent 写普通文件 / CI 配置（.github/workflows，file/create）照常
 *      201 直达——窄表刻意不收日常编辑对象
 *   3. 归一化绕过防护：反斜杠分隔符变体照常命中 428；.. 段在写入入口被既有
 *      边界校验 403 拒绝（不触闸也不落盘）
 *   4. 闸面覆盖：rename 挪入 .git/hooks、mkdir .ssh、upload 到 .ssh 同样 428；
 *      放行一次性（同 ID 二次重试重新 428）；用户解锁令牌（scl_）豁免直达
 * 环境敏感点同 agent-batch-replace.spec.ts：仓库放系统临时目录、服务端形态路径注册。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const REPO_DIR = path.join(process.env.TEMP || os.tmpdir(), 'sc-e2e-sensitive-write')
const PROJ_NAME = 'agent-sensitive-write-demo'

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
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'sensitive write guard demo\n')
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

/** 清账 pending 审批（run15 教训）：本 spec 的 428 闸面用例刻意只拦不解——
 *  replay/变体/rename/mkdir/upload 五处 428 各留一张 pending 卡入服务端全局
 *  队列，字母序紧随其后的审批族用例（agent-terminal 等）的 .aprv-card 计数/
 *  折叠可见卡全被污染。pending 是跨用例共享的服务端状态（通知中心同款纪律），
 *  每例收尾统一放行清账，防泄漏（断言本身不受影响——用例内该 428 的仍 428） */
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

const agentHeaders = () => ({ 'Content-Type': 'application/json', 'X-Lock-Token': agentToken })
const fileURL = () => `${BASE}/api/projects/${projectId}/file`

test('命中闸：写 .git/hooks/pre-commit → 428 审批卡 → 允许 → 重试落盘（一次性）', async ({ request }) => {
  const hookBody = '#!/bin/sh\necho hook\n'

  // agent 令牌首写 → 428 + approvalId（未写盘零副作用）
  const first = await request.put(fileURL(), {
    headers: agentHeaders(), data: { path: '.git/hooks/pre-commit', content: hookBody },
  })
  expect(first.status()).toBe(428)
  const guard = (await first.json()) as { approvalId?: string; code?: string }
  expect(guard.approvalId, '428 body should carry approvalId').toBeTruthy()
  expect(guard.code).toBe('ops.approval_required')
  expect(fs.existsSync(path.join(REPO_DIR, '.git', 'hooks', 'pre-commit'))).toBeFalsy()

  // 审批卡：op 以「写入敏感路径」为前缀且钉在归一路径上（透明协议：agent 与
  // 用户都能预判/看清拦的是什么）
  const uh = await unlockHeaders(request)
  const detail = await (await request.get(`${BASE}/api/ops-confirm/${guard.approvalId}`, { headers: uh })).json() as { data?: { op?: string; status?: string } }
  expect(detail.data?.status).toBe('pending')
  expect(detail.data?.op?.startsWith('写入敏感路径')).toBeTruthy()
  expect(detail.data?.op).toContain('.git/hooks/pre-commit')

  // 用户裁决允许 → 携 X-Approval-ID 重试放行 → 钩子落盘
  const resolved = await request.post(`${BASE}/api/ops-confirm/${guard.approvalId}/resolve`, {
    headers: uh, data: { allow: true },
  })
  expect(resolved.ok()).toBeTruthy()
  const retry = await request.put(fileURL(), {
    headers: { ...agentHeaders(), 'X-Approval-ID': guard.approvalId! },
    data: { path: '.git/hooks/pre-commit', content: hookBody },
  })
  expect(retry.status()).toBe(200)
  expect(fs.readFileSync(path.join(REPO_DIR, '.git', 'hooks', 'pre-commit'), 'utf8')).toBe(hookBody)

  // 一次性语义：同 ID 二次重试 → 已消费，重新 428（重建新审批）
  const replay = await request.put(fileURL(), {
    headers: { ...agentHeaders(), 'X-Approval-ID': guard.approvalId! },
    data: { path: '.git/hooks/pre-commit', content: hookBody },
  })
  expect(replay.status()).toBe(428)
})

test('零打扰与绕过防护：普通文件/CI 配置直达；反斜杠变体照常命中；.. 段被边界校验拒绝', async ({ request }) => {
  const createURL = () => `${BASE}/api/projects/${projectId}/file/create`

  // agent 写普通源码：201 直达（日常开发零打扰；新建走 file/create——
  // PUT file 是保存已打开文件语义，不创建父目录）
  const normal = await request.post(createURL(), {
    headers: agentHeaders(), data: { path: 'src/normal.ts', content: 'export const ok = 1\n' },
  })
  expect(normal.status()).toBe(201)

  // CI 配置（任务书点名的正常编辑对象，不进窄表）：201 直达
  const ci = await request.post(createURL(), {
    headers: agentHeaders(), data: { path: '.github/workflows/ci.yml', content: 'on: push\n' },
  })
  expect(ci.status()).toBe(201)
  expect(fs.readFileSync(path.join(REPO_DIR, '.github', 'workflows', 'ci.yml'), 'utf8')).toContain('on: push')

  // 反斜杠分隔符变体（agent 常拼）：归一后照常命中窄表 → 428 而非绕过
  const variant = await request.put(fileURL(), {
    headers: agentHeaders(), data: { path: '.git\\hooks\\pre-commit', content: '#!/bin/sh\n' },
  })
  expect(variant.status()).toBe(428)
  const vGuard = (await variant.json()) as { code?: string }
  expect(vGuard.code).toBe('ops.approval_required')

  // .. 段：写入入口既有边界校验（SafeJoinProject 整体拒绝）先于一切 → 403，
  // 不触闸也绝无落盘
  const traversal = await request.put(fileURL(), {
    headers: agentHeaders(), data: { path: 'src/../.git/hooks/pre-commit', content: '#!/bin/sh\n' },
  })
  expect(traversal.status()).toBe(403)
  const tBody = (await traversal.json()) as { code?: string }
  expect(tBody.code).toBe('files.path_outside_root')
})

test('闸面覆盖：rename 挪入 .git/hooks、mkdir .ssh、upload 到 .ssh 均 428；用户令牌豁免', async ({ request }) => {
  const uh = await unlockHeaders(request)

  // rename 写目标闸：把普通脚本改名挪进 hooks = 敏感位置写入 → 428，未挪动
  const seed = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers: agentHeaders(), data: { path: 'evil.sh', content: '#!/bin/sh\necho pwned\n' },
  })
  expect(seed.status()).toBe(201)
  const mv = await request.post(`${BASE}/api/projects/${projectId}/file/rename`, {
    headers: agentHeaders(), data: { oldPath: 'evil.sh', newPath: '.git/hooks/post-commit' },
  })
  expect(mv.status()).toBe(428)
  expect(fs.existsSync(path.join(REPO_DIR, 'evil.sh'))).toBeTruthy()
  expect(fs.existsSync(path.join(REPO_DIR, '.git', 'hooks', 'post-commit'))).toBeFalsy()

  // mkdir 闸：先立敏感目录的分步投毒在第一步即被拦（** 吞零段，目录自身命中）
  const mk = await request.post(`${BASE}/api/projects/${projectId}/file/mkdir`, {
    headers: agentHeaders(), data: { path: '.ssh' },
  })
  expect(mk.status()).toBe(428)

  // upload 闸：multipart 上传到 .ssh 目标 → 整批预检 428
  const up = await request.post(`${BASE}/api/projects/${projectId}/file/upload?dest=.ssh`, {
    headers: { 'X-Lock-Token': agentToken },
    multipart: {
      files: {
        name: 'authorized_keys',
        mimeType: 'text/plain',
        buffer: Buffer.from('ssh-ed25519 AAAA e2e\n'),
      },
    },
  })
  expect(up.status()).toBe(428)
  expect(fs.existsSync(path.join(REPO_DIR, '.ssh'))).toBeFalsy()

  // 用户解锁令牌豁免：写 .git/config（窄表命中路径）直达 200——强制面只针对机器令牌
  const userWrite = await request.put(fileURL(), {
    headers: uh, data: { path: '.git/config', content: '[core]\n\trepositoryformatversion = 0\n' },
  })
  expect(userWrite.status()).toBe(200)
})
