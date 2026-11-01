import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 命令片段占位符参数化（P-20261002-123）E2E：
 *   1. 带 {name} 占位符片段 → 面板点击展开内联参数区 → 填值确认 → 含值命令插入
 *      终端（回车后 shell 执行含值命令，无占位符残留）
 *   2. 历史值记忆：再次点击同一片段，参数输入框预填上次填写值
 *   3. {{ 转义片段无参数区（直接插入不变），插入文本为字面单大括号
 * 前置（spec 内自备）：临时空项目 + 经 API 造片段（脚手架同 terminal-history-snippet）。
 * 本机终端语义为「插入不执行」（防误执行，产品既有设计）——回车执行由用例显式触发；
 * 远程控制台 sendMode 的「确认即执行」不在此覆盖（需远程主机夹具）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-snippet-params'
// 片段标题前缀加运行戳：实例 DB 跨用例存活，避免上轮残留片段干扰列表定位
const RUN = Date.now().toString(36)
const PARAM_TITLE = `e2e参数片段${RUN}`
const PARAM_CMD = 'echo sc-e2e-{tag}-{n}'
// {{x y}} 内容含空格非合法占位符名 → 整段按转义还原为字面 {x y}（{{合法名}} 是
// 旧双大括号占位符形式，不作转义演示——语义见 utils/textTemplate 头注）
const LIT_TITLE = `e2e转义片段${RUN}`
const LIT_CMD = 'echo lit-{{x y}}'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-snippet-params')

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

let createdIds: string[] = []

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) await api('DELETE', `/api/projects/${oldProj.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201], `create project → ${proj.status} ${JSON.stringify(proj.json)}`).toContain(proj.status)
  const oldSps = await api('GET', '/api/snippets')
  for (const s of ((oldSps.json?.data || []) as { id: string; title: string }[])) {
    if (s.title.startsWith('e2e参数片段') || s.title.startsWith('e2e转义片段')) {
      await api('DELETE', `/api/snippets/${s.id}`)
    }
  }

  const param = await api('POST', '/api/snippets', { title: PARAM_TITLE, command: PARAM_CMD, description: 'e2e' })
  expect([200, 201]).toContain(param.status)
  createdIds.push(param.json?.data?.id)
  const lit = await api('POST', '/api/snippets', { title: LIT_TITLE, command: LIT_CMD, description: 'e2e' })
  expect([200, 201]).toContain(lit.status)
  createdIds.push(lit.json?.data?.id)
})

test.afterAll(async () => {
  for (const id of createdIds) {
    if (id) await api('DELETE', `/api/snippets/${id}`)
  }
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

async function switchProject(page: Page, name: string) {
  await page.locator('.header-project-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: name }).first().click()
}

async function openFreshTerminal(page: Page) {
  const panel = page.locator('.bottom-panel')
  const ensureOpen = async () => {
    // 项目切换的异步布局应用可能在点击后把面板收起（持久化布局 showBottomPanel=
    // false 迟到覆盖，分片负载下恢复请求常晚于单次点击，run9 实测）——rail 点击
    // 幂等重验（terminal-history-repeat 同款守卫）
    for (let i = 0; i < 3 && !(await panel.isVisible().catch(() => false)); i++) {
      await page.locator('.rail-btn[title="终端"]').click()
      await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态，重试 */ })
    }
    await expect(panel).toBeVisible({ timeout: 5000 })
  }
  await ensureOpen()
  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
  await ensureOpen()
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  return xterm
}

async function openSnippetPanel(page: Page) {
  await page.locator('.term-toolbar button[title="命令片段"]').click()
  const panel = page.locator('.snippet-panel')
  await expect(panel).toBeVisible()
  return panel
}

test('带参片段：填值确认插入含值命令 + 历史值预填 + 转义片段直接插入', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  // 历史值记忆落在 localStorage（safeStorage）：清掉上轮残留，保证「首次展开为空」可断言
  await page.addInitScript(() => localStorage.removeItem('sc.snippet.paramValues'))
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)
  await xterm.click()

  // ---- 带参片段：首次点击展开内联参数区（两个占位符输入框，无预填）----
  const panel = await openSnippetPanel(page)
  const item = panel.locator('.snippet-item').filter({ hasText: PARAM_TITLE }).first()
  await expect(item).toBeVisible({ timeout: 10000 })
  await item.click()
  const params = panel.locator('.snippet-params')
  await expect(params).toBeVisible()
  await expect(params.locator('.snippet-param-row')).toHaveCount(2)
  const inputs = params.locator('input')
  await expect(inputs.nth(0)).toHaveValue('')
  await expect(inputs.nth(1)).toHaveValue('')

  // 填值确认 → 插值后的含值命令进入终端输入行（插入不执行）
  await inputs.nth(0).fill('alpha')
  await inputs.nth(1).fill('7')
  await params.locator('button').filter({ hasText: '填好插入' }).click()
  await expect(xterm).toContainText('echo sc-e2e-alpha-7', { timeout: 5000 })
  await expect(params).toHaveCount(0) // 确认后参数区收起

  // 回车执行：shell 跑含值命令（无占位符残留）
  await xterm.click()
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1000)
  await expect(xterm).toContainText('sc-e2e-alpha-7')

  // ---- 历史值记忆：再次点击同一片段，输入框预填上次填写值 ----
  await item.click()
  await expect(params).toBeVisible()
  await expect(inputs.nth(0)).toHaveValue('alpha')
  await expect(inputs.nth(1)).toHaveValue('7')
  // 改一个值确认插入 → 插值按新值组合
  await inputs.nth(1).fill('8')
  await params.locator('button').filter({ hasText: '填好插入' }).click()
  await expect(xterm).toContainText('echo sc-e2e-alpha-8', { timeout: 5000 })
  await xterm.click()
  await page.keyboard.press('Control+c')

  // ---- {{ 转义片段：无占位符不弹参数区，插入为字面单大括号 ----
  const litItem = panel.locator('.snippet-item').filter({ hasText: LIT_TITLE }).first()
  await expect(litItem).toBeVisible({ timeout: 10000 })
  await litItem.click()
  await expect(params).toHaveCount(0)
  await expect(xterm).toContainText('echo lit-{x y}', { timeout: 5000 })
})
