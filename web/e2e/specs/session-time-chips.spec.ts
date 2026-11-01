import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 会话中心时间过滤 chips E2E（P-20261003-174）：
 * - Claude 页签（选择器）：chip 今天 → 仅显今日会话；本周（滚动 7 天窗口）→
 *   今日 + 3 天前；全部恢复；与名称检索 AND 组合（q 服务端先过滤，chips 再
 *   展示层收窄——正好覆盖验收的「与名称过滤组合」）。
 * - 终端会话页签（会话中心）：今日创建的会话在各 chip 下不被误隐藏，名称
 *   筛选与 chip AND 组合，全部 = 不过滤。时间窗的排除语义（窗口外会话被
 *   隐藏）在 Claude 侧由 20 天前 fixture 覆盖——终端会话 createdAt 由服务端
 *   落当前时间，无法从测试面回拨，不做重复断言。
 *
 * 测试数据：播种 3 条 fixture transcript 到真实 ~/.claude/projects（标题带
 * [e2e-timechip] 标记，utimes 控制 mtime 落今日/3 天前/20 天前——lastAt 即
 * 文件 mtime，chips 判定与时间分段同源），afterAll 精确删除 fixture 文件。
 * 「今日」fixture 的 mtime 取 max(今日零点+1s, 现在-6min)：常态落在活跃窗口
 * (5min) 外可交互；跨零点 6 分钟内运行时落在今日凌晨（此时被判「进行中」
 * 也只是渲染徽标差异，本用例不断言恢复入口，不受影响）。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（claude-session-hide.spec.ts 同款约定）。
 */

const MARK = '[e2e-timechip]'
const FAKE_DIR_NAME = 'D--e2e-timechip-fixtures'
const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const TERM_NAME = '[e2e-timechip] 终端会话'
const createdFiles: string[] = []

interface TimeFixture {
  id: string
  title: string
  at: number
}

function buildFixtures() {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const fixtures: TimeFixture[] = [
    { id: 'e2e-timechip-a1b2-today', title: `${MARK} 今日会话`, at: Math.max(startOfToday + 1000, Date.now() - 6 * 60_000) },
    { id: 'e2e-timechip-c3d4-week', title: `${MARK} 三天前会话`, at: Date.now() - 3 * 86_400_000 },
    { id: 'e2e-timechip-e5f6-early', title: `${MARK} 二十天前会话`, at: Date.now() - 20 * 86_400_000 },
  ]
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  for (const f of fixtures) {
    const file = path.join(dir, `${f.id}.jsonl`)
    const iso = new Date(f.at).toISOString()
    const lines = [
      `{"type":"last-prompt","sessionId":"${f.id}"}`,
      `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${f.title}"},"timestamp":"${iso}","cwd":"D:\\\\e2e-timechip-fixtures"}`,
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]},"timestamp":"${iso}"}`,
    ]
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
    fs.utimesSync(file, new Date(f.at), new Date(f.at))
    createdFiles.push(file)
  }
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享；侧栏同显项目会话，只清 agent 会话会有
 *  外部残留混入 .ats-item 计数——agent-terminal.spec 同款约定） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

async function openAgentManager(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  return view
}

/** 搜索标记并等列表收窄到 fixture 行（服务端 q 过滤，行数即 fixture 数） */
async function searchMark(picker: ReturnType<Page['locator']>) {
  const searchResp = picker.page().waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
  await picker.locator('input').first().fill(MARK)
  await searchResp
  await expect(picker.locator('.csp-row').filter({ hasText: MARK })).toHaveCount(3, { timeout: 15000 })
}

async function pickChip(picker: ReturnType<Page['locator']>, chip: 'today' | 'week' | 'all') {
  await picker.locator(`[data-test="session-time-chip-${chip}"]`).click()
}

test.describe('会话中心时间过滤 chips（P-20261003-174）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(async ({ request }) => {
    await cleanupTerminals(request).catch(() => { /* 服务不在：无残留面 */ })
    cleanupFixtures()
  })

  test('Claude 页签：chip 今天→仅显今日；本周→今日+近 7 天；全部恢复；与名称检索 AND', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const view = await openAgentManager(page)
    await view.locator('.ats-tab', { hasText: 'Claude' }).click()
    const picker = view.locator('.csp-root')
    await expect(picker).toBeVisible({ timeout: 8000 })
    await expect(picker.locator('[data-test="session-time-chips"]')).toBeVisible()

    const rows = picker.locator('.csp-row').filter({ hasText: MARK })
    const todayRow = rows.filter({ hasText: '今日会话' })
    const weekRow = rows.filter({ hasText: '三天前会话' })
    const earlyRow = rows.filter({ hasText: '二十天前会话' })

    // 1. 名称检索（服务端 q）收窄到 3 条 fixture：默认「全部」chip 全可见
    await searchMark(picker)
    await expect(todayRow).toBeVisible()
    await expect(weekRow).toBeVisible()
    await expect(earlyRow).toBeVisible()
    await expect(picker.locator('[data-test="session-time-chip-all"]')).toHaveClass(/active/)

    // 2. chip 今天 → 仅显今日 fixture（3 天前/20 天前被隐藏）
    await pickChip(picker, 'today')
    await expect(todayRow).toBeVisible()
    await expect(weekRow).toHaveCount(0)
    await expect(earlyRow).toHaveCount(0)
    await expect(rows).toHaveCount(1)

    // 3. chip 本周（滚动 7 天窗口）→ 今日 + 3 天前，20 天前仍隐藏
    await pickChip(picker, 'week')
    await expect(todayRow).toBeVisible()
    await expect(weekRow).toBeVisible()
    await expect(earlyRow).toHaveCount(0)
    await expect(rows).toHaveCount(2)

    // 4. chip 全部 → 恢复全量（与名称检索仍 AND：只有 fixture 行）
    await pickChip(picker, 'all')
    await expect(rows).toHaveCount(3)
  })

  test('终端会话页签：今日会话不被 chips 误隐藏 + 与名称筛选 AND', async ({ page, request }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await cleanupTerminals(request)
    const view = await openAgentManager(page)

    // API 直建纯终端会话（runtime=shell 不拉起 claude；terminals.changed 广播
    // 到达侧栏即出现），createdAt=当前时间 → 恒落「今天」窗口。
    // chips 行与列表同现（空会话表无过滤面，先建会话再断言）
    const headers = await unlockHeaders(request)
    await request.post(`${BASE}/api/terminals`, {
      headers,
      data: { kind: 'agent', name: TERM_NAME, runtime: 'shell' },
    })
    const row = view.locator('.ats-item').filter({ hasText: TERM_NAME })
    await expect(row).toBeVisible({ timeout: 10000 })
    const chips = view.locator('[data-test="session-time-chips"]')
    await expect(chips).toBeVisible()

    // chip 今天/本周：今日创建的会话不被误隐藏；全部 = 默认不过滤
    for (const chip of ['today', 'week', 'all'] as const) {
      await view.locator(`[data-test="session-time-chip-${chip}"]`).click()
      await expect(row).toBeVisible()
    }

    // 与名称筛选 AND：命中共存、不命中同隐（无匹配提示出现）、清空恢复
    await view.locator('.ats-filter input').fill(TERM_NAME)
    await expect(row).toBeVisible()
    await view.locator('.ats-filter input').fill('绝无匹配的会话名xyz')
    await expect(row).toHaveCount(0)
    await expect(view.locator('.ats-no-match')).toBeVisible()
    await view.locator('.ats-filter input').fill('')
    await expect(row).toBeVisible()
  })
})
