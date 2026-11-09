import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 终端输出时点冻结分享（P-20261005-205）E2E：
 *   1. 全链路：创建终端 → 打印敏感令牌形态 → 冻结分享 → 访客页定格形态
 *      （xterm 渲染 + 无 SSE 接线）+ raw 净本（*** 遮蔽、本体零残留）→
 *      会话关闭后链接仍可访问（快照脱离会话生命周期）→ 撤销 → 立即失效
 *   2. 管理链路：敏感会话出域闸门（warnings + override 放行）→ 幂等同链 →
 *      rotate 换链（旧 404、新链 raw 同内容）→ 管理列表「快照」徽标 +
 *      tab 右键菜单「分享输出快照」入口可见
 * 子服务端口经 /api/share/status 动态获取（默认主端口+2）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态，保证确定性） */
async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  }
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJECT_NAME)
  if (!p) throw new Error(`project ${PROJECT_NAME} not found`)
  return p.id
}

async function getShareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

/** 开一个普通 shell 终端并回读会话 ID（快照源） */
async function createTerminal(request: APIRequestContext, headers: Record<string, string>, projectId: string, name = 'e2e-frozen-src'): Promise<string> {
  const res = await request.post(`${BASE}/api/terminals`, { headers, data: { projectId, name } })
  expect(res.ok()).toBeTruthy()
  const data = ((await res.json()) as { data?: { id?: string } }).data
  if (!data?.id) throw new Error('terminal id missing')
  return data.id
}

/** 轮询 scrollback 直到出现标记（快照是创建时刻定格——写早于冻才可断言） */
async function waitForScrollback(request: APIRequestContext, headers: Record<string, string>, sessionId: string, marker: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const res = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
    if (res.ok() && (await res.text()).includes(marker)) return
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`marker ${marker} not in scrollback in time`)
}

test.describe('share-terminal-frozen', () => {
  test.beforeEach(async ({ request }) => {
    await cleanupShares(request)
  })

  // 礼貌清场：测试开的终端会话
  let sessionIds: string[] = []
  test.afterEach(async ({ request }) => {
    const headers = await unlockHeaders(request)
    for (const id of sessionIds) {
      await request.delete(`${BASE}/api/terminals/${id}`, { headers })
    }
    sessionIds = []
  })

  test('全链路：冻结 → 访客页定格形态 + 净本遮蔽 → 会话关闭后仍可访问 → 撤销失效', async ({ request }) => {
    test.setTimeout(90_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)

    const sessionId = await createTerminal(request, headers, projectId)
    sessionIds.push(sessionId)
    // 打印敏感令牌形态（sca_ 系整段遮蔽）——写早于冻，定格内容可断言
    const SECRET = 'sca_e2eFrozen0Secret1'
    const wr = await request.post(`${BASE}/api/terminals/broadcast-write`, {
      headers, data: { ids: [sessionId], data: `echo FROZEN_${SECRET}_TAIL\r` },
    })
    expect(wr.ok()).toBeTruthy()
    await waitForScrollback(request, headers, sessionId, `FROZEN_${SECRET}_TAIL`)

    // 冻结分享：kind=terminal-frozen、默认 ~30 天 TTL、脱会话锚点不绑项目
    const created = await request.post(`${BASE}/api/share/terminal-frozen`, { headers, data: { sessionId } })
    expect(created.ok()).toBeTruthy()
    const share = ((await created.json()) as { data?: { token: string; kind: string; terminalId: string; expiresAt: string; size: number } }).data
    expect(share?.kind).toBe('terminal-frozen')
    expect(share?.terminalId).toBe(sessionId)
    expect(share?.expiresAt).toBeTruthy()
    const remain = new Date(share!.expiresAt!).getTime() - Date.now()
    expect(remain).toBeGreaterThan(29 * 24 * 3600_000)

    // 访客页：定格形态——xterm 渲染 + /raw 取数，无 SSE 接线
    const page = await request.get(`${shareBase}/s/${share!.token}`)
    expect(page.status()).toBe(200)
    const html = await page.text()
    expect(html).toContain('/assets/xterm.js')
    expect(html).toContain('/raw')
    expect(html).not.toContain('/stream')
    expect(html).not.toContain('EventSource')

    // raw 净本：遮蔽形态可见、敏感本体零残留（快照落盘前净化完成的实证）
    const raw = await request.get(`${shareBase}/s/${share!.token}/raw`)
    expect(raw.ok()).toBeTruthy()
    expect(raw.headers()['content-type']).toContain('text/plain')
    const text = await raw.text()
    expect(text).toContain('FROZEN_***_TAIL')
    expect(text).not.toContain(SECRET)

    // 快照脱离会话生命周期：会话关闭后链接与内容原样可访问
    const delSession = await request.delete(`${BASE}/api/terminals/${sessionId}`, { headers })
    expect(delSession.ok()).toBeTruthy()
    sessionIds = sessionIds.filter(id => id !== sessionId)
    const raw2 = await request.get(`${shareBase}/s/${share!.token}/raw`)
    expect(raw2.ok()).toBeTruthy()
    expect(await raw2.text()).toContain('FROZEN_***_TAIL')

    // 撤销 → 立即失效（页面与 raw 双断言）
    const del = await request.delete(`${BASE}/api/share/${share!.token}`, { headers })
    expect(del.ok()).toBeTruthy()
    expect((await request.get(`${shareBase}/s/${share!.token}`)).status()).toBe(404)
    expect((await request.get(`${shareBase}/s/${share!.token}/raw`)).status()).toBe(404)
  })

  test('管理链路：敏感闸门 override 放行 → 幂等同链 → rotate 换链快照不动 → 管理列表徽标 + 右键入口', async ({ page, request }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    await fixedLocale(page)

    // 敏感会话出域闸门：标记敏感 → 创建回 warnings 不带 data → override 放行。
    // 先产出输出（空输出 400 是服务端护栏——无内容可分享）：
    const sessionId = await createTerminal(request, headers, projectId, 'e2e-frozen-gate')
    sessionIds.push(sessionId)
    const wr = await request.post(`${BASE}/api/terminals/broadcast-write`, {
      headers, data: { ids: [sessionId], data: 'echo GATE_READY\r' },
    })
    expect(wr.ok()).toBeTruthy()
    await waitForScrollback(request, headers, sessionId, 'GATE_READY')

    const mark = await request.post(`${BASE}/api/terminals/${sessionId}/sensitive`, {
      headers, data: { sensitive: true },
    })
    expect(mark.ok()).toBeTruthy()
    const blocked = await request.post(`${BASE}/api/share/terminal-frozen`, { headers, data: { sessionId } })
    expect(blocked.ok()).toBeTruthy()
    const blockedBody = ((await blocked.json()) as { data?: unknown; warnings?: string[] })
    expect(blockedBody.data).toBeUndefined()
    expect(blockedBody.warnings).toContain('sensitive-session')
    const allowed = await request.post(`${BASE}/api/share/terminal-frozen`, {
      headers, data: { sessionId, override: true },
    })
    expect(allowed.ok()).toBeTruthy()
    const share = ((await allowed.json()) as { data?: { token: string; kind: string } }).data
    expect(share?.kind).toBe('terminal-frozen')

    // 幂等：同会话未再产生输出时重复定格（同哈希）恒同链
    const again = await request.post(`${BASE}/api/share/terminal-frozen`, {
      headers, data: { sessionId, override: true },
    })
    expect(((await again.json()) as { data?: { token: string } }).data?.token).toBe(share!.token)

    // rotate 换链：旧链立即失效、新链 raw 同内容（快照目录锚零代际值不动）
    const rot = await request.post(`${BASE}/api/share/${share!.token}/rotate`, { headers })
    expect(rot.ok()).toBeTruthy()
    const next = ((await rot.json()) as { data?: { token: string } }).data
    expect(next?.token).toBeTruthy()
    expect(next!.token).not.toBe(share!.token)
    expect((await request.get(`${shareBase}/s/${share!.token}/raw`)).status()).toBe(404)
    const rawNew = await request.get(`${shareBase}/s/${next!.token}/raw`)
    expect(rawNew.ok()).toBeTruthy()

    // UI 链路：项目终端面板 → tab 右键「分享输出快照」（与直播分享同区）→
    // 点击出结果卡（UI→API→定格全链）→ 管理列表「快照」徽标
    await gotoAndUnlock(page, `${BASE}/`)
    await page.locator('.project-card').first().click()
    await page.waitForURL('**/project')
    for (let i = 0; i < 3; i++) {
      if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
      await page.locator('[data-testid="rail-terminal"]').click()
      await page.waitForTimeout(600)
    }
    await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
    await page.waitForTimeout(2500)

    const tab = page.locator('.term-tab').last()
    await tab.click({ button: 'right' })
    const frozenItem = page.locator('[data-testid="terminal-frozen-share"]')
    await expect(frozenItem).toBeVisible({ timeout: 5000 })
    await expect(frozenItem).toContainText('分享输出快照')
    await frozenItem.click()
    // 选项弹层（P-20261106-9）：遮蔽缺省开（安全基线），直接确认创建
    const options = page.locator('[data-testid="share-term-options"]')
    await expect(options).toBeVisible({ timeout: 5000 })
    await expect(options).toHaveAttribute('data-kind', 'frozen')
    await page.locator('[data-testid="share-term-confirm"]').click()
    // 结果卡弹出（useShareDialog 单例 → ShareResultDialog）：快照形态描述 + 有效期提示
    const dialog = page.locator('.share-result-modal')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog).toContainText('输出定格快照')

    // 管理列表：经结果卡「管理全部分享」直达（关弹层 + 切管理视图一步到位）
    await dialog.getByRole('button', { name: '管理全部分享' }).click()
    await expect(page.locator('.share-manager')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="sm-termfrozen-badge"]').first())
      .toBeVisible({ timeout: 20_000 })
  })
})
