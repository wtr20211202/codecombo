import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverIsRemote } from '../../tests/dualpath'

/**
 * 会话接力 E2E（P-20261003-114）：会话中心行「接力」→ 新开 agent 会话，
 * launchArgs 携旧会话尾部 assistant 结论摘要。
 *
 * 前置：simple-coding 已运行（/api/claude/sessions/:id/timeline 直读服务端
 * 所在文件系统的 ~/.claude/projects——仅在服务实例与测试同机拓扑可跑，
 * 与 claude-timeline.spec.ts 同款约定）。
 *
 * 断言核心（拦截 POST /api/terminals 请求体，不依赖 claude 运行时真实在场
 * ——已装则真实起 claude、未装则服务端预检拒绝/降级，请求体不变）：
 *   1. 完整结论夹具（≤200 rune，服务端条目截断窗内原样到达）→ launchArgs
 *      精确等于「台账附行 + 此前会话结论：<结论>，请继续」，全串 ≤500 字节
 *   2. 超预算结论夹具（纯 CJK 178 字=534 字节 > 500-模板预算）→ 前端保尾
 *      裁头：台账附行在场、结论行以「此前会话结论：…」开头（… 前缀标注省略）、
 *      结论尾部+「，请继续」收尾、全串 ≤500 字节（服务端上限口径）
 *   3. 无 assistant 回复的夹具 → 如实提示放弃，不发创建请求（不注空前言）
 *
 * 台账附行（P-20261005-208）：夹具垫的 1 条 Bash tool_use 聚合成台账
 * {filesWritten:0, commandsRun:1, durationMs:0}（单事件首尾相接无跨时）→
 * 前言以「上次会话：跑 1 命令」原子行开头、结论行紧随；弃段阶梯先弃台账行
 * （结论是主体），夹具超预算时被裁的是结论头不是台账。
 *
 * 契约注记：单条 assistant 文本服务端钳 200 rune（claudesessions.go
 * truncateRunes+…），故夹具结论长度设计都 ≤200 rune——超预算裁剪发生在前端
 * 装箱层（utils/promptFit fitByBytes），两层截断语义由两夹具分别覆盖。
 *
 * 夹具：transcript 落真实 ~/.claude/projects，cwd 指向本测试自建的真实临时
 * 目录（接力真的会以该 cwd 创建会话，manager.create 校验目录存在）；
 * utimes 控制在 activeWindow(5 分钟) 之外避免「进行中」判定；afterEach
 * 清理终端会话，afterAll 精确删除夹具与临时目录。
 */

const MARK = '[e2e-relay]'
const FAKE_DIR_NAME = 'D--e2e-relay-fixtures'
// 夹具 A 结论尾部标记：断言结论原样直达（服务端 200 rune 窗内无损）
const TAIL_MARK = 'RELAY-TAIL-CHECK-9z'
// 154 字符（306 字节）：整条在服务端 200 rune 窗内、前端 500 字节预算内
const CONCLUSION_INTACT = ('最终结论：构建链已收敛，vite 替换 webpack 冷启动 42s→3s，单测全绿，遗留分片偶发超时已登记跟踪，' + TAIL_MARK).repeat(2)
// 夹具 B 结论尾部片段（保尾裁头断言锚点）
const CONCLUSION_B_TAIL = '明日继续收尾发布清单'
// 178 字全 CJK（534 字节）：服务端窗内原样到达、超前端预算触发保尾裁头
const CONCLUSION_FIT = '复盘结论：本次迁移完成度九成，剩余清单与风险已同步至任务清单，明日按优先级继续推进。'.repeat(4).slice(0, 176) + CONCLUSION_B_TAIL
// 台账附行（P-20261005-208）：夹具 1 条 Bash tool_use（无写文件、单事件无跨时）
// 聚合出的原子前言行——精确断言的组成段（zh-CN 固定 locale 下的文案形态）
const LEDGER_PREFIX = '上次会话：跑 1 命令\n'
const createdFiles: string[] = []
let relayDir = ''

function seedTranscript(sessionId: string, userText: string, conclusion: string | null) {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  const base = Date.now() - 30 * 60_000
  const at = (min: number) => new Date(base + min * 60_000).toISOString()
  const lines = [
    JSON.stringify({ type: 'last-prompt', sessionId }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: userText }, timestamp: at(0), cwd: relayDir }),
    // 中间垫 tool 条目：验证「结论优先弃过程」（摘要取 assistant 文本非工具调用）
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } }] }, timestamp: at(1) }),
  ]
  if (conclusion !== null) {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: conclusion }] }, timestamp: at(2) }))
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  // mtime 留 10 分钟余量：落在服务端 activeWindow(5 分钟) 外，行可交互
  const idle = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, idle, idle)
  createdFiles.push(file)
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
  if (relayDir) {
    try { fs.rmSync(relayDir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
}

/** 清理全部终端会话：接力会创建真实 agent 会话，残留会污染后续用例会话表 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  const headers = { 'X-Lock-Token': token }
  const list = await request.get(`${API_BASE}/api/terminals`, { headers })
  for (const s of ((await list.json()) as { data?: { id: string }[] }).data || []) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers }).catch(() => {})
  }
}

async function openClaudeTab(page: Page) {
  await fixedLocale(page)
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

/** 搜索关键字定位唯一夹具行（多个夹具共享 MARK 前缀，按正文区分）。
 *  必须等列表页与全文命中区两个响应都落定再返回——搜索输入有 300ms 防抖，
 *  响应先后到达会重排行列表/在列表上方插入命中区，不落定就 hover+点击会
 *  点到行本体误触发恢复（claude-timeline 同款先等响应再碰行） */
async function findRow(page: Page, picker: ReturnType<Page['locator']>, q: string) {
  const listResp = page.waitForResponse(r => r.url().includes('/claude/sessions?') && r.url().includes('q='))
  const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions/search'))
  await picker.locator('input').first().fill(q)
  await listResp
  await searchResp
  const row = picker.locator('.csp-row').filter({ hasText: q }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  return row
}

/** 点行内「接力」角标并捕获 agent 会话创建请求体 */
async function relayAndCapture(row: ReturnType<Page['locator']>) {
  const createReq = row.page().waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await row.hover()
  await row.locator('[data-test="session-relay"]').click()
  const req = await createReq
  return req.postDataJSON() as { kind?: string; name?: string; runtime?: string; dir?: string; launchArgs?: string }
}

test.describe('会话接力（P-20261003-114）', () => {
  // transcript 夹具种在测试侧 ~/.claude/projects（会话清单是服务端从服务侧
  // homedir 读的），跨拓扑时结构性不可见，无服务端写入 API 可翻译——按环境
  // 门控 skip（dualpath.serverIsRemote，P-20261005-187）
  test.skip(serverIsRemote, 'claude transcript 夹具在测试侧 homedir，跨拓扑服务端不可见——仅同机拓扑')
  const INTACT_ID = 'e2e-rl-a1b2c3d4-e5f6-0001'
  const FIT_ID = 'e2e-rl-a1b2c3d4-e5f6-0002'
  const NOASST_ID = 'e2e-rl-a1b2c3d4-e5f6-0003'

  test.beforeAll(() => {
    relayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-e2e-relay-'))
    seedTranscript(INTACT_ID, `${MARK} 接力夹具：收敛构建链`, CONCLUSION_INTACT)
    seedTranscript(FIT_ID, `${MARK} 接力夹具：超长结论`, CONCLUSION_FIT)
    seedTranscript(NOASST_ID, `${MARK} 无结论夹具`, null)
  })

  test.afterEach(async ({ request }) => {
    await cleanupTerminals(request)
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('接力行入口：launchArgs 精确携尾部结论（结论优先弃过程，≤500 字节）', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const picker = await openClaudeTab(page)
    const row = await findRow(page, picker, '收敛构建链')
    const body = await relayAndCapture(row)

    expect(body.kind).toBe('agent')
    expect(body.runtime).toBe('claude')
    // dir = 会话记录的 cwd（transcript 往返无损）
    expect(body.dir).toBe(relayDir)
    // 会话名 = 接力前缀 + 旧会话标题（首条用户指令摘要）
    expect(body.name || '').toContain('接力 · ')
    expect(body.name || '').toContain('收敛构建链')

    const la = body.launchArgs || ''
    // 前言模板精确形态：台账附行（P-208，夹具 1 条 Bash → 跑 1 命令）+ 夹具
    // 结论 ≤ 服务端 200 rune 窗原样直达无裁剪；中间 tool 条目（npm run build）
    // 被「结论优先弃过程」排除在摘要外（但计入台账命令数）
    expect(la).toBe(`${LEDGER_PREFIX}此前会话结论：${CONCLUSION_INTACT}，请继续`)
    // 服务端 launchArgs 上限口径：全串 ≤500 字节
    expect(Buffer.byteLength(la, 'utf8')).toBeLessThanOrEqual(500)
  })

  test('超预算结论：前端保尾裁头（… 前缀标注，越近越相关）', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const picker = await openClaudeTab(page)
    const row = await findRow(page, picker, '超长结论')
    const body = await relayAndCapture(row)

    const la = body.launchArgs || ''
    // 台账附行（P-208 原子段）在场；结论头部裁剪以 … 标注省略——被裁的是
    // 结论头不是台账（弃段阶梯先弃台账的前提是它塞得下），结论尾部（越近越
    // 相关）+ 续做指令收尾
    expect(la.startsWith(`${LEDGER_PREFIX}此前会话结论：…`)).toBe(true)
    expect(la.endsWith(`${CONCLUSION_B_TAIL}，请继续`)).toBe(true)
    expect(Buffer.byteLength(la, 'utf8')).toBeLessThanOrEqual(500)
  })

  test('无 assistant 结论的会话：如实提示放弃，不发创建请求', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const picker = await openClaudeTab(page)
    const row = await findRow(page, picker, '无结论夹具')

    const posts: string[] = []
    page.on('request', r => {
      if (r.url().includes('/api/terminals') && r.method() === 'POST') posts.push(r.url())
    })
    await row.hover()
    await row.locator('[data-test="session-relay"]').click()

    // 放弃提示（空前言不误导接力语义），且未创建会话
    await expect(page.locator('.n-message').filter({ hasText: '没有可接力的结论' })).toBeVisible({ timeout: 5000 })
    expect(posts).toHaveLength(0)
  })
})
