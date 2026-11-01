import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * .gitignore / git exclude 端点 E2E：
 *   - GET 无文件 → 空串（不报错）
 *   - PUT 覆盖 → GET 回读一致
 *   - POST rule 追加 → 文件尾部含新规则
 *   - git exclude 规则 → 落在 .git/info/exclude（不改 .gitignore）且文件被忽略
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-gitignore')
const PROJ = 'e2e-gitignore'

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
  fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'gitignore e2e\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: gitignore 基线'])
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

test('gitignore：GET 空态 → PUT 覆盖 → POST rule 追加', async ({ request }) => {
  const headers = savedHeaders

  // 初始无 .gitignore → 空串而非报错
  const empty = await request.get(`${API_BASE}/api/projects/${projectId}/gitignore`, { headers })
  expect(empty.ok()).toBeTruthy()
  expect(((await empty.json()) as { data?: string }).data).toBe('')

  // PUT 整体覆盖
  const put = await request.put(`${API_BASE}/api/projects/${projectId}/gitignore`, {
    headers, data: { content: '*.log\nnode_modules/\n' },
  })
  expect(put.ok()).toBeTruthy()
  expect(fs.readFileSync(path.join(REPO_DIR, '.gitignore'), 'utf8')).toBe('*.log\nnode_modules/\n')

  // POST rule 追加（不覆盖已有内容）
  const rule = await request.post(`${API_BASE}/api/projects/${projectId}/gitignore/rule`, {
    headers, data: { rule: 'dist/' },
  })
  expect(rule.ok()).toBeTruthy()
  const after = fs.readFileSync(path.join(REPO_DIR, '.gitignore'), 'utf8')
  expect(after).toContain('*.log')
  expect(after).toContain('dist/')
})

test('git exclude：规则落 info/exclude 且文件被 git 忽略', async ({ request }) => {
  const headers = savedHeaders
  const beforeGitignore = fs.readFileSync(path.join(REPO_DIR, '.gitignore'), 'utf8')

  const rule = await request.post(`${API_BASE}/api/projects/${projectId}/git-exclude/rule`, {
    headers, data: { rule: 'local-only.tmp' },
  })
  expect(rule.ok()).toBeTruthy()

  // .git/info/exclude 含规则，.gitignore 未被修改
  const exclude = fs.readFileSync(path.join(REPO_DIR, '.git', 'info', 'exclude'), 'utf8')
  expect(exclude).toContain('local-only.tmp')
  expect(fs.readFileSync(path.join(REPO_DIR, '.gitignore'), 'utf8')).toBe(beforeGitignore)

  // 行为面：该文件确实被 git 忽略
  fs.writeFileSync(path.join(REPO_DIR, 'local-only.tmp'), 'x\n')
  expect(git(REPO_DIR, ['check-ignore', 'local-only.tmp'])).toContain('local-only.tmp')
})
