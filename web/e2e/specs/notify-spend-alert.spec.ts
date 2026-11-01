import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * Claude 会话花费阈值告警 E2E（P-20261003-157）：
 * P-139 用量聚合（input+output+cache_read）命中会话级阈值
 * （prefs.claudeSpendAlertTokens，默认 0=关）→ 列表消费时点入账通知一次
 * （防重标记 kind claudespentalert），二次上报不重复。
 *   1. 设置契约：部分合并 + 越界钳制（0=关 / 低于下限钳 10 万）+ 设置页回显
 *   2. 正向链路：注入超阈值用量 transcript → 列表消费 → 通知入账恰一次
 *      （模板键 + MsgParams + 通知中心 UI 行）
 *   3. 二次上报：重复列表（索引命中路径）→ 同会话仍恰一条
 *   4. UI 会话中心打开（Claude 页签）触发同链路 → 不重复
 *   5. 默认关：阈值 0 → 无告警
 *
 * 断言口径按 fixture 名过滤而非通知总数：e2e 宿主机 ~/.claude/projects 里的
 * 真实会话也可能超阈并合法入账（属功能正确行为），总数断言会误伤。
 * transcript 播种到真实 ~/.claude/projects（与 claude-timeline.spec 同款约定），
 * mtime 取当下（列表按最后活动倒序，保证 fixture 稳定在首屏 50 条内；
 * 本 spec 无「恢复」类交互，Active 判定无关紧要），afterAll 精确删除 +
 * 偏好还原 + 通知清场。
 */

const SPEND_TITLE_KEY = 'notify.spendAlert.done.title'
const MARK = '[e2e-spend]'
const FAKE_DIR_NAME = 'D--e2e-spend-fixtures'
// 会话 id/标题带运行级随机段：防重标记（claudespentalert）持久在数据面——
// 固定 id 复跑温实例会因「已告警过」静默跳过，正向链路断言必空
const RUN = Date.now().toString(36)
const OVER_ID = `e2e-spend-${RUN}-0001`
const UNDER_ID = `e2e-spend-${RUN}-0002`
const OVER_TITLE = `${MARK} 花费超阈会话 ${RUN}`
const UNDER_TITLE = `${MARK} 花费未达会话 ${RUN}`
// 阈值取服务端下限 100000（ClampSpendTokens 最小合法档，PUT 回读即该值）
const THRESHOLD = 100000
const createdFiles: string[] = []

interface NotifItem { titleKey?: string; title?: string; type?: string; category?: string; msgParams?: Record<string, unknown> }

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function putPrefs(headers: Record<string, string>, body: Record<string, unknown>): Promise<void> {
  await fetch(`${API_BASE}/api/notifications/prefs`, { method: 'PUT', headers, body: JSON.stringify(body) })
}

async function getPrefs(headers: Record<string, string>): Promise<Record<string, unknown> & { claudeSpendAlertTokens?: number }> {
  const res = await fetch(`${API_BASE}/api/notifications/prefs`, { headers })
  return (await res.json()) as Record<string, unknown> & { claudeSpendAlertTokens?: number }
}

async function notifs(headers: Record<string, string>): Promise<NotifItem[]> {
  const res = await fetch(`${API_BASE}/api/notifications`, { headers })
  return ((await res.json()) as { data?: NotifItem[] }).data || []
}

function spendCountFor(list: NotifItem[], name: string): number {
  return list.filter(n => n.titleKey === SPEND_TITLE_KEY && n.msgParams?.['name'] === name).length
}

async function clearNotifs(headers: Record<string, string>): Promise<void> {
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
}

async function listSessions(headers: Record<string, string>): Promise<void> {
  const res = await fetch(`${API_BASE}/api/claude/sessions?limit=50`, { headers })
  if (!res.ok) throw new Error(`list sessions failed: ${res.status}`)
}

// 轮询直到条件成立或超时
async function pollUntil<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (ok(v) || Date.now() > deadline) return v
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** 播种 fixture transcript：一条超阈（total 150k）+ 一条未达阈（total 99,999） */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const writeOne = (id: string, title: string, inTok: number, crTok: number, outTok: number) => {
    const file = path.join(dir, `${id}.jsonl`)
    const lines = [
      `{"type":"last-prompt","sessionId":"${id}"}`,
      `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${title}"},"timestamp":"2026-01-01T00:00:00Z","cwd":"D:\\\\e2e-spend-fixtures"}`,
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"..."}],"usage":{"input_tokens":${inTok},"cache_read_input_tokens":${crTok},"output_tokens":${outTok}}},"timestamp":"2026-01-01T00:01:00Z"}`,
    ]
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
    createdFiles.push(file)
  }
  writeOne(OVER_ID, OVER_TITLE, 100_000, 40_000, 10_000) // total 150,000 ≥ 阈值
  writeOne(UNDER_ID, UNDER_TITLE, 89_999, 9_000, 1_000) // total 99,999 < 阈值
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)
}

test.beforeAll(async () => {
  buildFixtures()
  const headers = await unlockHeaders()
  await clearNotifs(headers)
})

test.afterAll(async () => {
  cleanupFixtures()
  const headers = await unlockHeaders()
  await putPrefs(headers, { claudeSpendAlertTokens: 0 }) // 还原默认关
  await clearNotifs(headers)
})

test('设置契约：部分合并 + 越界钳制 + 设置页回显', async ({ page }) => {
  const headers = await unlockHeaders()
  // 部分合并：只传新字段；回读即写入值
  await putPrefs(headers, { claudeSpendAlertTokens: THRESHOLD })
  expect((await getPrefs(headers)).claudeSpendAlertTokens).toBe(THRESHOLD)
  // 越界钳制：1 → 下限 100000；0 → 关
  await putPrefs(headers, { claudeSpendAlertTokens: 1 })
  expect((await getPrefs(headers)).claudeSpendAlertTokens).toBe(100000)
  await putPrefs(headers, { claudeSpendAlertTokens: THRESHOLD })

  // 设置页 UI：通知偏好页签内花费告警分组回显开关态（开启 → 数值输入可见）
  await enterProject(page)
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.locator('.nc-action-btn').first().click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await expect(page.locator('.settings-modal .content-pane:visible .pane-title')).toHaveText('通知偏好')
  const group = page.locator('[data-testid="settings-spend-alert"]')
  await expect(group).toBeVisible()
  await expect(group.locator('.n-checkbox')).toHaveClass(/n-checkbox--checked/)
  // n-input-number 的可见输入（组内还有 naive 隐藏 checkbox input，须按类定位）
  await expect(group.locator('input.n-input__input-el')).toHaveValue(String(THRESHOLD))
})

test('超阈值会话列表消费 → 通知一次；二次上报不重复', async ({ page }) => {
  test.setTimeout(60000)
  const headers = await unlockHeaders()
  await clearNotifs(headers)
  await enterProject(page)

  // 首次列表消费：超阈 fixture 入账恰一条（模板 + 参数 + 形态断言）
  await listSessions(headers)
  await pollUntil(
    () => notifs(headers),
    list => spendCountFor(list, OVER_TITLE) > 0,
    15000,
  )
  let list = await notifs(headers)
  expect(spendCountFor(list, OVER_TITLE)).toBe(1)
  const entry = list.find(n => n.titleKey === SPEND_TITLE_KEY && n.msgParams?.['name'] === OVER_TITLE)
  expect(entry?.type).toBe('warning')
  expect(entry?.category).toBe('task')
  expect(entry?.msgParams?.['tokens']).toBe(150000)
  expect(entry?.msgParams?.['threshold']).toBe(THRESHOLD)
  // 未达阈值 fixture 沉默
  expect(spendCountFor(list, UNDER_TITLE)).toBe(0)

  // 二次上报：同会话仍超阈（索引命中路径）→ 防重标记生效不重复
  await listSessions(headers)
  await listSessions(headers)
  list = await notifs(headers)
  expect(spendCountFor(list, OVER_TITLE)).toBe(1)
})

test('UI 会话中心打开（Claude 页签）同链路 → 仍恰一条 + 通知中心行', async ({ page }) => {
  test.setTimeout(60000)
  const headers = await unlockHeaders()
  await enterProject(page)

  // 真实前端消费路径：活动栏终端会话管理 → Claude 页签（列表请求触发判定）
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.ats-tab', { hasText: 'Claude' }).click()
  await expect(view.locator('.csp-root')).toBeVisible({ timeout: 8000 })

  // 服务端防重标记在先：UI 消费不产生第二条
  const list = await notifs(headers)
  expect(spendCountFor(list, OVER_TITLE)).toBe(1)

  // 通知中心 UI：模板渲染行可见
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const row = page.locator('.nc-item').filter({ hasText: 'Claude 会话花费超过阈值' }).filter({ hasText: OVER_TITLE }).first()
  await expect(row).toBeVisible({ timeout: 8000 })
})

test('默认关：阈值 0 → 列表消费无告警', async ({ page }) => {
  const headers = await unlockHeaders()
  await putPrefs(headers, { claudeSpendAlertTokens: 0 })
  await clearNotifs(headers)
  await enterProject(page)
  await listSessions(headers)
  await page.waitForTimeout(1500)
  expect(spendCountFor(await notifs(headers), OVER_TITLE)).toBe(0)
})
