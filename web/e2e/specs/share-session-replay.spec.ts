import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 会话回放只读分享（P-20261003-77）E2E：
 *   1. API 全链路：播种含思考块/工具/结果的 fixture transcript →
 *      POST /api/share/session（kind=session、sessionId 锚点、默认 24h TTL）
 *      → 访客结构化时间线页（/session 取数、无 SSE）→ 条目 JSON 含
 *      thinking/tool/result 且敏感值已遮蔽 → 浏览器实跑渲染 → meta 投影 →
 *      SetExpiry 过去 → 页面 410 → 撤销 → 页面与 /session 立即 404。
 *   2. UI 入口：会话回放弹层工具条「分享」→ 结果卡 → 管理列表「会话回放」
 *      徽标。
 *
 * 前置：simple-coding 已运行（含 POST /api/share/session）。
 * 测试数据：播种一条 fixture transcript 到真实 ~/.claude/projects（与
 * session-export-md.spec 同款约定——标题带 [e2e-sess-share] 标记），
 * afterAll 精确删除 fixture。服务实例与测试同机的拓扑下可跑。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const MARK = '[e2e-sess-share]'
const FAKE_DIR_NAME = 'D--e2e-sess-share-fixtures'
const SESSION_ID = 'e2e-sess-share-a1b2c3d4'
const USER_TEXT = `${MARK} 排查心跳 PASSWORD=hunter2`
const THINKING_TEXT = '先确认端口 sca_abcdef123456 再定位心跳'
const TOOL_COMMAND = 'grep -rn heartbeat server/'
const RESULT_TEXT = 'server/ws/heartbeat.go:12 interval=30s'
const SECOND_TURN = '心跳间隔 30s 正常，问题在网络层'

function buildFixture() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
  const lines = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: USER_TEXT },
      timestamp: at(6), cwd: 'D:\\e2e-sess-share-fixtures',
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'thinking', thinking: THINKING_TEXT },
        { type: 'text', text: '好的，开始排查' },
        { type: 'tool_use', id: 'toolu_ss1', name: 'Bash', input: { command: TOOL_COMMAND } },
      ] },
      timestamp: at(5),
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_ss1', content: [{ type: 'text', text: RESULT_TEXT }], is_error: false },
      ] },
      timestamp: at(4),
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: SECOND_TURN }] },
      timestamp: at(2),
    }),
  ]
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  const at10 = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, at10, at10)
}

function cleanupFixture() {
  if (process.env.SC_KEEP_FIXTURES) return
  try { fs.unlinkSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME, `${SESSION_ID}.jsonl`)) } catch { /* gone */ }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  }
}

async function getShareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

/** 打开会话回放弹层（session-export-md.spec 同款入口链） */
async function openReplayModal(page: Page) {
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.ats-tab', { hasText: 'Claude' }).click()
  const picker = view.locator('.csp-root')
  await expect(picker).toBeVisible({ timeout: 8000 })
  const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
  await picker.locator('input').fill(MARK)
  await searchResp
  const row = picker.locator('.csp-row').filter({ hasText: MARK }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.hover()
  await row.locator('.csp-row-replay').click()
  const modal = page.locator('.n-modal .cstl-root')
  await expect(modal).toBeVisible({ timeout: 10000 })
  await expect(modal.locator('.cstl-step').first()).toBeVisible({ timeout: 15000 })
  return modal
}

test.beforeAll(() => { buildFixture() })
test.afterAll(() => { cleanupFixture() })

test.beforeEach(async ({ request }) => { await cleanupShares(request) })
test.afterEach(async ({ request }) => { await cleanupShares(request) })

test('API 全链路：创建 → 访客页渲染（思考/工具可见）→ 脱敏不外泄 → 过期 410 → 撤销断链', async ({ request, page }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(request)
  const shareBase = await getShareBase(request, headers)

  const created = await request.post(`${BASE}/api/share/session`, {
    headers, data: { sessionId: SESSION_ID },
  })
  expect(created.ok()).toBeTruthy()
  const body = (await created.json()) as {
    data?: { token: string; kind: string; sessionId: string; name: string; size: number; expiresAt: string }
  }
  const share = body.data
  expect(share?.kind).toBe('session')
  expect(share?.sessionId).toBe(SESSION_ID)
  expect(share?.size).toBeGreaterThan(0)
  const remain = new Date(share!.expiresAt).getTime() - Date.now()
  expect(remain).toBeGreaterThan(23 * 60 * 60_000)
  expect(remain).toBeLessThanOrEqual(25 * 60 * 60_000)

  // 访客页：结构化时间线取数端点 + 无 SSE/轮询接线
  const pageResp = await request.get(`${shareBase}/s/${share!.token}`)
  expect(pageResp.status()).toBe(200)
  const html = await pageResp.text()
  expect(html).toContain('/session')
  expect(html).toContain('sessionReady')
  expect(html).not.toContain('EventSource')
  expect(html).not.toContain('/stream')

  // 条目净本 JSON：thinking/tool/result 全形态在列；P-108 命中值已 ***
  const sess = await request.get(`${shareBase}/s/${share!.token}/session`)
  expect(sess.ok()).toBeTruthy()
  expect(sess.headers()['content-type']).toContain('application/json')
  const snapText = await sess.text()
  for (const want of ['"kind":"thinking"', '"kind":"tool"', '"kind":"result"', '"kind":"user"']) {
    expect(snapText).toContain(want)
  }
  expect(snapText).toContain('先确认端口')
  expect(snapText).toContain(TOOL_COMMAND)
  expect(snapText).toContain('PASSWORD=***')
  expect(snapText).not.toContain('hunter2')
  expect(snapText).not.toContain('sca_abcdef')

  // 浏览器实跑：页面渲染 5 类步骤，思考块/工具详情对访客可见
  await page.goto(`${shareBase}/s/${share!.token}`)
  await expect(page.locator('body')).toHaveAttribute('data-session-ready', '1', { timeout: 20_000 })
  const steps = page.locator('[data-test="session-step"]')
  // user → thinking → assistant 文本 → tool → result → 第二回合 assistant
  await expect(steps).toHaveCount(6)
  await expect(page.locator('[data-kind="thinking"]')).toContainText('先确认端口')
  await expect(page.locator('[data-kind="tool"]')).toContainText(TOOL_COMMAND)
  await expect(page.locator('[data-kind="result"]')).toContainText(RESULT_TEXT)
  const rendered = await page.locator('body').innerText()
  expect(rendered).toContain('PASSWORD=***')
  expect(rendered).not.toContain('hunter2')
  expect(rendered).not.toContain('sca_abcdef')

  // meta：kind=session 投影
  const meta = await request.get(`${shareBase}/s/${share!.token}/meta`)
  expect(meta.ok()).toBeTruthy()
  expect(await meta.text()).toContain('"kind":"session"')

  // 过期：SetExpiry 过去时点 → 访客页 410（既有分享族过期语义）
  const past = new Date(Date.now() - 60_000).toISOString()
  const exp = await request.post(`${BASE}/api/share/${share!.token}/expiry`, {
    headers, data: { expiresAt: past },
  })
  expect(exp.ok()).toBeTruthy()
  expect((await request.get(`${shareBase}/s/${share!.token}`)).status()).toBe(410)

  // 重新创建（过期记录被惰性删除后落新周期）→ 撤销 → 页面与 /session 立即 404
  const recreated = await request.post(`${BASE}/api/share/session`, { headers, data: { sessionId: SESSION_ID } })
  expect(recreated.ok()).toBeTruthy()
  const token2 = ((await recreated.json()) as { data?: { token: string } }).data?.token
  expect(token2).toBeTruthy()
  const del = await request.delete(`${BASE}/api/share/${token2}`, { headers })
  expect(del.ok()).toBeTruthy()
  expect((await request.get(`${shareBase}/s/${token2}`)).status()).toBe(404)
  expect((await request.get(`${shareBase}/s/${token2}/session`)).status()).toBe(404)
})

test('UI 入口：回放工具条「分享」→ 结果卡短链 → 管理列表会话回放徽标', async ({ page, request }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  const modal = await openReplayModal(page)

  const shareBtn = modal.locator('[data-test="timeline-share"]')
  await expect(shareBtn).toBeVisible()
  await shareBtn.click()

  const dialog = page.locator('.share-result-modal')
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await expect(dialog).toContainText('只读时间线')
  const link = await dialog.locator('input').first().inputValue()
  expect(link).toContain('/s/')
  // 结果卡展示的是「发给手机」的地址（P-20261020-6 回环入口改局域网候选），
  // e2e 实例只绑回环时该 host 不可直连——按 token 走分享子服务基址验证可访问
  const shareBase = await getShareBase(request, headers)
  expect((await request.get(`${shareBase}/s/${link.split('/s/')[1]}`)).status()).toBe(200)

  await dialog.getByRole('button', { name: '关闭' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  // 结果卡关掉后回放弹层仍在：先关弹层再进主区导航，否则 n-modal 遮罩
  // 拦截侧栏点击（叠层遮挡是测试编排问题，不是产品缺陷）
  await page.locator('.n-modal:has(.cstl-root) .n-base-close').first().click()
  await expect(modal).toHaveCount(0, { timeout: 5000 })

  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.share-manager')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-testid="sm-session-badge"]').first()).toBeVisible({ timeout: 20_000 })
})
