import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Patch 导出端点 E2E（提交右键菜单「提取补丁」的数据源，此前零覆盖）：
 *   - commits 模式：导出指定提交的补丁（含 subject 与 diff 内容）
 *   - staged 模式：导出暂存区补丁
 * 补丁内容断言：diff 头 + 变更行存在。自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-patch')
const PROJ = 'e2e-patch'
const FILE = 'patched.txt'

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

let projectId = ''
let savedHeaders: Record<string, string> = {}

test.beforeAll(async ({ request }) => {
  savedHeaders = await unlockHeaders()
  const headers = savedHeaders
  const stale = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: patch 基线'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'v2\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'feat: 待导出的提交'])
  const created = await request.post(`${API_BASE}/api/projects`, {
    headers, data: { name: PROJ, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async ({ request }) => {
  const headers = savedHeaders['X-Lock-Token'] ? savedHeaders : await unlockHeaders()
  if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

test('patch 导出：commits 模式含提交与 diff', async ({ request }) => {
  const head = git(REPO_DIR, ['rev-parse', 'HEAD'])
  const res = await request.post(`${API_BASE}/api/projects/${projectId}/patch/export`, {
    headers: savedHeaders, data: { commits: [head] },
  })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { data?: string }
  expect(body.data).toBeTruthy()
  // git format-patch 的 subject 经 RFC 2047 编码：中文以 =?UTF-8?q? 形式出现，
  // 断言补丁头与 diff 内容（非编码敏感部分）
  expect(body.data).toContain('Subject: [PATCH]')
  expect(body.data).toContain('+v2')
})

test('patch 导出：staged 模式导出暂存区', async ({ request }) => {
  // 暂存区造一个新改动
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'v3\n')
  git(REPO_DIR, ['add', '.'])

  const res = await request.post(`${API_BASE}/api/projects/${projectId}/patch/export`, {
    headers: savedHeaders, data: { staged: true },
  })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { data?: string }
  expect(body.data).toBeTruthy()
  expect(body.data).toContain('+v3')
})
