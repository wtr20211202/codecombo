import { test, expect, type Page, type Locator } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

// 文件树触屏长按（P-20261003-137）：触屏无右键，树行长按 500ms 复用既有右键
// 菜单流（useFileTreeContext 全量菜单）。桌面右键回归在 file-tree-context.spec，
// 本 spec 只守长按手势面：到时出菜单 / 移动超阈值不误触发 / 快速点按不触发。
// 探针用仓库自带行（README.md 文件 + docs 目录），只开菜单不开破坏性动作，
// 零播种零残留。

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

async function enterProject(page: Page) {
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——奇数次点击保证最终打开
  for (let i = 0; i < 3; i++) {
    if (await page.getByText('README.md').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

// 模拟触屏长按：合成 PointerEvent（pointerType=touch）。合成事件不产生原生
// click/原生滚动，手势各段（down/move/up）按用例需要逐一显式派发——正好把
// 「长按后浏览器补发 click」与手势判定解耦，纯守计时/取消逻辑。
// 事件派发在 elementFromPoint 命中的行内子元素（.item-name 等）上冒泡到
// .tree-item（行 @pointerdown 挂行元素，与真实触屏目标路径同形）。
async function touchDown(page: Page, row: Locator) {
  const box = await row.boundingBox()
  if (!box) throw new Error('tree item 不可定位')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.evaluate(({ x: px, y: py }) => {
    const el = document.elementFromPoint(px, py) as HTMLElement
    el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: px, clientY: py,
    }))
  }, { x, y })
}

async function touchUp(page: Page, row: Locator) {
  const box = await row.boundingBox()
  if (!box) throw new Error('tree item 不可定位')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.evaluate(({ x: px, y: py }) => {
    const el = document.elementFromPoint(px, py) as HTMLElement
    el.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: px, clientY: py,
    }))
  }, { x, y })
}

// window 级 pointermove（组合式收听挂 window，滑出行元素仍可达）
async function touchMoveBy(page: Page, dx: number, dy: number) {
  await page.evaluate(({ x: jx, y: jy }) => {
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, pointerType: 'touch', pointerId: 1, isPrimary: true, clientX: jx, clientY: jy,
    }))
  }, { x: dx, y: dy })
}

test.describe('文件树触屏长按', () => {
  test('长按目录行 → 右键同款全量菜单（触屏无右键的保底入口）', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const dir = itemByName(page, 'docs')
    await expect(dir).toBeVisible({ timeout: 5000 })
    await touchDown(page, dir)
    // 未满时长不触发（计时器在走，不是 hover 即弹）
    await page.waitForTimeout(200)
    await expect(page.locator('.n-dropdown-menu')).toHaveCount(0)
    await page.waitForTimeout(500)

    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()
    // 全量项抽查（目录形态）：文件操作 / agent 与终端 / 分享导出 / 删除殿后 各组代表
    for (const label of ['新建文件', '重命名', '在终端中打开', '在此目录新建 agent 会话', '生成分享链接', '下载为 zip', '删除']) {
      await expect(menu.getByText(label, { exact: true })).toBeVisible()
    }
  })

  test('长按文件行 → 菜单选重命名 → 内联输入预填旧名（复用既有流全链路）', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const readme = itemByName(page, 'README.md')
    await expect(readme).toBeVisible({ timeout: 5000 })
    await touchDown(page, readme)
    await page.waitForTimeout(700)
    await touchUp(page, readme)

    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()
    await menu.getByText('重命名', { exact: true }).click()
    // 内联重命名预填旧名（useFileTreeContext.startRename 同链路）
    const inlineInput = page.locator('.inline-input-row input')
    await expect(inlineInput).toBeVisible()
    await expect(inlineInput).toHaveValue('README.md')
    // Escape 取消，不改名（spec 零残留）
    await inlineInput.press('Escape')
    await expect(page.locator('.inline-input-row')).toHaveCount(0)
  })

  test('移动超阈值取消：滚动/拖拽不误触发菜单', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const readme = itemByName(page, 'README.md')
    await expect(readme).toBeVisible({ timeout: 5000 })
    await touchDown(page, readme)
    // 起滚即大幅位移（> LONG_PRESS_CANCEL_PX 10px）→ 计时取消
    await touchMoveBy(page, 60, 40)
    await page.waitForTimeout(900)
    await touchUp(page, readme)
    await expect(page.locator('.n-dropdown-menu')).toHaveCount(0)
  })

  test('快速点按（<500ms）不触发菜单', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const readme = itemByName(page, 'README.md')
    await expect(readme).toBeVisible({ timeout: 5000 })
    await touchDown(page, readme)
    await page.waitForTimeout(150)
    await touchUp(page, readme)
    await page.waitForTimeout(700)
    await expect(page.locator('.n-dropdown-menu')).toHaveCount(0)
  })
})
