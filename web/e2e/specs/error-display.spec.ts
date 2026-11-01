import { test, expect } from '@playwright/test'
import { fixedLocale, unlockIfNeeded, waitForAppReady, projectCardByName } from '../../tests/helpers'

/**
 * 错误展示功能 E2E 测试
 *
 * 覆盖 Task 1-16 引入的错误处理改造：
 * - 网络错误时弹出友好 toast + 「查看详情」按钮
 * - 点击「查看详情」打开 Console tab + 切到「错误」子标签
 * - silent 请求失败时不弹 toast
 *
 * 关键约束：useErrorDisplayInit 仅在 Layout.vue（/project 路由）挂载，
 * 因此测试需要先进入项目页面，触发 fetchProjects 错误时才能拿到 message API。
 * 项目卡片在 HomeView 中以 .project-card 渲染（is-recent 类仅在 localStorage 有记录时附加）。
 */

async function enterFirstProject(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/')
  await page.waitForSelector('body')
  // 锁定开关被其他 spec 切换时状态不定——统一容忍两种状态
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await page.waitForSelector('.project-card', { timeout: 8000 })
  // 点击确定目标（simple-coding）而非第一个卡片：项目集合变化（如 perf 注册）
  // 会改变「第一个卡片」的身份，其 uiState 持久化会串扰后续 spec 的启动恢复
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project', { timeout: 10000 })
}

test.describe('错误展示', () => {
  test.beforeEach(async ({ page }) => {
    await fixedLocale(page)
    await enterFirstProject(page)
  })

  test('网络错误时弹出友好 toast 与「查看详情」按钮', async ({ page }) => {
    // 在 reload 之前注册 route，确保拦截生效
    await page.route('**/api/projects', route => route.abort('failed'))

    // 重新加载触发 Layout onMounted → fetchProjects
    await page.reload()

    // 友好提示出现（zh-CN: errors.network = "网络连接异常，请检查服务是否启动"）
    await expect(page.getByText('网络连接异常').first()).toBeVisible({ timeout: 10000 })

    // 「查看详情」按钮可见（zh-CN: errors.toastViewDetail = "查看详情"）
    await expect(page.getByText('查看详情').first()).toBeVisible({ timeout: 5000 })
  })

  test('点击「查看详情」打开底部 Console 面板', async ({ page }) => {
    // 同样拦截出网络错误
    await page.route('**/api/projects', route => route.abort('failed'))
    await page.reload()

    // 等待 toast 出现
    const detailBtn = page.getByText('查看详情').first()
    await expect(detailBtn).toBeVisible({ timeout: 10000 })

    // 点击「查看详情」→ 底部面板展开
    await detailBtn.click()

    // 底部面板可见
    await expect(page.locator('.bottom-panel')).toBeVisible({ timeout: 5000 })

    // 注：项目列表加载失败时 currentProjectId 为空，ConsoleView 显示空态，
    // 此时 .sub-tab 与 .log-row 不会渲染。仅验证底部面板打开行为。
  })

  test('silent 请求失败时不弹 toast', async ({ page }) => {
    // 后台轮询请求（如 ahead-behind、settings.get）走 silent 模式
    // 拦截 ahead-behind 接口模拟 500
    await page.route('**/api/projects/*/ahead-behind', route =>
      route.fulfill({ status: 500, body: JSON.stringify({ error: 'server down' }) })
    )

    // 等待可能的后台轮询触发（默认 autoFetch 周期 + 防 500ms）
    await page.waitForTimeout(3000)

    // 不应该出现「服务器异常」友好提示
    // zh-CN: errors.server = "服务器异常，请稍后重试或查看日志"
    // 只查 toast 容器：提交列表等页面正文可能渲染包含同字面量的提交信息
    await expect(
      page.locator('.n-message-container').getByText('服务器异常'),
    ).toHaveCount(0)
  })
})
