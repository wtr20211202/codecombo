import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * navigate 事件四目标形态 E2E（P-20261005-223）：
 * agent 完成工作后的「告知+呈现」双通道之「呈现」——POST /api/ops-notify 播种
 * navigate（真实前端链路：ops-channel WS → useOpsChannel 显式分发 sc-ops:navigate
 * → OpsChannelBridge 四形态分发，全部复用既有直达链零新执行逻辑）：
 *   1. {file, line} → 文件深链既有链：编辑器打开目标文件且锚点行可见（行定位生效）
 *   2. {view:'diff', file} → ?file=&diff=1 深链变体：vs HEAD 工作区 diff 直开
 *      （夹具已提交后又改写第 3 行，未提交差异即 diff 内容断言锚）
 *   3. {view:'changes'} → 变更面板聚焦：项目页内 ensure-open（重复聚焦不收起）；
 *      他页冷启动经 pendingSideView 打标由 bootstrap 布局恢复消费（先切回文件
 *      视图并等持久化落盘，恢复若覆盖跳转意图则断言必红——该断言即 pending
 *      语义的端到端面）
 *   4. 未知形态宽容忽略：无路由跳转、无新 tab（开放词表同哲学 + debug 留痕）
 * {terminalId} 形态复用审批卡「查看发起会话」jumpToSession 既有链（零新执行
 * 逻辑，该链由审批域 e2e 覆盖），本 spec 不重复建会话夹具。
 * 夹具项目 spec 内自备/自清，不残留测试数据
 */

const PROJ_NAME = 'e2e-ops-navigate'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-ops-navigate')
const APP_GO = path.join(REPO_DIR, 'src', 'app.go')
// 60 行夹具：锚点在第 55 行——未滚动视口不渲染该行，打开后可见即行定位生效
const ANCHOR = 'ops-navigate-anchor-55'
// 提交后改动第 3 行（未提交）：vs HEAD diff 的内容断言锚。改动须落在文件头部
// ——Monaco diff 虚拟化只渲染视口内行，末尾差异在 textContent 里不出现
const DIFF_MODIFIED = 'ops-navigate-diff-modified-line'
const REL_PATH = 'src/app.go'

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
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  return list.find(p => p.name === PROJ_NAME)?.id || ''
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' })
}

test.beforeAll(async () => {
  // 清掉前次运行残留（崩溃遗留的旧项目/旧夹具）
  const staleId = await lookupProjectId()
  if (staleId) await fetch(`${API_BASE}/api/projects/${staleId}`, { method: 'DELETE', headers: await unlockHeaders() })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留占用 */ }
  fs.mkdirSync(path.dirname(APP_GO), { recursive: true })
  const lines: string[] = ['package main', '']
  for (let i = 2; i < 60; i++) {
    lines.push(i === 55 ? `// ${ANCHOR}` : `// pad line ${i}`)
  }
  fs.writeFileSync(APP_GO, lines.join('\n') + '\n')
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false'])
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: navigate 夹具基线'])
  // 未提交差异：改写第 3 行（vs HEAD diff = ±1 行，DIFF_MODIFIED 只在 HEAD 之外存在）
  const committed = fs.readFileSync(APP_GO, 'utf8')
  fs.writeFileSync(APP_GO, committed.replace('// pad line 3', `// ${DIFF_MODIFIED}`))
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

/** 播种 navigate（agent 真实上报通道：POST /api/ops-notify → ops-channel 广播） */
async function seedNavigate(page: import('@playwright/test').Page, payload: Record<string, unknown>): Promise<void> {
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers: await unlockHeaders(),
    data: { type: 'navigate', payload },
  })
}

// 进项目页（接收分发在 OpsChannelBridge：全路由常驻；深链消费链挂 Layout）：
// 路上留出 WS 建立窗口再播种
async function enterProject(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(1000)
}

test('{file, line} → 文件深链既有链：打开且定位到目标行', async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page)
  await seedNavigate(page, { file: REL_PATH, line: 55, project: projectId })
  await expect(page.locator('.editor-tab').filter({ hasText: 'app.go' })).toBeVisible({ timeout: 15000 })
  // 锚点行（55 行）未滚动视口不可见，出现即证明行定位生效（file-deeplink 同款断言）
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(ANCHOR, { timeout: 15000 })
})

test("{view:'diff', file} → vs HEAD 工作区 diff 直开（含未提交追加行）", async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page)
  await seedNavigate(page, { view: 'diff', file: REL_PATH, project: projectId })
  // diff 伪签命名：文件名 + ' (Diff)' 后缀（openDiffView 既有约定）
  await expect(page.locator('.editor-tab').filter({ hasText: '(Diff)' })).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })
  // DIFF_MODIFIED 只存在于工作区（HEAD 无此行）：出现即证明「vs HEAD 工作区差异」取数正确
  await expect(page.locator('.monaco-diff-editor')).toContainText(DIFF_MODIFIED, { timeout: 15000 })
})

test("{view:'changes'} 项目页内聚焦：ensure-open 且重复聚焦不收起", async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page)
  await seedNavigate(page, { view: 'changes' })
  await expect(page.locator('[data-testid="commit-panel"]')).toBeVisible({ timeout: 15000 })
  // ensure-open 语义（与 panel 事件 toggle 区分）：再聚焦一次仍打开不收起
  await seedNavigate(page, { view: 'changes' })
  await expect(page.locator('[data-testid="commit-panel"]')).toBeVisible({ timeout: 10000 })
})

test("{view:'changes'} 他页冷启动：pendingSideView 经 bootstrap 恢复消费（恢复不覆盖）", async ({ page }) => {
  test.setTimeout(90000)
  await enterProject(page)
  // 先把侧栏切回文件视图并等持久化防抖（2s）落盘——此后 uiState 记录的 sideView
  // 是 files，冷启动恢复若覆盖跳转意图（pendingSideView 语义缺失的回归形态）
  // 则本用例必红
  await page.locator('[data-testid="rail-files"]').click()
  await page.waitForTimeout(2600)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.waitForTimeout(1200) // WS 建立窗口（首页不进 Layout，事件直达 Bridge）
  await seedNavigate(page, { view: 'changes' })
  await page.waitForURL('**/project', { timeout: 15000 })
  await expect(page.locator('[data-testid="commit-panel"]')).toBeVisible({ timeout: 20000 })
})

test('未知形态宽容忽略：无路由跳转、无新 tab', async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page)
  const tabsBefore = await page.locator('.editor-tab').count()
  // 首命中分发全落空 → 宽容忽略：畸形字段值（非字符串 file / 未知 view）同理
  await seedNavigate(page, { foo: 'bar' })
  await seedNavigate(page, { file: 42 })
  await seedNavigate(page, { view: 'unknown-view' })
  await page.waitForTimeout(2000)
  expect(page.url()).toMatch(/\/project$/)
  expect(await page.locator('.editor-tab').count()).toBe(tabsBefore)
})
