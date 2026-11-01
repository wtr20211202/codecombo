import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * agent 会话输入框 @ 文件引用补全 E2E（P-20261005-196）：
 *   1. NewSessionDialog 任务指令敲「@片段」→ 浮层按子序列过滤 → 点选插入
 *      「@相对路径 」（Claude CLI 原生引用语义的文本形态）
 *   2. 邮箱负向：user@ho 不触发浮层（@ 前非空白边界）
 *   3. @src/ 目录级补全（P-196 修正案）：仅目录条目，选中注入目录相对路径
 *   4. Esc 关浮层且不连带关模态（浮层 keydown stopPropagation 拦 n-modal
 *      focus-trap 的 document Esc 链）
 *   5. 运行中会话排队指令输入同款补全（项目分组树会话，按归属项目取清单）：
 *      敲 @ → Enter 选中（keydown 消费，不触发排队提交）→ 再 Enter 入队
 * 夹具自备临时仓库（5 文件 3 目录，清单小而确定），afterAll 清项目与夹具；
 * 会话用 API 造（agent-queue.spec 同款），afterEach 清终端防残留
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-agent-at-completion')
const PROJ_NAME = 'e2e-agent-at-completion'

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

let projectId = ''

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，防残留会话混入侧栏树） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)

  const stale = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await request.delete(`${API_BASE}/api/projects/${old.id}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(path.join(REPO_DIR, 'src', 'composables'), { recursive: true })
  fs.mkdirSync(path.join(REPO_DIR, 'src', 'utils'), { recursive: true })
  fs.mkdirSync(path.join(REPO_DIR, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), '# at-completion fixture\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'app.ts'), 'export const a = 1\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'composables', 'useFoo.ts'), 'export const foo = 1\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'utils', 'format.ts'), 'export const fmt = 1\n')
  fs.writeFileSync(path.join(REPO_DIR, 'docs', 'guide.md'), '# guide\n')
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: seed'])

  const projRes = await request.post(`${API_BASE}/api/projects`, {
    headers,
    data: { name: PROJ_NAME, path: serverPath(REPO_DIR) },
  })
  const body = (await projRes.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId, '夹具项目应注册成功').toBeTruthy()
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

/** 解锁后延迟出现的「建议修改默认密码」提醒会弹独立 dialog 抢焦点（既有惯例） */
async function dismissPasswordTip(page: Page): Promise<void> {
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

/** 进夹具项目页并打开新建会话对话框（草稿播种使指令 textarea 在场，P-92 聚焦） */
async function openNewSessionDialog(page: Page) {
  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.setItem('sc.newSession.draft', JSON.stringify({
      name: 'at-completion-e2e',
      runtime: 'claude',
      prompt: 'E2E 基线指令',
    }))
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await dismissPasswordTip(page)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.atv-header-actions button').filter({ hasText: '新建会话' }).click()
  const dlg = page.locator('.n-modal').filter({ hasText: '新建智能体会话' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  const promptBox = dlg.locator('[data-testid="agent-template-prompt"] textarea')
  await expect(promptBox).toBeVisible({ timeout: 5000 })
  await expect(promptBox).toHaveValue('E2E 基线指令')
  return { dlg, promptBox }
}

test('敲 @ 片段弹浮层，点选插入 @相对路径；邮箱负向不触发；Esc 关浮层不关模态', async ({ page }) => {
  const { dlg, promptBox } = await openNewSessionDialog(page)
  const popover = page.locator('[data-testid="at-completion"]')

  // ① @ 片段 → 子序列过滤 → 点选插入「@相对路径 」
  await promptBox.press('End')
  await page.keyboard.type(' fix @rea')
  await expect(popover).toBeVisible({ timeout: 10000 })
  await popover.locator('button').filter({ hasText: 'README.md' }).first().click()
  await expect(promptBox).toHaveValue('E2E 基线指令 fix @README.md ')
  await expect(popover).toHaveCount(0)

  // ② 邮箱负向：@ 前是字母（非空白边界）不触发
  await promptBox.press('End')
  await page.keyboard.type('\ncontact user@ho')
  await expect(popover).toHaveCount(0)
  await expect(dlg).toBeVisible()

  // ③ @src/ 目录级补全（P-196 修正案）：仅目录条目，选中注入目录相对路径
  await promptBox.press('End')
  await page.keyboard.type(' see @src/')
  await expect(popover).toBeVisible({ timeout: 10000 })
  const items = popover.locator('button')
  await expect(items).toHaveCount(2) // src/ 下仅 composables/ 与 utils/ 两个子目录
  await expect(items.filter({ hasText: 'app.ts' })).toHaveCount(0) // 文件不混入目录形态
  await items.filter({ hasText: 'composables/' }).first().click()
  await expect(promptBox).toHaveValue('E2E 基线指令 fix @README.md \ncontact user@ho see @src/composables/ ')
  await expect(popover).toHaveCount(0)

  // ④ Esc 关浮层且不连带关模态（keydown stopPropagation 拦 document Esc 链）
  await promptBox.press('End')
  await page.keyboard.type(' @doc')
  await expect(popover).toBeVisible({ timeout: 10000 })
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
  await expect(dlg).toBeVisible() // 模态未被连带关闭
  await expect(promptBox).toBeFocused() // 焦点回置输入框，键盘流可继续
})

test('运行中会话排队指令输入同款补全：Enter 选中不触发排队，再 Enter 入队', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  // API 造项目会话（kind shell + projectId → 项目分组树，面板按归属项目取清单）
  const created = await request.post(`${API_BASE}/api/terminals`, {
    headers,
    data: { kind: 'shell', projectId, name: 'at-queue-agent' },
  })
  expect(created.ok()).toBeTruthy()

  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await dismissPasswordTip(page)
  // 项目卡片整词定位（helpers 同款纪律：hasText 子串会误中路径含 simple-coding 的卡）
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })

  // 项目分组树会话行 → 展开排队面板（agent-queue.spec 同款驱动）
  const section = page.locator('.ats-section').filter({ hasText: 'at-queue-agent' }).first()
  await expect(section).toBeVisible({ timeout: 10000 })
  const row = section.locator('.ats-item', { hasText: 'at-queue-agent' }).first()
  await row.hover()
  await row.locator('[data-testid="session-queue-toggle"]').click()
  const panel = page.locator('[data-testid="session-queue-panel"]')
  await expect(panel).toBeVisible()

  // 敲 @ 片段 → 浮层（清单 = 夹具项目）→ Enter 选中（keydown 消费，不入队）
  const queueInput = panel.locator('input').first()
  await queueInput.fill('@read')
  const popover = page.locator('[data-testid="at-completion"]')
  await expect(popover).toBeVisible({ timeout: 10000 })
  await expect(popover.locator('button').filter({ hasText: 'README.md' })).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(queueInput).toHaveValue('@README.md ')
  await expect(popover).toHaveCount(0)
  await expect(panel.locator('.asq-item')).toHaveCount(0) // 补全选中的 Enter 不触发排队提交

  // 再按 Enter（浮层已关）：排队提交照常
  await queueInput.press('Enter')
  await expect(panel.locator('.asq-item')).toHaveCount(1)
  await expect(panel.locator('.asq-item')).toContainText('@README.md')
})
