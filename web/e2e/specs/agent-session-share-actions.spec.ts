import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * 终端会话管理页分享/导出能力对齐（P-20261106-7 双入口纪律）E2E：
 *   1. 会话树行右键菜单含四件（直播分享 / 分享输出快照 / 分享回放 / 导出输出）
 *      ——与底部终端 tab 右键同款；「直播分享」→ 行红点徽标即现（创建点即时
 *      对账，不等轮询）+ title 携「直播中」→ 右键同位翻转「结束直播」→ 一键撤销
 *      红点即摘 + 服务端分享记录消失（撤销即断流，P-306 既有链不变）
 *   2. 行右键「导出输出」→ 走服务端会话层导出链（GET /terminals/:id/export，
 *      tmux capture-pane / native 环形缓冲）落下载附件——会话管理页的 agent 会话
 *      没有底部 tab，此前四件能力在其唯一宿主缺席
 * 会话用 runtime=shell 的 agent 会话（kind=agent，只在管理页出现、不进底部
 * tab 条——正是双入口对齐要补的那一侧）；直播清场走全量分享撤销。
 */

const SESSION_NAME = 'e2e-mgr-share-actions'
const DL_DIR = path.join(os.tmpdir(), 'sc-e2e-mgr-share-actions')

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态，保证确定性；终端直播撤销同时断流） */
async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/share/${s.token}`, { headers })
  }
}

/** 按名清理本 spec 的 agent 会话（重跑残留 + 用后即删） */
async function cleanupSessions(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name?: string }[] }).data || []
  for (const s of list) {
    if (s.name === SESSION_NAME) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers }).catch(() => { /* 已不存在即目标态 */ })
    }
  }
}

/** 某会话当前直播 token（列表过滤 kind=terminal + terminalId 锚定） */
async function liveTokenOf(request: APIRequestContext, sessionId: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string; kind: string; terminalId?: string }[] }).data || []
  return list.find(s => s.kind === 'terminal' && s.terminalId === sessionId)?.token || ''
}

/** 解锁后延迟出现的「建议修改默认密码」提醒遮罩会拦截点击，先收起（既有惯例） */
async function dismissPasswordTip(page: Page): Promise<void> {
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

/** 进项目页并打开 docked 终端会话管理页，返回管理页根与目标会话行 */
async function openManagerRow(page: Page): Promise<{ view: ReturnType<Page['locator']>; row: ReturnType<Page['locator']> }> {
  await fixedLocale(page)
  // agent 终端开合状态是 localStorage：显式清一次避免上例 docked 残留态影响入口点击
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await dismissPasswordTip(page)
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10_000 })
  const row = view.locator('.ats-item').filter({ hasText: SESSION_NAME }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  return { view, row }
}

test.describe('agent-session-share-actions', () => {
  test.beforeEach(async ({ request }) => {
    await cleanupShares(request)
    await cleanupSessions(request)
  })

  test.afterEach(async ({ request }) => {
    await cleanupSessions(request)
    await cleanupShares(request)
  })

  test('会话树行右键四件 + 直播分享→行红点即现→结束直播→红点即摘', async ({ page, request }) => {
    test.setTimeout(120_000)
    const created = await createAgentSessionApi(request, { name: SESSION_NAME })
    const { row } = await openManagerRow(page)

    // 无直播：行无红点
    await expect(row.locator('[data-test="session-live-badge"]')).toHaveCount(0)

    // 右键：四件齐全（与底部终端 tab 右键同款），直播项文案为「直播分享」
    await row.click({ button: 'right' })
    const option = (text: string) => page.locator('.n-dropdown-option').filter({ hasText: text })
    await expect(option('直播分享')).toBeVisible({ timeout: 5000 })
    await expect(option('分享输出快照')).toBeVisible()
    await expect(option('分享回放')).toBeVisible()
    await expect(option('导出输出')).toBeVisible()
    await option('直播分享').click()

    // 选项弹层（P-20261106-9）：创建链先过遮蔽/水印选项——遮蔽缺省开（安全
    // 基线），直接确认创建（与底部 tab 右键 share-terminal-live-tab.spec 同款）
    const options = page.locator('[data-testid="share-term-options"]')
    await expect(options).toBeVisible({ timeout: 5000 })
    await expect(options).toHaveAttribute('data-kind', 'live')
    await page.locator('[data-testid="share-term-confirm"]').click()

    // 创建链即挂徽标（bump 即时对账，不等 30s 轮询）；title 携「直播中」
    const badge = row.locator('[data-test="session-live-badge"]')
    await expect(badge).toBeVisible({ timeout: 10_000 })
    await expect(badge).toHaveAttribute('title', /直播中/)

    // 服务端分享记录锚定该会话（TerminalID 会话级寻址）；结果卡可关（模态挡后续右键）
    const token = await liveTokenOf(request, created.id)
    expect(token).toBeTruthy()
    await page.locator('.share-result-modal .result-footer').getByRole('button', { name: '关闭' }).click()
    await expect(page.locator('.share-result-modal')).toBeHidden({ timeout: 5000 })

    // 右键同位翻转「结束直播」→ 一键撤销 → 红点即摘 + 记录消失
    await row.click({ button: 'right' })
    await expect(option('结束直播')).toBeVisible({ timeout: 5000 })
    await option('结束直播').click()
    await expect(badge).toHaveCount(0, { timeout: 10_000 })
    await expect(async () => {
      expect(await liveTokenOf(request, created.id)).toBe('')
    }).toPass({ timeout: 10_000 })
  })

  test('行右键「导出输出」走服务端会话层导出链落下载附件', async ({ page, request }) => {
    test.setTimeout(90_000)
    fs.mkdirSync(DL_DIR, { recursive: true })
    await createAgentSessionApi(request, { name: SESSION_NAME })
    const { row } = await openManagerRow(page)

    await row.click({ button: 'right' })
    const exportItem = page.locator('.n-dropdown-option').filter({ hasText: '导出输出' })
    await expect(exportItem).toBeVisible({ timeout: 5000 })
    // download 事件与点击并行等（点击后才触发请求→blob→a.click）
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10_000 }),
      exportItem.click(),
    ])
    const file = path.join(DL_DIR, download.suggestedFilename())
    await download.saveAs(file)
    // 下载名沿 P-100 约定：terminal-<会话名摘要>-<yyyymmdd>.txt（两入口同一合成函数）
    expect(download.suggestedFilename()).toMatch(/^terminal-.*-\d{8}\.txt$/)
    expect(fs.existsSync(file)).toBe(true)
  })
})
