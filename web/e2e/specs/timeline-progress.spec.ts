import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 时间轴进度条拖拽定位 E2E（P-20261003-132）：回放弹层搜索行下的细进度条
 * 按条目索引比例拖拽——拖动中浮显目标条目首行摘要预览（列表不动），松手
 * 视口跳至对应条目并呼吸高亮；目标在未加载段时先「加载更多」追加到位再
 * 定位；total≤1 无可导航空间不渲染进度条。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions/:id/timeline）。
 *
 * 测试数据：播种两条 fixture transcript 到真实 ~/.claude/projects（与
 * claude-timeline.spec.ts 同款约定——标题带 [e2e-tp] 标记，utimes 控制
 * 在 activeWindow(5 分钟) 之外避免被判「进行中」），afterAll 精确删除。
 * 60 步 > 首屏 limit(50)：80% 命中已加载段（idx=47），100% 命中未加载段
 * （idx=59，验证追加加载）；1 步 fixture 验证进度条隐藏。回放链路只读。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与既有 claude-timeline.spec.ts 一致）。
 */

const MARK = '[e2e-tp]'
const FAKE_DIR_NAME = 'D--e2e-tp-fixtures'
const SESSION_ID = 'e2e-tp-c3d4e5f6-a7b8'
const SOLO_ID = 'e2e-tp-d4e5f6a7-b8c9'
// 60 步：80% × (60-1) = 47.2 → idx 47（首屏 50 内）；100% → idx 59（需追加）
const STEP_COUNT = 60
const createdFiles: string[] = []

/** 播种 fixture transcript：count 条用户指令步，每步间隔 1 分钟（时间正序） */
function seedTranscript(sessionId: string, count: number, tag: string) {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  const lines: string[] = [
    `{"type":"last-prompt","sessionId":"${sessionId}"}`,
  ]
  for (let i = 0; i < count; i++) {
    const at = new Date(Date.now() - (count + 10 - i) * 60_000).toISOString()
    lines.push(
      `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${tag} 进度步骤 ${i}"},"timestamp":"${at}","cwd":"D:\\\\e2e-tp-fixtures"}`,
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

/** 搜索标记打开对应 fixture 的回放弹层 */
async function openReplay(page: Page, tag: string) {
  const picker = await openClaudeTab(page)
  const row = picker.locator('.csp-row').filter({ hasText: tag }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.hover()
  await row.locator('.csp-row-replay').click()
  const modal = page.locator('.n-modal .cstl-root')
  await expect(modal).toBeVisible({ timeout: 10000 })
  return modal
}

/** 等弹层几何稳定再取坐标：n-modal 有 scale 入场动画（实测秒级），动画中
 *  boundingBox 每次读数都不同——按未稳坐标拖拽会映射到错误比例。连续两次
 *  读数一致（<0.5px）才认为入场结束 */
async function settledBox(locator: ReturnType<Page['locator']>) {
  let prev = await locator.boundingBox()
  for (let i = 0; i < 20; i++) {
    await locator.page().waitForTimeout(250)
    const cur = await locator.boundingBox()
    if (prev && cur && Math.abs(cur.x - prev.x) < 0.5 && Math.abs(cur.width - prev.width) < 0.5) return cur
    prev = cur
  }
  return prev
}

test.describe('时间轴进度条拖拽定位（P-20261003-132）', () => {
  test.beforeAll(() => {
    seedTranscript(SESSION_ID, STEP_COUNT, MARK)
    seedTranscript(SOLO_ID, 1, '[e2e-tpx-solo]')
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('拖至 80%：预览浮显目标首行摘要，松手跳至对应条目并高亮，进度同步', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplay(page, MARK)

    // 首屏 50 步加载完成后进度条出现；初始位号在头部。虚拟切片下 DOM 有界
    //（可见窗口 ± overscan，远小于已加载的 50，P-20261003-182）
    const bar = modal.locator('[data-test="timeline-progress"]')
    await expect(bar).toBeVisible({ timeout: 15000 })
    await expect(modal.locator('.cstl-step').first()).toBeVisible({ timeout: 15000 })
    const windowCount = await modal.locator('.cstl-step').count()
    expect(windowCount).toBeGreaterThan(0)
    expect(windowCount).toBeLessThan(50)

    // 拖到 80%：比例 0.8 × (60-1) = 47.2 → idx 47（位号 48 / 60）
    const box = await settledBox(bar)
    const y = box!.y + box!.height / 2
    await page.mouse.move(box!.x + box!.width * 0.1, y)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width * 0.8, y, { steps: 8 })

    // 拖动中：浮层预览位号 + 目标条目首行摘要（步骤 47 已加载）
    const tip = modal.locator('[data-test="timeline-progress-tip"]')
    await expect(tip).toBeVisible()
    await expect(tip).toContainText('48 / 60')
    await expect(tip).toContainText('进度步骤 47')

    // 松手：视口跳至对应条目并呼吸高亮（is-focus）
    await page.mouse.up()
    const target = modal.locator('.cstl-step[data-step="47"]')
    await expect(target).toHaveClass(/is-focus/)
    await expect(target).toContainText('进度步骤 47')
    // 目标在列表视口内。虚拟化定位（P-20261003-182）含「估高落点 → 切片实测
    // 回写 → 位差回补」的数百毫秒收敛期，断言轮询到收敛稳态而非瞬时读数
    const listBox = await modal.locator('.cstl-list').boundingBox()
    await expect.poll(async () => {
      const targetBox = await target.boundingBox()
      if (!targetBox || !listBox) return false
      return targetBox.y >= listBox.y &&
        targetBox.y + targetBox.height <= listBox.y + listBox.height
    }, { timeout: 10000 }).toBe(true)

    // 进度填充与定位目标一致（松手后进度即目标条目，不受滚动钳制影响）：47/59 ≈ 79.66%
    await expect(modal.locator('.cstl-progress-fill')).toHaveAttribute('style', /79\.66%/)

    // 高亮短暂性：2s 后自行消退
    await expect(target).not.toHaveClass(/is-focus/, { timeout: 4000 })

    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })

  test('拖至 100%（未加载段）：预览只报位号，松手追加加载到位再定位末条', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplay(page, MARK)
    const bar = modal.locator('[data-test="timeline-progress"]')
    await expect(bar).toBeVisible({ timeout: 15000 })
    await expect(modal.locator('.cstl-step').first()).toBeVisible({ timeout: 15000 })

    const box = await settledBox(bar)
    const y = box!.y + box!.height / 2
    await page.mouse.move(box!.x + box!.width * 0.5, y)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width, y, { steps: 6 })

    // idx 59 未加载：浮层只报位号、无文本可预览（拖动路径零 IO）
    const tip = modal.locator('[data-test="timeline-progress-tip"]')
    await expect(tip).toBeVisible()
    await expect(tip).toContainText('60 / 60')
    await expect(tip).not.toContainText('进度步骤 59')

    // 松手：自动「加载更多」追加到 60 条全量，末条 scrollTo 进窗（虚拟切片，
    // DOM 仍有界）定位高亮
    await page.mouse.up()
    const last = modal.locator('.cstl-step[data-step="59"]')
    await expect(last).toHaveClass(/is-focus/, { timeout: 15000 })
    await expect(last).toContainText('进度步骤 59')
    await expect(modal.locator('[data-test="timeline-load-more"]')).toHaveCount(0, { timeout: 15000 })

    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })

  test('单步会话（total≤1）：不渲染进度条', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplay(page, '[e2e-tpx-solo]')
    await expect(modal.locator('.cstl-step')).toHaveCount(1, { timeout: 15000 })
    await expect(modal.locator('[data-test="timeline-progress"]')).toHaveCount(0)
    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })
})
