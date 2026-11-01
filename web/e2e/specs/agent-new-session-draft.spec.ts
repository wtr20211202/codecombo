import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 新建会话对话框草稿保留 + 关闭确认 E2E（P-20261004-89 + P-20261006-6）：
 *   1. 长指令输入 → 防抖 1s 落 localStorage（sc.newSession.draft 单键）
 *   2. 点遮罩不再关闭（mask-closable=false 长表单防误触）；有未发送内容
 *      （指令/模板）时 Esc 出「保持/放弃」确认层（P-6 事前拦截）——保持回
 *      对话框内容在，放弃关闭并清暂存键（P-6 × P-89 共存：放弃=清暂存）
 *   3. 纯会话名草稿（确认阈值外）Esc 仍直关，重开恢复 + 弱提示 → 丢弃 → 空
 *      （P-89 恢复链在未被确认层拦截的路径上原样保留）
 *   4. 创建成功路径清草稿且不弹确认（提交路径零打扰；已提交无保留意义）
 * 模板经 /api/ui-state 播种——对话框任务指令输入框 v-if=templateId||promptText，
 * 指令输入必须先选模板。播种会物化模板表使出厂预置消失，afterAll 还原键原值
 * 不污染同实例后续 spec（agent-task-template 的预置计数断言）。草稿本体在
 * 浏览器 localStorage，每个用例新 context 天然隔离，无跨用例残留
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-agent-new-session-draft')
const PROJ_NAME = 'e2e-agent-new-session-draft'
const TPL_ID = 'e2e-draft-tpl'
const TPL_NAME = 'E2E 草稿种子模板'
const TPL_PROMPT = 'E2EDRAFT 审查当前工作区改动'
// 长指令（提案动机场景），×2 ≈ 320 字节 < 500 服务端上限（超限会被创建预检拦截）
const LONG_PROMPT = `请对本仓库做一次依赖安全审计：列出全部直接与间接依赖，标注已知 CVE 与许可证类型，输出升级建议清单。`.repeat(2).trim()
const PROMPT_HEAD = LONG_PROMPT.slice(0, 40)
const DRAFT_KEY = 'sc.newSession.draft'

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

/** 清理全部终端会话：创建成功用例会留会话，污染后续断言 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

let projectId = ''
// 播种前的 agentTaskTemplates 键原值（undefined = 键本不存在，还原时以 null 清键）
let originalTemplates: unknown
let hadTemplateKey = false

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

  // 播种模板（本机实例键 'local'）：先捕获原值，afterAll 还原（物化不可逆，
  // 出厂预置消失会打断 agent-task-template spec 的预置计数断言）
  const uiRes = await request.get(`${API_BASE}/api/ui-state`, { headers })
  const uiAll = ((await uiRes.json()) as { data?: Record<string, Record<string, unknown>> }).data || {}
  const localState = uiAll['local'] || {}
  if (Object.prototype.hasOwnProperty.call(localState, 'agentTaskTemplates')) {
    hadTemplateKey = true
    originalTemplates = localState.agentTaskTemplates
  }
  await request.patch(`${API_BASE}/api/ui-state`, {
    headers,
    data: { local: { agentTaskTemplates: { items: [{ id: TPL_ID, name: TPL_NAME, prompt: TPL_PROMPT }] } } },
  })
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  // 还原模板键：原不存在 = null 清键（PATCH 合并语义），存在 = 写回原值
  await request.patch(`${API_BASE}/api/ui-state`, {
    headers,
    data: { local: { agentTaskTemplates: hadTemplateKey ? originalTemplates : null } },
  })
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
})

/** 进项目页并打开新建会话对话框（返回对话框 locator） */
async function openNewSessionDialog(page: Page) {
  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.atv-header-actions button').filter({ hasText: '新建会话' }).click()
  const dlg = page.locator('.n-modal').filter({ hasText: '新建智能体会话' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  return dlg
}

/** 选播种模板让指令输入框出现（v-if=templateId||promptText），并填入长指令 */
async function fillLongPrompt(page: Page, dlg: ReturnType<Page['locator']>) {
  await dlg.locator('[data-testid="agent-template-select"] .n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: TPL_NAME }).click()
  const promptBox = dlg.locator('[data-testid="agent-template-prompt"] textarea')
  await expect(promptBox).toBeVisible({ timeout: 5000 })
  await promptBox.fill(LONG_PROMPT)
  return promptBox
}

test('长指令 Esc 出关闭确认：保持回对话框内容在→放弃关闭且暂存清除', async ({ page }) => {
  const dlg = await openNewSessionDialog(page)
  const promptBox = await fillLongPrompt(page, dlg)
  // 顺带填会话名：放弃路径验证整键清除（name 同键不残留）
  await dlg.locator('.n-form-item').filter({ hasText: '会话名' }).locator('input').fill('e2e 草稿会话')

  // 防抖 1s 落键（轮询等待，上限 5s）
  await expect.poll(
    () => page.evaluate(key => localStorage.getItem(key), DRAFT_KEY),
    { timeout: 5000, interval: 200 },
  ).toContain(PROMPT_HEAD)

  // 点遮罩（本对话框自己的 wrapper 内取 mask，防他层 modal 干扰；模态居中
  // 520px 宽，视口左缘是纯遮罩区）→ 不再关闭（P-89 mask-closable=false 不变）
  const dlgWrapper = page.locator('.n-modal-body-wrapper').filter({ has: dlg })
  await dlgWrapper.locator('.n-modal-mask').click({ position: { x: 5, y: 300 } })
  await expect(dlg).toBeVisible({ timeout: 2000 })

  // Esc：有未发送内容不再直关——出「保持/放弃」确认层（P-20261006-6），
  // 对话框本体留在原位（focus-trap 栈顶层是确认层，Esc 先拦在此处）
  await page.keyboard.press('Escape')
  const confirm = page.locator('.n-dialog').filter({ hasText: '放弃这次输入？' })
  await expect(confirm).toBeVisible({ timeout: 3000 })
  await expect(dlg).toBeVisible()

  // 保持：确认层收起，回到对话框，指令/会话名原样在，暂存键未被动过
  await confirm.locator('.n-dialog__action button').filter({ hasText: '保持' }).click()
  await expect(confirm).toBeHidden({ timeout: 2000 })
  await expect(dlg).toBeVisible()
  await expect(promptBox).toHaveValue(LONG_PROMPT)
  await expect(dlg.locator('.n-form-item').filter({ hasText: '会话名' }).locator('input')).toHaveValue('e2e 草稿会话')
  await expect.poll(
    () => page.evaluate(key => localStorage.getItem(key), DRAFT_KEY),
    { timeout: 3000, interval: 200 },
  ).toContain(PROMPT_HEAD)

  // 再 Esc → 放弃：对话框关闭且暂存键清除（P-6 × P-89 共存：放弃=清暂存，
  // 含在途防抖撤销），重开不恢复、不亮恢复提示（事前拦截消灭恢复需求）
  await page.keyboard.press('Escape')
  await expect(confirm).toBeVisible({ timeout: 3000 })
  await confirm.locator('.n-dialog__action button').filter({ hasText: '放弃' }).click()
  await expect(dlg).toBeHidden({ timeout: 3000 })
  await expect.poll(
    () => page.evaluate(key => localStorage.getItem(key), DRAFT_KEY),
    { timeout: 3000, interval: 200 },
  ).toBe(null)

  await page.locator('.atv-header-actions button').filter({ hasText: '新建会话' }).click()
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await expect(page.locator('[data-testid="agent-draft-restored"]')).toHaveCount(0)
  // 指令输入框 v-if=templateId||promptText——无内容即整块卸载
  await expect(dlg.locator('[data-testid="agent-template-prompt"]')).toHaveCount(0)
  await expect(dlg.locator('.n-form-item').filter({ hasText: '会话名' }).locator('input')).toHaveValue('')
})

test('纯会话名草稿在确认阈值外：Esc 直关→重开恢复+提示→丢弃→空', async ({ page }) => {
  const dlg = await openNewSessionDialog(page)
  const nameInput = dlg.locator('.n-form-item').filter({ hasText: '会话名' }).locator('input')
  await nameInput.fill('e2e 纯名草稿')

  await expect.poll(
    () => page.evaluate(key => localStorage.getItem(key), DRAFT_KEY),
    { timeout: 5000, interval: 200 },
  ).toContain('e2e 纯名草稿')

  // Esc 直关（无确认层）——确认阈值只数任务指令/模板，纯会话名保持零打扰
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-dialog').filter({ hasText: '放弃这次输入？' })).toHaveCount(0)
  await expect(dlg).toBeHidden({ timeout: 3000 })

  // 重开：草稿恢复 + 顶部弱提示可见（P-89 恢复链未被确认层拦的路径原样保留）
  await page.locator('.atv-header-actions button').filter({ hasText: '新建会话' }).click()
  await expect(dlg).toBeVisible({ timeout: 5000 })
  const hint = page.locator('[data-testid="agent-draft-restored"]')
  await expect(hint).toBeVisible({ timeout: 3000 })
  await expect(nameInput).toHaveValue('e2e 纯名草稿')

  // 丢弃：存储键清除、提示消失、字段空
  await page.locator('[data-testid="agent-draft-discard"]').click()
  await expect(hint).toBeHidden({ timeout: 2000 })
  await expect(nameInput).toHaveValue('')
  await expect.poll(
    () => page.evaluate(key => localStorage.getItem(key), DRAFT_KEY),
    { timeout: 3000, interval: 200 },
  ).toBe(null)
})

test('创建成功清草稿：请求发出且存储键清除', async ({ page }) => {
  const dlg = await openNewSessionDialog(page)
  await fillLongPrompt(page, dlg)
  await dlg.locator('.n-form-item').filter({ hasText: '工作目录' }).locator('input').fill(serverPath(REPO_DIR))

  await expect.poll(
    () => page.evaluate(key => localStorage.getItem(key), DRAFT_KEY),
    { timeout: 5000, interval: 200 },
  ).toContain(PROMPT_HEAD)

  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await dlg.locator('button').filter({ hasText: '创建' }).click()
  const req = await createReq
  const resp = await (await req.response()).json() as { data?: { id?: string } }
  expect(resp.data?.id, '会话创建成功（清草稿的前提）').toBeTruthy()

  // 提交路径不弹关闭确认（P-20261006-6：创建成功零打扰直关）
  await expect(page.locator('.n-dialog').filter({ hasText: '放弃这次输入？' })).toHaveCount(0)

  // 创建成功即清：存储键清除（对话框随成功链关闭，恢复提示不再出现）
  await expect.poll(
    () => page.evaluate(key => localStorage.getItem(key), DRAFT_KEY),
    { timeout: 3000, interval: 200 },
  ).toBe(null)
})
