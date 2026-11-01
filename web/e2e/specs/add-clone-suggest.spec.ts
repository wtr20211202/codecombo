import { test, expect, type Page, type Locator } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 本地 tab 粘贴 URL 的克隆建议（P-20261003-170）：
 *   - 「本地路径」tab 粘贴远程 URL 形态 → 行内建议条出现
 *   - 一键「切换到克隆」：切 tab + 预填 URL + 名称按剥 .git 推断
 *   - 本地路径粘贴不触发（协议前缀/SCP 锚定防误报）
 *   - 「忽略」可关闭不强制，再次粘贴重新提示
 * 纯前端行为，无服务端状态写入；粘贴以 dispatchEvent + clipboardData 假体模拟
 * （不依赖 Chromium ClipboardEvent 构造器对初始化参数的支持，与单测同构）；
 * fill 镜像粘贴文本落入输入框的默认行为（组件不 preventDefault）。
 */

const GIT_URL = 'https://github.com/user/repo.git'
const LOCAL_PATH = 'D:/workspace/go/my-project'

/** 往输入框派发 paste 事件（clipboardData 假体，文本不会真实落入输入框） */
async function paste(locator: Locator, text: string) {
  await locator.evaluate((el, t) => {
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: { getData: () => t } })
    el.dispatchEvent(ev)
  }, text)
}

async function openAddDialog(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.getByRole('button', { name: '添加项目' }).first().click()
  const modal = page.locator('.n-modal').filter({ hasText: '添加项目' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  return modal
}

test('粘贴 URL → 建议条出现 → 一键切换到克隆并预填', async ({ page }) => {
  const modal = await openAddDialog(page)
  const suggest = modal.locator('[data-testid="clone-suggest"]')
  await expect(suggest).toHaveCount(0)

  // 路径框粘贴 URL：fill 镜像粘贴文本真实落入输入框，paste 触发检测
  const pathInput = modal.locator('input').first()
  await pathInput.fill(GIT_URL)
  await paste(pathInput, GIT_URL)
  await expect(suggest).toBeVisible()
  await expect(suggest).toContainText('检测到 Git 地址')

  // 一键切换：克隆 tab 激活、URL 预填、名称按剥 .git 推断为 repo
  await modal.locator('[data-testid="clone-suggest-switch"]').click()
  await expect(modal.locator('input[placeholder*="https://github.com"]')).toHaveValue(GIT_URL)
  await expect(modal.locator('input[placeholder="留空自动从路径推断"]')).toHaveValue('repo')

  // 建议条已收；切回本地 tab：来源路径框整格恰为粘贴内容 → 已清
  // （naive-ui n-tabs 的 tab 元素无 role=tab，按 .n-tabs-tab 文本定位）
  await expect(suggest).toHaveCount(0)
  await modal.locator('.n-tabs-tab').filter({ hasText: '本地路径' }).click()
  await expect(modal.locator('input').first()).toHaveValue('')
})

test('本地路径粘贴不触发建议（防误报），URL 形态才触发', async ({ page }) => {
  const modal = await openAddDialog(page)
  const pathInput = modal.locator('input').first()
  await pathInput.fill(LOCAL_PATH)
  await paste(pathInput, LOCAL_PATH)
  await expect(modal.locator('[data-testid="clone-suggest"]')).toHaveCount(0)

  // 同一输入框换贴 URL 立即触发——排除「harness 失效导致的不触发」假阳性
  await paste(pathInput, GIT_URL)
  await expect(modal.locator('[data-testid="clone-suggest"]')).toBeVisible()
})

test('「忽略」可关闭不强制：粘贴内容保留，再次粘贴重新提示', async ({ page }) => {
  const modal = await openAddDialog(page)
  const suggest = modal.locator('[data-testid="clone-suggest"]')
  const pathInput = modal.locator('input').first()
  await pathInput.fill(GIT_URL)
  await paste(pathInput, GIT_URL)
  await expect(suggest).toBeVisible()

  await modal.locator('[data-testid="clone-suggest-dismiss"]').click()
  await expect(suggest).toHaveCount(0)
  // 仍在本地 tab，粘贴内容未被强改——忽略即继续本地流程
  await expect(pathInput).toHaveValue(GIT_URL)

  // 再次粘贴 = 新信号，重新提示
  await paste(pathInput, GIT_URL)
  await expect(suggest).toBeVisible()
})
