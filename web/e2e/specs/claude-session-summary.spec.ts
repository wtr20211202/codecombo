import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverIsRemote } from '../../tests/dualpath'

/**
 * 回放页「AI 总结本会话」E2E（P-20261003-215）：回放弹层工具条点「AI 总结」→
 * 拦截 agent 会话创建请求，断言 launchArgs 含 transcript 绝对路径（数据面
 * transcriptPath）与结构化摘要指令（四节 + 遮蔽要求）。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions 列表 transcriptPath 字段）。
 *
 * 测试数据：播种一条 fixture transcript 到真实 ~/.claude/projects（与
 * claude-timeline.spec.ts 同款约定——标题带标记，utimes 控制在 activeWindow
 * (5 分钟)之外），afterAll 精确删除。agent 会话创建请求经 page.route fulfill
 * 假响应收口——断言请求体即可，不真起 claude 进程（runtime 可用性与否不影响断言）。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在服务实例
 * 与测试同机的拓扑下可跑（与既有 claude-timeline.spec.ts 一致）。
 */

const MARK = '[e2e-aisum]'
const FAKE_DIR_NAME = 'D--e2e-aisum-fixtures'
const SESSION_ID = 'e2e-aisum-a1b2c3d4-e5f6'
const createdFiles: string[] = []

/** 期望的 transcript 绝对路径：服务端 root（~/.claude/projects）+ 编码目录 + 会话 id */
const EXPECTED_TRANSCRIPT_PATH = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME, `${SESSION_ID}.jsonl`)

/** 播种 fixture transcript：3 条用户指令步（回放弹层可打开即可） */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  const lines: string[] = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
  ]
  for (let i = 0; i < 3; i++) {
    const at = new Date(Date.now() - (3 + 10 - i) * 60_000).toISOString()
    lines.push(
      `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} 总结步骤 ${i}"},"timestamp":"${at}","cwd":"D:\\\\e2e-aisum-fixtures"}`,
    )
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  // mtime 落在服务端 activeWindow(5 分钟) 外：行可交互（恢复/回放入口可见）
  const at = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, at, at)
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

  // 搜索标记 → 唯一 fixture 行 → 行内「回放」角标开弹层
  const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
  await picker.locator('input').fill(MARK)
  await searchResp
  const row = picker.locator('.csp-row').filter({ hasText: MARK }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.hover()
  await row.locator('.csp-row-replay').click()
  const modal = page.locator('.n-modal .cstl-root')
  await expect(modal).toBeVisible({ timeout: 10000 })
  return modal
}

test.describe('回放页 AI 总结本会话（P-20261003-215）', () => {
  // transcript 夹具种在测试侧 ~/.claude/projects，跨拓扑时服务端 homedir
  // 结构性不可见，无服务端写入 API 可翻译——按环境门控 skip
  // （dualpath.serverIsRemote，P-20261005-187）
  test.skip(serverIsRemote, 'claude transcript 夹具在测试侧 homedir，跨拓扑服务端不可见——仅同机拓扑')
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('点「AI 总结」→ create 请求 launchArgs 含 transcript 路径与摘要指令', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplayModal(page)

    // 拦截 agent 会话创建：fulfill 假响应（不真起 claude 进程，runtime 可用性与否
    // 不影响断言）；非 POST 放行走真实链路（列表刷新等）
    let createBody: { kind?: string; runtime?: string; dir?: string; launchArgs?: string } | undefined
    await page.route('**/api/terminals', async route => {
      const req = route.request()
      if (req.method() !== 'POST') return route.fallback()
      createBody = req.postDataJSON() as typeof createBody
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: { id: 'e2e-fake-summary', name: 'fake', launched: true } }),
      })
    })

    // 工具条「AI 总结」可点（服务端已带 transcriptPath → 未禁用）
    const btn = modal.locator('[data-test="timeline-ai-summary"]')
    await expect(btn).toBeEnabled({ timeout: 5000 })
    await btn.click()

    await expect.poll(() => createBody).toBeDefined()
    expect(createBody!.kind).toBe('agent')
    expect(createBody!.runtime).toBe('claude')
    expect(createBody!.dir).toBe('D:\\e2e-aisum-fixtures')
    // launchArgs 含 transcript 绝对路径（数据面同源派生）与四节摘要指令 + 遮蔽要求
    expect(createBody!.launchArgs, 'launchArgs should contain the transcript path')
      .toContain(EXPECTED_TRANSCRIPT_PATH)
    expect(createBody!.launchArgs).toContain('任务')
    expect(createBody!.launchArgs).toContain('关键改动')
    expect(createBody!.launchArgs).toContain('结论')
    expect(createBody!.launchArgs).toContain('遗留事项')
    expect(createBody!.launchArgs, 'summary instruction must carry the masking reminder')
      .toContain('***')

    // 发起成功：弹层收起（summarized → 宿主关弹层接线）
    await expect(modal).toHaveCount(0, { timeout: 10000 })
  })
})
