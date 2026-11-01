import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 值班交接包（P-20261005-148）E2E：
 *   1. 值班大屏入口：pending 审批播种 → 生成 → 文档含静态快照注记/审批段/
 *      日报与热力段标题 → 复制剪贴板 → 分享短链 → 访客页只读可读（三段 +
 *      24h 过期提示）
 *   2. 在跑会话入档：项目终端跑长命令点亮运行态 → 会话段含会话名（SPA 内
 *      导航，整页 goto 会重载丢内存 runningMap——同 shift-summary 口径）
 *   3. 通知中心入口：同款弹层可达（App 层浮窗头部按钮）
 * 共享 :9999 实例（workers=1 串行）；审批/分享/终端全局清账防残留
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-handover'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-handover')
// 长命令按服务端 shell 分支：点亮运行态只需 C 帧在账（同 shift-summary）
const SLEEP_CMD = serverIsLinux ? 'sleep 90' : 'Start-Sleep -Seconds 90'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（Windows ConPTY 死会话不从会话表自移除） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers }).catch(() => {})
  }
}

/** 清理 pending 审批（全局广播，残留会污染后续用例的审批段计数） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    }).catch(() => {})
  }
}

/** 清空分享列表（snippet 幂等键=内容哈希，时间戳使内容次次不同，不清会堆积） */
async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/share/${s.token}`, { headers }).catch(() => {})
  }
}

async function getShareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

/** 播种一条 pending 审批（sessionId 可空——交接包行不依赖会话归属） */
async function seedApproval(request: APIRequestContext, sessionId: string): Promise<void> {
  const headers = await unlockHeaders(request)
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId, op: 'reset --hard', target: 'main', detail: 'e2e 交接包验证' },
  })
  expect(appr.ok()).toBeTruthy()
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovals(request)
  await cleanupShares(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovals(request)
  await cleanupShares(request)
})

let pid = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await request.get(`${BASE}/api/projects`, { headers })
  const oldProj = ((await stale.json()) as { data?: { id: string; name: string }[] }).data
    ?.find(p => p.name === PROJ_NAME)
  if (oldProj) await request.delete(`${BASE}/api/projects/${oldProj.id}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  const proj = await request.post(`${BASE}/api/projects`, {
    headers, data: { name: PROJ_NAME, path: serverPath(REPO_DIR) },
  })
  expect([200, 201]).toContain(proj.status())
  pid = ((await proj.json()) as { data?: { id: string } }).data?.id || ''
})

test.afterAll(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovals(request)
  const headers = await unlockHeaders(request)
  const list = await request.get(`${BASE}/api/projects`, { headers })
  const mine = ((await list.json()) as { data?: { id: string; name: string }[] }).data
    ?.find(p => p.name === PROJ_NAME)
  if (mine) await request.delete(`${BASE}/api/projects/${mine.id}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

/** 大屏打开交接包弹窗（数据装配异步：等文档 textarea 出现非空值） */
async function openHandoverOnMonitor(page: Page): Promise<void> {
  await page.locator('[data-testid="monitor-handover-btn"]').click()
  const doc = page.locator('[data-testid="handover-doc"] textarea')
  await expect(page.locator('[data-testid="handover-modal"]')).toBeVisible({ timeout: 5000 })
  await expect(doc).toHaveValue(/# 值班交接包/, { timeout: 15000 })
}

test('大屏交接包：审批入档 + 三段结构 + 复制 + 分享短链访客可读', async ({ page, request }) => {
  test.setTimeout(120000)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)

  // 播种 pending 审批（弹窗 generate 自带 seedApprovals 补账，API 播种即入档；
  // 无会话归属 → 行不带会话名，交接包对孤儿审批照收）
  await seedApproval(request, '')
  // 触发 store 广播对账的兜底：等审批卡类目出现（弹窗与卡片同源 store）
  await expect(page.locator('.mon-card.is-approval')).toHaveCount(1, { timeout: 10000 })

  await openHandoverOnMonitor(page)
  const doc = page.locator('[data-testid="handover-doc"] textarea')
  const value = await doc.inputValue()
  // 文档三段结构：审批段含 op/target（API 播种无会话归属 → agent=未知来源，
  // 行首标签不钉 claude）；日报/热力段标题恒在（内容随实例档位）
  expect(value).toContain('## 待裁决审批（1）')
  expect(value).toContain('reset --hard main')
  expect(value).toContain('## 当日日报（')
  expect(value).toContain('## 今日活动')
  // 静态快照注记随文档走（接手人视角 ③）
  expect(value).toContain('> 静态快照：生成于')

  // 复制出口：剪贴板 = 文档全文（Windows 剪贴板把 \n 归一为 \r\n，比较前还原）
  await page.locator('[data-testid="handover-copy"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '交接包已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip.replace(/\r\n/g, '\n')).toBe(value)

  // 分享出口：短链结果卡（访客短链 + TTL 注记；服务端回 expiresAt → 「将于…自动过期」形态）
  await page.locator('[data-testid="handover-share"]').click()
  const urlEl = page.locator('[data-testid="handover-share-url"]')
  await expect(urlEl).toBeVisible({ timeout: 15000 })
  const link = (await urlEl.textContent()) || ''
  expect(link).toMatch(/\/s\/[0-9a-z]{16}$/)
  await expect(page.locator('.handover-share-result').filter({ hasText: '自动过期' })).toBeVisible()

  // 接手人视角：访客页只读可读（片段代码块形态 + 过期提示条）
  const shareBase = await getShareBase(request, await unlockHeaders(request))
  await page.goto(`${shareBase}/s/${link.split('/s/')[1]}`)
  const article = page.locator('.md-article pre code')
  await expect(article).toContainText('待裁决审批（1）', { timeout: 10000 })
  await expect(article).toContainText('## 今日活动')
  await expect(article).toContainText('静态快照：生成于')
  await expect(page.locator('.doc-note').filter({ hasText: '自动过期' })).toBeVisible()
})

test('在跑会话入档：会话段含会话名与静默/运行时长拼版', async ({ page, request }) => {
  // Linux 服务端守卫：tmux 新 pane 首段键入丢字符（同 shift-summary.spec 的
  // 既有缺口登记 P-20261004-82，修复后随其解除）
  test.skip(serverIsLinux, 'Linux tmux 新 pane 首段键入丢字符（终端输入完整性缺陷，P-20261004-82 实证登记），跳过')
  test.setTimeout(180000)
  const headers = await unlockHeaders(request)
  await fixedLocale(page)

  // 走应用内导航保持 store 内存（整页 goto 重载丢 runningMap）——同 shift-summary
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')

  // 底部终端面板开新终端（面板收起时经活动栏打开；切项目的异步布局应用可能
  // 在点击后把面板再收起——重试环兜底，同 shift-summary 的 ensureOpen 惯例）
  const panel = page.locator('.bottom-panel')
  for (let i = 0; i < 3 && !(await panel.isVisible().catch(() => false)); i++) {
    await page.locator('.rail-btn[title="终端"]').click()
    await panel.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { /* 下一轮重开 */ })
  }
  await expect(panel).toBeVisible({ timeout: 5000 })
  const sessionsCount = async (): Promise<number> => {
    try {
      const r = await request.get(`${BASE}/api/terminals`)
      return (((await r.json()) as { data?: unknown[] }).data || []).length
    } catch { return 0 }
  }
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  const before = await sessionsCount()
  await newBtn.click()
  let postSeen = false
  try {
    await page.waitForResponse(
      (r) => r.url().includes('/api/terminals') && r.request().method() === 'POST',
      { timeout: 12000 },
    )
    postSeen = true
  } catch { /* 点击未生效 */ }
  {
    const deadline = Date.now() + 5000
    while ((await sessionsCount()) <= before && Date.now() < deadline) {
      await page.waitForTimeout(300)
    }
    if ((await sessionsCount()) <= before && !postSeen) {
      if (await newBtn.isVisible().catch(() => false)) await newBtn.click().catch(() => { /* 重渲染瞬断 */ })
    }
  }
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText(serverIsLinux ? /[#$] / : 'PS ', { timeout: 20000 })

  // 跑长命令点亮运行态（OSC 133 C 入账）
  await xterm.click()
  await page.keyboard.type(SLEEP_CMD + '\r')
  await page.waitForTimeout(1500)

  // SPA 内导航回大屏
  await page.locator('.ide-header button[title="返回首页"]').click()
  await expect(page).toHaveURL(/\/$/)
  const entry = page.locator('.home-action-btn[title="值班大屏"]')
  await expect(entry).toBeVisible()
  await entry.click()
  await page.waitForURL('**/monitor')

  const sessCard = page.locator('.mon-card.is-session').filter({ hasText: PROJ_NAME })
  await expect(sessCard).toHaveCount(1, { timeout: 10000 })
  await expect(sessCard).toContainText('运行中')

  await openHandoverOnMonitor(page)
  const value = await page.locator('[data-testid="handover-doc"] textarea').inputValue()
  expect(value).toContain('## 在跑会话（1）')
  // 会话行：会话名加粗 + 运行时长段（monitor.shift.dur* 同源文案）
  expect(value).toMatch(/- \*\*.+\*\*（.+运行 .+）/)
})

test('通知中心入口：同款弹层可达且审批入档', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await seedApproval(request, '')

  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('[data-testid="notif-center"]')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="notif-handover-btn"]').click()

  const doc = page.locator('[data-testid="handover-doc"] textarea')
  await expect(page.locator('[data-testid="handover-modal"]')).toBeVisible({ timeout: 5000 })
  await expect(doc).toHaveValue(/# 值班交接包/, { timeout: 15000 })
  const value = await doc.inputValue()
  expect(value).toContain('## 待裁决审批（1）')
  expect(value).toContain('reset --hard main')
})

test('交接包分享可设口令：邀请复制含口令 + 访客需口令', async ({ page, request }) => {
  test.setTimeout(120000)
  const passphrase = 'e2e-handover-pass'
  await page.context().grantPermissions(['clipboard-read'])
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)
  await openHandoverOnMonitor(page)

  // 勾选设门并输入口令 → 分享按钮可用
  await page.locator('[data-testid="handover-pass-toggle"]').click()
  const passInput = page.locator('[data-testid="handover-pass-input"] input')
  await expect(passInput).toBeVisible({ timeout: 5000 })
  await passInput.fill(passphrase)
  await page.locator('[data-testid="handover-share"]').click()

  const urlEl = page.locator('[data-testid="handover-share-url"]')
  await expect(urlEl).toBeVisible({ timeout: 15000 })
  const link = (await urlEl.textContent()) || ''
  expect(link).toMatch(/\/s\/[0-9a-z]{16}$/)
  // 链接本身绝不含口令；邀请复制才带口令
  expect(link).not.toContain(passphrase)
  await page.locator('[data-testid="handover-share-invite-copy"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '邀请信息已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain(link)
  expect(clip).toContain(`访问口令：${passphrase}`)

  // 访客面：口令门 → 正确口令后交接文档可读
  const shareBase = await getShareBase(request, await unlockHeaders(request))
  const token = link.split('/s/')[1]!
  await page.goto(`${shareBase}/s/${token}`)
  const form = page.locator(`form[action="/s/${token}/gate"]`)
  await expect(form).toBeVisible({ timeout: 5000 })
  await form.locator('input[type="password"]').fill(passphrase)
  await form.locator('button[type="submit"]').click()
  await page.waitForURL(`**/s/${token}`)
  await expect(page.locator('.md-article')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.md-article')).toContainText('静态快照')
})
