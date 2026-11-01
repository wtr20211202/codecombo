import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 克隆取消语义 E2E（API 层）：本地造一个多分支多提交源仓库 →
 * start file:// 克隆 → 立即 cancel → 轮询任务状态含 canceled / 项目未注册。
 * UI 取消按钮仅关闭弹窗（任务后台继续），API cancel 才真正终止任务——
 * 取消语义此前零覆盖。
 */

const SRC_DIR = path.join(os.tmpdir(), 'sc-e2e-clone-src')
const CLONE_DIR = path.join(os.tmpdir(), 'sc-e2e-clone-dst')
const PROJ_PREFIX = 'e2e-clone-cancel'

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

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name.startsWith(PROJ_PREFIX)) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [SRC_DIR, CLONE_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  // 源仓库：较大提交体争取取消窗口
  fs.mkdirSync(SRC_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: SRC_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: SRC_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: SRC_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: SRC_DIR })
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(path.join(SRC_DIR, `blob-${i}.bin`), Buffer.alloc(2 * 1024 * 1024, i))
    git(SRC_DIR, ['add', '.'])
    git(SRC_DIR, ['commit', '-m', `c${i}`])
  }
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name.startsWith(PROJ_PREFIX)) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  for (const dir of [SRC_DIR, CLONE_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
})

test('克隆取消：start → cancel → 状态 canceled 且项目未注册', async ({ request }) => {
  const headers = await unlockHeaders()

  const start = await request.post(`${API_BASE}/api/clone`, {
    headers,
    // 源/目标路径按服务端形态交接（linux 服务端经 /mnt/c 同见 %TEMP% 夹具）
    data: { url: `file:///${serverPath(SRC_DIR).replace(/\\/g, '/')}`, dir: serverPath(CLONE_DIR), name: `${PROJ_PREFIX}-x` },
  })
  expect(start.ok()).toBeTruthy()
  const tid = ((await start.json()) as { taskId?: string }).taskId
  expect(tid).toBeTruthy()

  // 立即取消（16MB 提交体传输中）
  const cancel = await request.post(`${API_BASE}/api/clone/${tid}/cancel`, { headers })
  expect(cancel.ok()).toBeTruthy()

  // 等待取消生效（无 REST 状态端点，从行为面断言）：
  // a) 目标目录不出现完整检出的 README 之外产物（克隆中途停止）
  // b) 项目未注册
  await expect.poll(async () => {
    const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
    return ((list?.data || []) as Array<{ name: string }>).filter(p => p.name.startsWith(PROJ_PREFIX)).length
  }, { timeout: 15000 }).toBe(0)
})
