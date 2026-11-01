import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 原子呈现能力注册表端到端（P-20261022-3）：
 *   1. locate-in-tree（新增 agent 可发形态，原子 present.tree）：侧栏整体收起
 *      （FileTreeView 未挂载无人监听）播种 → useLayoutViews 兜底适配层切回
 *      files 视图重派发 → 文件树逐层展开并高亮目标目录行；
 *   2. 坏载荷 400 退回（发布口注册表校验：缺 projectId / 反斜杠路径）；
 *   3. 编造 URL 收口：/project/<id>/files?path=X（agent 自然但不存在的形态）
 *      → 防御性路由别名重定向 /project?file=X&project=<id> → 文件深链链路
 *      打开该文件（404 事故的机制性杜绝面）；
 *   4. 手册=实现：GET /ops-manual 由注册表渲染——navigate 五形态、深链表、
 *      locate-in-tree 在册；GET /api/meta 声明 ops.present-atoms 能力项。
 * 夹具项目 spec 内自备/自清，不残留测试数据
 */

const PROJ_NAME = 'e2e-ops-present-atoms'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-ops-present-atoms')
const PROBE = path.join(REPO_DIR, 'src', 'deep', 'probe.txt')
const REL_DIR = 'src/deep'
const REL_FILE = 'src/deep/probe.txt'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''

async function lookupProjectId(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects`, { headers: await unlockHeaders() })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  return list.find(p => p.name === PROJ_NAME)?.id || ''
}

test.beforeAll(async () => {
  // 清掉前次运行残留（崩溃遗留的旧项目/旧夹具）
  const staleId = await lookupProjectId()
  if (staleId) await fetch(`${API_BASE}/api/projects/${staleId}`, { method: 'DELETE', headers: await unlockHeaders() })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留占用 */ }
  fs.mkdirSync(path.dirname(PROBE), { recursive: true })
  fs.writeFileSync(PROBE, 'present-atoms probe\n')
  // 注册项目：路径交给服务端一律 serverPath 折算（跨拓扑口径）
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST',
    headers: await unlockHeaders(),
    body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(res.status)
  projectId = await lookupProjectId()
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const id = await lookupProjectId()
  if (id) await fetch(`${API_BASE}/api/projects/${id}`, { method: 'DELETE', headers: await unlockHeaders() })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用时忽略 */ }
})

function itemByName(page: import('@playwright/test').Page, name: string) {
  const re = new RegExp(`^${name}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

// 进项目页（适配层/深链消费链挂 Layout）：路上留出 WS 建立窗口再播种
async function enterProject(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)
}

/** 收起文件侧栏（整体隐藏 = FileTreeView 卸载 = 事件无人监听的缺口形态） */
async function collapseSidePanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('#side-panel').isVisible().catch(() => false))) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(400)
  }
  await expect(page.locator('#side-panel')).toBeHidden()
}

test('locate-in-tree → 侧栏收起态下兜底适配层切视图重派发，树展开高亮目标目录', async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page)
  await collapseSidePanel(page)
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers: await unlockHeaders(),
    data: { type: 'locate-in-tree', payload: { path: REL_DIR, projectId } },
  })
  // 适配层介入：侧栏被自动打开且落在 files 视图
  await expect(page.locator('#side-panel')).toBeVisible({ timeout: 15000 })
  // 树逐层展开并高亮目标目录行（reveal 链 .focused 高亮）
  const focused = page.locator('.tree-item.focused')
  await expect(focused).toBeVisible({ timeout: 15000 })
  await expect(focused).toContainText('deep')
})

test('locate-in-tree 坏载荷 400 退回：不进广播流（发布口注册表校验）', async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page)
  await collapseSidePanel(page)
  const bad = [
    { payload: { path: REL_DIR } },                                  // 缺 projectId
    { payload: { path: 'src\\deep', projectId } },                   // 反斜杠路径
    { payload: { path: '../escape', projectId } },                   // .. 段
  ]
  for (const body of bad) {
    const res = await page.request.post(`${API_BASE}/api/ops-notify`, {
      headers: await unlockHeaders(),
      data: { type: 'locate-in-tree', ...body },
    })
    expect(res.status()).toBe(400)
    expect(await res.text()).toContain('invalid locate-in-tree payload')
  }
  // 无事件进广播流：侧栏保持收起（适配层零触发）
  await expect(page.locator('#side-panel')).toBeHidden({ timeout: 3000 })
})

test('编造 URL /project/:id/files?path=X → 别名重定向 → 文件深链直达打开', async ({ page }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 直访编造形态（用户点开 agent 发来的链接）：vue-router 别名收口为正确深链
  await page.goto(`${API_BASE}/project/${projectId}/files?path=${encodeURIComponent(REL_FILE)}`)
  await page.waitForURL('**/project', { timeout: 15000 })
  // 文件深链既有链消费：编辑器打开目标文件（深链消费后清 query）
  await expect(page.locator('.editor-tab').filter({ hasText: 'probe.txt' })).toBeVisible({ timeout: 20000 })
  await expect(page).toHaveURL(/\/project$/)
})

test('手册=实现：/ops-manual 含注册表渲染的四形态与深链表；/api/meta 声明 ops.present-atoms', async () => {
  const headers = await unlockHeaders()
  // Node 全局 fetch：status 是属性（Playwright APIResponse 的 .status() 才是方法）
  const manualRes = await fetch(`${API_BASE}/ops-manual`, { headers })
  expect(manualRes.status).toBe(200)
  const manual = ((await manualRes.json()) as { data?: { manual?: string } }).data?.manual || ''
  // navigate 五形态原子在册（P-20261005-223 实现而手册未写的漂移，此处收口）
  for (const atom of ['navigate.path', 'navigate.file', 'navigate.diff', 'navigate.changes', 'navigate.terminal']) {
    expect(manual, `手册缺原子 ${atom}`).toContain(atom)
  }
  // 新形态与深链表在册
  for (const fragment of ['present.tree', 'locate-in-tree', 'present.file', 'notify.persist', '人类深链表', '/project?file=']) {
    expect(manual, `手册缺 ${fragment}`).toContain(fragment)
  }
  // 能力探测面：ops.present-atoms 族项声明（旧实例未声明即降级的探测点）
  const metaRes = await fetch(`${API_BASE}/api/meta`)
  expect(metaRes.status).toBe(200)
  const meta = (await metaRes.json()) as { capabilities?: string[] }
  expect(meta.capabilities || []).toContain('ops.present-atoms')
})
