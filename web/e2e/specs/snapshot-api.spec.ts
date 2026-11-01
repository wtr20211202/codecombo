import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 提交快照端点（tree/blob）E2E：Diff 视图与变更存储的数据源，此前零直接覆盖。
 *   - HEAD 快照树列出根条目、子目录树 path 参数（ref 必填——工作区列表已迁
 *     /file-tree，/tree 为纯快照树，语义收口见 db41c2b 及其后续演进）
 *   - blob 返回指定 ref 的文件内容
 *   - 无效 ref / 不存在路径 → 4xx
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-snapshot')
const PROJ = 'e2e-snapshot'

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

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders()
  const stale = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(path.join(REPO_DIR, 'src'), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'root.md'), 'root content\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'app.ts'), 'const app = "snapshot-e2e"\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: snapshot 基线'])
})

let projectId = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders()
  const created = await request.post(`${API_BASE}/api/projects`, {
    headers, data: { name: PROJ, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders()
  if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

test('tree：HEAD 快照树根列表 + 子目录列表（ref 必填）', async ({ request }) => {
  const headers = await unlockHeaders()
  const head = git(REPO_DIR, ['rev-parse', 'HEAD'])

  // 根列表：含 root.md 与 src 目录（工作区列表已迁 /file-tree，/tree 为纯快照树）
  const root = await request.get(`${API_BASE}/api/projects/${projectId}/tree?ref=${head}`, { headers })
  expect(root.ok()).toBeTruthy()
  const rootBody = (await root.json()) as { data?: Array<{ name: string; isDir?: boolean }> }
  const names = (rootBody.data || []).map(e => e.name)
  expect(names).toContain('root.md')
  expect(names).toContain('src')

  // 子目录列表：src 下含 app.ts
  const sub = await request.get(`${API_BASE}/api/projects/${projectId}/tree?ref=${head}&path=src`, { headers })
  expect(sub.ok()).toBeTruthy()
  const subBody = (await sub.json()) as { data?: Array<{ name: string }> }
  expect((subBody.data || []).map(e => e.name)).toContain('app.ts')
})

test('snapshot blob：指定 ref 的文件内容', async ({ request }) => {
  const headers = await unlockHeaders()
  const head = git(REPO_DIR, ['rev-parse', 'HEAD'])

  const blob = await request.get(`${API_BASE}/api/projects/${projectId}/blob?ref=${head}&path=src/app.ts`, { headers })
  expect(blob.ok()).toBeTruthy()
  const body = (await blob.json()) as { data?: string }
  expect(body.data).toContain('snapshot-e2e')
})

test('snapshot 语义：tree 无 ref 显式 400（ref 必填收口）+ blob 非法输入 4xx', async ({ request }) => {
  const headers = await unlockHeaders()
  const head = git(REPO_DIR, ['rev-parse', 'HEAD'])

  // /tree 已收口为纯快照树（工作区列表迁 /file-tree）：无 ref 显式 400，
  // 不再回落工作区目录列表——调用方误当工作区接口用会直接失败而非静默错数据
  const withoutRef = await request.get(`${API_BASE}/api/projects/${projectId}/tree`, { headers })
  expect(withoutRef.status()).toBe(400)

  const badRef = await request.get(`${API_BASE}/api/projects/${projectId}/blob?ref=deadbeef00&path=root.md`, { headers })
  expect(badRef.status()).toBeGreaterThanOrEqual(400)
  expect(badRef.status()).toBeLessThan(500)

  const badPath = await request.get(`${API_BASE}/api/projects/${projectId}/blob?ref=${head}&path=src/none.ts`, { headers })
  expect(badPath.status()).toBeGreaterThanOrEqual(400)
})
