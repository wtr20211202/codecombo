import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * stash 操作 hash 稳定引用（P-20261003-264）E2E：
 *   API 面：列表每条带完整 hash；hash 寻址 diff/drop 在栈位漂移后仍指向原条目；
 *           drop 后旧 hash 的所有操作（diff/drop/pop/apply/branch）明确 409 +
 *           稳定标记、不误动相邻条目；index 入口（DELETE /stash/0）渐进保留。
 *   UI 面：列表行被外部（另一标签页语义）drop 后点「删除」——按 hash 明确报错
 *           并本地化提示，绝不按旧 index 误删当前栈位上的相邻条目。
 * 自备临时仓库，afterAll 清理（项目/目录/uiState 归零，与 stash-flow 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-stash-hash')
const PROJ = 'e2e-stash-hash'
const FILE = '.e2e-stash-hash.tmp'
const ALPHA_MSG = 'e2e: hash alpha（后入栈）'
const BETA_MSG = 'e2e: hash beta（先入栈）'
const GAMMA_MSG = 'e2e: hash gamma 哨兵'
const STALE_MARKER = 'stash entry no longer exists'

let projectId = ''

interface ServerStash {
  index: number
  message: string
  hash: string
}

// 固定参数列表调用 git（无 shell 拼接），身份 -c 内联不依赖本机 git 配置
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

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'stash hash e2e v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: stash hash 基线提交'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // uiState 归零收尾（与 stash-flow 对称，防布局恢复污染后续 spec）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
}

/** 切到 stash 页签（提交面板页签语义锚点） */
async function openStashTab(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="cp-tab-stash"]').click()
  await expect(page.locator('.cp-stash-toolbar')).toBeVisible({ timeout: 3000 })
}

/** 经 API 写入工作区文件（服务端同路径写，git 可见） */
async function writeFile(headers: Record<string, string>, content: string) {
  const put = await fetch(`${API_BASE}/api/projects/${projectId}/file`, {
    method: 'PUT', headers, body: JSON.stringify({ path: FILE, content }),
  })
  expect(put.ok).toBeTruthy()
}

/** 写入变更 → 经 API 建 stash（消息可寻址） */
async function seedStash(headers: Record<string, string>, content: string, message: string) {
  await writeFile(headers, content)
  const create = await fetch(`${API_BASE}/api/projects/${projectId}/stash`, {
    method: 'POST', headers, body: JSON.stringify({ message }),
  })
  expect(create.ok, `创建 stash 失败：${message}`).toBeTruthy()
}

async function serverStashes(headers: Record<string, string>): Promise<ServerStash[]> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/stashes`, { headers })
  expect(res.ok).toBeTruthy()
  const body = (await res.json()) as { data?: ServerStash[] }
  return body.data || []
}

/** 用例开头清空 stash（跨用例共享的服务端域先归零） */
async function clearStashes(headers: Record<string, string>) {
  for (let i = 0; i < 10; i++) {
    const list = await serverStashes(headers)
    if (list.length === 0) return
    const del = await fetch(`${API_BASE}/api/projects/${projectId}/stash/0`, { method: 'DELETE', headers })
    expect(del.ok, '前置：清理遗留 stash 条目').toBeTruthy()
  }
}

test('hash 寻址：列表带 hash，栈位漂移后旧 hash 仍命中原条目；drop 后旧 hash 明确拒绝不错位', async () => {
  const headers = await unlockHeaders()
  await clearStashes(headers)
  // beta 先入栈（旧 → index 1），alpha 后入栈（新 → index 0）
  await seedStash(headers, 'stash hash e2e beta\n', BETA_MSG)
  await seedStash(headers, 'stash hash e2e alpha\n', ALPHA_MSG)

  let list = await serverStashes(headers)
  const alpha = list.find((s) => s.message === ALPHA_MSG)
  const beta = list.find((s) => s.message === BETA_MSG)
  expect(alpha, 'alpha 条目应存在').toBeTruthy()
  expect(beta, 'beta 条目应存在').toBeTruthy()
  const alphaHash = alpha?.hash || ''
  const betaHash = beta?.hash || ''
  expect(list.map((s) => s.index)).toEqual([0, 1])
  // 每条下发完整 commit OID（SHA-1 40 / SHA-256 64），且两者不同
  expect(alphaHash).toMatch(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
  expect(betaHash).toMatch(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/)
  expect(alphaHash).not.toBe(betaHash)

  // hash 寻址 diff：alpha 内容只含 alpha（不串到 beta）
  let res = await fetch(`${API_BASE}/api/projects/${projectId}/stashes/${alphaHash}/diff`, { headers })
  expect(res.ok, 'hash 预览应成功').toBeTruthy()
  let diff = ((await res.json()) as { data?: string }).data || ''
  expect(diff).toContain('stash hash e2e alpha')
  expect(diff).not.toContain('stash hash e2e beta')

  // 外部 drop beta（旧 index=0）→ alpha 从 1 前移到 0；旧 alpha hash 仍命中 alpha
  res = await fetch(`${API_BASE}/api/projects/${projectId}/stash/${betaHash}`, { method: 'DELETE', headers })
  expect(res.ok, '按 hash 删除 beta 应成功').toBeTruthy()
  list = await serverStashes(headers)
  expect(list).toHaveLength(1)
  expect(list[0].message).toBe(ALPHA_MSG)
  expect(list[0].index).toBe(0)
  res = await fetch(`${API_BASE}/api/projects/${projectId}/stashes/${alphaHash}/diff`, { headers })
  expect(res.ok, '前移后旧 alpha hash 预览应成功').toBeTruthy()
  diff = ((await res.json()) as { data?: string }).data || ''
  expect(diff).toContain('stash hash e2e alpha')

  // drop alpha 后其 hash 失效：所有操作 409 + 稳定标记，且请求体 index=0
  // （当前栈位是哨兵条目）绝不误吃相邻条目
  res = await fetch(`${API_BASE}/api/projects/${projectId}/stash/${alphaHash}`, { method: 'DELETE', headers })
  expect(res.ok, '按 hash 删除 alpha 应成功').toBeTruthy()
  await seedStash(headers, 'stash hash e2e gamma\n', GAMMA_MSG)
  expect(await serverStashes(headers)).toHaveLength(1)

  const staleOps: Array<{ name: string; method: string; url: string; body?: string }> = [
    { name: 'diff', method: 'GET', url: `/stashes/${alphaHash}/diff` },
    { name: 'drop', method: 'DELETE', url: `/stash/${alphaHash}` },
    { name: 'pop', method: 'POST', url: '/stash/pop', body: JSON.stringify({ index: 0, hash: alphaHash }) },
    { name: 'apply', method: 'POST', url: '/stash/apply', body: JSON.stringify({ index: 0, hash: alphaHash }) },
    { name: 'branch', method: 'POST', url: '/stash/branch', body: JSON.stringify({ index: 0, hash: alphaHash, name: 'stale-trial' }) },
  ]
  for (const op of staleOps) {
    const r = await fetch(`${API_BASE}/api/projects/${projectId}${op.url}`, {
      method: op.method, headers, body: op.body,
    })
    expect(r.status, `${op.name} 对旧 hash 应 409`).toBe(409)
    const err = ((await r.json()) as { error?: string }).error || ''
    expect(err, `${op.name} 应返回稳定标记`).toContain(STALE_MARKER)
  }
  // 哨兵原样：列表未被误删、工作区未被套用、stale-trial 分支未创建
  list = await serverStashes(headers)
  expect(list).toHaveLength(1)
  expect(list[0].message).toBe(GAMMA_MSG)
  expect(git(REPO_DIR, ['status', '--porcelain'])).toBe('')
  expect(git(REPO_DIR, ['branch', '--list', 'stale-trial'])).toBe('')

  // index 入口渐进保留（旧前端/脚本形态）：DELETE /stash/0 删哨兵
  res = await fetch(`${API_BASE}/api/projects/${projectId}/stash/0`, { method: 'DELETE', headers })
  expect(res.ok, 'index 入口删除应成功').toBeTruthy()
  expect(await serverStashes(headers)).toHaveLength(0)
})

test('UI 旧行删除：外部 drop 后按 hash 明确报错，不误删相邻条目', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearStashes(headers)
  // beta 先入栈（index 1），alpha 后入栈（index 0）——UI 列表序 alpha 在前
  await seedStash(headers, 'stash hash e2e beta\n', BETA_MSG)
  await seedStash(headers, 'stash hash e2e alpha\n', ALPHA_MSG)
  const alpha = (await serverStashes(headers)).find((s) => s.message === ALPHA_MSG)
  expect(alpha, 'alpha 条目应存在').toBeTruthy()
  const alphaHash = alpha?.hash || ''

  await enterProject(page)
  await openStashTab(page)
  const alphaRow = page.locator('.cp-stash-item').filter({ hasText: ALPHA_MSG })
  await expect(alphaRow).toHaveCount(1, { timeout: 5000 })

  // 另一标签页语义：外部 drop alpha（UI 列表未刷新，旧行 index=0 已指向 beta）
  const drop = await fetch(`${API_BASE}/api/projects/${projectId}/stash/${alphaHash}`, { method: 'DELETE', headers })
  expect(drop.ok).toBeTruthy()

  // 点旧行的「删除」：前端带 hash → 服务端 409 稳定标记 → 本地化提示；
  // 若仍按旧 index=0 下发会误删 beta——下方 git 断言钉住零误操作
  await alphaRow.getByRole('button', { name: '删除' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '暂存条目已不存在' })).toBeVisible({ timeout: 5000 })

  // refs/stash 更新在 Windows 文件层有可观测的短暂滞后 → poll 轮询
  await expect.poll(async () => git(REPO_DIR, ['stash', 'list']), { timeout: 5000 }).toContain(BETA_MSG)
  await expect.poll(async () => git(REPO_DIR, ['stash', 'list']), { timeout: 5000 }).not.toContain(ALPHA_MSG)
})
