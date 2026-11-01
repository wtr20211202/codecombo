import { test, expect } from '@playwright/test'
import { fixedLocale, unlockIfNeeded, waitForAppReady } from '../../tests/helpers'

/**
 * 渲染错误兜底「白屏保险丝」E2E（P-20261002-26）
 *
 * 覆盖：
 * - ?__crash=1（本机守卫：e2e 实例走 127.0.0.1，钩子激活）渲染必抛组件，
 *   连续错误达阈值（3 次/10s）后出现降级页
 * - 降级页「复制详情」按钮可交互（headless 剪贴板权限不定，只验交互不崩）
 * - 降级页「回首页」→ 保险丝复位 + 路由跳转成功，应用壳恢复正常渲染
 * - 常规进入（无 __crash 参数）不出现降级页
 *
 * 守卫说明：e2e 走 go:embed 生产构建，钩子守卫是主机名（localhost/127.0.0.1）
 * 而非 import.meta.env.DEV；远端实例经非本机地址访问时探针不激活（无法在
 * e2e 内模拟非本机主机名，该分支由代码审查保障）。
 */

test.describe('渲染错误兜底（白屏保险丝）', () => {
  test('?__crash=1 触发降级页，回首页恢复应用壳', async ({ page }) => {
    await fixedLocale(page)
    await page.goto('/?__crash=1')

    const fallback = page.locator('.crash-fallback')
    // 必抛组件经 :key 重挂载连续抛错，阈值判定确定性触发（毫秒级完成）
    await expect(fallback).toBeVisible({ timeout: 15000 })
    await expect(fallback.locator('.crash-title')).toHaveText('页面渲染出现异常')

    // 复制详情可点击（不崩即可；剪贴板内容受 headless 权限影响不强断言）
    await fallback.getByRole('button', { name: '复制详情' }).click()

    // 回首页：保险丝复位 + 路由跳转成功（__crash 查询参数被剥离）
    await fallback.getByRole('button', { name: '回首页' }).click()
    await page.waitForURL(url => url.pathname === '/' && !url.searchParams.has('__crash'), { timeout: 10000 })
    await expect(fallback).toHaveCount(0)

    // 应用壳恢复正常渲染（实例可能带锁，先解锁再验首页）
    await waitForAppReady(page)
    await unlockIfNeeded(page)
    await expect(page.locator('.home-root')).toBeVisible({ timeout: 15000 })
  })

  test('常规进入不出现降级页', async ({ page }) => {
    await fixedLocale(page)
    await page.goto('/')
    await waitForAppReady(page)
    await expect(page.locator('.crash-fallback')).toHaveCount(0)
  })
})
