import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * hunk 级工作区回滚（discard change）E2E（API 层，P-20261003-49）：
 * 改两处 → discard 一处 → 另一处保留且暂存区不动 → 再 discard → 回基线；
 * 越界索引拒绝且文件/暂存区原样。
 *
 * 冲突拒绝（块已被再改 → 409 稳定标记 hunk no longer applies）在 API 层无法
 * 确定性注入——「派生 diff → apply」的 TOCTOU 窗口在单次请求内部（毫秒级），
 * 由 server/git/diff_discard_test.go 的 applyHunkReverse 注入路径覆盖，此处不重复。
 *
 * 全程以 git CLI 校验仓库真实状态，API 只负责驱动操作。
 * 自备临时仓库（core.autocrlf false，三平台行尾语义对齐），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-discard-hunk')
const PROJ = 'e2e-discard-hunk'
const F1 = 'hunk.txt'
const F2 = 'staged.txt'

// 基线 12 行：两处改动（第 2 / 11 行）相距 8 行上下文——默认 U3 diff 下
// 稳定拆成两个独立 hunk（间隙 > 2×上下文）
const BASELINE = [
  'alpha one',
  'alpha two',
  'ctx',
  'ctx',
  'ctx',
  'ctx',
  'ctx',
  'ctx',
  'ctx',
  'ctx',
  'omega one',
  'omega two',
  '',
].join('\n')
const BOTH_CHANGED = BASELINE.replace('alpha two', 'alpha T1').replace('omega one', 'omega T2')

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

function readFile(rel: string) {
  return fs.readFileSync(path.join(REPO_DIR, rel), 'utf8')
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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, F1), BASELINE)
  fs.writeFileSync(path.join(REPO_DIR, F2), 'staged v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: discard-hunk 基线'])

  const created = await request.post(`${API_BASE}/api/projects`, {
    headers, data: { name: PROJ, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId).not.toBe('')
})

let projectId = ''

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders()
  if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('改两处 → discard 第一处 → 第二处保留且暂存区不动', async ({ request }) => {
  const headers = await unlockHeaders()

  // 工作区两处改动 + 无关文件先行入暂存区（discard 不许碰索引的哨兵）
  fs.writeFileSync(path.join(REPO_DIR, F1), BOTH_CHANGED)
  fs.writeFileSync(path.join(REPO_DIR, F2), 'staged v2\n')
  git(REPO_DIR, ['add', F2])
  expect(git(REPO_DIR, ['diff', '--cached', '--name-only'])).toBe(F2)

  const hs = await (await request.get(`${API_BASE}/api/projects/${projectId}/file/hunks`, {
    headers, params: { file: F1, staged: 'false' },
  })).json() as { data?: { oldStart: number; content: string }[] }
  expect(hs.data).toHaveLength(2)
  expect(hs.data![0]!.content).toContain('alpha T1')

  const dis = await request.post(`${API_BASE}/api/projects/${projectId}/hunk/discard`, {
    headers, data: { file: F1, hunkIndex: 0 },
  })
  expect(dis.ok()).toBeTruthy()

  // CLI 实况：第一处还原、第二处保留
  const now = readFile(F1)
  expect(now).toContain('alpha two')
  expect(now).not.toContain('alpha T1')
  expect(now).toContain('omega T2')
  // 暂存区不动：哨兵文件原样在暂存、目标文件未被顺手暂存
  expect(git(REPO_DIR, ['diff', '--cached', '--name-only'])).toBe(F2)
  // 该文件仍是未暂存改动（omega 块）
  expect(git(REPO_DIR, ['diff', '--name-only'])).toBe(F1)
})

test('discard 第二处 → 文件回基线且暂存区仍原样', async ({ request }) => {
  const headers = await unlockHeaders()

  const hs = await (await request.get(`${API_BASE}/api/projects/${projectId}/file/hunks`, {
    headers, params: { file: F1, staged: 'false' },
  })).json() as { data?: unknown[] }
  expect(hs.data).toHaveLength(1)

  const dis = await request.post(`${API_BASE}/api/projects/${projectId}/hunk/discard`, {
    headers, data: { file: F1, hunkIndex: 0 },
  })
  expect(dis.ok()).toBeTruthy()

  expect(readFile(F1)).toBe(BASELINE)
  expect(git(REPO_DIR, ['diff', '--name-only']), '工作区应干净').toBe('')
  expect(git(REPO_DIR, ['diff', '--cached', '--name-only'])).toBe(F2)
})

test('越界 hunkIndex 拒绝：文件与暂存区原样', async ({ request }) => {
  const headers = await unlockHeaders()

  const dis = await request.post(`${API_BASE}/api/projects/${projectId}/hunk/discard`, {
    headers, data: { file: F1, hunkIndex: 99 },
  })
  expect(dis.ok()).toBeFalsy()
  const body = await dis.json() as { error?: string }
  expect(body.error).toContain('invalid hunk index')
  // 工作区干净文件未被改写，暂存区哨兵原样
  expect(git(REPO_DIR, ['diff', '--name-only'])).toBe('')
  expect(git(REPO_DIR, ['diff', '--cached', '--name-only'])).toBe(F2)
})
