import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话敏感标记与出域警示 E2E（P-20261003-155）：AgentSessionMeta.sensitive
 * 人工策展的安全标注——导出/分享命中时服务端拦第一跳（warnings），前端确认
 * 后带 override 二次请求放行；本地检索不受限（标记只管出域）。
 *   1. 导出闸门 API 链路：未标记直出附件（现状零变化）→ 标记后无 override
 *      出 JSON warnings（零附件头）→ override=1 直出 → 快照携 sensitive
 *   2. 本地检索不受影响：跨会话输出检索（terminals/search）照常命中敏感会话
 *   3. 直播分享闸门 API 链路：未确认不创建只回 warnings → override 创建成功
 *   4. UI 链路：tab 右键「标记敏感」→ 「导出输出」弹「确认出域」→ 确认后
 *      下载含已知输出行；取消敏感标记后导出不再弹警示
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || API_BASE
const PROJECT_NAME = 'simple-coding'
const API_MARK = 'SC-E2E-SENS-EGRESS-155'
const UI_MARK = 'SC-E2E-SENS-UI-155'
const DL_DIR = path.join(os.tmpdir(), 'sc-e2e-terminal-sensitive-egress')

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function createTerminal(request: APIRequestContext, headers: Record<string, string>, name: string): Promise<string> {
  const projects = await request.get(`${BASE}/api/projects`, { headers })
  const list = ((await projects.json()) as { data?: { id: string; name: string }[] }).data || []
  const projectId = list.find(x => x.name === PROJECT_NAME)?.id
  if (!projectId) throw new Error(`project ${PROJECT_NAME} not found`)
  const res = await request.post(`${BASE}/api/terminals`, { headers, data: { projectId, name } })
  expect(res.ok()).toBeTruthy()
  const data = ((await res.json()) as { data?: { id?: string } }).data
  if (!data?.id) throw new Error('terminal id missing')
  return data.id
}

test('导出闸门 API 链路：未标记直出 → 标记后拦第一跳 → override 直出 + 快照携标记', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const sessionId = await createTerminal(request, headers, 'e2e-sen-egress')
  try {
    // 回显唯一标记（后续导出体与检索断言共用）
    const wr = await request.post(`${BASE}/api/terminals/broadcast-write`, {
      headers, data: { ids: [sessionId], data: `echo ${API_MARK}\r` },
    })
    expect(wr.ok()).toBeTruthy()

    // 未标记直出：附件头 + 200（现状零变化；轮询等 PTY 回显落进服务端缓冲）
    let body = ''
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500))
      const res = await request.get(`${BASE}/api/terminals/${sessionId}/export`, { headers })
      expect(res.status()).toBe(200)
      body = await res.text()
      if (body.includes(API_MARK)) break
    }
    expect(body).toContain(API_MARK)

    // 标记敏感：200 落库，快照携 sensitive（缺 key = 未标记契约）
    const mark = await request.post(`${BASE}/api/terminals/${sessionId}/sensitive`, { headers, data: { sensitive: true } })
    expect(mark.ok()).toBeTruthy()
    const list = await request.get(`${BASE}/api/terminals`, { headers })
    const sessions = ((await list.json()) as { data?: { id: string; sensitive?: boolean }[] }).data || []
    expect(sessions.find(s => s.id === sessionId)?.sensitive).toBe(true)

    // 标记后无 override：JSON warnings（stable token），零附件头——不出附件
    const gated = await request.get(`${BASE}/api/terminals/${sessionId}/export`, { headers })
    expect(gated.status()).toBe(200)
    expect(gated.headers()['content-disposition'] || '').toBe('')
    const gatedBody = (await gated.json()) as { warnings?: string[] }
    expect(gatedBody.warnings).toEqual(['sensitive-session'])

    // override=1：确认后直出附件
    const allowed = await request.get(`${BASE}/api/terminals/${sessionId}/export?override=1`, { headers })
    expect(allowed.status()).toBe(200)
    expect(allowed.headers()['content-disposition'] || '').toContain('attachment')
    expect(await allowed.text()).toContain(API_MARK)
  } finally {
    await request.delete(`${BASE}/api/terminals/${sessionId}`, { headers })
  }
})

test('本地检索不受影响：跨会话输出检索照常命中敏感会话', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const sessionId = await createTerminal(request, headers, 'e2e-sen-search')
  try {
    const wr = await request.post(`${BASE}/api/terminals/broadcast-write`, {
      headers, data: { ids: [sessionId], data: `echo ${API_MARK}\r` },
    })
    expect(wr.ok()).toBeTruthy()
    await request.post(`${BASE}/api/terminals/${sessionId}/sensitive`, { headers, data: { sensitive: true } })

    // 标记只管出域：检索面零变化（q≥2 子串，命中带会话归属；data 为扁平命中数组）
    let hit = false
    for (let i = 0; i < 20 && !hit; i++) {
      await new Promise(r => setTimeout(r, 500))
      const res = await request.get(`${BASE}/api/terminals/search?q=${API_MARK}`, { headers })
      expect(res.ok()).toBeTruthy()
      const out = (await res.json()) as { data?: { sessionId: string }[] }
      hit = (out.data ?? []).some(h => h.sessionId === sessionId)
    }
    expect(hit).toBe(true)
  } finally {
    await request.delete(`${BASE}/api/terminals/${sessionId}`, { headers })
  }
})

test('直播分享闸门 API 链路：未确认不创建只回 warnings → override 创建成功', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const sessionId = await createTerminal(request, headers, 'e2e-sen-live')
  try {
    await request.post(`${BASE}/api/terminals/${sessionId}/sensitive`, { headers, data: { sensitive: true } })

    // 未确认：响应无 data 只带 warnings（稳定 token），分享记录未创建
    const blocked = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(blocked.ok()).toBeTruthy()
    const blockedBody = (await blocked.json()) as { data?: unknown; warnings?: string[] }
    expect(blockedBody.data).toBeUndefined()
    expect(blockedBody.warnings).toEqual(['sensitive-session'])
    const shares = await request.get(`${BASE}/api/share`, { headers })
    const shareList = ((await shares.json()) as { data?: { terminalId?: string }[] }).data || []
    expect(shareList.some(s => s.terminalId === sessionId)).toBe(false)

    // override：确认后创建成功（kind=terminal）
    const allowed = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId, override: true } })
    expect(allowed.ok()).toBeTruthy()
    const created = ((await allowed.json()) as { data?: { token: string; kind: string; terminalId: string } }).data
    expect(created?.kind).toBe('terminal')
    expect(created?.terminalId).toBe(sessionId)
    // 清场：撤销测试直播
    await request.delete(`${BASE}/api/share/${created!.token}`, { headers })
  } finally {
    await request.delete(`${BASE}/api/terminals/${sessionId}`, { headers })
  }
})

test('侧栏链路：会话行右键「标记敏感」→ 角标常显；「取消敏感标记」→ 角标消失', async ({ page }) => {
  test.setTimeout(90_000)
  const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
  // 清场：历史失败运行泄漏的同名会话先删（按名对账，确定性）
  const list = await page.request.get(`${BASE}/api/terminals`, { headers })
  const existing = ((await list.json()) as { data?: { id: string; name: string }[] }).data || []
  for (const s of existing.filter(s => s.name === 'e2e-sen-sidebar')) {
    await page.request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
  // agent 会话经 API 直建 kind=agent + runtime=shell（一等选项，agent-review-baseline 同惯例）
  const res = await page.request.post(`${BASE}/api/terminals`, {
    headers, data: { kind: 'agent', name: 'e2e-sen-sidebar', runtime: 'shell' },
  })
  expect(res.ok()).toBeTruthy()
  const sessionId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(sessionId).not.toBe('')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/project`)
  // 打开终端会话管理页（docked）：打开即拉全量列表，API 预建的会话行可见
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10_000 })
  const row = view.locator('.ats-item').filter({ hasText: 'e2e-sen-sidebar' })
  await expect(row).toHaveCount(1, { timeout: 10_000 })
  await expect(row.locator('[data-test="session-sensitive-badge"]')).toHaveCount(0)

  try {
    // 行右键 → 「标记敏感」→ 成功 toast + 警示角标常显（导出/分享出域一眼可辨）
    await row.click({ button: 'right' })
    const markOpt = page.locator('.n-dropdown-option-body').filter({ hasText: '标记敏感' })
    await expect(markOpt).toBeVisible({ timeout: 5000 })
    await markOpt.click()
    await expect(page.locator('.n-message').filter({ hasText: '已标记为敏感会话' })).toBeVisible({ timeout: 5000 })
    await expect(row.locator('[data-test="session-sensitive-badge"]')).toBeVisible({ timeout: 5000 })

    // 重开菜单文案翻转（store 本地回写即时生效），取消后角标消失
    await row.click({ button: 'right' })
    const unmarkOpt = page.locator('.n-dropdown-option-body').filter({ hasText: '取消敏感标记' })
    await expect(unmarkOpt).toBeVisible({ timeout: 5000 })
    await unmarkOpt.click()
    await expect(page.locator('.n-message').filter({ hasText: '已取消敏感标记' })).toBeVisible({ timeout: 5000 })
    await expect(row.locator('[data-test="session-sensitive-badge"]')).toHaveCount(0, { timeout: 5000 })
  } finally {
    await page.request.delete(`${BASE}/api/terminals/${sessionId}`, { headers })
  }
})

test('UI 链路：标记敏感 → 导出弹「确认出域」→ 确认下载；取消标记后直出', async ({ page }) => {
  test.setTimeout(90_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')

  // 归一化：底部终端面板可见（面板开合是 uiState 持久态，随跑序而异）
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }

  // 新建终端并等待 shell 就绪，输入唯一标记
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(2500)
  await page.locator('.xterm-screen:visible').last().click()
  await page.keyboard.type(`echo ${UI_MARK}`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)

  // tab 右键 → 「标记敏感」→ 成功 toast；重开菜单文案翻转为「取消敏感标记」
  const tab = page.locator('.term-tab').last()
  await tab.click({ button: 'right' })
  const markItem = page.locator('[data-testid="terminal-mark-sensitive"]')
  await expect(markItem).toBeVisible({ timeout: 3000 })
  await expect(markItem).toContainText('标记敏感')
  await markItem.click()
  await expect(page.locator('.n-message').filter({ hasText: '已标记为敏感会话' })).toBeVisible({ timeout: 5000 })

  // tab 右键 → 「导出输出」→ 敏感出域警示弹窗 → 「确认出域」→ 下载含标记
  await tab.click({ button: 'right' })
  const exportItem = page.locator('[data-testid="terminal-export-output"]')
  await expect(exportItem).toBeVisible({ timeout: 3000 })
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }),
    exportItem.click(),
    // 警示弹窗与下载并行等：确认动作触发 override 重试
    (async () => {
      const dlg = page.locator('.n-dialog').filter({ hasText: '敏感会话出域确认' })
      await expect(dlg).toBeVisible({ timeout: 8000 })
      await dlg.locator('.n-dialog__action button').filter({ hasText: '确认出域' }).click()
    })(),
  ])
  fs.mkdirSync(DL_DIR, { recursive: true })
  const file = path.join(DL_DIR, download.suggestedFilename())
  await download.saveAs(file)
  expect(download.suggestedFilename()).toMatch(/^terminal-.*-\d{8}\.txt$/)
  const content = fs.readFileSync(file, 'utf8')
  expect(content).toContain(UI_MARK)

  // 取消敏感标记：菜单文案翻转断言本地回写生效；导出不再弹警示直出下载
  await tab.click({ button: 'right' })
  const unmarkItem = page.locator('[data-testid="terminal-mark-sensitive"]')
  await expect(unmarkItem).toContainText('取消敏感标记', { timeout: 3000 })
  await unmarkItem.click()
  await expect(page.locator('.n-message').filter({ hasText: '已取消敏感标记' })).toBeVisible({ timeout: 5000 })

  await tab.click({ button: 'right' })
  await expect(page.locator('[data-testid="terminal-export-output"]')).toBeVisible({ timeout: 3000 })
  const [download2] = await Promise.all([
    page.waitForEvent('download', { timeout: 15_000 }),
    page.locator('[data-testid="terminal-export-output"]').click(),
  ])
  const file2 = path.join(DL_DIR, download2.suggestedFilename())
  await download2.saveAs(file2)
  expect(fs.readFileSync(file2, 'utf8')).toContain(UI_MARK)
  // 直出路径零警示弹窗
  await expect(page.locator('.n-dialog').filter({ hasText: '敏感会话出域确认' })).toHaveCount(0)
})
