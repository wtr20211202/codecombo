import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 会话导出「仅问答」档 E2E（P-20261004-132）：回放页导出下拉分化两档——完整
 *（P-44 现状零变化，session-export-md.spec.ts 覆盖）/ 仅问答（mode=qa 服务端
 * 渲染层过滤：只留 user/assistant 分节正文，工具摘要 🔧 / 结果引用 ↳ / 思考
 * 引用 💭 过程噪声全跳过）。断言面 = 下载名 -qa 尾缀 + 无噪声行 + 分节与
 * 元数据完整（任务书方案④）。
 *
 * 前置与拓扑：同 session-export-md.spec.ts——服务端直读其所在文件系统的
 * ~/.claude/projects，仅服务实例与测试同机拓扑可跑；fixture transcript 播种
 * 到真实目录（标题带 [e2e-expqa] 标记），afterAll 精确删除。
 */

const MARK = '[e2e-expqa]'
const FAKE_DIR_NAME = 'D--e2e-expqa-fixtures'
const SESSION_ID = 'e2e-expqa-a1b2c3d4-e5f6'
const USER_TEXT_1 = `${MARK} 仅问答导出：帮我排查心跳`
const THINKING_TEXT = 'QA档思考草稿不应出现在仅问答档'
const TOOL_COMMAND = 'grep -rn qa-noise-check server/'
const RESULT_TEXT = 'server/ws/qa-noise.go:12 should-not-appear'
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
      timestamp: at(6), cwd: 'D:\\e2e-expqa-fixtures',
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'thinking', thinking: THINKING_TEXT },
        { type: 'text', text: '好的，先确认端口' },
        { type: 'tool_use', id: 'toolu_q1', name: 'Bash', input: { command: TOOL_COMMAND } },
      ] },
      timestamp: at(5),
    }),
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_q1', content: [{ type: 'text', text: RESULT_TEXT }], is_error: false },
      ] },
      timestamp: at(4),
    }),
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: `${MARK} 第二回合：结论是什么` },
      timestamp: at(3), cwd: 'D:\\e2e-expqa-fixtures',
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '心跳间隔 30s 正常，问题在网络层' }] },
      timestamp: at(2),
    }),
  ]
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  // mtime 留余量落在服务端 activeWindow(5 分钟) 外：行可交互
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

test.describe('会话导出仅问答档（P-20261004-132）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('导出下拉「仅问答」档 → 下载名 -qa 尾缀 + 无 🔧/↳/💭 噪声 + 分节与元数据完整', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplayModal(page)

    // 工具条「导出」下拉：完整档与仅问答档并列（仅问答紧随完整档，机读 JSONL 不同族）
    await modal.locator('[data-test="timeline-export"]').click()
    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()
    const qaOption = menu.locator('.n-dropdown-option').filter({ hasText: 'Markdown（仅问答 · 贴文档）' })
    await expect(qaOption).toBeVisible()
    await expect(menu.locator('.n-dropdown-option').filter({ hasText: 'Markdown（人读文档）' })).toBeVisible()

    // 选仅问答档 → blob 下载（下载名客户端合成：claude-<标题>-<日期>-qa.md）
    const dlPromise = page.waitForEvent('download')
    await qaOption.first().click()
    const dl = await dlPromise
    const suggested = dl.suggestedFilename()
    expect(suggested).toMatch(/^claude-.*-qa\.md$/)
    expect(suggested).toContain('e2e-expqa')

    // 下载产物：分节与元数据完整（任务书方案④「元数据完整」）
    const md = fs.readFileSync(await dl.path(), 'utf-8')
    expect(md.startsWith('# Claude 会话：')).toBe(true)
    expect(md).toContain(USER_TEXT_1) // 标题 = 首条用户消息
    expect(md).toContain(`- 会话 ID：\`${SESSION_ID}\``)
    expect(md).toContain('- 导出时间：')
    expect(md).toContain('## 👤 用户')
    expect(md).toContain('## 🤖 助手')
    // 问答正文完整：两回合 user 与两段 assistant 文本
    expect(md).toContain('第二回合：结论是什么')
    expect(md).toContain('好的，先确认端口')
    expect(md).toContain('心跳间隔 30s 正常，问题在网络层')

    // 过程噪声全跳过（任务书方案④「无 🔧/↳ 行」；思考块按实施定夺一并跳过）：
    // 工具摘要行、结果引用、思考引用及其携带的正文内容均不出现在文档中
    expect(md).not.toContain('🔧')
    expect(md).not.toContain('↳')
    expect(md).not.toContain('💭')
    expect(md).not.toContain(TOOL_COMMAND)
    expect(md).not.toContain(RESULT_TEXT)
    expect(md).not.toContain(THINKING_TEXT)

    // 完整档同链可达（两档并存对账）：仅问答档点开后下拉收起，重开下拉仍有完整档
    await modal.locator('[data-test="timeline-export"]').click()
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.keyboard.press('Escape')

    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })
})
