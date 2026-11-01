import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 任务模板 {selection} 占位符（P-20261005-149）E2E：
 *   1. 编辑器选中代码 → 开新建会话对话框选含 {selection} 模板 → 指令含选区文本
 *      （打开时刻快照经 navHistory 信标入占位符）
 *   2. 无选区 → {selection} 原样保留（P-16「未解析保留」语义）+ 无选区专属提示可见
 *   3. 超长选区（Ctrl+A 全选 >200 rune 文件）→ 保头 200 rune +「选区已截断」注记可见
 * 模板经 PATCH /api/ui-state 直接播种（local 实例键顶层浅合并，只动
 * agentTaskTemplates 命名空间；后经同通道置 null 复原 = 回落出厂预置）。
 * 自备临时仓库；不创建会话（断言面是模板解析与提示呈现，launchArgs 注入链由
 * agent-task-template.spec 覆盖），afterAll 清理项目、模板键与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-agent-template-selection')
const PROJ_NAME = 'e2e-agent-template-selection'
const FILE = 'app.ts'
const SEL_TPL_NAME = 'E2E 选区模板'
const SEL_TPL_PROMPT = '审查这段代码：{selection}'
const TRUNCATED_NOTE = '…（选区已截断）'
// 夹具文件全文（第 4 行 260 rune > 200 截断上限，供 Ctrl+A 全选触发截断）
const FILE_BODY = [
  'export function hello(name: string): string {',
  '  return `hello ${name}`',
  '}',
  `const longLine = "${'x'.repeat(260)}"`,
  '',
].join('\n')
// 键盘选前两行（ask-selection.spec 同款口径）的期望选区文本
const SEL_TEXT = `${FILE_BODY.split('\n')[0]}\n${FILE_BODY.split('\n')[1]}`
// Ctrl+A 全选期望的解析值：头 200 rune（码点计数）+ 截断注记
const TRUNCATED_HEAD = Array.from(FILE_BODY).slice(0, 200).join('')

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
  fs.writeFileSync(path.join(REPO_DIR, FILE), FILE_BODY)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: seed'])

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''

  // 播种含 {selection} 的定制模板（uiState local 实例键浅合并，只动本命名空间）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ local: { agentTaskTemplates: { items: [
      { id: 'tpl-e2e-selection', name: SEL_TPL_NAME, prompt: SEL_TPL_PROMPT },
    ] } } }),
  })
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  // 模板键置 null：读取器按「未定制」回落出厂预置（seed 物化态不残留污染他 spec）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ local: { agentTaskTemplates: null } }),
  })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 进项目页（不打开编辑器的干净入口） */
async function gotoProject(page: Page) {
  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
}

/** 进项目页并打开夹具文件（ask-selection.spec 同款就绪等待/重试口径） */
async function gotoProjectAndOpenFile(page: Page) {
  await gotoProject(page)
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await page.locator('.file-tree .item-name').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  // 工具栏轮询重渲染会让元素瞬时失效：点击一律带重试
  const clickRetry = async (loc: import('@playwright/test').Locator, timeout = 2000, attempts = 8) => {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try { await loc.click({ timeout }); return } catch (err) { lastErr = err; await page.waitForTimeout(300) }
    }
    throw lastErr
  }
  await clickRetry(page.getByText(FILE).first(), 2000, 10)
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20000 })
}

/** 键盘选中前两行（ask-selection.spec 同款：重试点选 + 选区渲染轮询收敛） */
async function selectFirstTwoLines(page: Page) {
  const line1 = page.locator('.monaco-editor .view-line').first()
  const selected = page.locator('.monaco-editor .selected-text').first()
  for (let attempt = 0; attempt < 4; attempt++) {
    await line1.click({ position: { x: 10, y: 8 } })
    await page.keyboard.press('Home')
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('End')
    await page.keyboard.up('Shift')
    try {
      await expect(selected).toBeVisible({ timeout: 2000 })
      return
    } catch { /* 选区未渲染/键盘被吞：重试点选 */ }
  }
  throw new Error('键盘选区未落上（.selected-text 未出现）')
}

/** Ctrl+A 全选（选区渲染轮询收敛同款） */
async function selectAll(page: Page) {
  const line1 = page.locator('.monaco-editor .view-line').first()
  const selected = page.locator('.monaco-editor .selected-text').first()
  for (let attempt = 0; attempt < 4; attempt++) {
    await line1.click({ position: { x: 10, y: 8 } })
    await page.keyboard.press('ControlOrMeta+a')
    try {
      await expect(selected).toBeVisible({ timeout: 2000 })
      return
    } catch { /* 选区未渲染/键盘被吞：重试点选 */ }
  }
  throw new Error('Ctrl+A 全选未落上（.selected-text 未出现）')
}

/** 开新建会话对话框并选播种模板，返回指令 textarea */
async function openDialogAndPickTemplate(page: Page) {
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.atv-header-actions button').filter({ hasText: '新建会话' }).click()
  const dlg = page.locator('.n-modal').filter({ hasText: '新建智能体会话' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('[data-testid="agent-template-select"] .n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: SEL_TPL_NAME }).click()
  const promptBox = dlg.locator('[data-testid="agent-template-prompt"] textarea')
  await expect(promptBox).toBeVisible({ timeout: 5000 })
  return { dlg, promptBox }
}

test('选中代码段→选模板：指令含选区文本（打开时刻快照入占位符）', async ({ page }) => {
  await gotoProjectAndOpenFile(page)
  await selectFirstTwoLines(page)
  // 选区就绪后开对话框：编辑器主区 v-show 保活（docked 管理页不卸载编辑器），
  // 信标值跨视图切换存活，对话框打开时刻快照命中
  const { promptBox } = await openDialogAndPickTemplate(page)
  await expect(promptBox).toHaveValue(SEL_TPL_PROMPT.replace('{selection}', SEL_TEXT), { timeout: 5000 })
})

test('无选区→{selection} 原样保留 + 无选区专属提示可见', async ({ page }) => {
  // 不打开任何文件：信标空 → 占位符走 P-16「未解析原样保留」+ 提示面区分无选区
  await gotoProject(page)
  const { dlg, promptBox } = await openDialogAndPickTemplate(page)
  await expect(promptBox).toHaveValue(SEL_TPL_PROMPT, { timeout: 5000 })
  await expect(dlg.locator('[data-testid="agent-template-selection-hint"]')).toBeVisible()
})

test('超长选区（Ctrl+A 全选 >200 rune）→ 头 200 rune + 截断注记', async ({ page }) => {
  await gotoProjectAndOpenFile(page)
  await selectAll(page)
  const { promptBox } = await openDialogAndPickTemplate(page)
  await expect(promptBox).toHaveValue(
    `${SEL_TPL_PROMPT.replace('{selection}', '')}${TRUNCATED_HEAD}${TRUNCATED_NOTE}`,
    { timeout: 5000 },
  )
})
