import { execSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 审批卡「查看发起会话」一键跳转（P-20261001-2）：
 * 审批记录的 sessionId 是发起确认的终端会话——卡片头部按钮点击后统一广播
 * OPS_ACTIVATE_TERMINAL，按会话归属路由激活：
 *   1. 系统会话（kind=agent）→ 终端会话管理页打开并选中该会话
 *   2. 项目会话（kind=shell）→ 切项目上下文 + 底部终端面板打开 + 对应 tab 激活
 *   3. 会话已结束（列表对账后无此 id）→ 降级提示，不打开任何终端形态
 * 满种方式对齐 agent-terminal.spec 审批三态用例（API 造 pending → 全局卡片）；
 * 会话创建走 API（纯终端 runtime，不拉起 claude TUI）；afterEach 清账防残留
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，保证确定性 + 防残留 tmux 进程） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 清理 pending 审批（卡片全局常驻，残留会污染后续用例的 .aprv-card 计数） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovals(request)
})

test('审批卡查看发起会话：系统会话 → 打开管理页并激活该会话', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // API 造系统会话（纯终端 runtime，避免拉起 claude TUI）+ 以其 id 造 pending 审批
  const dir = await mkdtemp(path.join(tmpdir(), 'sc-appr-jump-'))
  const created = await request.post(`${BASE}/api/terminals`, {
    headers,
    data: { kind: 'agent', name: 'appr-jump-agent', runtime: 'shell', dir: serverPath(dir) },
  })
  expect(created.ok()).toBeTruthy()
  const tlist = await (await request.get(`${BASE}/api/terminals`, { headers })).json()
  const session = ((tlist?.data || []) as { id: string; name: string }[])
    .find(s => s.name === 'appr-jump-agent')
  expect(session).toBeTruthy()

  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: session!.id, op: 'reset --hard', target: 'main', detail: 'e2e 系统会话跳转验证' },
  })
  expect(appr.ok()).toBeTruthy()

  // 卡片出现 + 头部跳转按钮（sessionId 存在才显示）
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('reset --hard')
  const jumpBtn = card.getByRole('button', { name: '查看发起会话' })
  await expect(jumpBtn).toBeVisible()

  // 点击 → docked 管理页打开 + 对应会话激活（侧栏 active 项 + 终端区渲染）
  await jumpBtn.click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  const activeItem = view.locator('.ats-item.active')
  await expect(activeItem).toHaveCount(1, { timeout: 10000 })
  await expect(activeItem.locator('.ats-item-title')).toContainText('appr-jump-agent')
  await expect(view.locator('.xterm').first()).toBeVisible({ timeout: 15000 })
})

test('审批卡查看发起会话：项目会话 → 切项目 + 底部终端 tab 激活', async ({ page, request }) => {
  test.setTimeout(60000)
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // 注册临时 git 仓库为项目（服务端要求 git 仓库）+ 建项目终端会话
  const repoDir = await mkdtemp(path.join(tmpdir(), 'sc-appr-jump-repo-'))
  execSync('git init', { cwd: repoDir })
  execSync('git config core.autocrlf false', { cwd: repoDir })
  try {
    const projRes = await request.post(`${BASE}/api/projects`, {
      headers, data: { name: 'appr-jump-proj', path: serverPath(repoDir) },
    })
    expect([200, 201]).toContain(projRes.status())
    const plist = await (await request.get(`${BASE}/api/projects`, { headers })).json()
    const proj = ((plist?.data || []) as { id: string; name: string }[])
      .find(p => p.name === 'appr-jump-proj')
    expect(proj).toBeTruthy()

    const termRes = await request.post(`${BASE}/api/terminals`, {
      headers, data: { projectId: proj!.id, name: 'appr-jump-shell' },
    })
    expect(termRes.ok()).toBeTruthy()
    const tlist = await (await request.get(`${BASE}/api/terminals`, { headers })).json()
    const session = ((tlist?.data || []) as { id: string; name: string }[])
      .find(s => s.name === 'appr-jump-shell')
    expect(session).toBeTruthy()

    const appr = await request.post(`${BASE}/api/ops-confirm`, {
      headers,
      data: { sessionId: session!.id, op: 'push --force', target: 'main', detail: 'e2e 项目会话跳转验证' },
    })
    expect(appr.ok()).toBeTruthy()

    const card = page.locator('.aprv-card')
    await expect(card).toHaveCount(1, { timeout: 10000 })
    await card.getByRole('button', { name: '查看发起会话' }).click()

    // 非项目页先路由到项目页 + 底部终端面板打开 + 对应 tab 激活
    await page.waitForURL('**/project')
    const panel = page.locator('.bottom-panel')
    await expect(panel).toBeVisible({ timeout: 10000 })
    const tab = panel.locator('.term-tab.is-active')
    await expect(tab).toHaveCount(1, { timeout: 15000 })
    await expect(tab).toContainText('appr-jump-shell')
    await expect(panel.locator('.xterm').first()).toBeVisible({ timeout: 15000 })
  } finally {
    // 清理项目与夹具目录（终端会话由 afterEach 全量清）
    const plist = await (await request.get(`${BASE}/api/projects`, { headers })).json()
    const mine = ((plist?.data || []) as { id: string; name: string }[])
      .find(p => p.name === 'appr-jump-proj')
    if (mine) await request.delete(`${BASE}/api/projects/${mine.id}`, { headers })
    await rm(repoDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('审批卡查看发起会话：会话已结束 → 降级提示且不打开终端', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: 'sc_e2e_gone_session', op: 'clean -fdx', target: '', detail: 'e2e 降级验证' },
  })
  expect(appr.ok()).toBeTruthy()

  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await card.getByRole('button', { name: '查看发起会话' }).click()

  // 降级提示 + 不打开任何终端形态（管理页/底部面板均不出现）
  await expect(page.locator('.n-message').filter({ hasText: '已结束' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.atv-root')).toHaveCount(0)
  await expect(page.locator('.bottom-panel')).toHaveCount(0)
})
