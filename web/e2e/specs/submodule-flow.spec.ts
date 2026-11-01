import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Submodule 端点 E2E（GitManageModal 子模块页签数据源，此前零覆盖）：
 *   - 空仓库列表为空
 *   - 添加（本地 file:// 源）→ CLI .gitmodules 含配置 → 列表出现
 *   - 移除 → 列表消失
 * 自备主仓库 + 本地源仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-submodule')
const SRC_DIR = path.join(os.tmpdir(), 'sc-e2e-submodule-src')
const PROJ = 'e2e-submodule'
const SUB_PATH = 'libs/sub'
// 源仓库 URL 交服务端 git submodule add 用，按服务端形态交接
const SUB_URL = `file:///${serverPath(SRC_DIR).replace(/\\/g, '/')}`

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

test.beforeAll(async () => {
  savedHeaders = await unlockHeaders()
  const headers = savedHeaders
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [REPO_DIR, SRC_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  // 源仓库（submodule 的上游）
  fs.mkdirSync(SRC_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: SRC_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: SRC_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: SRC_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: SRC_DIR })
  fs.writeFileSync(path.join(SRC_DIR, 'lib.txt'), 'sub content\n')
  git(SRC_DIR, ['add', '.'])
  git(SRC_DIR, ['commit', '-m', 'root: submodule 源'])

  // 主仓库
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'main.md'), 'main repo\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: submodule 基线'])

  const created = await fetch(`${API_BASE}/api/projects`, {
    // 注册路径按服务端形态交接（linux 实例经 /mnt/c 同见 %TEMP% 夹具）
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR).replace(/\\/g, '/') }),
  })
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = savedHeaders['X-Lock-Token'] ? savedHeaders : await unlockHeaders()
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  // 先摘除 worktree 元数据风险点：直接删目录（.git/modules 残留不影响清理）
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  try { fs.rmSync(SRC_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

test('submodule 增删回环：空态 → 添加 → .gitmodules 落盘 → 移除', async ({ request }) => {
  const headers = savedHeaders

  // 空态
  const empty = await request.get(`${API_BASE}/api/projects/${projectId}/submodules`, { headers })
  expect(empty.ok()).toBeTruthy()
  expect(((await empty.json()) as { data?: unknown[] }).data?.length ?? 0).toBe(0)

  // 添加
  const add = await request.post(`${API_BASE}/api/projects/${projectId}/submodules`, {
    headers, data: { url: SUB_URL, path: SUB_PATH },
  })
  expect(add.ok()).toBeTruthy()

  // CLI：.gitmodules 落盘 + 列表出现
  expect(fs.readFileSync(path.join(REPO_DIR, '.gitmodules'), 'utf8')).toContain(SUB_PATH)
  const list = await request.get(`${API_BASE}/api/projects/${projectId}/submodules`, { headers })
  const names = ((await list.json()) as { data?: Array<{ path?: string }> }).data?.map(s => s.path) || []
  expect(names).toContain(SUB_PATH)

  // 移除
  const remove = await request.delete(`${API_BASE}/api/projects/${projectId}/submodules`, {
    headers, data: { path: SUB_PATH },
  })
  expect(remove.ok()).toBeTruthy()
  const list2 = await request.get(`${API_BASE}/api/projects/${projectId}/submodules`, { headers })
  expect((((await list2.json()) as { data?: Array<{ path?: string }> }).data?.length) ?? 0).toBe(0)
})
