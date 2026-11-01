import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Stash diff 预览 E2E（P-20261002-89）：stash 时间舱在 apply/pop 前应可查看内容。
 *   列表行「查看 diff」→ 预览弹层（DiffViewer 只读渲染）展示该 stash 的变更
 *   （tracked 修改 + untracked 新文件）→ Esc 关闭。
 *   双 stash 用例核实 index 语义：列表第 i 行（服务端 /stashes 的 index）弹出的
 *   diff 标题是 stash@{i} 且内容只含该行自己的变更（与 git.StashShow 单测同款断言）。
 * 自备临时仓库，stash 经 API 播种（创建路径由 stash-flow.spec 覆盖），
 * afterAll 清理（项目/目录/uiState 归零，与 stash-flow 对称）。
 * 播种/断言口径：服务端 /stashes 为权威视图（UI 列表同源）——播种后轮询服务端
 * 确认入栈（连发 POST 撞 .git/index.lock 会 500，重试即可）；仓库真实状态断言
 * 用 expect.poll 轮询本地 git（Windows 文件层对 refs/stash 有可观测滞后，
 * stash-flow 同款口径）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-stash-diff')
const PROJ = 'e2e-stash-diff'
const FILE = '.e2e-stash-diff.tmp'
const UNTRACKED = '.e2e-stash-diff-untracked.tmp'
const TRACKED_MARK = 'stash-diff-e2e-tracked-v2'
const UNTRACKED_MARK = 'stash-diff-e2e-untracked-v2'
const SEED_MSG = 'e2e: stash diff 预览'
const ALPHA_MSG = 'e2e: stash diff alpha'
const BETA_MSG = 'e2e: stash diff beta'
const ALPHA_MARK = 'stash-diff-e2e-alpha-content'
const BETA_MARK = 'stash-diff-e2e-beta-content'

let projectId = ''

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

/** 服务端 stash 列表（权威视图，UI 列表同源） */
async function serverStashes(headers: Record<string, string>): Promise<Array<{ index: number; message: string }>> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/stashes`, { headers })
  expect(res.ok).toBeTruthy()
  const body = (await res.json()) as { data?: Array<{ index: number; message: string }> }
  return body.data || []
}

/** rmSync 重试：Windows 下残留 git 子进程句柄会让目录暂不可删（stash-flow 同款容忍） */
async function rmRepoDir() {
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(REPO_DIR, { recursive: true, force: true }); return } catch { await sleep(200) }
  }
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名会撞；并行 worker 的收尾可能晚于本轮清理）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
      await sleep(300)
    }
  }
  await rmRepoDir()
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'stash diff e2e v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: stash diff 基线提交'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
  // 保险：清掉残留 stash（目录重建成功时本为空；重建失败时靠这步归零，
  // 保证首用例的列表计数断言不受历史栈污染）
  for (const s of await serverStashes(headers)) {
    await fetch(`${API_BASE}/api/projects/${projectId}/stash/${s.index}`, { method: 'DELETE', headers })
  }
  await expect.poll(() => serverStashes(headers), { timeout: 5000 }).toHaveLength(0)
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
  await rmRepoDir()
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
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
}

/** 经 API 写入工作区文件（服务端同路径写，git 可见） */
async function writeFile(headers: Record<string, string>, relPath: string, content: string) {
  const put = await fetch(`${API_BASE}/api/projects/${projectId}/file`, {
    method: 'PUT', headers, body: JSON.stringify({ path: relPath, content }),
  })
  expect(put.ok).toBeTruthy()
}

/**
 * 经 API 播种一条 stash（含 untracked）并轮询服务端 /stashes 确认入栈。
 * 连发播种撞 .git/index.lock 会 500 → 失败退避重试（上限 5 次）。
 */
async function seedStash(headers: Record<string, string>, message: string) {
  for (let i = 0; i < 5; i++) {
    const create = await fetch(`${API_BASE}/api/projects/${projectId}/stash`, {
      method: 'POST', headers, body: JSON.stringify({ message, includeUntracked: true }),
    })
    if (create.ok && (await serverStashes(headers)).some((s) => s.message.includes(message))) return
    await sleep(400)
  }
  throw new Error(`seedStash 失败：${message} 5 次尝试未入栈`)
}

/** 切到 stash 页签（提交面板页签语义锚点，P-20261002-151） */
async function openStashTab(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="cp-tab-stash"]').click()
  await expect(page.locator('.cp-stash-toolbar')).toBeVisible({ timeout: 3000 })
}

/** 打开指定列表行的 diff 预览弹层并断言标题为 stash@{index} */
async function openDiffModal(page: import('@playwright/test').Page, rowMessage: string, index: number) {
  await page.locator('.cp-stash-item').filter({ hasText: rowMessage }).first().getByRole('button', { name: '查看 diff' }).click()
  const modal = page.locator('.n-modal').filter({ hasText: 'Stash 内容预览' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  await expect(modal).toContainText(`stash@{${index}}`)
  return modal
}

test('stash diff 预览：列表查看 → 弹层展示 tracked 变更 + untracked 新文件', async ({ page }) => {
  const headers = await unlockHeaders()
  // 播种：tracked 修改 + untracked 新文件 → stash（-u）
  await writeFile(headers, FILE, `${TRACKED_MARK}\n`)
  await writeFile(headers, UNTRACKED, `${UNTRACKED_MARK}\n`)
  await expect.poll(async () => git(REPO_DIR, ['status', '--porcelain']), { timeout: 5000 }).not.toBe('')
  await seedStash(headers, SEED_MSG)

  await enterProject(page)
  await openStashTab(page)
  await expect(page.locator('.cp-stash-item').filter({ hasText: SEED_MSG })).toHaveCount(1, { timeout: 5000 })

  const modal = await openDiffModal(page, SEED_MSG, 0)

  // 弹层内容：tracked 修改行 + untracked 文件（--include-untracked 生效）
  await expect(modal.locator('.sdm-diff')).toContainText(TRACKED_MARK, { timeout: 5000 })
  await expect(modal.locator('.sdm-diff')).toContainText(UNTRACKED)
  await expect(modal.locator('.sdm-diff')).toContainText(UNTRACKED_MARK)

  // Esc 关闭弹层
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal').filter({ hasText: 'Stash 内容预览' })).toBeHidden({ timeout: 3000 })

  // 仓库真实状态（轮询防 Windows refs/stash 滞后）
  await expect.poll(async () => git(REPO_DIR, ['stash', 'list']), { timeout: 5000 }).toContain('stash diff 预览')
})

test('stash diff 预览 index 对应：第 i 行弹出的 diff 标题是 stash@{i} 且内容只含该行变更', async ({ page }) => {
  const headers = await unlockHeaders()
  // 播种两条 stash（alpha 先入栈旧、beta 后入栈新）
  await writeFile(headers, FILE, `${ALPHA_MARK}\n`)
  await seedStash(headers, ALPHA_MSG)
  await writeFile(headers, FILE, `${BETA_MARK}\n`)
  await seedStash(headers, BETA_MSG)

  // index 语义取服务端 /stashes 权威视图（UI 列表即由它渲染）
  const stashes = await serverStashes(headers)
  const alphaIdx = stashes.find((s) => s.message.includes(ALPHA_MSG))?.index ?? -1
  const betaIdx = stashes.find((s) => s.message.includes(BETA_MSG))?.index ?? -1
  expect(alphaIdx).toBeGreaterThanOrEqual(0)
  expect(betaIdx).toBeGreaterThanOrEqual(0)

  await enterProject(page)
  await openStashTab(page)

  // alpha 行：标题 stash@{alphaIdx}，内容只含 alpha 变更（不含 beta）
  const alphaModal = await openDiffModal(page, ALPHA_MSG, alphaIdx)
  await expect(alphaModal.locator('.sdm-diff')).toContainText(ALPHA_MARK, { timeout: 5000 })
  await expect(alphaModal.locator('.sdm-diff')).not.toContainText(BETA_MARK)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal').filter({ hasText: 'Stash 内容预览' })).toBeHidden({ timeout: 3000 })

  // beta 行：标题 stash@{betaIdx}，内容只含 beta 变更
  const betaModal = await openDiffModal(page, BETA_MSG, betaIdx)
  await expect(betaModal.locator('.sdm-diff')).toContainText(BETA_MARK, { timeout: 5000 })
  await expect(betaModal.locator('.sdm-diff')).not.toContainText(ALPHA_MARK)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal').filter({ hasText: 'Stash 内容预览' })).toBeHidden({ timeout: 3000 })

  // 仓库真实状态（轮询防 Windows refs/stash 滞后）：两条消息都在栈里
  await expect.poll(async () => git(REPO_DIR, ['stash', 'list']), { timeout: 5000 }).toContain(ALPHA_MSG)
  await expect.poll(async () => git(REPO_DIR, ['stash', 'list']), { timeout: 5000 }).toContain(BETA_MSG)
})
