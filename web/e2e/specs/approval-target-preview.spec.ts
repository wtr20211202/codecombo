import { execSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 审批卡 target 可点击预览（P-20261003-47，事中知情）：
 *   1. 路径形态 target（无未提交差异）→ 可点态，点击打开文件且审批仍 pending
 *      （点击与三按钮裁决链隔离）
 *   2. 路径形态 target（工作区有未提交差异）→ 点击直开 vs HEAD 差异视图
 *   3. 命令形 target（git push …）→ 形态守卫保持纯文本（无可点态）
 *   4. 将新建路径（文件不存在）→ 点击静默落空：不开 tab、不弹错、审批仍 pending
 *   5. 目录类审批 target（P-20261003-201，已存在目录）→ 点击树定位该目录：
 *      父链展开 + 目录行聚焦高亮，不开文件 tab
 * 夹具仓库经 API 注册为项目（approval-jump 同款），进入项目页建立当前项目
 * 上下文后播种审批；afterEach 清账防残留
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ = 'aprv-target-preview-proj'

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

/** 夹具仓库：docs/notes.md 已提交（干净文件），docs/archive/old.md 已提交
 *  （干净目录，P-201 目录定位夹具），src/app.ts 已提交后再改（未提交差异）*/
async function makeFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(tmpdir(), 'sc-aprv-target-'))
  const git = (args: string) => execSync(`git ${args}`, { cwd: repo })
  git('init')
  git('config core.autocrlf false')
  git('config user.email e2e@example.com')
  git('config user.name e2e')
  await mkdir(path.join(repo, 'docs'), { recursive: true })
  await mkdir(path.join(repo, 'docs', 'archive'), { recursive: true })
  await mkdir(path.join(repo, 'src'), { recursive: true })
  await writeFile(path.join(repo, 'docs', 'notes.md'), 'clean committed note\n')
  await writeFile(path.join(repo, 'docs', 'archive', 'old.md'), 'archived note\n')
  await writeFile(path.join(repo, 'src', 'app.ts'), 'export const v = 1\n')
  git('add .')
  git('commit -m init')
  // 未提交差异：追加一行（status → Modified）
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

  // 预置良性布局命名空间（editor-locate-tree 同款）：面板开 + files 视图——
  // boot 的 restoreLayoutState 落地时机不定，迟到的恢复会翻回任意面板态把
  // 目录定位目标的文件树 v-show 藏掉；预置同欲态后恢复即无操作回放
  await request.put(`${BASE}/api/ui-state`, {
    headers, data: { local: { layout: { showSidePanel: true, sideView: 'files' } } },
  })

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
    data: { sessionId: 'sc_aprv_target_e2e', op, target, detail: 'P-20261003-47 target 预览验证' },
  })
  expect(res.ok()).toBeTruthy()
  const id = ((await res.json()) as { data: { id: string } }).data.id
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  return id
}

async function approvalStatus(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: { status?: string } }).data?.status || ''
}

test.beforeEach(async ({ request }) => {
  await cleanupApprovals(request)
  await removeStaleProject(request)
})

test.afterEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test('干净文件 target 可点 → 点击打开文件且审批仍 pending', async ({ page, request }) => {
  test.setTimeout(60000)
  const repoDir = await makeFixtureRepo()
  try {
    await registerAndEnter(page, request, repoDir)
    const id = await seedApproval(page, request, 'write', 'docs/notes.md')

    // 路径形态 → 可点态（下划线按钮），点击经 OPS_OPEN_FILE_AT 桥开文件
    const link = page.locator('.aprv-card [data-test="aprv-target-link"]')
    await expect(link).toHaveText('docs/notes.md')
    await link.click()
    await expect(page.locator('.pane-primary .editor-tab', { hasText: 'notes.md' })).toBeVisible({ timeout: 15000 })

    // 点击与裁决隔离：卡片不清账、后端仍 pending
    await expect(page.locator('.aprv-card')).toHaveCount(1)
    expect(await approvalStatus(request, id)).toBe('pending')
  } finally {
    const headers = await unlockHeaders(request)
    const plist = await (await request.get(`${BASE}/api/projects`, { headers })).json()
    const mine = ((plist?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
    if (mine) await request.delete(`${BASE}/api/projects/${mine.id}`, { headers })
    await rm(repoDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('有未提交差异的 target → 点击直开 vs HEAD 差异视图', async ({ page, request }) => {
  test.setTimeout(60000)
  const repoDir = await makeFixtureRepo()
  try {
    await registerAndEnter(page, request, repoDir)
    const id = await seedApproval(page, request, 'write', 'src/app.ts')

    await page.locator('.aprv-card [data-test="aprv-target-link"]').click()
    // 差异视图 tab：name + " (Diff)"（openDiffView 命名惯例）
    await expect(page.locator('.pane-primary .editor-tab', { hasText: 'app.ts (Diff)' })).toBeVisible({ timeout: 15000 })

    // 裁决不受影响：仍 pending
    await expect(page.locator('.aprv-card')).toHaveCount(1)
    expect(await approvalStatus(request, id)).toBe('pending')
  } finally {
    const headers = await unlockHeaders(request)
    const plist = await (await request.get(`${BASE}/api/projects`, { headers })).json()
    const mine = ((plist?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
    if (mine) await request.delete(`${BASE}/api/projects/${mine.id}`, { headers })
    await rm(repoDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('命令形 target（git push …）保持纯文本，无可点态', async ({ page, request }) => {
  const repoDir = await makeFixtureRepo()
  try {
    await registerAndEnter(page, request, repoDir)
    await seedApproval(page, request, 'push', 'git push origin main')

    const card = page.locator('.aprv-card')
    // 形态守卫：不渲染可点态按钮，target 原样纯文本展示
    await expect(card.locator('[data-test="aprv-target-link"]')).toHaveCount(0)
    await expect(card.locator('.aprv-target')).toHaveText('git push origin main')
  } finally {
    const headers = await unlockHeaders(request)
    const plist = await (await request.get(`${BASE}/api/projects`, { headers })).json()
    const mine = ((plist?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
    if (mine) await request.delete(`${BASE}/api/projects/${mine.id}`, { headers })
    await rm(repoDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('将新建路径（文件不存在）点击静默落空：不开 tab、审批仍 pending', async ({ page, request }) => {
  test.setTimeout(60000)
  const repoDir = await makeFixtureRepo()
  try {
    await registerAndEnter(page, request, repoDir)
    const id = await seedApproval(page, request, 'write', 'docs/future.md')

    // agent 引用将新建路径：形态命中渲染可点态，点击存在性探测落空 → 静默返回
    await page.locator('.aprv-card [data-test="aprv-target-link"]').click()
    await page.waitForTimeout(800)
    await expect(page.locator('.pane-primary .editor-tab', { hasText: 'future.md' })).toHaveCount(0)

    // 落空不清账：卡片保留、后端仍 pending
    await expect(page.locator('.aprv-card')).toHaveCount(1)
    expect(await approvalStatus(request, id)).toBe('pending')
  } finally {
    const headers = await unlockHeaders(request)
    const plist = await (await request.get(`${BASE}/api/projects`, { headers })).json()
    const mine = ((plist?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
    if (mine) await request.delete(`${BASE}/api/projects/${mine.id}`, { headers })
    await rm(repoDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('目录类审批 target 点击 → 树定位该目录（父链展开+高亮），不开文件 tab（P-20261003-201）', async ({ page, request }) => {
  test.setTimeout(60000)
  const repoDir = await makeFixtureRepo()
  try {
    await registerAndEnter(page, request, repoDir)
    const id = await seedApproval(page, request, 'mkdir', 'docs/archive')

    // 目录探测命中（filePolicy 对已存在目录回 400）→ OPS_LOCATE_IN_TREE：
    // archive 行聚焦高亮且可见——虚拟列表只渲染展开父目录下的可见条目，
    // 该行出现即证明「父链逐层展开 + 滚动定位」整链生效（editor-locate 同款）
    await page.locator('.aprv-card [data-test="aprv-target-link"]').click()
    await expect(page.locator('#side-panel')).toBeVisible({ timeout: 15000 })
    const focused = page.locator('.tree-item.focused')
    await expect(focused).toBeVisible({ timeout: 15000 })
    await expect(focused.locator('.item-name')).toHaveText('archive')

    // 目录不落开文件链：无新 editor tab；点击与裁决隔离：卡片保留、仍 pending
    await expect(page.locator('.pane-primary .editor-tab')).toHaveCount(0)
    await expect(page.locator('.aprv-card')).toHaveCount(1)
    expect(await approvalStatus(request, id)).toBe('pending')
  } finally {
    const headers = await unlockHeaders(request)
    const plist = await (await request.get(`${BASE}/api/projects`, { headers })).json()
    const mine = ((plist?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
    if (mine) await request.delete(`${BASE}/api/projects/${mine.id}`, { headers })
    await rm(repoDir, { recursive: true, force: true }).catch(() => {})
  }
})
