import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话 token 用量聚合展示 E2E（P-20261002-139）：播种带 assistant usage 的
 * transcript fixture，会话列表行出现「累计 token」徽标（全文聚合的精确账目，
 * 区别于 P-58 压力徽标的 ≈ 估算），聚合口径 = input+output+cache_read（提案
 * 原文，cache_creation 不计入；sidechain 行不计）。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions）。
 *
 * 测试数据：写入真实 ~/.claude/projects/D--e2e-tok-fixtures（与
 * claude-timeline.spec.ts 同款约定，标题带 [e2e-tok-*] 标记），utimes 回拨
 * 10 分钟（activeWindow 之外，行可交互——用量徽标与活跃判定无关，但随大流）。
 * afterAll 精确删除 fixture 文件。
 *
 * 断言两条数据链路：
 *   1. 搜索路径（q 非空 = 全量扫描 List）API 返回聚合分项，UI 徽标紧凑展示；
 *   2. 无搜索路径（claudeindex 条目透传，P-116 mtime 缓存一致性——
 *      UsageKnown 标记补齐前不命中）API 返回同值。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与 claude-timeline.spec.ts 一致）。
 */

const FAKE_DIR_NAME = 'D--e2e-tok-fixtures'
const FIXTURE_CWD_JSON = 'D:\\\\e2e-tok-fixtures'
const createdFiles: string[] = []

// 聚合口径（input+output+cache_read）：行 A 1300 + 行 B 1500 = 2800 → 「2.8k」；
// cache_creation(500+700) 与 sidechain(99999+9999) 都不计入
const SUM_ID = 'e2e-tok-sum'
const SUM_MARK = '[e2e-tok-sum]'
const NONE_ID = 'e2e-tok-none'
const NONE_MARK = '[e2e-tok-none]'
const WANT_TOTAL = 2800

/** 播种 fixture：用户消息 + assistant usage 行（×2 主线 + 1 sidechain） */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const at = new Date(Date.now() - 30 * 60_000).toISOString()
  const usageLine = (extra: string, inp: number, cc: number, cr: number, out: number) =>
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":${inp},"cache_creation_input_tokens":${cc},"cache_read_input_tokens":${cr},"output_tokens":${out}}}${extra}}`
  const lines = [
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${SUM_MARK} 用量聚合会话"},"timestamp":"${at}","cwd":"${FIXTURE_CWD_JSON}"}`,
    usageLine(`,"timestamp":"${at}"`, 1000, 500, 100, 200),
    usageLine(`,"timestamp":"${at}"`, 1000, 700, 200, 300),
    `{"parentUuid":"x","isSidechain":true,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"sub"}],"usage":{"input_tokens":99999,"output_tokens":9999}},"timestamp":"${at}"}`,
  ]
  const sumFile = path.join(dir, `${SUM_ID}.jsonl`)
  fs.writeFileSync(sumFile, lines.join('\n') + '\n', 'utf-8')
  createdFiles.push(sumFile)

  const noneLines = [
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${NONE_MARK} 无用量会话"},"timestamp":"${at}","cwd":"${FIXTURE_CWD_JSON}"}`,
  ]
  const noneFile = path.join(dir, `${NONE_ID}.jsonl`)
  fs.writeFileSync(noneFile, noneLines.join('\n') + '\n', 'utf-8')
  createdFiles.push(noneFile)

  // 回拨 mtime：落在 activeWindow(5 分钟) 外，行可交互
  const old = new Date(Date.now() - 10 * 60_000)
  for (const f of createdFiles) fs.utimesSync(f, old, old)
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 打开 agent 侧栏 Claude 页签（scope=global，与 claude-timeline.spec.ts 同款入口） */
async function openClaudeTab(page: Page) {
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.ats-tab', { hasText: 'Claude' }).click()
  const picker = view.locator('.csp-root')
  await expect(picker).toBeVisible({ timeout: 8000 })
  return picker
}

interface SessionJSON {
  id: string
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number }
}

test.describe('会话 token 用量聚合展示（P-20261002-139）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('搜索路径：API 聚合分项正确，行徽标紧凑展示精确值', async ({ page }) => {
    const picker = await openClaudeTab(page)

    // P-20261003-19 起搜索框走 /claude/sessions/search 全文 hits（无 usage 聚合，
    // 命中上下文片段），不再过滤会话列表——本用例的聚合契约改为 API 直断
    // （/claude/sessions?q= 仍回 sessions+usage 分项，服务端聚合链路不变），
    // 行徽标断言取默认列表行（夹具在列）
    const headers = await unlockHeaders()
    const apiRes = await fetch(`${API_BASE}/api/claude/sessions?q=${encodeURIComponent(SUM_MARK)}`, { headers })
    expect(apiRes.ok).toBeTruthy()
    const sessions = ((await apiRes.json()) as { data?: { sessions?: SessionJSON[] } }).data?.sessions ?? []
    const sum = sessions.find(s => s.id === SUM_ID)
    expect(sum, 'fixture in search response').toBeTruthy()
    expect(sum!.usage).toEqual({ inputTokens: 2000, outputTokens: 500, cacheReadTokens: 300, totalTokens: WANT_TOTAL })

    // 行徽标：紧凑展示 2.8k，tooltip 带精确总数（无 ≈ 前缀——精确聚合非估算）
    const row = picker.locator('.csp-row').filter({ hasText: SUM_MARK }).first()
    await expect(row).toBeVisible({ timeout: 8000 })
    const badge = row.locator('[data-testid="session-tokens"]')
    await expect(badge).toHaveText('2.8k')
    const title = await badge.getAttribute('title')
    expect(title).toContain(String(WANT_TOTAL))
    expect(title).not.toContain('≈')

    // 无 usage 数据的会话：无徽标（「无数据」≠「零消耗」）
    const noneRow = picker.locator('.csp-row').filter({ hasText: NONE_MARK }).first()
    await expect(noneRow).toBeVisible({ timeout: 8000 })
    await expect(noneRow.locator('[data-testid="session-tokens"]')).toHaveCount(0)
  })

  test('索引路径：claudeindex 条目透传同值（mtime 缓存一致性）', async ({ page }) => {
    // 先开一次页签触发无搜索列表（首次建/对账索引条目），再直连 API 断言
    // 索引命中链路的聚合值与扫描链路一致
    const picker = await openClaudeTab(page)
    await expect(picker.locator('.csp-row').first()).toBeVisible({ timeout: 8000 })

    const headers = await unlockHeaders()
    const apiRes = await fetch(`${API_BASE}/api/claude/sessions?limit=200`, { headers })
    expect(apiRes.ok).toBeTruthy()
    const sessions = ((await apiRes.json()) as { data?: { sessions?: SessionJSON[] } }).data?.sessions ?? []
    const sum = sessions.find(s => s.id === SUM_ID)
    expect(sum, 'fixture in index-path response').toBeTruthy()
    expect(sum!.usage?.totalTokens).toBe(WANT_TOTAL)
  })
})
