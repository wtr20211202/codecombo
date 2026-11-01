import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 退役短链外泄观测（P-20261008-2）E2E——轮换作废的旧链接仍被访问的告警链：
 *   1. 建分享 → 轮换 → 旧 token 访客访问 2 次：响应保持 404（静默撤销语义
 *      不变——观测只补主人侧；实况码为 404 与「从未存在」同观感，存在性
 *      信号不得因观测面可探测）
 *   2. 审计台账出现 share.retiredHit ×2（Detail 含展示名与退役 token，3s
 *      攒批入账，轮询等待）；非退役 token 的未知短链 404 不留痕（漫扫不告警）
 *   3. 管理列表行投影 retiredHits=2 + 通知中心 warning 告警（titleKey=
 *      share.retired.notify.title，首次命中即发——2 次命中只 1 条，去抖）
 *   4. UI：管理器类型列「退役访问 2」徽标（有命中才显示）
 *   5. 生命周期：撤销宿主 → 旧 token 命中退化为普通 404（审计不再增长，
 *      观测随宿主消亡）
 * 共享实例的全局分享列表与审计台账（workers=1 串行），beforeEach 清分享。
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'
const PROBE = 'e2e-retired-hit-probe.md'

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

/** 分享子服务基址（访客短链端口，经 status 端点取实际值） */
async function shareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  expect(status?.running, 'share sub-service must be running').toBeTruthy()
  return `${status!.scheme || 'http'}://127.0.0.1:${status!.port}`
}

/** 造唯一探针分享（唯一路径 → 唯一 token，重跑不被上一轮台账沾染）；
 *  探针文件登记进 createdFiles 供 afterEach 清理（guestbook 同款纪律——
 *  保种子项目工作树干净） */
const createdFiles: string[] = []

async function seedShare(
  request: APIRequestContext, headers: Record<string, string>,
): Promise<{ token: string; name: string }> {
  const projectId = await getProjectId(request, headers)
  const path = `e2e-retired-hit-${Date.now()}.md`
  const mk = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path, content: '# retired hit probe\n' },
  })
  expect(mk.ok(), await mk.text()).toBeTruthy()
  createdFiles.push(path)
  const res = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path } })
  expect(res.ok(), await res.text()).toBeTruthy()
  const token = ((await res.json()) as { data?: { token: string } }).data?.token
  expect(token).toBeTruthy()
  return { token: token!, name: path }
}

/** 通知中心退役告警的当前条数（全局通知中心累积不随 cleanupShares 清理
 *  ——断言一律走增量，与 guestbook 通知用例同一口径） */
async function retiredNotifyCount(request: APIRequestContext, headers: Record<string, string>): Promise<number> {
  const res = await request.get(`${BASE}/api/notifications`, { headers })
  const data = ((await res.json()) as { data?: { titleKey?: string }[] }).data || []
  return data.filter(n => n.titleKey === 'share.retired.notify.title').length
}

/** 轮询通知中心直至退役告警较基线推进 delta 条（首发即攒批入账） */
async function waitRetiredNotify(
  request: APIRequestContext,
  headers: Record<string, string>,
  baseline: number,
): Promise<void> {
  const deadline = Date.now() + 15_000
  for (;;) {
    if (await retiredNotifyCount(request, headers) > baseline) return
    if (Date.now() > deadline) throw new Error(`retired leak alert never advanced past ${baseline}`)
    await new Promise(r => setTimeout(r, 400))
  }
}

type AuditEvent = { action: string; detail?: string; result: string }

/** 轮询审计台账直至该动作 × 退役 token 的事件达标（3s 批量入账，不忙等） */
async function waitRetiredAudit(
  request: APIRequestContext,
  headers: Record<string, string>,
  retiredToken: string,
  want: number,
): Promise<AuditEvent[]> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const res = await request.get(`${BASE}/api/audit?limit=500`, { headers })
    const events = ((await res.json()) as { data?: AuditEvent[] }).data || []
    const hits = events.filter(e => e.action === 'share.retiredHit' && (e.detail || '').includes(retiredToken))
    if (hits.length >= want) return hits
    if (Date.now() > deadline) throw new Error(`share.retiredHit audit for ${retiredToken} never reached ${want}`)
    await new Promise(r => setTimeout(r, 400))
  }
}

/** 轮询管理列表直至该行退役计数达标（3s 攒批落盘 → 列表投影） */
async function waitRetiredHits(
  request: APIRequestContext,
  headers: Record<string, string>,
  token: string,
  want: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const res = await request.get(`${BASE}/api/share`, { headers })
    const rows = ((await res.json()) as { data?: Record<string, unknown>[] }).data || []
    const row = rows.find(r => r.token === token)
    if (row && Number(row.retiredHits ?? 0) >= want) return row
    if (Date.now() > deadline) throw new Error(`retiredHits for ${token} never reached ${want}`)
    await new Promise(r => setTimeout(r, 400))
  }
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})

test.afterEach(async ({ request }) => {
  await cleanupShares(request)
  // 探针文件清理（尽力而为：分享撤销在前，文件删除失败不串扰下一轮——
  // 唯一路径天然不撞名）
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers).catch(() => '')
  for (const path of createdFiles.splice(0)) {
    if (!projectId) break
    await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path } })
  }
})

test('轮换后旧链被踩：响应仍 404 + 审计留痕 + 列表徽标数据 + 告警首发（2 命中 1 条）', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const visitor = await shareBase(request, headers)
  const notifyBaseline = await retiredNotifyCount(request, headers)

  const oldToken = await seedShare(request, headers).then(s => s.token)
  // 轮换：旧链立即作废
  const rot = await request.post(`${BASE}/api/share/${oldToken}/rotate`, { headers })
  expect(rot.ok()).toBeTruthy()
  const newToken = ((await rot.json()) as { data?: { token: string } }).data?.token
  expect(newToken, 'rotate must return a fresh token').toBeTruthy()
  expect(newToken).not.toBe(oldToken)
  // 新链照常可访问（轮换不断服务）
  expect((await request.get(`${visitor}/s/${newToken!}/meta`)).status()).toBe(200)

  // 旧链被踩 2 次：响应仍是 404（与「从未存在」同观感——静默撤销语义零变化）
  expect((await request.get(`${visitor}/s/${oldToken}`)).status()).toBe(404)
  expect((await request.get(`${visitor}/s/${oldToken}/meta`)).status()).toBe(404)

  // 未知短链 404 不留痕（漫扫不触发外泄告警——观测只认台账内 token）
  expect((await request.get(`${visitor}/s/aaaaaaaaaaaaaaaa`)).status()).toBe(404)

  // 审计：恰好 2 条 share.retiredHit（Detail 含展示名/退役 token/累计命中；
  // 唯一路径 → 唯一 token，历史轮次的台账不沾染断言）。达标后再等一个
  // 冲刷周期复核总量——未知 token 的 404 不产生第三条
  const hits = await waitRetiredAudit(request, headers, oldToken, 2)
  expect(hits[0]!.result).toBe('success')
  await new Promise(r => setTimeout(r, 3_500))
  const settled = await waitRetiredAudit(request, headers, oldToken, 2)
  expect(settled, 'exactly the two visitor hits are audited').toHaveLength(2)
  for (const e of settled) {
    expect(e.detail).toContain('e2e-retired-hit-')
    expect(e.detail).toContain(`(retired ${oldToken})`)
  }

  // 管理列表投影：当前代际行 retiredHits=2 + lastRetiredAt（徽标数据源）
  const row = await waitRetiredHits(request, headers, newToken!, 2)
  expect(String(row.lastRetiredAt ?? '')).not.toBe('')

  // 通知中心：warning 告警增量恰 1 条（首次命中即发 + 此后每 10 次汇总——
  // 2 次命中去抖为 1 条，防轰炸；titleKey 区分于其余通知域）
  await waitRetiredNotify(request, headers, notifyBaseline)
  const alertsNow = await retiredNotifyCount(request, headers)
  expect(alertsNow).toBe(notifyBaseline + 1)
  const notices = await request.get(`${BASE}/api/notifications`, { headers })
  const data = ((await notices.json()) as { data?: { titleKey?: string; type?: string }[] }).data || []
  const alert = data.find(n => n.titleKey === 'share.retired.notify.title')
  expect(alert?.type).toBe('warning')
})

test('UI：管理器类型列「退役访问 N」徽标（有命中才显示）+ 撤销后观测消亡', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const visitor = await shareBase(request, headers)

  const seeded = await seedShare(request, headers)
  const oldToken = seeded.token
  const rot = await request.post(`${BASE}/api/share/${oldToken}/rotate`, { headers })
  const newToken = ((await rot.json()) as { data?: { token: string } }).data?.token!
  await request.get(`${visitor}/s/${oldToken}`)
  await request.get(`${visitor}/s/${oldToken}`)
  await waitRetiredHits(request, headers, newToken, 2)

  // 管理器：当前代际行的类型列挂「退役访问 2」warning 徽标（行以展示名
  // 定位——文件名即名称列文本，token 不入行文本）
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.sm-card table')).toBeVisible({ timeout: 10_000 })
  const row = page.locator('.sm-card tbody tr').filter({ hasText: seeded.name })
  await expect(row).toHaveCount(1)
  const badge = row.locator('[data-testid="sm-retired-badge"]')
  await expect(badge).toContainText('退役访问 2')

  // 撤销宿主（UI 口径：更多 → 撤销 → 确认弹窗——撤销后前端 fetchAll 刷新，
  // 行消失即时可见）：台账随宿主消亡——退役 token 命中退化为普通 404，
  // 观测面与记录同生命周期
  await page.getByTestId('sm-more-btn').first().click()
  await page.locator('.n-dropdown-menu').last().getByText('撤销', { exact: true }).click()
  const dlg = page.locator('.n-dialog')
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('撤销后短链立即失效')
  await dlg.getByRole('button', { name: '确认' }).click()
  await expect(page.locator('.sm-card tbody tr').filter({ hasText: seeded.name })).toHaveCount(0, { timeout: 10_000 })
  // 记录删除后旧 token 再被踩：无新审计（与「从未存在」同观感）
  const countRetired = async (): Promise<number> => {
    const res = await request.get(`${BASE}/api/audit?limit=500`, { headers })
    const events = ((await res.json()) as { data?: AuditEvent[] }).data || []
    return events.filter(e => e.action === 'share.retiredHit' && (e.detail || '').includes(oldToken)).length
  }
  const beforeCount = await countRetired()
  expect(beforeCount, 'two hits were recorded before revoke').toBe(2)
  expect((await request.get(`${visitor}/s/${oldToken}`)).status()).toBe(404)
  expect(await countRetired()).toBe(beforeCount)
})
