import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 图标按钮最小热区纪律（P-20261019-5）：桌面 ≥28×28、粗指针 ≥40×40。
 * 审计实锚：项目页 51 个交互元素 <28×28（多为 18×22）、Git 分区 +/× 14×10、
 * 设置图标钮 26×22 / 关闭钮 21×22——图标视觉尺寸不动，按钮盒以透明
 * min-width/min-height 撑开命中区（token `--hit-target-min`）。P-20261003-128
 * 的审批卡 coarse 40px 先例（approval-touch-target.spec.ts）在本条推广到
 * 活动栏 / 顶栏 / Git 分区 / 设置弹窗 / 文件树五类落点。
 *   ① fine 指针（桌面默认）：代表按钮 getBoundingClientRect ≥28×28；
 *      树头相邻操作钮命中区不交叠（gap 检查）
 *   ② coarse 指针：CDP 触摸模拟 + 移动设备度量（同 P-128 用例的开关——
 *      Emulation.setEmulatedMedia 覆盖 pointer 特性名不生效，触摸模拟才是
 *      Chromium 判定 coarse 主指针的开关）→ 同一批按钮 ≥40×40，且树头
 *      换行后同排相邻命中区仍不交叠；点击链不受放大影响（进项目/开 Git
 *      面板/开设置均是点击驱动）
 * 环境守卫：coarse 用例先断言 matchMedia('(pointer: coarse)').matches——模拟
 * 不生效时显式红，不静默假绿；fine 用例反向断言 coarse=false（单变量对照）。
 * 数据面用 e2e-seed 的 simple-coding 项目卡（仓库自带 origin，Git 分区
 * × 按钮恒有样本），不另建临时项目。
 */

const FINE_MIN = 28
const COARSE_MIN = 40

interface Box { width: number; height: number; left: number; top: number; right: number; bottom: number }

/** 量取全部匹配元素的命中盒（getBoundingClientRect 是热区的地面真值） */
async function boxes(page: Page, selector: string): Promise<Box[]> {
  return page.locator(selector).evaluateAll(els => els.map(el => {
    const r = el.getBoundingClientRect()
    return { width: r.width, height: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom }
  }))
}

/** 断言选择器命中的每个元素宽高均达 min，返回盒集合供相邻性检查 */
async function expectHitTargets(page: Page, selector: string, min: number): Promise<Box[]> {
  const list = await boxes(page, selector)
  expect(list.length, `${selector} 应有至少一个命中样本`).toBeGreaterThan(0)
  for (const b of list) {
    expect(b.width, `${selector} 宽 ${b.width} 未达 ${min}`).toBeGreaterThanOrEqual(min - 0.5)
    expect(b.height, `${selector} 高 ${b.height} 未达 ${min}`).toBeGreaterThanOrEqual(min - 0.5)
  }
  return list
}

/** 同一行（top 相同）相邻按钮的命中区不得交叠——热区放大后 gap 纪律的机械断言 */
function expectNoRowOverlap(list: Box[], label: string): void {
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]
    const cur = list[i]
    if (Math.abs(prev.top - cur.top) < 1) {
      expect(cur.left, `${label} 第 ${i + 1} 个按钮的命中区与前一个交叠`).toBeGreaterThanOrEqual(prev.right - 0.5)
    }
  }
}

/** 进项目页（金态项目卡）并等文件树操作钮就绪 */
async function enterProject(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await expect(page.locator('.tree-action-btn').first()).toBeVisible({ timeout: 10000 })
}

/** 打开 Git 面板并归一化到可见基线（面板开关是 toggle 语义，跑序可能已开） */
async function ensureGitPanel(page: Page): Promise<void> {
  const addBtn = page.locator('.git-sidebar .section-add-btn').first()
  for (let i = 0; i < 3; i++) {
    if (await addBtn.isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    try {
      await expect(addBtn).toBeVisible({ timeout: 3000 })
      return
    } catch { /* 下一轮再试（首轮可能在等面板挂载） */ }
  }
  await expect(addBtn).toBeVisible()
}

/** 设置弹窗 → 安全 → 审计日志页（含一个 icon-only naive 按钮的稳定样本） */
async function openAuditPane(page: Page): Promise<void> {
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="settings-nav-security"]').click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 5000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审计日志' }).click()
  await expect(page.getByTestId('audit-pane')).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId('audit-refresh')).toBeVisible()
}

/** 五类落点的代表按钮量取（设置弹窗样本须先 openAuditPane） */
async function assertRepresentativeTargets(page: Page, min: number): Promise<void> {
  // 活动栏：顶部面板钮 + 实例入口 + 底部添加项目/设置钮（rail 里两档都量）
  await expect(page.locator('[data-testid="rail-git"]')).toBeVisible()
  await expectHitTargets(page, '.rail-top .rail-btn', min)
  await expectHitTargets(page, '[data-testid="rail-add-project"]', min)
  await expectHitTargets(page, '[data-testid="rail-settings"]', min)
  const rail = await boxes(page, '.ide-rail')
  const indicator = await expectHitTargets(page, '[data-testid="instance-indicator"]', min)
  // 实例入口是活动栏内最宽的非 rail-btn 命中区（coarse 40px）：44px 栏宽内
  // 不得横向溢出（coarse 档 rail-instance 内边距收到 2px 的前提）
  expect(rail.length).toBe(1)
  expect(indicator[0].left).toBeGreaterThanOrEqual(rail[0].left - 0.5)
  expect(indicator[0].right).toBeLessThanOrEqual(rail[0].right + 0.5)

  // 顶栏：ToolButton（布局锁定钮，size=small）
  await expectHitTargets(page, '[data-testid="topbar-layout-lock"]', min)

  // 文件树：树头操作钮（原 18×22）+ 相邻命中区不交叠
  const treeBtns = await expectHitTargets(page, '.tree-actions .tree-action-btn', min)
  expectNoRowOverlap(treeBtns, '文件树操作钮')

  // Git 面板分区 +/×（原 14×10）：远程分区的 +、远程行的 ×、工作树分区的 +
  await expectHitTargets(page, '.git-sidebar .section-add-btn', min)
  await expectHitTargets(page, '.git-sidebar .section-action', min)

  // 设置弹窗：关闭钮（原 21×22）+ 分区内 icon-only naive 按钮（原 26×22）
  await expectHitTargets(page, '.settings-close', min)
  await expectHitTargets(page, '[data-testid="audit-refresh"]', min)
}

test('fine 指针（桌面）：代表图标按钮命中区 ≥28×28 且相邻不交叠', async ({ page }) => {
  await enterProject(page)
  await expect
    .poll(() => page.evaluate(() => matchMedia('(pointer: coarse)').matches))
    .toBe(false)

  await ensureGitPanel(page)
  await openAuditPane(page)
  await assertRepresentativeTargets(page, FINE_MIN)
})

test.describe('coarse 指针（触屏模拟）', () => {
  // 视口放宽只让设置弹窗/文件树同屏可点（coarse 与视口尺寸无关，单变量仍是指针形态）
  test.use({ viewport: { width: 1280, height: 900 } })

  test('代表图标按钮命中区 ≥40×40，换行后同排不交叠且点击链照常', async ({ page }) => {
    // 触摸模拟 + 移动设备度量 → Chromium 判定主指针 coarse（先于导航，首帧即 coarse）
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      mobile: true, width: 1280, height: 900, deviceScaleFactor: 1,
    })

    await enterProject(page)
    // 环境守卫：模拟不生效（Chromium 行为变化）显式红，不静默假绿
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)

    await ensureGitPanel(page)
    await openAuditPane(page)
    await assertRepresentativeTargets(page, COARSE_MIN)

    // 点击链不受热区放大影响：关闭设置后重新开合一次 Git 面板（toggle 语义，
    // ensureGitPanel 自行归一化到「可见」基线）
    await page.locator('.settings-close').click()
    await expect(page.locator('.settings-modal')).toHaveCount(0, { timeout: 5000 })
    await page.locator('[data-testid="rail-git"]').click()
    await ensureGitPanel(page)
    await expect(page.locator('.git-sidebar .section-add-btn').first()).toBeVisible()
  })
})
