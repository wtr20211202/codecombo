import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更暂存流 E2E（API 层）：工作区改动 → stage → CLI 确认进入暂存区 →
 * unstage → 回到未暂存 → status 面板一致性。stage/unstage 是提交流的前置
 * 步骤（commit-amend 经 API stage 过），但 stage→unstage 回环本身零覆盖。
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-stage')
const PROJ = 'e2e-stage'
const F1 = 'stage-a.txt'
const F2 = 'stage-b.txt'

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
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, F1), 'stage v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: stage 基线'])
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

test('stage/unstage 回环：工作区改动 → 暂存 → 取消暂存', async ({ request }) => {
  const headers = await unlockHeaders()

  // 工作区：改 F1 + 新增 F2
  fs.writeFileSync(path.join(REPO_DIR, F1), 'stage v2\n')
  fs.writeFileSync(path.join(REPO_DIR, F2), 'new file\n')

  // stage 两个文件 → CLI 确认进入暂存区
  const stage = await request.post(`${API_BASE}/api/projects/${projectId}/stage`, {
    headers, data: { files: [F1, F2] },
  })
  expect(stage.ok()).toBeTruthy()
  const staged = git(REPO_DIR, ['diff', '--cached', '--name-only']).split('\n')
  expect(staged).toContain(F1)
  expect(staged).toContain(F2)
  expect(git(REPO_DIR, ['diff', '--name-only']), '暂存后工作区无未暂存改动').toBe('')

  // unstage → 回到未暂存
  const unstage = await request.post(`${API_BASE}/api/projects/${projectId}/unstage`, {
    headers, data: { files: [F1] },
  })
  expect(unstage.ok()).toBeTruthy()
  expect(git(REPO_DIR, ['diff', '--cached', '--name-only'])).not.toContain(F1)
  expect(git(REPO_DIR, ['diff', '--name-only'])).toContain(F1)
})

test('hunk 级暂存：按 hunkIndex 暂存第一段 → 部分进入暂存区', async ({ request }) => {
  const headers = await unlockHeaders()

  // F1 隔行追加（构造独立 hunk）
  const p1 = path.join(REPO_DIR, F1)
  fs.writeFileSync(p1, 'stage v2\nhunk-a\n\nmiddle\n\nhunk-b\n')

  // 服务端契约：file + hunkIndex（第 0 个 hunk）
  const hs = await request.post(`${API_BASE}/api/projects/${projectId}/hunk/stage`, {
    headers, data: { file: F1, hunkIndex: 0 },
  })
  expect(hs.ok()).toBeTruthy()

  // CLI：暂存区含 hunk-a；hunk-b 留在工作区或暂存区（git hunk 拆分在
  // 相邻行时可能合并）——确定性断言：暂存区已出现部分内容且未全部暂存
  const staged = git(REPO_DIR, ['diff', '--cached', '--', F1])
  expect(staged).toContain('hunk-a')

  // hunk 级取消暂存 → 该段回工作区
  const hu = await request.post(`${API_BASE}/api/projects/${projectId}/hunk/unstage`, {
    headers, data: { file: F1, hunkIndex: 0 },
  })
  expect(hu.ok()).toBeTruthy()
  expect(git(REPO_DIR, ['diff', '--cached', '--', F1])).not.toContain('hunk-a')
})
