import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 新建会话对话框打开聚焦 E2E（P-20261004-92 键盘流第一步）：
 *   1. 全新打开 → 会话名输入框自动聚焦（focus 断言）→ 不点任何控件直接键入
 *      即落在输入框（键入先被运行时下拉 typeahead 吃掉的回归即在此翻红）
 *   2. 草稿恢复打开 → 任务指令 textarea 聚焦 + 顶部恢复提示在场 → 直接键入
 *      落在 textarea（聚焦与 P-89 恢复提示协调：聚焦不改值、提示不受扰）
 * 草稿用例经 localStorage 直接播种 sc.newSession.draft——草稿「保存/仲裁」
 * 链路由 agent-new-session-draft.spec 覆盖，此处只测「恢复后的聚焦落点」；
 * n-modal focus-trap autoFocus 会先聚焦第一个可聚焦元素（运行时下拉/恢复
 * 提示丢弃钮），组件 nextTick 续体聚焦主输入为最终落点——两用例都是对
 * 「键入即落主输入」的端到端裁决。草稿在浏览器 localStorage，每用例新
 * context 天然隔离；自备临时仓库，afterAll 清理项目与夹具（不建会话，
 * 无终端清理面）
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-agent-new-session-focus')
const PROJ_NAME = 'e2e-agent-new-session-focus'
const DRAFT_KEY = 'sc.newSession.draft'
const DRAFT = {
  name: 'e2e 键盘流恢复会话',
  runtime: 'claude',
  prompt: 'E2E 键盘流草稿指令：审查当前工作区改动',
}

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

let projectId = ''

test.beforeAll(async ({ request }) => {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }

  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${API_BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  fs.writeFileSync(path.join(REPO_DIR, 'app.ts'), 'export const a = 1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: seed'])

  const projRes = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await projRes.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
})

test.afterAll(async ({ request }) => {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 解锁后延迟出现的「建议修改默认密码」提醒会弹独立 dialog 抢焦点——本 spec
 *  断言的是焦点落点，必须先收起（agent-runtime-version 同款既有惯例） */
async function dismissPasswordTip(page: Page): Promise<void> {
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

/** 进项目页并打开新建会话对话框（agent-new-session-draft 同款入口链） */
async function openNewSessionDialog(page: Page) {
  await fixedLocale(page)
  await page.addInitScript(() => {
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
  return dlg
}

test('全新打开聚焦会话名：直接键入即落在输入框', async ({ page }) => {
  const dlg = await openNewSessionDialog(page)
  const nameInput = dlg.locator('.n-form-item').filter({ hasText: '会话名' }).locator('input')

  // focus 断言：打开即聚焦会话名（首个非空打开路径的落点，见组件注记）
  await expect(nameInput).toBeFocused({ timeout: 5000 })

  // 键盘流第一步端到端：不点任何控件，直接键入落在输入框
  await page.keyboard.type('e2e-focus-flow')
  await expect(nameInput).toHaveValue('e2e-focus-flow')
})

test('草稿恢复打开聚焦指令 textarea：恢复提示在场且直接键入落 textarea', async ({ page }) => {
  // 直接播种草稿（保存链路见 agent-new-session-draft.spec）：重开恢复场景下
  // 指令 textarea 由 v-if=templateId||promptText 渲染，主输入落点切换到它
  await page.addInitScript(({ key, draft }) => {
    localStorage.setItem(key, draft)
  }, { key: DRAFT_KEY, draft: JSON.stringify(DRAFT) })

  const dlg = await openNewSessionDialog(page)

  // 恢复确实发生（聚焦协调的前提）：恢复提示在场 + 字段回填
  await expect(page.locator('[data-testid="agent-draft-restored"]')).toBeVisible({ timeout: 3000 })
  const promptBox = dlg.locator('[data-testid="agent-template-prompt"] textarea')
  await expect(promptBox).toBeVisible({ timeout: 3000 })
  await expect(promptBox).toHaveValue(DRAFT.prompt)
  await expect(dlg.locator('.n-form-item').filter({ hasText: '会话名' }).locator('input')).toHaveValue(DRAFT.name)

  // 主输入落点 = 指令 textarea（launchArgs 主文本域，延续进行中内容）
  await expect(promptBox).toBeFocused({ timeout: 5000 })

  // 直接键入落在 textarea（光标在端点，含 X 即落在正文）
  await page.keyboard.type('X')
  await expect(promptBox).toHaveValue(new RegExp('X'))
})
