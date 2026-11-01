import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * uiState 多标签写竞争 E2E（P-20261002-8）：写入语义「全量覆盖/整包」→
 * 「键级 PATCH（服务端读-合并-写 + 客户端脏键 diff）」。
 *   ① 同 context 双页同项目：B 开底部终端面板（写 layout）→ A 零改动关闭
 *     （beforeunload forceSave）→ 断言 B 的 showBottomPanel 未被 A 的 boot
 *     旧值回滚，且 A 关闭时零 uiState 请求（脏键 diff 零写）
 *   ② A 打开文件（写 editor 命名空间）→ A 关闭 → editor 与 B 的 layout 两键
 *     并存：键级合并而非整记录覆盖（旧实现 A 的整包 PUT 会连带回滚 layout）
 * 自备临时仓库，afterAll 清理（含 uiState local 记录，防串扰后续用例）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-uistate-multitab')
const PROJ = 'e2e-uistate-multitab'
const FILE_A = 'multitab-a.txt'

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

/** 服务端 uiState 的 local 记录（键级断言用） */
async function readLocalUIState(headers: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
  const body = (await res.json()) as { data?: Record<string, Record<string, unknown>> }
  return body.data?.local || {}
}

/** ui-state 写请求捕获器：调试/断言两用——记录 tag/时刻/method/载荷，失败时
 *  随断言消息输出（定位「谁在什么时刻写了什么键」）；同时记录该页 boot GET
 *  读到的基底（首条 /api/ui-state 响应），佐证 diff 基底来源 */
function attachUIStateWriteLog(page: import('@playwright/test').Page, tag: string, log: string[]) {
  const t0 = Date.now()
  let bootBaseLogged = false
  page.on('response', async (r) => {
    if (bootBaseLogged || !r.url().includes('/api/ui-state') || r.request().method() !== 'GET') return
    bootBaseLogged = true
    let base = ''
    try {
      const body = (await r.json()) as { data?: Record<string, unknown> }
      base = JSON.stringify(body.data?.local ?? null)
    } catch { base = '<unreadable>' }
    log.push(`[${tag}] +${Date.now() - t0}ms BOOT-GET base.local=${base}`)
  })
  page.on('request', (r) => {
    const url = r.url()
    if (!url.includes('/api/ui-state') || r.method() === 'GET') return
    log.push(`[${tag}] +${Date.now() - t0}ms ${r.method()} ${r.postData() || ''}`)
  })
}

/** 打开项目页（不点文件树） */
async function openProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  // 等 boot 恢复与首次归一化补丁落定（防抖 500ms + 网络余量）
  await page.waitForTimeout(1500)
}

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE_A), 'multitab fixture a\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: multitab 基线'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
  // 基线归零：前序用例遗留的面板开合随跑序漂移（toggle 语义），清空后两页
  // 都从「面板全关」默认布局起步，断言确定
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT', headers, body: JSON.stringify({ local: null }),
  })
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
  // 页面全部关闭后再清 uiState：清早了会被存续页面的保存写回
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test('多标签写竞争：B 开面板 → A 零改动关闭 → B 的面板不被回滚', async ({ page }) => {
  test.setTimeout(60000)
  const writes: string[] = []
  attachUIStateWriteLog(page, 'A', writes)
  // A 页：打开项目（boot 快照 S0：面板全关）
  await openProject(page)

  // B 页（同 context 同 localStorage → 同实例记录 local）
  const pageB = await page.context().newPage()
  attachUIStateWriteLog(pageB, 'B', writes)
  await openProject(pageB)

  // 统计 A 页发出的 uiState PATCH（关页阶段必须为零）
  let aPatchCount = 0
  page.on('request', (r) => {
    if (r.method() === 'PATCH' && r.url().includes('/api/ui-state')) aPatchCount++
  })

  // B 切底部终端面板（Ctrl+` → showBottomPanel true）→ 等防抖补丁落定
  await pageB.keyboard.press('Control+`')
  await expect(pageB.locator('.bottom-panel')).toBeVisible()
  await pageB.waitForTimeout(1200)

  // B 的键级补丁已落库：服务端可见
  const headers = await unlockHeaders()
  const afterB = await readLocalUIState(headers)
  expect((afterB.layout as Record<string, unknown> | undefined)?.showBottomPanel, `writes=${writes.join(' | ')}`).toBe(true)

  // A 零改动关闭（beforeunload forceSave）：旧实现整包 PUT 会用 boot 旧值
  // 回滚 B；新实现 diff 零变更 → 零请求
  const before = aPatchCount
  await page.close({ runBeforeUnload: true })
  await pageB.waitForTimeout(900)
  expect(aPatchCount, `writes=${writes.join(' | ')}`).toBe(before)

  // 核心断言：B 的面板状态未被 A 的关页动作回滚
  const afterClose = await readLocalUIState(headers)
  expect((afterClose.layout as Record<string, unknown> | undefined)?.showBottomPanel, `writes=${writes.join(' | ')}`).toBe(true)
  await pageB.close()
})

test('键级并存：A 打开文件关闭后 editor 与 B 的 layout 两键互不覆盖', async ({ page }) => {
  test.setTimeout(60000)
  // 基线归零：上一用例遗留的 showBottomPanel=true 会让本用例 B 页 boot 恢复出
  // 「面板已开」，Ctrl+` 的 toggle 语义就变成关（面板开合随跑序漂移，必须归一）。
  // 此刻无存活页面（上一用例两页均已关闭），清空不会被写回
  const headers0 = await unlockHeaders()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT', headers: headers0, body: JSON.stringify({ local: null }),
  })

  // A 页：打开项目，并在文件树打开一个文件（本页动过 editor 命名空间）
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE_A }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE_A }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toBeVisible()
  await page.waitForTimeout(1200)

  // B 页：开底部面板并等补丁落定
  const pageB = await page.context().newPage()
  await openProject(pageB)
  await pageB.keyboard.press('Control+`')
  await expect(pageB.locator('.bottom-panel')).toBeVisible()
  await pageB.waitForTimeout(1200)

  // A 关闭：补丁只应携带 A 动过的键（editor 等），绝不整包覆盖 layout
  await page.close({ runBeforeUnload: true })
  await pageB.waitForTimeout(900)

  const headers = await unlockHeaders()
  const final = await readLocalUIState(headers)
  // A 的 editor 键存活（A 关页补丁送达）
  expect(((final.editor as Record<string, unknown> | undefined)?.openFiles as string[] | undefined)?.length).toBeGreaterThan(0)
  // B 的 layout 键同存活（未被 A 的补丁连带覆盖）
  expect((final.layout as Record<string, unknown> | undefined)?.showBottomPanel).toBe(true)
  await pageB.close()
})
