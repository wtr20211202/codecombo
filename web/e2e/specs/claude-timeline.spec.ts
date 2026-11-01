import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverIsRemote } from '../../tests/dualpath'

/**
 * Claude 会话回放时间线 E2E（P-20261001-3）：列表行「回放」入口 → 弹层逐步
 * 回览 transcript（用户指令步），断言步骤数与分页「加载更多」。
 *
 * 虚拟滚动适配（P-20261003-182）：列表切片渲染——`.cstl-step` 只渲染可见
 * 窗口 ± overscan，DOM 数有界不再等于已加载条数；全量断言改为「有界 + 随
 * 滚动换窗」两步（滚到底可见末条）。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions/:id/timeline）。
 *
 * 测试数据：播种一条 60 步的 fixture transcript 到真实 ~/.claude/projects
 *（与 web/tests/claude-sessions.spec.ts 同款约定——标题带 [e2e-tl] 标记，
 * utimes 控制在 activeWindow(5 分钟) 之外避免被判「进行中」），
 * afterAll 精确删除 fixture 文件。回放链路只读，不创建终端会话。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与既有 claude-sessions.spec.ts 一致）。
 */

const MARK = '[e2e-tl]'
const FAKE_DIR_NAME = 'D--e2e-tl-fixtures'
const SESSION_ID = 'e2e-tl-a1b2c3d4-e5f6'
// 60 步 > 首屏 limit(50)：首屏 50 步 + 「加载更多」追加 10 步
const STEP_COUNT = 60
const createdFiles: string[] = []

/** 播种 fixture transcript：60 条用户指令步，每步间隔 1 分钟（时间正序） */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  const lines: string[] = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
  ]
  for (let i = 0; i < STEP_COUNT; i++) {
    const at = new Date(Date.now() - (STEP_COUNT + 10 - i) * 60_000).toISOString()
    lines.push(
      `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} 回放步骤 ${i}"},"timestamp":"${at}","cwd":"D:\\\\e2e-tl-fixtures"}`,
    )
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  // mtime/收尾部留 10 分钟余量：落在服务端 activeWindow(5 分钟) 外，行可交互
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

test.describe('Claude 会话回放时间线（P-20261001-3）', () => {
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

  test('列表行回放入口：弹层步骤数与「加载更多」分页', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const picker = await openClaudeTab(page)

    // 搜索标记 → 唯一 fixture 行
    const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
    await picker.locator('input').fill(MARK)
    await searchResp
    const row = picker.locator('.csp-row').filter({ hasText: MARK }).first()
    await expect(row).toBeVisible({ timeout: 15000 })

    // 行内「回放」角标 → 弹层时间线（角标 hover 显现，click 自动先移动鼠标）
    await row.hover()
    await row.locator('.csp-row-replay').click()
    const modal = page.locator('.n-modal .cstl-root')
    await expect(modal).toBeVisible({ timeout: 10000 })

    // 首屏 50 步已加载（服务端 limit=50），头部总步数 = 60；虚拟切片下 DOM
    // 有界——只渲染可见窗口 ± overscan，远小于 50（P-20261003-182）
    await expect(modal.locator('.cstl-step').first()).toBeVisible({ timeout: 15000 })
    await expect(modal.locator('.cstl-head')).toContainText('60 步')
    const firstWindow = await modal.locator('.cstl-step').count()
    expect(firstWindow).toBeGreaterThan(0)
    expect(firstWindow).toBeLessThan(50)

    // 「加载更多」追加剩余 10 步（Playwright 自动滚动到按钮），追加后入口消失；
    // DOM 仍有界（60 条不全量渲染）
    await modal.locator('[data-test="timeline-load-more"]').click()
    await expect(modal.locator('[data-test="timeline-load-more"]')).toHaveCount(0, { timeout: 15000 })
    const afterLoad = await modal.locator('.cstl-step').count()
    expect(afterLoad).toBeGreaterThan(0)
    expect(afterLoad).toBeLessThan(60)

    // 步骤正序：滚回顶部，首步是最老的一条（fixture 第 0 步）
    await modal.locator('.cstl-list').evaluate((el: HTMLElement) => { el.scrollTop = 0 })
    await expect(modal.locator('.cstl-step').first()).toContainText('回放步骤 0', { timeout: 15000 })

    // 虚拟切片随滚动换窗：滚到列表底部可见末条（步骤 59）
    await modal.locator('.cstl-list').evaluate((el: HTMLElement) => { el.scrollTop = el.scrollHeight })
    await expect(modal.locator('.cstl-step[data-step="59"]')).toContainText('回放步骤 59', { timeout: 15000 })

    // 关闭弹层
    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })
})
