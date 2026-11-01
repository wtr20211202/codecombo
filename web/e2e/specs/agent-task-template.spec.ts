import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 智能体任务模板 E2E（P-20261002-16）：
 *   1. 设置 → 通用 → 任务模板区块：出厂预置 4 条可见（预置标签），新建自定义
 *      模板即时生效（物化落盘，预置标签消失）
 *   2. 选模板创建会话：任务指令按上下文填入（未打开文件时 {file} 占位符原样
 *      保留），创建请求 launchArgs 含模板文本，服务端以 prompt 首行派生会话名
 *      （≤24 rune 不截断），docked 侧栏出现该会话（终端出现）
 *   3. 不选模板创建：请求体无 launchArgs（请求形状保持，promptSessionName
 *      不派生）——模板链不改变既有无模板路径
 * 自备临时仓库，afterEach 清理全部终端会话，afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-agent-task-template')
const PROJ_NAME = 'e2e-agent-task-template'
const TPL_NAME = 'E2E 冒烟模板'
// 23 rune（≤24 不触发服务端摘要截断）：会话名 = 整条 prompt，断言零换算
const TPL_PROMPT = 'E2ETPL 审查当前工作区改动并给出提交信息'
const TPL_PROMPT_V2 = 'E2ETPL 覆盖版：复审当前改动并复跑测试'
const EXPLAIN_TPL = '解释当前文件' // 出厂预置（prompt 含 {file} 占位符）

const DL_DIR = path.join(os.tmpdir(), 'sc-e2e-agent-task-template-dl')

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

/** 清理全部终端会话：断言基于会话创建链路，残留会话会污染侧栏行断言 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

let projectId = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${API_BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(REPO_DIR, 'app.ts'), 'export const a = 1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: seed'])

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
})

/** 进项目页（设置区块与 docked 管理页共用前置） */
async function gotoProject(page: Page) {
  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
}

test('设置区块：出厂预置可见，新建自定义模板即时生效并物化', async ({ page }) => {
  await gotoProject(page)
  await page.locator('[data-testid="rail-settings"]').click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-general"]').click()

  const block = page.locator('[data-testid="settings-agent-task-templates"]')
  await expect(block).toBeVisible({ timeout: 5000 })
  // 出厂预置 4 条（数据面 FRESH：uiState 无定制记录），带「预置」标签
  await expect(block.locator('[data-testid="agent-tpl-row"]')).toHaveCount(4)
  await expect(block.locator('.n-tag').filter({ hasText: '预置' })).toHaveCount(4)
  await expect(block.locator('[data-testid="agent-tpl-row"]').filter({ hasText: EXPLAIN_TPL })).toBeVisible()

  // 新建自定义模板：行内表单保存即生效（不走设置页「保存」链）。
  // n-input 的 data-testid 落在包裹层 div，真正的输入框在其内部（settings-search 同款口径）
  await block.locator('[data-testid="agent-tpl-add"]').click()
  await block.locator('[data-testid="agent-tpl-name"] input').fill(TPL_NAME)
  await block.locator('[data-testid="agent-tpl-prompt"] textarea').fill(TPL_PROMPT)
  await block.locator('[data-testid="agent-tpl-save"]').click()
  await expect(block.locator('[data-testid="agent-tpl-row"]').filter({ hasText: TPL_NAME })).toBeVisible({ timeout: 5000 })
  await expect(block.locator('[data-testid="agent-tpl-row"]')).toHaveCount(5)
  // 物化后预置标签消失（此后列表 = 用户定制表，i18n 不再派生）
  await expect(block.locator('.n-tag').filter({ hasText: '预置' })).toHaveCount(0)
})

test('选模板创建会话：launchArgs 含模板文本，{file} 未解析原样保留，终端出现', async ({ page }) => {
  await gotoProject(page)
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })

  await view.locator('.atv-header-actions button').filter({ hasText: '新建会话' }).click()
  const dlg = page.locator('.n-modal').filter({ hasText: '新建智能体会话' })
  await expect(dlg).toBeVisible({ timeout: 5000 })

  // 选出厂预置「解释当前文件」：未打开任何编辑器文件 → {file} 上下文缺失，
  // 指令里原样保留（提案「占位符未定义时原样保留并提示」的可见面）。
  // textarea 断言用 toHaveValue（toContainText 读 textContent 对 textarea 恒空）
  await dlg.locator('[data-testid="agent-template-select"] .n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: EXPLAIN_TPL }).click()
  const promptBox = dlg.locator('[data-testid="agent-template-prompt"] textarea')
  await expect(promptBox).toHaveValue(/请解释 \{file\}/, { timeout: 5000 })

  // 换选自定义模板（beforeEach 物化自上个用例的落盘——同实例 uiState 持久）
  await dlg.locator('[data-testid="agent-template-select"] .n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: TPL_NAME }).click()
  await expect(promptBox).toHaveValue(TPL_PROMPT)

  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await dlg.locator('.n-form-item').filter({ hasText: '工作目录' }).locator('input').fill(serverPath(REPO_DIR))
  await dlg.locator('button').filter({ hasText: '创建' }).click()

  // 请求体：launchArgs 首行 = 模板文本（整段含占位符替换结果）。P-20261003-176
  // 起对话框默认勾选「附带 git 状态」，模板文本后追加一行状态摘要——首行语义
  //（会话名派生/模板文本可辨识）不变，故按首行断言
  const body = (await createReq).postDataJSON() as { kind?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.launchArgs?.split('\n')[0]).toBe(TPL_PROMPT)

  // 服务端响应：prompt 首行派生会话名（23 rune ≤24 不截断）；侧栏出现该会话
  const resp = await (await createReq).response()
  const created = (await resp.json()) as { data?: { name?: string } }
  expect(created.data?.name).toBe(TPL_PROMPT)
  await expect(view.locator('.ats-item').filter({ hasText: TPL_PROMPT }).first()).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.xterm').first()).toBeVisible({ timeout: 15000 })
})

test('不选模板创建：请求体无 launchArgs（既有路径形状不变）', async ({ page }) => {
  await gotoProject(page)
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })

  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await view.locator('.atv-header-actions button').filter({ hasText: '新建会话' }).click()
  const dlg = page.locator('.n-modal').filter({ hasText: '新建智能体会话' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('.n-form-item').filter({ hasText: '工作目录' }).locator('input').fill(serverPath(REPO_DIR))
  await dlg.locator('button').filter({ hasText: '创建' }).click()

  const body = (await createReq).postDataJSON() as { launchArgs?: string }
  expect(body.launchArgs, '未选模板不携带 launchArgs').toBeUndefined()
})

test('导出/导入：勾选导出 JSON 往返，同名默认跳过、勾选覆盖原位替换（P-20261005-209）', async ({ page }) => {
  test.setTimeout(45000)
  await gotoProject(page)
  await page.locator('[data-testid="rail-settings"]').click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-general"]').click()
  const block = page.locator('[data-testid="settings-agent-task-templates"]')
  await expect(block).toBeVisible({ timeout: 5000 })
  const rowOf = () => block.locator('[data-testid="agent-tpl-row"]').filter({ hasText: TPL_NAME })
  const preview = page.locator('.n-modal:visible').filter({ hasText: '导入任务模板' })

  // 行勾选（多选面）→ 导出：载荷只含勾选项（前序用例已物化 4 预置 + 本条 = 5 行）
  await rowOf().locator('[data-testid="agent-tpl-check"]').click()
  fs.mkdirSync(DL_DIR, { recursive: true })
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    block.locator('[data-testid="agent-tpl-export"]').click(),
  ])
  // 导出名前缀随品牌切换（4adaf9da）改 codecombo-*
  expect(dl.suggestedFilename()).toMatch(/^codecombo-task-templates-\d{8}\.json$/)
  const file = path.join(DL_DIR, dl.suggestedFilename())
  await dl.saveAs(file)
  const payload = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    scAgentTaskTemplates?: number
    templates?: Array<{ name: string; prompt: string }>
  }
  expect(payload.scAgentTaskTemplates).toBe(1)
  expect(payload.templates).toEqual([{ name: TPL_NAME, prompt: TPL_PROMPT }])

  // 删除该模板（popconfirm 二次确认）→ 导入同文件：预览「新增」→ 确认落库行恢复
  await rowOf().locator('button[title="删除"]').click()
  await page.locator('.n-popconfirm .n-popconfirm__action button').last().click()
  await expect(rowOf()).toHaveCount(0)

  await block.locator('input[type=file]').setInputFiles(file)
  await expect(preview).toBeVisible()
  await expect(preview).toContainText(TPL_NAME)
  await expect(preview).toContainText('新增')
  await preview.locator('[data-testid="agent-tpl-import-confirm"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '导入完成：新增 1、覆盖 0、跳过 0' })).toBeVisible({ timeout: 10000 })
  await expect(rowOf()).toBeVisible()

  // 同名再导入：默认跳过（保守档），本机内容不变（toast 计数零应用）
  await block.locator('input[type=file]').setInputFiles(file)
  await expect(preview).toBeVisible()
  await expect(preview).toContainText('同名')
  await preview.locator('[data-testid="agent-tpl-import-confirm"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '导入完成：新增 0、覆盖 0、跳过 1' })).toBeVisible({ timeout: 10000 })
  await expect(rowOf().locator('.att-row-prompt')).toHaveText(TPL_PROMPT)

  // 同名再导入 + 勾选「覆盖本地」：原位替换本机内容
  const overwriteFile = path.join(DL_DIR, 'import-tpl-overwrite.json')
  fs.writeFileSync(overwriteFile, JSON.stringify({
    scAgentTaskTemplates: 1,
    version: 1,
    exportedAt: new Date().toISOString(),
    templates: [{ name: TPL_NAME, prompt: TPL_PROMPT_V2 }],
  }))
  await block.locator('input[type=file]').setInputFiles(overwriteFile)
  await expect(preview).toBeVisible()
  await preview.locator('[data-testid="agent-tpl-overwrite-check"]').click()
  await preview.locator('[data-testid="agent-tpl-import-confirm"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '导入完成：新增 0、覆盖 1、跳过 0' })).toBeVisible({ timeout: 10000 })
  await expect(rowOf().locator('.att-row-prompt')).toHaveText(TPL_PROMPT_V2)
})
