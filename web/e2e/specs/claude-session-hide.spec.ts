import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { DEFAULT_PASSWORD, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverIsRemote } from '../../tests/dualpath'

/**
 * Claude 会话隐藏/恢复 E2E（P-20261003-112）：索引层清理文件零触碰——
 * 行「隐藏」→ 默认列表与全文检索消失 →「显示已隐藏」管理视图可见（带恢复键）
 * → 恢复显示 → 回到默认列表。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions?hidden=1 与策展 hidden）。
 *
 * 测试数据：播种一条 fixture transcript 到真实 ~/.claude/projects（与
 * claude-timeline.spec.ts 同款约定——标题带 [e2e-hide] 标记，utimes 控制在
 * activeWindow(5 分钟) 之外），afterAll 恢复显示（防残留 hidden 策展）+ 精确
 * 删除 fixture 文件。隐藏只动索引层策展（claudecur），不动 fixture 文件本身。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与 claude-timeline.spec.ts 一致）。
 */

const MARK = '[e2e-hide]'
const FAKE_DIR_NAME = 'D--e2e-hide-fixtures'
const SESSION_ID = 'e2e-hide-a1b2c3d4-e5f6'
const createdFiles: string[] = []

function buildFixture() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  const lines = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} 隐藏实验会话"},"timestamp":"${new Date(Date.now() - 30 * 60_000).toISOString()}","cwd":"D:\\\\e2e-hide-fixtures"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]},"timestamp":"${new Date(Date.now() - 30 * 60_000).toISOString()}"}`,
  ]
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  // mtime 留在 activeWindow(5 分钟) 外：行可交互（不被判「进行中」）
  const at = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, at, at)
  createdFiles.push(file)
}

function cleanupFixture() {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

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

/** 搜索标记并等待列表行出现（列表过滤 + 全文命中区共用同一查询） */
async function searchMark(picker: ReturnType<Page['locator']>) {
  const searchResp = picker.page().waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
  await picker.locator('input').first().fill(MARK)
  await searchResp
  const row = picker.locator('.csp-row').filter({ hasText: MARK }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  return row
}

test.describe('Claude 会话隐藏/恢复（P-20261003-112）', () => {
  // transcript 夹具种在测试侧 ~/.claude/projects（会话清单/检索是服务端从
  // 服务侧 homedir 读的），跨拓扑时结构性不可见，无服务端写入 API 可翻译——
  // 按环境门控 skip（dualpath.serverIsRemote，P-20261005-187）
  test.skip(serverIsRemote, 'claude transcript 夹具在测试侧 homedir，跨拓扑服务端不可见——仅同机拓扑')
  test.beforeAll(() => {
    buildFixture()
  })

  test.afterAll(async ({ request }) => {
    // 防残留：即使用例中途失败也把策展隐藏态撤掉（fixture 文件另行精确删除）
    try {
      const base = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
      const unlock = await request.post(`${base}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
      const token = ((await unlock.json()) as { token?: string }).token || ''
      await request.post(`${base}/api/claude/sessions/curation`, {
        headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
        data: { sessionId: SESSION_ID, hidden: false },
      })
    } catch { /* 服务不在：fixture 文件随 afterAll 删除，无残留面 */ }
    cleanupFixture()
  })

  test('隐藏 → 列表/检索消失 → 显示已隐藏 → 恢复', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const picker = await openClaudeTab(page)

    // 1. 搜索标记 → fixture 行在默认列表 + 全文命中区
    let row = await searchMark(picker)
    const hitRegion = picker.locator('[data-test="session-search-hits"]')
    await expect(hitRegion.locator('.csp-hit').filter({ hasText: MARK })).toBeVisible({ timeout: 15000 })

    // 2. 行「隐藏」（hover 显现）→ 成功提示 + 刷新后行消失
    // （n-message teleport 到 body：断言挂 page 而非 picker 根——仓内同款惯例）
    await row.hover()
    await row.locator('[data-test="session-hide-btn"]').click()
    await expect(page.locator('.n-message').filter({ hasText: '已隐藏' }).first()).toBeVisible({ timeout: 8000 })
    await expect(picker.locator('.csp-row').filter({ hasText: MARK })).toHaveCount(0, { timeout: 15000 })

    // 3. 重搜：列表与全文命中区都不再有该会话（检索默认排除 hidden）
    await picker.locator('input').first().fill(MARK)
    await picker.page().waitForTimeout(800) // 防抖后查询完成
    await expect(picker.locator('.csp-row').filter({ hasText: MARK })).toHaveCount(0, { timeout: 15000 })
    await expect(hitRegion.locator('.csp-hit').filter({ hasText: MARK })).toHaveCount(0, { timeout: 15000 })

    // 4. 「显示已隐藏」管理视图：行可见，带「已隐藏」徽标与恢复键
    await picker.locator('[data-test="session-hidden-toggle"]').click()
    const hiddenRow = picker.locator('.csp-row').filter({ hasText: MARK }).first()
    await expect(hiddenRow).toBeVisible({ timeout: 15000 })
    await expect(hiddenRow.locator('.csp-row-hiddenbadge')).toHaveText('已隐藏')
    // 管理视图不支持检索（输入框禁用）
    await expect(picker.locator('input').first()).toBeDisabled()

    // 5. 恢复显示 → 管理视图行消失
    await hiddenRow.hover()
    await hiddenRow.locator('[data-test="session-restore-btn"]').click()
    await expect(picker.locator('.csp-row').filter({ hasText: MARK })).toHaveCount(0, { timeout: 15000 })

    // 6. 退回默认视图：行回到列表（transcript 文件全程零触碰）
    await picker.locator('[data-test="session-hidden-toggle"]').click()
    row = await searchMark(picker)
    await expect(row).toBeVisible({ timeout: 15000 })
  })
})
