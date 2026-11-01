import { execSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 审批卡 target 悬停浮窗 diff 预览（P-20261003-253）：
 *   1. 有未提交差异的 target 悬停 → 浮窗 diff 摘要出现（增删计数 + 变更行预览）
 *   2. 一次性拉取：浮窗收起再悬停不重发 diff 请求（首开缓存）
 *   3. 干净文件 target 悬停 → 浮窗空态提示（无 diff 时如实呈现）
 *   4. 悬停后点击仍直开 vs HEAD 差异视图（P-47 点击语义保留）
 * 夹具仓库经 API 注册为项目（approval-target-preview 同款），进入项目页建立
 * 当前项目上下文后播种审批；afterEach 清账防残留
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ = 'aprv-target-pop-proj'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理 pending 审批（卡片全局常驻，残留污染后续用例的 .aprv-card 计数） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

/** 清掉同名残留项目（前次运行崩溃遗留：夹具 tmpdir 已删，旧卡指向空路径） */
async function removeStaleProject(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  for (const p of list.filter(x => x.name === PROJ)) {
    await request.delete(`${BASE}/api/projects/${p.id}`, { headers }).catch(() => {})
  }
}

/** 夹具仓库：docs/notes.md 已提交（干净文件），src/app.ts 已提交后再改（未提交差异）*/
async function makeFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'sc-aprv-pop-'))
  const git = (args: string) => execSync(`git ${args}`, { cwd: repo })
  git('init')
  git('config core.autocrlf false')
  git('config user.email e2e@example.com')
  git('config user.name e2e')
  await mkdir(path.join(repo, 'docs'), { recursive: true })
  await mkdir(path.join(repo, 'src'), { recursive: true })
  await writeFile(path.join(repo, 'docs', 'notes.md'), 'clean committed note\n')
  await writeFile(path.join(repo, 'src', 'app.ts'), 'export const v = 1\n')
  git('add .')
  git('commit -m init')
  // 未提交差异：追加一行（git diff → +1 行）
  await writeFile(path.join(repo, 'src', 'app.ts'), 'export const v = 1\nexport const w = 2\n')
  return repo
}

/** 注册项目 → 进项目页（建立当前项目上下文），返回项目 id */
async function registerAndEnter(page: import('@playwright/test').Page, request: APIRequestContext, repoDir: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const projRes = await request.post(`${BASE}/api/projects`, {
    headers, data: { name: PROJ, path: serverPath(repoDir) },
  })
  expect([200, 201]).toContain(projRes.status())
  const plist = await (await request.get(`${BASE}/api/projects`, { headers })).json()
  const proj = ((plist?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
  expect(proj).toBeTruthy()

  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  return proj!.id
}

/** 播种 pending 审批并等卡片在屏 */
async function seedApproval(page: import('@playwright/test').Page, request: APIRequestContext, op: string, target: string): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId: 'sc_aprv_pop_e2e', op, target, detail: 'P-20261003-253 target 浮窗验证' },
  })
  expect(res.ok()).toBeTruthy()
  const id = ((await res.json()) as { data: { id: string } }).data.id
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  return id
}

async function cleanupProject(request: APIRequestContext, repoDir: string): Promise<void> {
  const headers = await unlockHeaders(request)
  const plist = await (await request.get(`${BASE}/api/projects`, { headers })).json()
  const mine = ((plist?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
  if (mine) await request.delete(`${BASE}/api/projects/${mine.id}`, { headers })
  await rm(repoDir, { recursive: true, force: true }).catch(() => {})
}

test.beforeEach(async ({ request }) => {
  await cleanupApprovals(request)
  await removeStaleProject(request)
})

test.afterEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test('有未提交差异的 target 悬停 → 浮窗 diff 摘要（计数+变更行）', async ({ page, request }) => {
  test.setTimeout(60000)
  const repoDir = await makeFixtureRepo()
  try {
    await registerAndEnter(page, request, repoDir)
    await seedApproval(page, request, 'write', 'src/app.ts')

    // 悬停延迟浮窗（400ms delay）：teleport 到 body 的摘要面板出现
    await page.locator('.aprv-card [data-test="aprv-target-link"]').hover()
    const pop = page.locator('[data-test="aprv-target-pop"]')
    await expect(pop).toBeVisible({ timeout: 10000 })
    // 头部脱敏 target 路径 + 增删计数（+1 -0）
    await expect(pop.locator('[data-test="aprv-target-pop-path"]')).toHaveText('src/app.ts')
    await expect(pop.locator('[data-test="aprv-target-pop-stat"]')).toContainText('+1')
    await expect(pop.locator('[data-test="aprv-target-pop-stat"]')).toContainText('-0')
    // 变更行预览（工作区 diff 摘要正文）
    await expect(pop.locator('[data-test="aprv-target-pop-line"]').first()).toHaveText('export const w = 2')
  } finally {
    await cleanupProject(request, repoDir)
  }
})

test('一次性拉取：浮窗收起再悬停不重发 diff 请求', async ({ page, request }) => {
  test.setTimeout(60000)
  const repoDir = await makeFixtureRepo()
  // 记账 /file/diff 请求（首开两发：未暂存 + 已暂存）；按 file 参数过滤，
  // 项目页其他组件的偶发 diff 请求不干扰计数
  let diffReqCount = 0
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (u.pathname.endsWith('/file/diff') && u.searchParams.get('file') === 'src/app.ts') {
      diffReqCount++
    }
  })
  try {
    await registerAndEnter(page, request, repoDir)
    await seedApproval(page, request, 'write', 'src/app.ts')

    const link = page.locator('.aprv-card [data-test="aprv-target-link"]')
    await link.hover()
    await expect(page.locator('[data-test="aprv-target-pop"]')).toBeVisible({ timeout: 10000 })
    await expect.poll(() => diffReqCount, { timeout: 5000 }).toBe(2)

    // 移出收起浮窗（duration 100ms）→ 再悬停：命中缓存，请求计数不变
    await page.locator('.aprv-card [data-test="aprv-deny"]').hover()
    await expect(page.locator('[data-test="aprv-target-pop"]')).toBeHidden({ timeout: 5000 })
    await link.hover()
    await expect(page.locator('[data-test="aprv-target-pop"]')).toBeVisible({ timeout: 10000 })
    await page.waitForTimeout(800)
    expect(diffReqCount).toBe(2)
  } finally {
    await cleanupProject(request, repoDir)
  }
})

test('干净文件 target 悬停 → 浮窗空态提示（无 diff）', async ({ page, request }) => {
  test.setTimeout(60000)
  const repoDir = await makeFixtureRepo()
  try {
    await registerAndEnter(page, request, repoDir)
    await seedApproval(page, request, 'write', 'docs/notes.md')

    await page.locator('.aprv-card [data-test="aprv-target-link"]').hover()
    const pop = page.locator('[data-test="aprv-target-pop"]')
    await expect(pop).toBeVisible({ timeout: 10000 })
    // 无未提交差异：浮窗内如实提示（不误报计数、不出变更行）
    await expect(pop.locator('[data-test="aprv-target-pop-empty"]')).toBeVisible()
    await expect(pop.locator('[data-test="aprv-target-pop-line"]')).toHaveCount(0)
  } finally {
    await cleanupProject(request, repoDir)
  }
})

test('悬停后点击仍直开 vs HEAD 差异视图（P-47 语义保留）', async ({ page, request }) => {
  test.setTimeout(60000)
  const repoDir = await makeFixtureRepo()
  try {
    await registerAndEnter(page, request, repoDir)
    const id = await seedApproval(page, request, 'write', 'src/app.ts')

    const link = page.locator('.aprv-card [data-test="aprv-target-link"]')
    await link.hover()
    await expect(page.locator('[data-test="aprv-target-pop"]')).toBeVisible({ timeout: 10000 })
    // 浮窗只读呈现，点击链不被浮窗拦截：直开差异视图 tab
    await link.click()
    await expect(page.locator('.pane-primary .editor-tab', { hasText: 'app.ts (Diff)' })).toBeVisible({ timeout: 15000 })

    // 裁决不受影响：仍 pending
    await expect(page.locator('.aprv-card')).toHaveCount(1)
    const res = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers: await unlockHeaders(request) })
    expect(((await res.json()) as { data?: { status?: string } }).data?.status).toBe('pending')
  } finally {
    await cleanupProject(request, repoDir)
  }
})
