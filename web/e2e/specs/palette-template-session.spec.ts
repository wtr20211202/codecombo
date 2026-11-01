import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 命令面板「按模板新建会话」E2E（P-20261005-10）：P-16 模板的全局直达。
 *   1. 直达链：模板经 uiState agentTaskTemplates 命名空间播种 → 打开编辑器文件
 *      （{file} 上下文就位）→ Ctrl+K 按模板名搜到「按模板新建会话」命令 → 执行
 *      → POST /api/terminals launchArgs = 占位符解析后全文（不经对话框），
 *      docked 管理页展开并出现该会话
 *   2. 内容可搜：按模板正文片段（非名称）过滤也能命中模板命令
 *   3. 降级链：模板含 {file} 而无激活文件（上下文缺失）→ 执行不开会话，改开
 *      新建对话框并预选该模板（P-16「原样保留+缺失提示」可见，创建请求零发生）
 *
 * 模板播种/清理走 PATCH /api/ui-state（local 实例记录的 agentTaskTemplates 键，
 * 清理显式传 null 等效清键恢复出厂预置派生）；自备临时仓库，afterEach 清理全部
 * 终端会话，afterAll 清理项目/仓库/模板残留
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-palette-template-session')
const PROJ_NAME = 'e2e-palette-template-session'
const FILE_MAIN = 'pal-main.ts'
/** 直达链模板：{file}/{branch} 上下文在用例内均可满足（打开文件+有分支） */
const TPL_DIRECT_NAME = 'E2E面板直达模板'
const TPL_DIRECT_PROMPT = 'E2EPAL 审查 {file} 并总结分支状态（分支 {branch}）'
/** 降级链模板：正文含 {file}，无激活文件时必降级 */
const TPL_FALLBACK_NAME = 'E2E面板降级模板'
const TPL_FALLBACK_PROMPT = 'E2EPAL2 请解释 {file} 的结构与职责'

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 模板播种/清理：PATCH ui-state 的 local 实例记录（agentTaskTemplates 键）；
 *  items=null 等效清键恢复出厂预置派生（服务端 Merge 键值 nil 归一语义） */
async function seedTemplates(request: APIRequestContext, items: unknown): Promise<void> {
  const headers = await unlockHeaders(request)
  await request.patch(`${API_BASE}/api/ui-state`, {
    headers,
    data: { local: { agentTaskTemplates: items } },
  })
}

/** 清理全部终端会话：直达链会真实创建会话，残留会话污染侧栏断言 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

let projectId = ''
let projectBranch = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${API_BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(REPO_DIR, FILE_MAIN), 'export const pal = 1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: seed'])

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string; currentBranch?: string } }
  projectId = body.data?.id || ''
  projectBranch = body.data?.currentBranch || ''
  // 播种两条模板（定制的 items 整表落盘；出厂预置不参与——语义见 P-16 物化）
  await seedTemplates(request, {
    items: [
      { id: 'e2e-tpl-pal-direct', name: TPL_DIRECT_NAME, prompt: TPL_DIRECT_PROMPT },
      { id: 'e2e-tpl-pal-fallback', name: TPL_FALLBACK_NAME, prompt: TPL_FALLBACK_PROMPT },
    ],
  })
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  await seedTemplates(request, null) // 清键：恢复出厂预置派生，不给邻域 spec 留定制表
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
})

/** 进项目页（文件树可见，供点开编辑器文件置 {file} 信标） */
async function gotoProject(page: Page) {
  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续点击，先收起（activity-bar 同款防御）
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

test('直达链：面板搜模板名执行 → launchArgs=解析后全文，不经对话框', async ({ page }) => {
  await gotoProject(page)
  // 打开编辑器文件：{file} 占位符上下文就位（navHistory activeFilePath 信标）。
  // 文件树若不在可见视图（布局残留）先点活动栏「文件」——bookmarks 同款幂等重试
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE_MAIN }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE_MAIN }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_MAIN })).toBeVisible({ timeout: 10000 })

  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(`>${TPL_DIRECT_NAME}`)
  const item = page.locator('.palette-item').filter({ hasText: TPL_DIRECT_NAME }).first()
  await expect(item).toBeVisible({ timeout: 5000 })

  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await item.click()

  // 请求体：launchArgs = 占位符解析后全文（{file}=项目相对路径、{branch}=当前分支）
  const body = (await createReq).postDataJSON() as { kind?: string; runtime?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.launchArgs).toBe(`E2EPAL 审查 ${FILE_MAIN} 并总结分支状态（分支 ${projectBranch}）`)

  // 直达语义：跳过对话框——新建会话对话框全程未出现
  await expect(page.locator('.n-modal').filter({ hasText: '新建智能体会话' })).toHaveCount(0)
  // 激活：docked 管理页展开，侧栏出现新会话（会话名 = launchArgs 首行摘要，
  // 超 24 rune 截尾加 …，故按解析后首行前缀断言）
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await expect(view.locator('.ats-item').filter({ hasText: `E2EPAL 审查 ${FILE_MAIN}` }).first()).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.xterm').first()).toBeVisible({ timeout: 15000 })
})

test('内容可搜：按模板正文片段（非名称）过滤命中模板命令', async ({ page }) => {
  await gotoProject(page)
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  // 正文片段「总结分支状态」不在任何命令标题里——命中即证明 keywords 携正文
  await input.fill('>总结分支状态')
  const item = page.locator('.palette-item').filter({ hasText: TPL_DIRECT_NAME }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  // Esc 双层退出（P-20261004-95）：有查询先清——两连 Esc 才落到关闭
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
})

test('降级链：{file} 无解时不开会话，改开对话框预选模板（原样保留+提示可见）', async ({ page }) => {
  await gotoProject(page)
  // 不打开任何编辑器文件：{file} 上下文缺失 → 必降级
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(`>${TPL_FALLBACK_NAME}`)
  const item = page.locator('.palette-item').filter({ hasText: TPL_FALLBACK_NAME }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  // 创建请求监听先于执行登记：降级路径全程（含对话框打开后的窗口）零创建
  let created = false
  page.on('request', (r) => {
    if (r.url().includes('/api/terminals') && r.method() === 'POST') created = true
  })
  await item.click()

  // 新建对话框打开（宿主 docked 管理页随之拉起），模板已预选
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  const dlg = page.locator('.n-modal').filter({ hasText: '新建智能体会话' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await expect(dlg.locator('[data-testid="agent-template-select"] .n-base-selection')).toContainText(TPL_FALLBACK_NAME, { timeout: 5000 })

  // P-16 语义可见：占位符原样保留在指令里 + 缺失提示行出现；创建请求零发生
  const promptBox = dlg.locator('[data-testid="agent-template-prompt"] textarea')
  await expect(promptBox).toHaveValue(TPL_FALLBACK_PROMPT, { timeout: 5000 })
  await expect(dlg.locator('.nsd-prompt-hint').filter({ hasText: '原样保留' })).toBeVisible()
  await expect(dlg.locator('.nsd-prompt-hint').filter({ hasText: '{file}' })).toBeVisible()
  await page.waitForTimeout(1500)
  expect(created, '降级路径不得发起创建请求').toBe(false)
})
