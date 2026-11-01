import { test, expect } from '@playwright/test'
import type { APIRequestContext, Locator, Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, getLockToken, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// C4 极窄屏抽屉：≤700px 时侧栏不再是 display:none 硬砍，
// 而是活动栏按钮开合的 overlay 抽屉（有真实展开入口）
test.describe('极窄屏侧栏抽屉', () => {
  test.use({ viewport: { width: 640, height: 800 } })

  test('files 按钮可开合侧栏抽屉', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    // rail 在项目页布局中（首页无 ActivityBar）
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')

    const panel = page.locator('#side-panel')
    const railFiles = page.locator('[data-testid="rail-files"]')
    // 前置幂等（CLAUDE.md 测试节：面板开关是 toggle，uiState 按实例跨用例恢复
    // 态不定）：侧栏可能继承「changes 等其他视图的开启态」——面板可见但非 files
    // 视图，此时点 rail-files 是切视图不是关抽屉（togglePanel 语义），旧版「只看
    // 可见」的幂等会把关抽屉误做成切视图（fulle2e run7 实测形态）。以 rail-btn
    // 的 active 类（=files 视图开启）为准归一化，保证后续开合断言的确定性
    for (let i = 0; i < 3; i++) {
      if (await railFiles.evaluate(el => el.classList.contains('active')).catch(() => false)) break
      await railFiles.click()
      await page.waitForTimeout(300)
    }
    await expect(railFiles).toHaveClass(/active/, { timeout: 5000 })
    await expect(panel).toBeVisible()
    // 关闭 → 再点恢复：抽屉可重新展开（此前 display:none 硬砍时永远不可见）
    await railFiles.click()
    await expect(panel).toBeHidden()
    await railFiles.click()
    await expect(panel).toBeVisible()
  })
})

// P-20261019-6：设置弹窗窄屏收口——390×844（手机竖屏；产品支持二维码接力
// 扫码打开当前页，移动浏览器是真实使用形态）。旧布局左栏固定 180px，内容区
// 仅剩 ~135px，220px 表单控件被裁出横向滚动；本用例守「顶部横向页签 + 内容区
// 零横向溢出 + 固定宽控件不越界 + 分区切换可用」四件事。
test.describe('窄屏设置弹窗', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  async function openSettings(page: Page): Promise<Locator> {
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await expect(page.locator('.home-root')).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Control+,')
    const modal = page.locator('.n-modal.settings-modal')
    await expect(modal).toBeVisible({ timeout: 3000 })
    return modal
  }

  /** 内容区横向溢出量（含子控件撑破；1px 容差给亚像素取整） */
  function horizontalOverflow(content: Locator): Promise<number> {
    return content.evaluate(el => el.scrollWidth - el.clientWidth)
  }

  /** 控件整体落在内容区可视宽内（不裁切、不越界） */
  async function expectInsideContent(control: Locator, content: Locator): Promise<void> {
    await expect(control).toBeVisible()
    const c = await content.boundingBox()
    const b = await control.boundingBox()
    expect(c, '内容区应有布局盒').not.toBeNull()
    expect(b, '控件应有布局盒').not.toBeNull()
    expect(b!.x).toBeGreaterThanOrEqual(c!.x - 1)
    expect(b!.x + b!.width).toBeLessThanOrEqual(c!.x + c!.width + 1)
  }

  test('左栏转横向页签，内容区无横向溢出且固定宽控件不裁切', async ({ page }) => {
    const modal = await openSettings(page)
    // naive-ui 的 n-modal 把 class 合并到内容根元素：.n-modal.settings-modal
    // 自身即 .settings-card（旧用例只认 .n-modal.settings-modal 即此因）
    const card = modal
    const nav = modal.locator('.settings-nav')
    const content = modal.locator('.settings-content')

    // 弹窗整体不超出视口（旧版 92vw 卡在弹窗水平边距内，这里放宽到满宽减边距）
    await expect.poll(async () => {
      const box = await card.boundingBox()
      return box ? Math.round(box.x + box.width) : Number.POSITIVE_INFINITY
    }).toBeLessThanOrEqual(390)

    // 左栏已变为顶部横向条：宽度近似卡片全宽，高度远小于宽度
    const navBox = await nav.boundingBox()
    const cardBox = await card.boundingBox()
    expect(navBox, '左栏应有布局盒').not.toBeNull()
    expect(cardBox, '卡片应有布局盒').not.toBeNull()
    expect(navBox!.width).toBeGreaterThan(navBox!.height * 2)
    expect(navBox!.width).toBeGreaterThan(cardBox!.width * 0.8)

    // 页签横向可滚动（10 个分区在 390px 下放不下，靠横向滚动而非换行/裁切）
    const navItems = nav.locator('.nav-items')
    expect(await navItems.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(0)

    // 通用分区：内容区零横向溢出，220px 审批档位选择器完整落在内容区内
    await expect.poll(() => horizontalOverflow(content)).toBeLessThanOrEqual(1)
    await expectInsideContent(
      page.locator('[data-testid="settings-agent-approval-mode"] .n-select'),
      content,
    )

    // 横向页签下键盘 ↑↓ 仍切分区（导航逻辑按 .nav-item 顺序索引，与排列轴无关）
    await page.locator('[data-testid="settings-nav-general"]').focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('[data-testid="settings-nav-appearance"]')).toHaveClass(/active/)

    // 切到最末分区「关于」：点击自动横向滚动页签，分区渲染正常
    await page.locator('[data-testid="settings-nav-about"]').click()
    await expect(page.locator('[data-testid="settings-pane-about"]')).toBeVisible()
    await expect.poll(() => horizontalOverflow(content)).toBeLessThanOrEqual(1)

    // 终端分区：340px 默认 shell 选择器被 max-width:100% 收进内容区（旧版撑破）
    await page.locator('[data-testid="settings-nav-terminal"]').click()
    await expect(page.locator('[data-testid="settings-pane-terminal"]')).toBeVisible()
    await expect.poll(() => horizontalOverflow(content)).toBeLessThanOrEqual(1)
    await expectInsideContent(
      page.locator('[data-testid="settings-terminal-default-shell"]'),
      content,
    )
  })
})

// P-20261019-7：窄屏工作区单栏形态（390×844 = 手机竖屏，二维码接力扫码直达
// 当前页的真实形态）。守四件事：
//   ① 页面零横向溢出（审计锚点：旧布局文档宽 770px；顶栏获取/拉取/推送被裁）；
//   ② 活动栏在底部、侧栏为抽屉且遮罩不挡底栏切换器；
//   ③ 终端为覆盖主区的全高抽屉且可输入（移动端核心是与 agent 交互）；
//   ④ 编辑器默认只读、可显式切编辑，切回桌面口径不受影响（本 spec 不覆盖后者，
//      由 activity-bar-drag / 布局邻域 spec 守桌面形态）。
test.describe('窄屏工作区单栏形态', () => {
  test.use({ viewport: { width: 390, height: 844 } })

  async function openProject(page: Page): Promise<void> {
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await expect(page.locator('.ide-rail')).toBeVisible()
  }

  /** 侧栏归一化为「files 视图开启」：面板开关是 toggle，uiState 跨用例恢复态不定 */
  async function ensureFilesDrawer(page: Page): Promise<void> {
    const railFiles = page.locator('[data-testid="rail-files"]')
    for (let i = 0; i < 3; i++) {
      if (await railFiles.evaluate(el => el.classList.contains('active')).catch(() => false)) break
      await railFiles.click()
      await page.waitForTimeout(200)
    }
    await expect(railFiles).toHaveClass(/active/, { timeout: 5000 })
    await expect(page.locator('#side-panel')).toBeVisible()
  }

  async function closeBottomPanel(page: Page): Promise<void> {
    if (await page.locator('[data-testid="bottom-panel"]').isVisible().catch(() => false)) {
      await page.locator('[data-testid="bottom-panel-close"]').click()
      await expect(page.locator('[data-testid="bottom-panel"]')).toBeHidden()
    }
  }

  async function unlockHeaders(page: Page): Promise<Record<string, string>> {
    // 令牌在 HttpOnly cookie（P-20261019-2）：页面读不到，经 context.cookies() 取
    const token = await getLockToken(page)
    return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  }

  async function listShellSessions(request: APIRequestContext, headers: Record<string, string>) {
    const res = await request.get(`${API_BASE}/api/terminals`, { headers })
    const body = (await res.json().catch(() => null)) as { data?: Array<{ id: string; kind?: string }> } | null
    return (body?.data || []).filter(s => s.kind === 'shell')
  }

  test('页面零横向溢出，顶栏低频按钮收进「更多」，活动栏在底部', async ({ page }) => {
    await openProject(page)

    // ① 文档零横向溢出（1px 容差给亚像素取整）；旧布局此处为 770px
    await expect.poll(() => page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )).toBeLessThanOrEqual(1)

    // 活动栏在底部（单栏主区 + 底部切换器）：容器顶边落在下半屏
    const railBox = await page.locator('.ide-rail').boundingBox()
    expect(railBox, '活动栏应有布局盒').not.toBeNull()
    expect(railBox!.y).toBeGreaterThan(844 * 0.8)
    expect(railBox!.width).toBeGreaterThan(390 * 0.95)

    // ② 顶栏远程动作组（旧版被裁出屏外）已隐藏，入口在「更多」菜单里
    await expect(page.locator('.header-btn-group')).toBeHidden()
    const moreBtn = page.locator('[data-testid="topbar-more"]')
    await expect(moreBtn).toBeVisible()
    await moreBtn.click()
    const menu = page.locator('.n-dropdown-menu').last()
    await expect(menu).toBeVisible()
    for (const label of ['获取', '拉取', '推送']) {
      await expect(menu.getByText(label, { exact: true })).toBeVisible()
    }
    // 菜单自身也在视口内（长文案曾把下拉撑到 472px 宽、横向溢出）
    const menuBox = await menu.boundingBox()
    expect(menuBox, '下拉应有布局盒').not.toBeNull()
    expect(menuBox!.x).toBeGreaterThanOrEqual(0)
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(391)
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
  })

  test('侧栏为抽屉：遮罩不挡底栏切换器，选中文件自动收起', async ({ page }) => {
    await openProject(page)
    await closeBottomPanel(page)
    await ensureFilesDrawer(page)

    // 遮罩下缘让出 52px 底部切换器：drawer 打开时仍可直接点终端/文件
    const maskBox = await page.locator('[data-testid="side-drawer-mask"]').boundingBox()
    const railBox = await page.locator('.ide-rail').boundingBox()
    expect(maskBox, '遮罩应有布局盒').not.toBeNull()
    expect(railBox, '活动栏应有布局盒').not.toBeNull()
    expect(maskBox!.y + maskBox!.height).toBeLessThanOrEqual(railBox!.y + 1)

    // 选中文件即收起抽屉，把主区让给编辑器
    await page.locator('.file-tree .item-name', { hasText: 'README.md' }).first().click()
    await expect(page.locator('#side-panel')).toBeHidden({ timeout: 5000 })
    await expect(page.locator('.editor-tab.active')).toContainText('README.md')
  })

  test('编辑器窄屏默认只读，可切换编辑', async ({ page }) => {
    await openProject(page)
    await closeBottomPanel(page)
    await ensureFilesDrawer(page)
    await page.locator('.file-tree .item-name', { hasText: 'README.md' }).first().click()
    await expect(page.locator('.editor-tab.active')).toContainText('README.md')

    // README 默认可能落在 markdown split；切「源码」确保 Monaco 是交互面
    const sourceBtn = page.locator('.md-mode-btn').filter({ hasText: '源码' }).first()
    if (await sourceBtn.isVisible().catch(() => false)) {
      await sourceBtn.click()
      await expect(sourceBtn).toHaveClass(/active/)
    }
    await expect(page.locator('.monaco-editor .view-lines')).toBeVisible({ timeout: 15000 })

    const bar = page.locator('[data-testid="narrow-editor-bar"]')
    const toggle = page.locator('[data-testid="narrow-editor-mode-toggle"]')
    await expect(bar).toContainText('窄屏默认只读')
    await expect(toggle).toContainText('开始编辑')

    // 只读态键入不落字：内容不含标记，且无未保存脏点
    const marker = `SCNARROW${Date.now()}`
    await page.locator('.monaco-editor').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(marker)
    await expect(page.locator('.monaco-editor .view-lines')).not.toContainText(marker)
    await expect(page.locator('.tab-dot')).toHaveCount(0)

    // 切编辑后可键入，随后撤销保持工作区干净
    await toggle.click()
    await expect(bar).toContainText('编辑中')
    await expect(toggle).toContainText('切换只读')
    await page.locator('.monaco-editor').click()
    await page.keyboard.press('Control+End')
    await page.keyboard.type(marker)
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(marker, { timeout: 5000 })
    await expect(page.locator('.tab-dot')).toHaveCount(1)
    await page.keyboard.press('Control+z')
    await expect(page.locator('.tab-dot')).toHaveCount(0)

    // 收尾：关闭 tab，避免把打开集留给后续用例
    await page.locator('.editor-tab.active .tab-close').click()
  })

  test('终端为覆盖主区的全高抽屉且可输入', async ({ page, request }) => {
    test.setTimeout(120000)
    await openProject(page)
    const headers = await unlockHeaders(page)
    const before = new Set((await listShellSessions(request, headers)).map(s => s.id))

    try {
      await closeBottomPanel(page)
      await page.locator('[data-testid="rail-terminal"]').click()
      const panel = page.locator('[data-testid="bottom-panel"]')
      await expect(panel).toBeVisible()

      // 覆盖主区：宽度≈视口、高度显著大于旧 260px 停靠条
      const panelBox = await panel.boundingBox()
      expect(panelBox, '终端面板应有布局盒').not.toBeNull()
      expect(panelBox!.x).toBeLessThanOrEqual(1)
      expect(panelBox!.width).toBeGreaterThanOrEqual(389)
      expect(panelBox!.height).toBeGreaterThan(600)

      const newTerminal = panel.getByRole('button', { name: '新建终端' }).first()
      if (await newTerminal.isVisible().catch(() => false)) await newTerminal.click()
      const xterm = page.locator('.xterm').last()
      await expect(xterm).toBeVisible({ timeout: 20000 })

      const marker = `SC-NARROW-${Date.now()}`
      await xterm.click()
      await page.keyboard.type(`echo ${marker}\r`)
      await expect(xterm).toContainText(marker, { timeout: 15000 })

      // 关闭即回编辑器（终端/编辑器二选一）
      await page.locator('[data-testid="bottom-panel-close"]').click()
      await expect(panel).toBeHidden()
    } finally {
      // 清理本用例新建的 shell 会话（不删除种子/他人会话）
      const after = await listShellSessions(request, headers)
      for (const s of after) {
        if (!before.has(s.id)) {
          await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
        }
      }
    }
  })
})
