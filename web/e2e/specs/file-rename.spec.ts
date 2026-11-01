import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件重命名/移动端点 E2E（file/rename 此前零覆盖）：
 *   - 重命名：内容保留、旧路径消失
 *   - 移动到子目录：内容保留
 *   - 越界 newPath（..）→ 400（SafeJoinProject 守卫）
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-file-rename')
const PROJ = 'e2e-file-rename'

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
  fs.mkdirSync(path.join(REPO_DIR, 'docs'), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'old-name.md'), 'rename me 9527\n')
  fs.writeFileSync(path.join(REPO_DIR, 'docs', 'nested.md'), 'nested content\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: rename 基线'])
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

test('重命名：内容保留 + 旧路径消失', async ({ request }) => {
  const res = await request.post(`${API_BASE}/api/projects/${projectId}/file/rename`, {
    headers: savedHeaders, data: { oldPath: 'old-name.md', newPath: 'new-name.md' },
  })
  expect(res.ok()).toBeTruthy()

  expect(fs.existsSync(path.join(REPO_DIR, 'old-name.md'))).toBe(false)
  expect(fs.readFileSync(path.join(REPO_DIR, 'new-name.md'), 'utf8')).toContain('rename me 9527')
})

test('移动到子目录：内容保留', async ({ request }) => {
  const res = await request.post(`${API_BASE}/api/projects/${projectId}/file/rename`, {
    headers: savedHeaders, data: { oldPath: 'new-name.md', newPath: 'docs/moved.md' },
  })
  expect(res.ok()).toBeTruthy()

  expect(fs.existsSync(path.join(REPO_DIR, 'new-name.md'))).toBe(false)
  expect(fs.readFileSync(path.join(REPO_DIR, 'docs', 'moved.md'), 'utf8')).toContain('rename me 9527')
})

test('越界 newPath：.. 遍历 → 400', async ({ request }) => {
  const res = await request.post(`${API_BASE}/api/projects/${projectId}/file/rename`, {
    headers: savedHeaders, data: { oldPath: 'docs/moved.md', newPath: '../escaped.md' },
  })
  expect(res.status()).toBeGreaterThanOrEqual(400)
  expect(res.status()).toBeLessThan(500)
  expect(fs.existsSync(path.join(os.tmpdir(), 'escaped.md'))).toBe(false)
})
