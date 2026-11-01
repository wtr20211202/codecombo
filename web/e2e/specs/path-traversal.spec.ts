import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件端点路径遍历防护 E2E（安全 backlog A4 回归网）：
 * safeJoinProject 拒绝 `..` 段、Abs/EvalSymlinks 归一化、「根+分隔符」边界。
 * 各类遍历形态（../ 直拼、子目录内上跳、URL 编码 %2e%2e）均应 4xx 拒绝，
 * 且拒绝响应不得泄露目标路径内容。自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-traversal')
const PROJ = 'e2e-traversal'
const SECRET = 'top-secret-content-9527'

let projectId = ''

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
  fs.mkdirSync(path.join(REPO_DIR, 'docs'), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'traversal e2e\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: traversal 基线'])
  // 仓库外的敏感文件（模拟服务进程可访问的同盘文件）
  fs.writeFileSync(path.join(os.tmpdir(), 'sc-e2e-secret.txt'), SECRET)

  const created = await request.post(`${API_BASE}/api/projects`, {
    headers, data: { name: PROJ, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  expect(created.status()).toBeLessThan(300)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders()
  if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  try { fs.rmSync(path.join(os.tmpdir(), 'sc-e2e-secret.txt'), { force: true }) } catch { /* ignore */ }
})

test('文件读取：各类遍历形态均被拒绝且不泄露仓库外内容', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  const attempts = [
    ['..%2F..%2F.git%2Fconfig', 'URL 编码上跳'],
    ['docs%2F..%2F..%2Fsc-e2e-secret.txt', '子目录内双重上跳'],
    ['%2E%2E%2Fsc-e2e-secret.txt', '全编码点号'],
  ]
  for (const [enc, label] of attempts) {
    const res = await page.request.get(`${API_BASE}/api/projects/${projectId}/file?path=${enc}`)
    expect(res.status(), `${label} 应被拒绝`).toBeGreaterThanOrEqual(400)
    expect(res.status(), `${label} 不应是 5xx`).toBeLessThan(500)
    const text = await res.text()
    expect(text, `${label} 不得泄露仓库外内容`).not.toContain(SECRET)
  }

  // 正常路径不受影响（守卫不误伤）
  const ok = await page.request.get(`${API_BASE}/api/projects/${projectId}/file?path=readme.md`)
  expect(ok.status()).toBe(200)
})

test('文件树与下载端点：遍历形态同样拒绝', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  const headers = await unlockHeaders()

  // 文件树子目录遍历
  const tree = await page.request.get(`${API_BASE}/api/projects/${projectId}/file-tree?path=..%2F..%2F`)
  expect(tree.status()).toBeGreaterThanOrEqual(400)

  // 下载端点遍历（safeJoinProject 同标准）
  const dl = await page.request.get(`${API_BASE}/api/projects/${projectId}/file/download?path=..%2F..%2Fsc-e2e-secret.txt`)
  expect(dl.status()).toBeGreaterThanOrEqual(400)
  const dlText = await dl.text()
  expect(dlText).not.toContain(SECRET)
})
