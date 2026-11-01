import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端输出导出的出域审计（P-20261005-186）E2E：
 *   1. API 建 shell 会话 → GET /api/terminals/:id/export 附件直出 → 审计台账
 *      出现 terminal.export 事件（Detail 含会话名与 id；Append 同步入账，轮询
 *      只为台账读取面留缓冲）；404/敏感闸 warnings 分支零入账由 Go 单测覆盖
 *      （terminal_export_test.go）。
 *   2. patch.export 同账顺带验证：POST /api/projects/:id/patch/export 后台账
 *      出现 patch.export（Detail 含项目名）。
 *   3. 审计面板可见（share-view-audit 同链）：设置·安全·审计日志行含会话名。
 * 共享实例串行（workers=1）；会话为全局状态，afterEach 清理本 spec 创建的会话。
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'

let createdSessionId = ''

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJECT_NAME)
  if (!p) throw new Error(`project ${PROJECT_NAME} not found`)
  return p.id
}

type AuditEvent = { action: string; detail?: string; result: string }

/** 轮询审计台账直至出现匹配动作 + Detail 片段的事件（同步入账，轮询防读取竞态） */
async function waitAudit(
  request: APIRequestContext,
  headers: Record<string, string>,
  action: string,
  detailFragment: string,
): Promise<AuditEvent> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const res = await request.get(`${BASE}/api/audit?limit=500`, { headers })
    const events = ((await res.json()) as { data?: AuditEvent[] }).data || []
    const hit = events.find(e => e.action === action && (e.detail || '').includes(detailFragment))
    if (hit) return hit
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`${action} audit with detail ~ "${detailFragment}" never appeared within 15s`)
}

async function openAuditPane(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审计日志' }).click()
  await expect(page.getByTestId('audit-pane')).toBeVisible({ timeout: 5000 })
}

test.afterEach(async ({ request }) => {
  if (!createdSessionId) return
  const headers = await unlockHeaders(request)
  await request.delete(`${BASE}/api/terminals/${createdSessionId}`, { headers })
  createdSessionId = ''
})

test('终端输出导出 → 审计台账 terminal.export + 面板条目；patch.export 同账', async ({ page, request }) => {
  test.setTimeout(90_000)
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const sessionName = `sc-exp-audit-${Date.now()}`

  // API 直建 shell 会话（broadcast spec 同款），拿响应回告的权威 id
  const created = await request.post(`${BASE}/api/terminals`, {
    headers,
    data: { projectId, name: sessionName },
  })
  expect(created.ok()).toBeTruthy()
  const session = (((await created.json()) as { data?: { id: string } }).data)
  expect(session?.id, 'session created').toBeTruthy()
  createdSessionId = session!.id

  // 导出直出：附件响应（审计在出域段同步落账）
  const exp = await request.get(`${BASE}/api/terminals/${session!.id}/export`, { headers })
  expect(exp.status(), 'export must succeed').toBe(200)
  expect(exp.headers()['content-disposition'] || '').toContain('attachment')

  // 审计台账：terminal.export 一条，Detail = 会话名 (id, N bytes)
  const ev = await waitAudit(request, headers, 'terminal.export', sessionName)
  expect(ev.detail).toContain(session!.id)
  expect(ev.result).toBe('success')

  // patch.export 同账：POST /patch/export（工作区态，内容可空——出域口入账
  // 与内容多少无关；补丁本体两个出域口的 Detail scope 词汇对账由 Go 单测覆盖）
  const patch = await request.post(`${BASE}/api/projects/${projectId}/patch/export`, {
    headers,
    data: {},
  })
  expect(patch.ok()).toBeTruthy()
  const pev = await waitAudit(request, headers, 'patch.export', PROJECT_NAME)
  expect(pev.result).toBe('success')

  // 审计面板可见：进项目 → 设置·安全·审计日志，行含会话名
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await openAuditPane(page)
  const row = page.locator('[data-testid="audit-pane"] .n-data-table-tr').filter({ hasText: sessionName })
  await expect(row.first()).toBeVisible({ timeout: 5000 })
})
