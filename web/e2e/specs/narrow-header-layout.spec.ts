import { test, expect } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// P-20261122-15：两处「头部一行硬排、无兜底」的存量布局缺陷回归守卫
//   A. 首页顶栏：390（二维码接力扫码的真实移动形态）品牌区曾被压成 0 宽并与
//      动作区重叠；768 在旧固定断点稿下副标题折行/重叠。守品牌宽>0、二维零
//      重叠、副标题单行、文档零横向溢出、工具栏 13 项不隐藏。
//   B. 项目文件面板：280 默认宽下标题已逐字折成 2 行、180 下末 2 个按钮被
//      overflow:hidden 裁出面板（能看见但点不到）。守标题单行 + 7 个按钮盒
//      全部落在面板内（不用 toBeVisible：被父级裁掉仍有盒会假绿）。

type Box = { x: number; y: number; width: number; height: number }

async function boxOf(loc: Locator): Promise<Box> {
  const b = await loc.boundingBox()
  expect(b, '元素应有布局盒').not.toBeNull()
  return b!
}

/** 两盒是否相交（gap>0 时要求至少留出 gap 的间隔） */
function overlaps(a: Box, b: Box, gap = 0): boolean {
  return !(
    a.x + a.width + gap <= b.x
    || b.x + b.width + gap <= a.x
    || a.y + a.height + gap <= b.y
    || b.y + b.height + gap <= a.y
  )
}

/** 元素行数判据：clientHeight 不超过 1.5 倍行高 */
async function expectSingleLine(loc: Locator, label: string): Promise<void> {
  const lineHeight = await loc.evaluate(el => {
    const cs = getComputedStyle(el)
    return cs.lineHeight === 'normal' ? parseFloat(cs.fontSize) * 1.2 : parseFloat(cs.lineHeight)
  })
  const height = await loc.evaluate(el => el.clientHeight)
  expect(height, `${label}应为单行（≤1.5 行高）`).toBeLessThanOrEqual(lineHeight * 1.5)
}

async function clearUiState(page: Page): Promise<void> {
  // 服务端全局态：用例前后清空，避免侧栏宽度/视图开合残留串到后续用例
  await page.evaluate(async () => {
    await fetch('/api/ui-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local: null }),
    })
  })
}

test.describe('首页顶栏窄宽度兜底', () => {
  test('390/768/850/900/1440/1920：品牌不被压扁、与动作区零重叠、入口完整', async ({ page }) => {
    test.setTimeout(90000)
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await expect(page.locator('.home-root')).toBeVisible({ timeout: 5000 })

    const header = page.locator('.home-header')
    const left = page.locator('.home-header-left')
    const logo = page.locator('.home-logo')
    const subtitle = page.locator('.home-subtitle')
    const actions = page.locator('.home-header-actions')
    const items = actions.locator('> *')

    const viewports = [
      { width: 390, height: 844 },
      { width: 768, height: 800 },
      { width: 850, height: 800 },
      { width: 900, height: 800 },
      { width: 1440, height: 900 },
      { width: 1920, height: 1080 },
    ]

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.waitForTimeout(200)
      const label = `${vp.width}x${vp.height}`

      const headerBox = await boxOf(header)
      const leftBox = await boxOf(left)
      const logoBox = await boxOf(logo)
      const actionsBox = await boxOf(actions)

      // ① 品牌区不再被压成 0 宽（旧 390 实测 left 宽 0、logo 与动作区重叠）
      expect(leftBox.width, `${label}: 品牌区宽度应 >0`).toBeGreaterThan(0)
      expect(overlaps(logoBox, actionsBox), `${label}: 品牌与动作区不得重叠`).toBe(false)

      // ② 副标题不逐字折行（旧 390 为 31×77 = 4 行）
      await expectSingleLine(subtitle, `${label}: 副标题`)

      // ③ 文档零横向溢出（1px 容差给亚像素取整）
      await expect.poll(
        () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
      ).toBeLessThanOrEqual(1)

      // ④ 工具栏 13 项（12 图标 + 添加项目）全在视口与 header 内，不隐藏入口
      await expect(items).toHaveCount(13)
      for (let i = 0; i < 13; i++) {
        const b = await boxOf(items.nth(i))
        expect(b.width, `${label}: 第 ${i + 1} 项应有宽`).toBeGreaterThan(0)
        expect(b.height, `${label}: 第 ${i + 1} 项应有高`).toBeGreaterThan(0)
        expect(b.x, `${label}: 第 ${i + 1} 项不得越左界`).toBeGreaterThanOrEqual(-1)
        expect(b.x + b.width, `${label}: 第 ${i + 1} 项不得越右界`).toBeLessThanOrEqual(vp.width + 1)
        expect(b.y + b.height, `${label}: 第 ${i + 1} 项应落在 header 内`).toBeLessThanOrEqual(headerBox.y + headerBox.height + 1)
      }

      // header 高度只作次要守卫（现状 106px 也满足，不作唯一判据）
      expect(headerBox.height, `${label}: header 高度`).toBeLessThanOrEqual(150)

      if (vp.width === 390) {
        // 390：动作区折到品牌行下方并在行内二次换行（13 项在 334px 内容宽
        // 内放不下；高度 >40 即至少两行，逐项 top 会有 ±1px 对齐差不能直接数）
        expect(actionsBox.height, '390: 动作区应在行内换行').toBeGreaterThan(40)
        // 换行后动作区整体位于品牌行下方（与重叠判据互补的形态断言）
        expect(actionsBox.y, '390: 动作区应在品牌行下方').toBeGreaterThanOrEqual(logoBox.y + logoBox.height)
        // 添加项目可见可点（enabled 判可点，不实际开弹窗）；设置点开断言弹窗出现
        await expect(actions.locator('.n-button')).toBeVisible()
        await expect(actions.locator('.n-button')).toBeEnabled()
        await actions.locator('[data-icon-nav="settings"]').click()
        const modal = page.locator('.n-modal.settings-modal')
        await expect(modal).toBeVisible({ timeout: 3000 })
        await page.keyboard.press('Escape')
        await expect(modal).toBeHidden({ timeout: 3000 })
      } else if (vp.width === 768) {
        // 768：动作区独占第二行（旧固定断点稿在此重叠 31px）
        expect(actionsBox.y, '768: 动作区应独占第二行').toBeGreaterThanOrEqual(leftBox.y + leftBox.height - 1)
        expect(actionsBox.height, '768: 动作区自身单行').toBeLessThanOrEqual(34)
      } else if (vp.width >= 900) {
        // ≥900：单行形态——品牌与动作区同一行且留 8px 水平间隔
        expect(logoBox.x + logoBox.width + 8, `${label}: 品牌与动作区水平间隔`).toBeLessThanOrEqual(actionsBox.x)
        expect(actionsBox.height, `${label}: 动作区单行`).toBeLessThanOrEqual(34)
      }
    }
  })
})

test.describe('项目文件面板窄侧栏兜底', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('180/240/280/500：标题不折行、7 个按钮全在面板内、无横向溢出', async ({ page }) => {
    test.setTimeout(120000)
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    await clearUiState(page)
    await page.reload()
    await gotoAndUnlock(page, `${API_BASE}/`)
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')

    // 归一到 files 视图（面板开关是 toggle）：按 rail 的 active 类判开合
    // （registry 定义 = showSidePanel && sideView==='files'），不按树行可见性判
    // ——树加载窗口内行未渲染会误点一次把已开面板关掉，重负载下多一次翻转即失稳
    const railFiles = page.locator('[data-testid="rail-files"]')
    for (let i = 0; i < 3; i++) {
      if (await railFiles.evaluate(el => el.classList.contains('active')).catch(() => false)) break
      await railFiles.click()
      await page.waitForTimeout(300)
    }
    await expect(page.locator('#side-panel')).toBeVisible({ timeout: 10000 })
    await expect(page.locator('.tree-header')).toBeVisible({ timeout: 10000 })

    const panel = page.locator('#side-panel')
    const resizer = page.locator('.ide-side-resizer')
    const header = page.locator('.tree-header')
    const title = page.locator('.tree-title')
    const buttons = page.locator('.tree-actions .tree-action-btn')
    await expect(buttons).toHaveCount(7)

    /** 经 resizer 拖到目标宽（钳位 [180,500]；端点额外越界 40px 保证命中钳位） */
    async function setSidebarWidth(target: number): Promise<void> {
      const current = (await boxOf(panel)).width
      const r = await boxOf(resizer)
      const startX = r.x + r.width / 2
      const y = r.y + Math.min(200, r.height / 2)
      const overshoot = target === 500 ? 40 : target === 180 ? -40 : 0
      await page.mouse.move(startX, y)
      await page.mouse.down()
      await page.mouse.move(startX + (target - current) + overshoot, y, { steps: 8 })
      await page.mouse.up()
      await expect.poll(async () => Math.round((await boxOf(panel)).width)).toBe(target)
    }

    try {
      // 从钳位下限 180 起逐步加宽（先测最窄形态），覆盖任务书四档
      for (const width of [180, 240, 280, 500]) {
        await setSidebarWidth(width)
        await page.waitForTimeout(150)
        const label = `侧栏 ${width}px`

        // ① 标题单行（旧 280 已 2 行、240 为 4 行逐字折行）
        await expectSingleLine(title, `${label}: 标题`)

        // ② header 无横向溢出（button 盒不得撑破行）
        const overflow = await header.evaluate(el => el.scrollWidth - el.clientWidth)
        expect(overflow, `${label}: header 横向溢出`).toBeLessThanOrEqual(1)

        // ③ 7 个按钮逐个盒落在面板内——被父级 overflow 裁掉仍有盒，
        //    故不能用 toBeVisible，必须以面板 boundingBox 做包含断言
        const panelBox = await boxOf(panel)
        for (let i = 0; i < 7; i++) {
          const b = await boxOf(buttons.nth(i))
          expect(b.width, `${label}: 第 ${i + 1} 键应有宽`).toBeGreaterThan(0)
          expect(b.height, `${label}: 第 ${i + 1} 键应有高`).toBeGreaterThan(0)
          expect(b.x, `${label}: 第 ${i + 1} 键不得越左界`).toBeGreaterThanOrEqual(panelBox.x - 1)
          expect(b.x + b.width, `${label}: 第 ${i + 1} 键不得被面板右缘裁切`).toBeLessThanOrEqual(panelBox.x + panelBox.width + 1)
          expect(b.y, `${label}: 第 ${i + 1} 键不得越上界`).toBeGreaterThanOrEqual(panelBox.y - 1)
          expect(b.y + b.height, `${label}: 第 ${i + 1} 键不得越下界`).toBeLessThanOrEqual(panelBox.y + panelBox.height + 1)
        }

        // ④ 280/500 按钮组单行；180/240 允许折行（240 现状即单行，不作反向断言）
        if (width === 280 || width === 500) {
          const rows = await buttons.evaluateAll(
            els => new Set(els.map(el => Math.round(el.getBoundingClientRect().top))).size,
          )
          expect(rows, `${label}: 按钮组应单行`).toBe(1)
        }
      }
    } finally {
      // 复原默认 280 并清 uiState（服务端全局态）：先进首页让项目页关页补丁落定，
      // 再清空，避免清理被页面卸载写回覆盖
      // silent-by-design: 收尾复原尽力而为，拖拽失败不改变用例结论（下方清理照跑）
      await setSidebarWidth(280).catch(() => {})
      await page.goto(`${API_BASE}/`)
      await expect(page.locator('.home-root')).toBeVisible({ timeout: 10000 })
      await clearUiState(page)
    }
  })
})
