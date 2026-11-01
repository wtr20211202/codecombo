import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { DEFAULT_PASSWORD, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverIsRemote } from '../../tests/dualpath'

/**
 * 会话结构化台账 E2E（P-20261005-208）：timeline tool_use 的会话级聚合
 * （写类工具去重文件数 / shell 命令数 / 首尾工具活动跨时）在会话中心行
 * meta 段呈现（紧凑徽标 + hover 完整句），无工具动作的会话整段缺省
 * （零值隐藏纪律）；列表 API 透传 ledger 字段（智能体操作面：agent 会话
 * 考古可编程筛「改文件最多 / 跑命令异常多」的会话）。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions）。
 *
 * 测试数据：播种两条 fixture transcript 到真实 ~/.claude/projects
 * （与 session-pressure.spec.ts / claude-timeline.spec.ts 同款约定，标题带
 * [e2e-ledger-*] 标记；mtime 回拨 10 分钟落在 activeWindow 外避免判「进行中」），
 * afterAll 精确删除 fixture 文件：
 *   - e2e-ledger-full：1 个文件被 Write+Edit 各写一次（去重 = 1）+ 2 条 Bash
 *     命令，工具时刻跨 42 分钟 → 段显「1 / 2 / 42m」，API ledger 三字段精确
 *   - e2e-ledger-none：纯聊天（无 tool_use）→ 段缺省、API 无 ledger 字段
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与 claude-timeline.spec.ts 一致）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const FAKE_DIR_NAME = 'D--e2e-ledger-fixtures'
const createdFiles: string[] = []

const FULL = { id: 'e2e-ledger-full-a1b2', marker: '[e2e-ledger-full]' }
const NONE = { id: 'e2e-ledger-none-c3d4', marker: '[e2e-ledger-none]' }

/** 播种 fixture：工具会话（1 去重文件 + 2 命令 + 42 分钟跨时）与纯聊天会话 */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  const t0 = new Date(now - 52 * 60_000).toISOString()
  const t1 = new Date(now - 50 * 60_000).toISOString()
  const t2 = new Date(now - 10 * 60_000).toISOString()
  const fullLines = [
    `{"type":"last-prompt","sessionId":"${FULL.id}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${FULL.marker} 台账测试会话"},"timestamp":"${t0}","cwd":"D:/e2e-ledger-fixtures"}`,
    // Write + Edit 同一文件：去重后 FilesWritten = 1
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Write","input":{"file_path":"D:/e2e-ledger-fixtures/a.go","content":"x"}}]},"timestamp":"${t0}"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"D:/e2e-ledger-fixtures/a.go"}}]},"timestamp":"${t1}"}`,
    // 两条 Bash 命令，首尾跨 42 分钟
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"go build ./..."}}]},"timestamp":"${t1}"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"go test ./..."}}]},"timestamp":"${t2}"}`,
    `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"ok"}],"is_error":false}]},"timestamp":"${t2}"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"台账会话完成"}]},"timestamp":"${t2}"}`,
  ]
  const noneLines = [
    `{"type":"last-prompt","sessionId":"${NONE.id}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${NONE.marker} 纯聊天会话"},"timestamp":"${t0}","cwd":"D:/e2e-ledger-fixtures"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"纯聊天无工具动作"}]},"timestamp":"${t2}"}`,
  ]
  for (const [id, lines] of [[FULL.id, fullLines], [NONE.id, noneLines]] as const) {
    const file = path.join(dir, `${id}.jsonl`)
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
    // mtime 回拨 10 分钟：activeWindow(5 分钟) 外，行非「进行中」可正常断言
    const at = new Date(now - 10 * 60_000)
    fs.utimesSync(file, at, at)
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

/** 解锁 API 请求头（web/tests/claude-sessions.spec.ts 同款握手） */
async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 打开 agent 侧栏 Claude 页签（scope=global，与 session-pressure.spec.ts 同款入口） */
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

test.describe('会话结构化台账（P-20261005-208）', () => {
  // transcript 夹具在测试侧 homedir，跨拓扑服务端不可见——仅同机拓扑
  test.skip(serverIsRemote, 'claude transcript 夹具在测试侧 homedir，跨拓扑服务端不可见——仅同机拓扑')

  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('工具会话行台账段：去重文件数 / 命令数 / 跨时 + hover 完整句', async ({ page }) => {
    const picker = await openClaudeTab(page)
    const row = picker.locator('.csp-row').filter({ hasText: FULL.marker })
    await expect(row).toBeVisible({ timeout: 8000 })
    const seg = row.locator('[data-testid="session-ledger"]')
    await expect(seg).toBeVisible()
    // 紧凑段：写文件数 1（Write+Edit 同文件去重）、命令数 2、跨时短格式 42m
    await expect(seg).toContainText('1')
    await expect(seg).toContainText('2')
    await expect(seg).toContainText('42m')
    // hover 完整句（title）：本地化三段，去重与耗时如实
    const title = await seg.getAttribute('title')
    expect(title).toContain('改 1 文件')
    expect(title).toContain('跑 2 命令')
    expect(title).toContain('耗时 42 分钟')
  })

  test('无 tool_use 会话零值隐藏：台账段整段缺省', async ({ page }) => {
    const picker = await openClaudeTab(page)
    const row = picker.locator('.csp-row').filter({ hasText: NONE.marker })
    await expect(row).toBeVisible({ timeout: 8000 })
    await expect(row.locator('[data-testid="session-ledger"]')).toHaveCount(0)
  })

  test('列表 API 透传 ledger：工具会话三字段精确、纯聊天会话无字段', async ({ request }) => {
    const headers = await unlockHeaders(request)
    const res = await request.get(`${BASE}/api/claude/sessions?q=${encodeURIComponent(FULL.marker)}&limit=10`, { headers })
    expect(res.ok()).toBeTruthy()
    const full = (await res.json()) as { data?: { sessions?: { id: string; ledger?: { filesWritten: number; commandsRun: number; durationMs: number } }[] } }
    const rowA = full.data?.sessions?.find(s => s.id === FULL.id)
    expect(rowA).toBeTruthy()
    expect(rowA!.ledger).toEqual({ filesWritten: 1, commandsRun: 2, durationMs: 42 * 60_000 })

    const res2 = await request.get(`${BASE}/api/claude/sessions?q=${encodeURIComponent(NONE.marker)}&limit=10`, { headers })
    expect(res2.ok()).toBeTruthy()
    const none = (await res2.json()) as { data?: { sessions?: { id: string; ledger?: unknown }[] } }
    const rowB = none.data?.sessions?.find(s => s.id === NONE.id)
    expect(rowB).toBeTruthy()
    expect(rowB!.ledger).toBeUndefined()
  })
})
