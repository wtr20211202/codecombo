import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 会话录制一键转运行书（P-20261005-3）E2E：
 *   1. 带 OSC133 索引的 cast → 回放器「存为运行书」→ 大屏路由进项目页 +
 *      运行书面板新建表单预填（标题「<今日> 会话操作」/ 相邻重复折叠为单步 /
 *      失败命令描述标注「录制时失败（exit 7）」/ 入库前警示条）→ 确认落库
 *      （API 复核步骤序与失败标注）→ 全书「运行」三步命令全部真执行
 *   2. 无 OSC133 索引的 cast（裸 sh）→ 入口隐藏（同章节跳转判定）
 * 录制数据面经 page.route 播种（cast 产出链路已由 approval-recording.spec 覆盖，
 * 本 spec 只验「索引 → 草稿 → 表单 → 落库 → 执行」的前端粘合层）；落库与全书
 * 执行走真实 API / 终端。前置（spec 内自备）：临时空项目 + 清理同名运行书。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-runbook-rec'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-runbook-rec')
const REC_ID = 'rec-e2e-rbook'

// 草稿标题日期段（本地时区 YYYY-MM-DD，与 CastReplayer.todayLabel 同口径）
const TODAY = (() => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
})()
const BOOK_TITLE = `${TODAY} 会话操作`
// 命令全部 echo（误执行无副作用）；s2 的退出码 7 只来自 cast 的 D 帧（失败标注来源）
const STEP_CMDS = ['echo sc-r2s1', 'echo sc-r2s2', 'echo sc-r2s3']
const FAIL_EXIT = 7

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

async function cleanupRunbook(): Promise<void> {
  const list = await api('GET', '/api/runbooks')
  for (const b of ((list.json?.data || []) as { id: string; title: string }[])) {
    if (b.title === BOOK_TITLE) await api('DELETE', `/api/runbooks/${b.id}`)
  }
}

/** 构造 asciinema v2 cast：cmds 逐条产 E（命令文本 b64）→ C → D（退出码）链 */
function buildCast(cmds: { cmd: string; code: number }[], withOsc133: boolean): string {
  const lines: string[] = [JSON.stringify({ version: 2, width: 80, height: 24 })]
  let t = 0.1
  const push = (data: string) => {
    lines.push(JSON.stringify([t, 'o', data]))
    t += 0.2
  }
  for (const { cmd, code } of cmds) {
    if (withOsc133) {
      push(`\x1b]133;E;${Buffer.from(cmd, 'utf-8').toString('base64')}\x07`)
      push('\x1b]133;C\x07')
      push(`\x1b]133;D;${code};5\x07`)
    } else {
      push(`${cmd}\r\n`)
    }
  }
  push('done\r\n')
  return lines.join('\n')
}

/** 播种录制数据面（列表 + cast）：真实产出链路由 approval-recording.spec 覆盖 */
async function mockRecording(page: Page, castText: string): Promise<void> {
  await page.route('**/api/recordings**', (route) => {
    const url = route.request().url()
    if (url.includes('/cast')) {
      return route.fulfill({ status: 200, contentType: 'text/plain', body: castText })
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: [{
          id: REC_ID,
          approvalIds: [],
          op: 'reset --hard',
          target: 'e2e',
          status: 'completed',
          startedAt: new Date().toISOString(),
          sizeBytes: 2048,
        }],
      }),
    })
  })
}

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
  await cleanupRunbook()
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
})

test.afterAll(async () => {
  await cleanupRunbook()
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
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText(/[$#] |PS /, { timeout: 20000 })
  return xterm
}

/** 大屏入口打开录制浏览器（数据面已 mock） */
async function openRecordingBrowser(page: Page) {
  await page.goto('/monitor')
  await unlockIfNeeded(page)
  await page.getByRole('button', { name: '实况记录' }).click()
  const modal = page.locator('.rb-modal')
  await expect(modal).toBeVisible({ timeout: 10000 })
  await expect(modal.locator('.rb-item')).toHaveCount(1, { timeout: 10000 })
  return modal
}

test('存为运行书：索引→草稿预填（折叠/失败标注/警示条）→确认落库→全书执行', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)

  // 播种带 OSC133 索引的 cast（s1 重复一次 = 相邻重复折叠样例；s2 exit 7 = 失败标注样例）
  await mockRecording(page, buildCast([
    { cmd: STEP_CMDS[0]!, code: 0 },
    { cmd: STEP_CMDS[0]!, code: 0 },
    { cmd: STEP_CMDS[1]!, code: FAIL_EXIT },
    { cmd: STEP_CMDS[2]!, code: 0 },
  ], true))

  const modal = await openRecordingBrowser(page)
  // 命令索引在列（章节列表 4 条：s1 重复两次）→ 存为运行书入口在场
  //（折叠发生在草稿映射层，章节列表如实全列）
  await expect(modal.locator('.cr-chapter')).toHaveCount(4, { timeout: 10000 })
  const saveBtn = modal.locator('.cr-toolbar').getByRole('button', { name: '存为运行书' })
  await expect(saveBtn).toBeVisible()

  await saveBtn.click()

  // 弹层收起 + 直达项目页：运行书面板新建表单预填草稿
  await expect(modal).toBeHidden({ timeout: 5000 })
  await expect(page).toHaveURL(/\/project/)
  const form = page.locator('.runbook-form')
  await expect(form).toBeVisible({ timeout: 10000 })
  // 标题预填「<今日> 会话操作」（可改）
  await expect(form.locator('input').first()).toHaveValue(BOOK_TITLE)
  // 来源录制 → 入库前检查命令原文警示条
  await expect(form.locator('.runbook-form-caution')).toBeVisible()
  // 相邻重复折叠为单步：4 章节落成 3 步；失败命令照录 + 描述标注
  const stepRows = form.locator('.runbook-form-step')
  await expect(stepRows).toHaveCount(3)
  await expect(stepRows.nth(0).locator('textarea')).toHaveValue(STEP_CMDS[0]!)
  await expect(stepRows.nth(1).locator('textarea')).toHaveValue(STEP_CMDS[1]!)
  await expect(stepRows.nth(1).locator('input')).toHaveValue(`录制时失败（exit ${FAIL_EXIT}）`)
  await expect(stepRows.nth(2).locator('textarea')).toHaveValue(STEP_CMDS[2]!)

  // 人工过目确认落库（生成物是草稿非直入库）
  await form.getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '运行书已保存' })).toBeVisible({ timeout: 5000 })

  // API 落库复核：步骤序 = 折叠后命令序列；失败标注随步骤入库；onFailure 缺省 continue
  const list = await api('GET', '/api/runbooks')
  const mine = ((list.json?.data || []) as {
    title: string
    onFailure?: string
    steps: { command: string; description?: string }[]
  }[]).find(b => b.title === BOOK_TITLE)
  expect(mine, 'runbook persisted').toBeTruthy()
  expect(mine!.steps.map(s => s.command)).toEqual(STEP_CMDS)
  expect(mine!.steps[1]!.description).toBe(`录制时失败（exit ${FAIL_EXIT}）`)
  expect(mine!.steps[0]!.description).toBeUndefined()
  expect(mine!.onFailure ?? 'continue').toBe('continue')

  // 全书执行含全部命令：新开终端（活动 pane 已连）→ 开书 → 运行 → 三步输出全上屏
  const xterm = await openFreshTerminal(page)
  await page.locator('.runbook-item').filter({ hasText: BOOK_TITLE }).first().click()
  await expect(page.locator('.runbook-panel .runbook-step')).toHaveCount(3)
  await page.locator('.runbook-steps-actions').getByRole('button', { name: '运行', exact: true }).click()
  await expect(page.locator('.runbook-run-status')).toContainText('运行完成', { timeout: 90000 })
  await expect(xterm).toContainText('sc-r2s1', { timeout: 5000 })
  await expect(xterm).toContainText('sc-r2s2', { timeout: 5000 })
  await expect(xterm).toContainText('sc-r2s3', { timeout: 10000 })
})

test('无 OSC133 索引的 cast：存为运行书入口隐藏（降级同章节跳转判定）', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await mockRecording(page, buildCast([{ cmd: 'echo plain-sh', code: 0 }], false))

  const modal = await openRecordingBrowser(page)
  // 回放器就绪但无命令索引（裸 sh）→ 章节区回落占位提示 + 入口隐藏
  await expect(modal.locator('.cr-no-chapters')).toBeVisible({ timeout: 10000 })
  await expect(modal.getByRole('button', { name: '存为运行书' })).toHaveCount(0)
})
