import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 单文件聚合时间线（P-20261008-11）：git 提交与本地保存版本在文件历史弹窗合流。
 *   1. 播种 c1(提交) → 写 A(快照 s1) → c2(提交 A) → 写 B(快照 s2)：
 *      合流视图 [local s2, git c2, local s1] 按时间穿插 + 来源徽标（data-kind）
 *   2. 时间窗注记：窗口（最旧快照）之前的 c1 不混列，注记「更早的 1 条提交在
 *      Git 历史中」，点击切「只看 Git」
 *   3. 来源过滤：只看 Git（全量 2 提交，注记消失）/ 只看本地（2 快照）/ 全部
 *   4. 本地条目恢复走既有链：选最旧快照 → 右侧 DiffEditor 预览 → 确认 →
 *      磁盘回滚 + 恢复前内容自动入档（列表 +1）
 *   5. git 条目恢复：右侧 diff 即预览 → 确认 → 磁盘改写为该提交版本
 *      （rollback 端点可选 ref，与整文件回滚同语义）
 * 自备临时仓库（CLI 提交；快照经 PUT /file 生产写路径播种），afterAll 清理。
 * 播种步间 sleep 1.2s：提交时间（%at 秒精度）须严格晚于上一步的毫秒级快照 ts，
 * 否则同秒并列会动摇穿插次序断言。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-file-history-timeline')
const PROJ_NAME = 'e2e-file-history-timeline'
const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

let projectId = ''

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function lockHeaders(): Promise<Record<string, string>> {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = (await unlockRes.json()).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function apiWrite(pathInRepo: string, content: string) {
  const headers = await lockHeaders()
  const res = await fetch(`${BASE}/api/projects/${projectId}/file`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ path: pathInRepo, content }),
  })
  if (!res.ok) throw new Error(`write ${pathInRepo}: ${res.status}`)
}

async function apiRead(pathInRepo: string): Promise<string> {
  const headers = await lockHeaders()
  const res = await fetch(`${BASE}/api/projects/${projectId}/file?path=${encodeURIComponent(pathInRepo)}`, { headers })
  const body = await res.json()
  return typeof body?.data === 'string' ? body.data : ''
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

test.beforeAll(async () => {
  const headers = await lockHeaders()
  const stale = await (await fetch(BASE + '/api/projects', { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge

  // 主探针时间线：c1 → 写A(s1) → c2 → 写B(s2)，快照走 PUT /file 生产写路径
  fs.writeFileSync(path.join(REPO_DIR, 'timeline.md'), 'tl-v0-original\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: add timeline'])
  const res = await fetch(BASE + '/api/projects', {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  projectId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  if (!projectId) throw new Error('project create failed')

  await sleep(1200)
  await apiWrite('timeline.md', 'tl-v1-after-c1\n')
  await sleep(1200)
  fs.writeFileSync(path.join(REPO_DIR, 'timeline.md'), 'tl-v1-after-c1\n')
  git(REPO_DIR, ['add', 'timeline.md'])
  git(REPO_DIR, ['commit', '-m', 'c2: save v1'])
  await sleep(1200)
  await apiWrite('timeline.md', 'tl-v2-after-c2\n')

  // git 恢复探针：独立文件。基线提交 → 写 v1（快照 s1 = 基线内容）→ 提交 v1 →
  // 写 v2（快照 s2 = v1 内容）。合流视图 [s2, 提交v1, s1]，git 条目在窗口内
  // （窗口 = 最旧快照 s1；基线提交在窗外成注记）——git 恢复选中的提交版本 = v1
  fs.writeFileSync(path.join(REPO_DIR, 'restore.md'), 'gr-v0-original\n')
  git(REPO_DIR, ['add', 'restore.md'])
  git(REPO_DIR, ['commit', '-m', 'gr: baseline'])
  await sleep(1200)
  await apiWrite('restore.md', 'gr-v1-overwritten\n')
  await sleep(1200)
  fs.writeFileSync(path.join(REPO_DIR, 'restore.md'), 'gr-v1-overwritten\n')
  git(REPO_DIR, ['add', 'restore.md'])
  git(REPO_DIR, ['commit', '-m', 'gr: save v1'])
  await sleep(1200)
  await apiWrite('restore.md', 'gr-v2-overwritten\n')
})

test.afterAll(async () => {
  if (!projectId) return
  const headers = await lockHeaders()
  await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  // 重置持久化布局：uiState 是服务端全局状态，前序 spec 的面板开关经布局恢复
  // 污染进入流程（editor-git-tools 同款处理）
  await page.evaluate(async () => {
    await fetch('/api/ui-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local: null }),
    })
  })
  await page.reload()
  await gotoAndUnlock(page, BASE + '/')
  await projectCardByName(page, PROJ_NAME).first().click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——先保证面板打开
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.tree-action-btn[title="搜索文件"]').isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="项目文件"], .rail-btn[aria-label="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

async function openFileHistory(page: import('@playwright/test').Page, fileName: string) {
  await enterProject(page)
  const clickRetry = async (loc: import('@playwright/test').Locator, timeout = 2000, attempts = 8) => {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try { await loc.click({ timeout }); return } catch (err) { lastErr = err; await page.waitForTimeout(300) }
    }
    throw lastErr
  }
  await clickRetry(page.locator('.tree-action-btn[title="搜索文件"]'))
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  const searchInput = page.locator('.tree-search input')
  await searchInput.waitFor({ state: 'attached', timeout: 30000 }).catch(() => {})
  await clickRetry(searchInput)
  await searchInput.fill(fileName)
  await clickRetry(page.getByText(fileName).first(), 2000, 10)
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20000 })
  // 编辑器 Git 快捷操作「历史」→ FileHistoryModal（FileHistoryView 宿主）
  await clickRetry(page.locator('.ega-anchor button').filter({ hasText: '历史' }))
  const modal = page.locator('.n-modal').filter({ hasText: `文件历史：${fileName}` })
  await expect(modal).toBeVisible({ timeout: 5000 })
  await expect(modal.locator('[data-testid="fh-source-filter"]')).toBeVisible({ timeout: 10000 })
  // 双数据面（git log + 本地快照）取数完成后行才渲染——等首行出现再断言，
  // 防取数在途时 kinds 采到空集（首轮实测吃过的假败）
  await expect(modal.locator('[data-kind]').first()).toBeVisible({ timeout: 15000 })
  return modal
}

test('聚合时间线：穿插 + 来源徽标 + 时间窗注记 + 过滤切换 + 本地恢复走既有链', async ({ page }) => {
  const modal = await openFileHistory(page, 'timeline.md')

  // 合流穿插（全部来源，默认）：[local s2, git c2, local s1]，窗口前 c1 成注记
  const kinds = await modal.locator('[data-kind]').evaluateAll(els => els.map(e => e.getAttribute('data-kind')))
  expect(kinds).toEqual(['local', 'git', 'local'])
  await expect(modal.getByText('c2: save v1')).toBeVisible()
  await expect(modal.getByText('更早的 1 条提交在 Git 历史中')).toBeVisible()

  // 注记点击 → 切「只看 Git」：全量 2 提交、注记消失
  await modal.getByTestId('fh-older-note').click()
  await expect(modal.locator('[data-kind="git"]')).toHaveCount(2)
  await expect(modal.locator('[data-kind="local"]')).toHaveCount(0)
  await expect(modal.getByText('c1: add timeline')).toBeVisible()
  await expect(modal.getByText('更早的 1 条提交在 Git 历史中')).toHaveCount(0)

  // 过滤下拉：只看本地 → 2 快照；回到全部 → 3 条 + 注记
  await modal.getByTestId('fh-source-filter').click()
  await page.locator('.n-base-select-menu .n-base-select-option').filter({ hasText: '本地保存' }).click()
  await expect(modal.locator('[data-kind="local"]')).toHaveCount(2)
  await expect(modal.locator('[data-kind="git"]')).toHaveCount(0)
  await modal.getByTestId('fh-source-filter').click()
  await page.locator('.n-base-select-menu .n-base-select-option').filter({ hasText: '全部来源' }).click()
  await expect(modal.locator('[data-kind]')).toHaveCount(3)

  // 本地恢复走既有链：选最旧快照 s1（右侧预览 = 提交版原文）→ 确认 → 磁盘回滚
  await modal.locator('[data-kind="local"]').last().click()
  await expect(page.locator('.monaco-diff-editor .editor.original .view-lines')).toContainText('tl-v0-original', { timeout: 15000 })
  await modal.getByTestId('fh-restore').click()
  await page.getByRole('button', { name: '确认' }).click()
  // 磁盘回滚为 s1 内容；恢复前内容（v2）自动入档 → 合流列表 3 → 4
  await expect(modal.locator('[data-kind]')).toHaveCount(4, { timeout: 10000 })
  expect(await apiRead('timeline.md')).toBe('tl-v0-original\n')
})

test('git 条目恢复：预览 diff → 确认 → 磁盘改写为该提交版本', async ({ page }) => {
  const modal = await openFileHistory(page, 'restore.md')

  // 合流视图：[local v2 快照, git 提交v1, local 基线快照]；选 git 条目 → 右侧 diff 即预览
  const kinds = await modal.locator('[data-kind]').evaluateAll(els => els.map(e => e.getAttribute('data-kind')))
  expect(kinds).toEqual(['local', 'git', 'local'])
  await modal.locator('[data-kind="git"]').first().click()
  // 该提交的 diff（+gr-v1-overwritten）即恢复前预览
  await expect(modal.locator('.diff-line').filter({ hasText: 'gr-v1-overwritten' }).first()).toBeVisible({ timeout: 10000 })

  // 确认恢复 → 工作区文件改写为该提交版本（v1）
  await modal.getByTestId('fh-restore').click()
  await page.getByRole('button', { name: '确认' }).click()
  await expect.poll(async () => apiRead('restore.md'), { timeout: 10000 }).toBe('gr-v1-overwritten\n')
})
