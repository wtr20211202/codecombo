import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话回放导出 Markdown E2E（P-20261003-44）：回放页工具条「导出 Markdown」
 * → 下载文件含分节结构（user/assistant 标题、思考引用块、工具摘要行）+ 下载
 * 名含日期与标题摘要 + 数据出域审计入账（claude.export）。
 *
 * 前置：simple-coding 已运行（含 GET /api/claude/sessions/:id/export）。
 *
 * 测试数据：播种一条含思考块/工具调用的 fixture transcript 到真实
 * ~/.claude/projects（与 claude-timeline.spec.ts 同款约定——标题带 [e2e-exp]
 * 标记，utimes 控制在 activeWindow(5 分钟) 之外），afterAll 精确删除 fixture。
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在服务
 * 实例与测试同机的拓扑下可跑（与 claude-timeline.spec.ts 一致）。
 */

const MARK = '[e2e-exp]'
const FAKE_DIR_NAME = 'D--e2e-exp-fixtures'
const SESSION_ID = 'e2e-exp-a1b2c3d4-e5f6'
const USER_TEXT_1 = `${MARK} 导出验证：帮我排查心跳`
const THINKING_TEXT = '先确认服务端口再定位心跳间隔'
const TOOL_COMMAND = 'grep -rn heartbeat server/'
const RESULT_TEXT = 'server/ws/heartbeat.go:12 interval=30s'
const createdFiles: string[] = []

/** 播种 fixture transcript：user → assistant(思考+正文+工具) → 结果 → 第二回合 */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
  const lines = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: USER_TEXT_1 },
      timestamp: at(6), cwd: 'D:\\e2e-exp-fixtures',
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'thinking', thinking: THINKING_TEXT },
        { type: 'text', text: '好的，开始排查' },
        { type: 'tool_use', id: 'toolu_e1', name: 'Bash', input: { command: TOOL_COMMAND } },
      ] },
      timestamp: at(5),
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_e1', content: [{ type: 'text', text: RESULT_TEXT }], is_error: false },
      ] },
      timestamp: at(4),
    }),
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: `${MARK} 第二回合：还有别的线索吗` },
      timestamp: at(3), cwd: 'D:\\e2e-exp-fixtures',
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '心跳间隔 30s 正常，问题在网络层' }] },
      timestamp: at(2),
    }),
  ]
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  // mtime 留余量落在服务端 activeWindow(5 分钟) 外：行可交互（恢复入口不隐藏也无妨）
  const at10 = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, at10, at10)
  createdFiles.push(file)
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

// 用 API 解锁拿 token（audit-log.spec 同款；锁定关闭时 unlock 端点同样发 token）
async function unlockToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  if (!res.ok()) throw new Error(`unlock failed: ${res.status()}`)
  return ((await res.json()) as { token: string }).token
}

async function openReplayModal(page: Page, pickerRoot = '.csp-root') {
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.ats-tab', { hasText: 'Claude' }).click()
  const picker = view.locator(pickerRoot)
  await expect(picker).toBeVisible({ timeout: 8000 })
  // 搜索标记 → 唯一 fixture 行 → 行内「回放」角标 → 弹层时间线
  const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
  await picker.locator('input').fill(MARK)
  await searchResp
  const row = picker.locator('.csp-row').filter({ hasText: MARK }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.hover()
  await row.locator('.csp-row-replay').click()
  const modal = page.locator('.n-modal .cstl-root')
  await expect(modal).toBeVisible({ timeout: 10000 })
  // 时间线首步渲染完成（导出按钮常驻工具条，等首步防时序）
  await expect(modal.locator('.cstl-step').first()).toBeVisible({ timeout: 15000 })
  return modal
}

test.describe('会话回放导出 Markdown（P-20261003-44）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('回放页导出 → 下载文件含分节结构 + 下载名含日期摘要 + 审计入账', async ({ page, request }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplayModal(page)

    // 工具条「导出」下拉（P-20261003-60 组化：Markdown / 原始 JSONL 双选项；
    // P-20261003-144 起另有策展组两项含「Markdown ·」前缀，故按全量项精确
    // 文案定位——裸 hasText 'Markdown' 会 strict 撞多元素）
    // → 选 Markdown → blob 下载（下载名客户端合成：claude-<标题>-<日期>.md）
    await modal.locator('[data-test="timeline-export"]').click()
    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('.n-dropdown-option').filter({ hasText: 'Markdown（人读文档）' })).toBeVisible()
    await expect(menu.locator('.n-dropdown-option').filter({ hasText: 'JSONL' })).toBeVisible()
    const dlPromise = page.waitForEvent('download')
    await menu.locator('.n-dropdown-option').filter({ hasText: 'Markdown（人读文档）' }).first().click()
    const dl = await dlPromise
    const suggested = dl.suggestedFilename()
    expect(suggested).toMatch(/^claude-.*\d{8}\.md$/)
    expect(suggested).toContain('e2e-exp')

    // 下载产物：Markdown 全文含分节结构与各形态条目
    const md = fs.readFileSync(await dl.path(), 'utf-8')
    expect(md.startsWith('# Claude 会话：')).toBe(true)
    expect(md).toContain(USER_TEXT_1) // 标题 = 首条用户消息
    expect(md).toContain(`- 会话 ID：\`${SESSION_ID}\``)
    expect(md).toContain('## 👤 用户')
    expect(md).toContain('## 🤖 助手')
    expect(md).toContain('好的，开始排查')
    // 思考块以引用块标记
    expect(md).toContain(`> 💭 ${THINKING_TEXT}`)
    // 工具调用折叠为摘要行（工具名+目标一行），结果带 ↳ 引用
    expect(md).toContain('- 🔧 **Bash**：')
    expect(md).toContain(`\`${TOOL_COMMAND}\``)
    expect(md).toContain(`> ↳ ${RESULT_TEXT}`)
    // 第二回合开新节
    expect(md).toContain('第二回合：还有别的线索吗')
    expect(md).toContain('心跳间隔 30s 正常，问题在网络层')

    // 数据出域审计入账（修正项 2）：claude.export 成功事件，detail = 会话 id
    const token = await unlockToken(request)
    const auditResp = await request.get(`${API_BASE}/api/audit?limit=50`, {
      headers: { 'X-Lock-Token': token },
    })
    expect(auditResp.ok()).toBe(true)
    const audit = (await auditResp.json()) as { data: Array<{ action: string; result: string; detail: string }> }
    const hit = audit.data.find(e => e.action === 'claude.export')
    expect(hit).toBeTruthy()
    expect(hit!.result).toBe('success')
    expect(hit!.detail).toBe(SESSION_ID)

    // 关闭弹层
    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })

  // 复制到剪贴板变体（P-20261005-6）：粘贴主用途一步直达——同一渲染文档
  //（标题+分节标记）落剪贴板 + 成功 toast；localhost 为 secure context，
  // copyText 首选 navigator.clipboard，授权后可 readText 断言落盘内容
  test('导出下拉「复制 Markdown 到剪贴板」→ 剪贴板含标题与分节标记 + toast 确认', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    const modal = await openReplayModal(page)

    await modal.locator('[data-test="timeline-export"]').click()
    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()
    // 全量档位第三项（Markdown 下载 / JSONL 下载之后、策展组之前）
    const copyOption = menu.locator('.n-dropdown-option').filter({ hasText: '复制 Markdown 到剪贴板' })
    await expect(copyOption).toBeVisible()
    await copyOption.first().click()

    // 成功 toast（copyText 返回值分支提示）
    await expect(page.locator('.n-message').filter({ hasText: '已复制到剪贴板' })).toBeVisible({ timeout: 5000 })

    // 剪贴板内容 = 与下载同一份渲染文档：会话标题 + 分节标记
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
      .toContain('# Claude 会话：')
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(clip).toContain('e2e-exp') // 标题 = 首条用户消息
    expect(clip).toContain('## 👤 用户')
    expect(clip).toContain('## 🤖 助手')

    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })
})
