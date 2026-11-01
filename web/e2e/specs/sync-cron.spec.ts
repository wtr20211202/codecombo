import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 定时同步任务 E2E（P-20261023-1 方案⑤）：/api/sync/crons CRUD + 校验 +
 * 立即试跑入账 + 同步中心面板清单。调度到点执行的完整语义（四态过滤/冲突
 * 策略三档/对端离线跳过）在 Go 单测 selectUnitsForPolicy 与 cronrun 链，
 * 本 spec 验证 API 契约与 UI 可达性。
 */

const BASE = API_BASE
const CRON_NAME = 'e2e-sync-cron'

let unlockToken = ''

async function lockToken(): Promise<string> {
  const res = await fetch(`${BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  return (await res.json()).token || ''
}

async function createCron(body: Record<string, unknown>): Promise<{ status: number; id: string }> {
  const res = await fetch(`${BASE}/api/sync/crons`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => ({}))) as { data?: { id?: string } }
  return { status: res.status, id: json.data?.id || '' }
}

test.beforeAll(async () => {
  unlockToken = await lockToken()
})

test.afterAll(async () => {
  // 清账：按名单删（幂等）
  const list = await fetch(`${BASE}/api/sync/crons`, { headers: { 'X-Lock-Token': unlockToken } })
  const crons = ((await list.json()) as { data?: { id: string; name: string }[] }).data || []
  for (const c of crons.filter(x => x.name === CRON_NAME)) {
    await fetch(`${BASE}/api/sync/crons/${c.id}`, {
      method: 'DELETE', headers: { 'X-Lock-Token': unlockToken },
    }).catch(() => {})
  }
})

test('API：校验（方向白名单/对端必填）+ CRUD + 立即试跑入账', async () => {
  const auth = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
  const base = { name: CRON_NAME, hour: 3, minute: 0, enabled: true }

  // 方向白名单外 400
  const badDir = await createCron({ ...base, direction: 'sideways', peerIds: ['nope'] })
  expect(badDir.status).toBe(400)
  // 对端必填 400
  const noPeer = await createCron({ ...base, direction: 'push' })
  expect(noPeer.status).toBe(400)
  // 时刻值域 400
  const badHour = await createCron({ ...base, direction: 'push', peerIds: ['nope'], hour: 25 })
  expect(badHour.status).toBe(400)

  // 创建（对端未注册也允许建档——运行期才解析）
  const ok = await createCron({ ...base, direction: 'push', peerIds: ['unregistered-peer'], conflictPolicy: 'safe' })
  expect(ok.status).toBe(200)
  expect(ok.id).toBeTruthy()

  // 清单在场 + 策略归一
  const list = await fetch(`${BASE}/api/sync/crons`, { headers: { 'X-Lock-Token': unlockToken } })
  const crons = ((await list.json()) as { data?: { id: string; name: string; conflictPolicy: string; enabled: boolean }[] }).data || []
  const mine = crons.find(c => c.id === ok.id)
  expect(mine, '创建的定时任务应在清单').toBeTruthy()
  expect(mine!.conflictPolicy).toBe('safe')
  expect(mine!.enabled).toBe(true)

  // 停用（Update 全量替换语义）。注意：全局 fetch 的 Response.ok 是布尔
  // 属性（playwright request 面的 response.ok() 才是方法）——误加括号即 TypeError
  const upd = await fetch(`${BASE}/api/sync/crons/${ok.id}`, {
    method: 'PUT', headers: auth,
    body: JSON.stringify({ ...base, direction: 'push', peerIds: ['unregistered-peer'], enabled: false }),
  })
  expect(upd.ok).toBeTruthy()

  // 立即试跑：对端不存在 → 运行账 failed（运行期事实，RecordRun 单点写入）
  const run = await fetch(`${BASE}/api/sync/crons/${ok.id}/run`, {
    method: 'POST', headers: { 'X-Lock-Token': unlockToken },
  })
  expect(run.ok).toBeTruthy()
  await expect.poll(async () => {
    const r = await fetch(`${BASE}/api/sync/crons`, { headers: { 'X-Lock-Token': unlockToken } })
    const crons2 = ((await r.json()) as { data?: { id: string; lastResult?: string }[] }).data || []
    return crons2.find(c => c.id === ok.id)?.lastResult || ''
  }, { timeout: 20000 }).toBe('failed')

  // 删除幂等收尾
  const del = await fetch(`${BASE}/api/sync/crons/${ok.id}`, {
    method: 'DELETE', headers: { 'X-Lock-Token': unlockToken },
  })
  expect(del.ok).toBeTruthy()
})

test('UI：同步中心面板定时同步区（清单行在场/展开可折叠）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  const panel = page.locator('[data-testid="sync-panel"]')
  for (let i = 0; i < 3; i++) {
    if (await panel.isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="多实例同步"]').click()
    await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态重试 */ })
  }
  await expect(panel).toBeVisible()

  // API 播一条任务 → 面板展开定时同步区 → 行在场
  const created = await createCron({
    name: CRON_NAME, direction: 'pull', peerIds: ['unregistered-peer'],
    hour: 4, minute: 30, enabled: true, conflictPolicy: 'peer-mirror',
  })
  expect(created.status).toBe(200)

  // 折叠区展开（重新加载清单：面板挂载时拉取——本条在挂载后播种，触发一轮
  // 重开面板让 loadCrons 重跑）
  await page.locator('.rail-btn[title="多实例同步"]').click()
  await expect(panel).toBeHidden({ timeout: 5000 }).catch(() => {})
  await page.locator('.rail-btn[title="多实例同步"]').click()
  await expect(panel).toBeVisible()

  await panel.locator('[data-testid="sync-cron-toggle"]').click()
  const crons = panel.locator('[data-testid="sync-crons"]')
  await expect(crons).toBeVisible()
  await expect(crons.locator('.sync-cron-row', { hasText: CRON_NAME })).toBeVisible()
})
