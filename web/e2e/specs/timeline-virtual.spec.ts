import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 回放时间线虚拟滚动 E2E（P-20261003-182）：P-52（文件树）/P-85（变更树）虚拟化
 * 第三面——长会话回放（200 步）不再全量 DOM 渲染。三个核心契约：
 *   ① 渲染节点有界：`.cstl-step` 只渲染可见窗口 ± overscan，滚动全程节点数
 *      恒有界（远小于总步数），滚动换窗后首/末条内容如实；
 *   ② P-89 时间线内搜索在虚拟化下定位正常：窗口外命中条目 Enter 后经
 *      scrollTo 进窗（querySelector 时代窗口外跳转静默失效的形态不再存在），
 *      「仅命中」紧凑视图在虚拟切片下同样成立；
 *   ③ P-132 进度条在虚拟化下定位正常：拖到未加载段松手，自动「加载更多」
 *      到位后 scrollTo 进窗 + is-focus 呼吸高亮 + 进度位号钉在目标。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions/:id/timeline）。
 *
 * 测试数据：播种一条 200 步 fixture transcript 到真实 ~/.claude/projects
 *（与 timeline-progress.spec.ts 同款约定——标题带 [e2e-tv] 标记，utimes 控制
 * 在 activeWindow(5 分钟) 之外避免被判「进行中」），afterAll 精确删除。
 * 单行短步让估高贴合实测（切片换窗稳定）；idx 35 带唯一检索词。回放链路只读。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与既有 claude-timeline.spec.ts 一致）。
 */

const MARK = '[e2e-tv]'
const FAKE_DIR_NAME = 'D--e2e-tv-fixtures'
const SESSION_ID = 'e2e-tv-e5f6a7b8-c9d0'
const STEP_COUNT = 200
const HIT_IDX = 25 // 唯一关键词所在步：全量加载后滚到尾，任何常规视口下都在窗口外
const createdFiles: string[] = []

function seedTranscript() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  const lines: string[] = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
  ]
  for (let i = 0; i < STEP_COUNT; i++) {
    const at = new Date(Date.now() - (STEP_COUNT + 10 - i) * 60_000).toISOString()
    const text = i === HIT_IDX
      ? `${MARK} 虚拟步骤 ${i} zebra-virtual-needle`
      : `${MARK} 虚拟步骤 ${i}`
    lines.push(
      `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${text}"},"timestamp":"${at}","cwd":"D:\\\\e2e-tv-fixtures"}`,
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

/** 搜索标记打开对应 fixture 的回放弹层（首屏 50 步已加载，头部总步数 200） */
async function openReplay(page: Page) {
  const picker = await openClaudeTab(page)
  const row = picker.locator('.csp-row').filter({ hasText: MARK }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.hover()
  await row.locator('.csp-row-replay').click()
  const modal = page.locator('.n-modal .cstl-root')
  await expect(modal).toBeVisible({ timeout: 10000 })
  await expect(modal.locator('.cstl-head')).toContainText('200 步', { timeout: 15000 })
  return modal
}

/** 滚动到列表纵向比例 p 处（0=顶 1=底，底=已加载段的底） */
async function scrollToRatio(modal: ReturnType<Page['locator']>, p: number) {
  await modal.locator('.cstl-list').evaluate((el: HTMLElement, ratio: number) => {
    el.scrollTop = (el.scrollHeight - el.clientHeight) * ratio
  }, p)
}

/** 等弹层几何稳定再取坐标：n-modal 有 scale 入场动画，动画中 boundingBox
 *  每次读数都不同——按未稳坐标拖拽会映射到错误比例（timeline-progress 同款） */
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

test.describe('回放时间线虚拟滚动（P-20261003-182）', () => {
  test.beforeAll(() => {
    seedTranscript()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('长回放渲染节点有界：滚动全程切片换窗，首/末条内容如实', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplay(page)
    const list = modal.locator('.cstl-list')

    // 首屏已加载 50 条内滚动扫查：每一站节点数有界（窗口 ± overscan，远小于 200）
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      await scrollToRatio(modal, p)
      await expect(modal.locator('.cstl-step').first()).toBeVisible({ timeout: 15000 })
      const count = await modal.locator('.cstl-step').count()
      expect(count).toBeGreaterThan(0)
      expect(count).toBeLessThan(80)
    }

    // 已加载段末条如实（首屏第 50 条），「加载更多」入口在（50 < 200）
    await scrollToRatio(modal, 1)
    await expect(modal.locator('.cstl-step[data-step="49"]')).toContainText(
      '虚拟步骤 49', { timeout: 15000 })
    await expect(modal.locator('[data-test="timeline-load-more"]')).toBeVisible()

    // 逐页「加载更多」到全量（入口消失）；节点数仍有界，末条经换窗渲染
    while (await modal.locator('[data-test="timeline-load-more"]').count() > 0) {
      await modal.locator('[data-test="timeline-load-more"]').click()
      await page.waitForTimeout(300)
    }
    await expect(modal.locator('[data-test="timeline-load-more"]')).toHaveCount(0, { timeout: 15000 })
    await scrollToRatio(modal, 1)
    await expect(modal.locator('.cstl-step[data-step="199"]')).toContainText(
      '虚拟步骤 199', { timeout: 15000 })
    const tailCount = await modal.locator('.cstl-step').count()
    expect(tailCount).toBeGreaterThan(0)
    expect(tailCount).toBeLessThan(80)

    // 滚回首条仍在（换窗回程）
    await scrollToRatio(modal, 0)
    await expect(modal.locator('.cstl-step[data-step="0"]')).toContainText(
      '虚拟步骤 0', { timeout: 15000 })

    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })

  test('P-89 搜索在虚拟化下定位正常：窗口外命中进窗，「仅命中」紧凑视图成立', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplay(page)
    const list = modal.locator('.cstl-list')
    const input = modal.locator('[data-test="timeline-search-input"] input')

    // 先「加载更多」到全量再滚到尾：命中步（idx 25）在列表头部远端，任何常规
    // 视口下都在渲染窗口外（尾窗 = 可见 ± overscan ≈ [190..199]）
    while (await modal.locator('[data-test="timeline-load-more"]').count() > 0) {
      await modal.locator('[data-test="timeline-load-more"]').click()
      await page.waitForTimeout(300)
    }
    await scrollToRatio(modal, 1)
    await expect(modal.locator('.cstl-step[data-step="199"]')).toBeVisible({ timeout: 15000 })
    await expect(modal.locator('.cstl-step[data-step="25"]')).toHaveCount(0)

    // 唯一命中：徽标计数 → Enter 后 scrollTo 长距换窗，命中步渲染 + is-hit-cur
    // 且回到视口内（虚拟化定位含测量回补收敛期，轮询稳态而非瞬时读数）
    await input.fill('zebra-virtual-needle')
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveText('1 处命中')
    await input.press('Enter')
    const hit = modal.locator('.cstl-step[data-step="25"]')
    await expect(hit).toHaveClass(/is-hit-cur/, { timeout: 15000 })
    const listBox = await list.boundingBox()
    await expect.poll(async () => {
      const hitBox = await hit.boundingBox()
      if (!hitBox || !listBox) return false
      return hitBox.y >= listBox.y &&
        hitBox.y + hitBox.height <= listBox.y + listBox.height
    }, { timeout: 10000 }).toBe(true)

    // 「仅命中」紧凑视图在虚拟切片下成立：未命中步骤全部隐藏，只剩命中行
    await modal.locator('[data-test="timeline-search-hits-only"]').click()
    await expect(modal.locator('.cstl-step')).toHaveCount(1)
    await expect(modal.locator('.cstl-step.is-hit')).toHaveCount(1)

    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })

  test('P-132 进度条在虚拟化下定位正常：拖未加载段松手，末段进窗高亮且位号钉住', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplay(page)
    const bar = modal.locator('[data-test="timeline-progress"]')
    await expect(bar).toBeVisible({ timeout: 15000 })

    // 拖到 90%：比例 0.9 × (200-1) = 179.1 → idx 179（未加载段，需追加加载）
    const box = await settledBox(bar)
    const y = box!.y + box!.height / 2
    await page.mouse.move(box!.x + box!.width * 0.1, y)
    await page.mouse.down()
    await page.mouse.move(box!.x + box!.width * 0.9, y, { steps: 8 })

    // 拖动中：浮层预览位号（该段未加载，无文本可预览）
    const tip = modal.locator('[data-test="timeline-progress-tip"]')
    await expect(tip).toBeVisible()
    await expect(tip).toContainText('180 / 200')

    // 松手：自动「加载更多」到位 → scrollTo 进窗 + is-focus；进度位号钉在目标
    await page.mouse.up()
    const target = modal.locator('.cstl-step[data-step="179"]')
    await expect(target).toHaveClass(/is-focus/, { timeout: 15000 })
    await expect(target).toContainText('虚拟步骤 179')
    // 虚拟化定位含测量回补收敛期（尾段还有顶对齐钳制退化底对齐），轮询稳态
    const listBox = await modal.locator('.cstl-list').boundingBox()
    await expect.poll(async () => {
      const targetBox = await target.boundingBox()
      if (!targetBox || !listBox) return false
      return targetBox.y >= listBox.y &&
        targetBox.y + targetBox.height <= listBox.y + listBox.height
    }, { timeout: 10000 }).toBe(true)
    // 进度填充 = 定位目标比例：179/199 ≈ 89.95%
    await expect(modal.locator('.cstl-progress-fill')).toHaveAttribute('style', /89\.95%/)
    // 定位驱动的追加加载已到位：入口消失
    await expect(modal.locator('[data-test="timeline-load-more"]')).toHaveCount(0, { timeout: 15000 })

    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })
})
