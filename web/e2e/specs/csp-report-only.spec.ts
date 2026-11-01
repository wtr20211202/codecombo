import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * CSP Report-Only 观察期 E2E（P-20261007-6）：
 *   1. 主应用响应（SPA 文档 + API）带 Content-Security-Policy-Report-Only，
 *      策略含初版指令与 report-uri /api/csp-report；不得出现 enforcing 的
 *      Content-Security-Policy（本阶段零拦截）；
 *   2. 报告端点公开可投递（浏览器上报不带应用凭据，锁定态也不得 423）；
 *   3. Report-Only 不破坏主界面（真实页面加载 + 首页渲染）。
 * 违规聚合入账的精确断言在 Go 单测（cspreport_test.go）——e2e 的浏览器
 * 本身也会自动产生报告，聚合窗口不受用例控制，不在端到端层赌时序。
 */

test.beforeEach(async ({ page }) => {
  await fixedLocale(page)
})

test('主应用响应带 CSP Report-Only 初版策略，且无 enforcing CSP', async ({ request }) => {
  // 文档面（SPA 入口）与 API 面都经全局安全头中间件
  for (const path of ['/', '/api/health']) {
    const res = await request.get(`${API_BASE}${path}`)
    expect(res.status()).toBe(200)

    const headers = res.headers()
    const policy = headers['content-security-policy-report-only'] || ''
    expect(policy, `${path} missing Report-Only CSP`).toContain("default-src 'self'")
    expect(policy, `${path} missing script-src`).toContain("script-src 'self'")
    expect(policy, `${path} missing report-uri`).toContain('report-uri /api/csp-report')
    expect(policy, `${path} missing report-to`).toContain('report-to csp-endpoint')
    expect(headers['reporting-endpoints'] || '').toContain('csp-endpoint="/api/csp-report"')
    // 只观察不拦截：主应用不得下发 enforcing CSP
    expect(headers['content-security-policy'] || '').toBe('')
  }
})

test('CSP 报告端点公开可投递（无应用凭据不 423/401）', async ({ request }) => {
  const body = JSON.stringify({
    'csp-report': {
      'document-uri': `${API_BASE}/`,
      'effective-directive': 'script-src',
      'blocked-uri': 'https://report-only-e2e.example/blocked.js',
    },
  })
  const res = await request.post(`${API_BASE}/api/csp-report`, {
    headers: { 'Content-Type': 'application/csp-report' },
    data: body,
  })
  // 限流命中（浏览器自身报告可能消耗配额）也证明端点公开可达；锁定门是 423，
  // 应用鉴权是 401/403——这两类出现即回归
  expect([204, 429]).toContain(res.status())
})

test('Report-Only 零拦截：首屏正常渲染', async ({ page }) => {
  await gotoAndUnlock(page, '/')
  await expect(page).toHaveTitle(/Codecombo$/)
  await expect(page.getByRole('button', { name: '添加项目' })).toBeVisible()
})
