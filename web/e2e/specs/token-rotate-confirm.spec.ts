import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Agent Token 轮换/撤销确认流 E2E（P-20261003-78 + P-20261004-63）：
 *   - 无运行会话：轮换/撤销走普通确认，确认后执行（轮换揭示新令牌 / 撤销后按钮禁用）
 *   - 有运行中 agent 会话：确认框含计数警示行（「1 个运行中」+ 工具回调 423 提示），
 *     轮换与撤销同级展示；取消则不执行
 *   - 跨设备真值（P-20261004-63）：警示计数改读服务端 GET /terminals/running-count
 *     （OSC 133 C/D 帧服务端权威统计）——从未附着该会话的第二浏览器上下文
 *     （runningMap 无此会话的跨设备模拟）同样见「1 个运行中」
 * 运行态链路：agent 会话（纯终端运行时）内跑长命令 → shellint OSC 133 C 帧 →
 * readLoop 字节源头点亮服务端运行态（先于任何前端收到）→ 前端统一 store 运行
 * 点亮（管理页侧栏 .ats-item-dot.running 为同步锚点）。
 * 轮换确认一律取消或重播种收尾，不污染共享实例令牌状态。
 */

/** 清理全部 agent 会话（kind=agent；项目会话不进计数，无需清） */
async function cleanupAgentSessions(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  const headers = { 'X-Lock-Token': token }
  const list = await (await request.get(`${API_BASE}/api/terminals`, { headers })).json()
  for (const s of ((list?.data || []) as { id: string; kind?: string }[])) {
    if (s.kind === 'agent') {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
  }
}

test.beforeEach(async ({ request }) => {
  await cleanupAgentSessions(request)
})

// 打开「设置 → 安全」并切到 Agent Token 页签（模式与 token-warning 一致）
async function openAgentTokenTab(page: Page) {
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: 'Agent Token' }).click()
}

async function clickRotate(page: Page) {
  await page.locator('.security-settings').getByRole('button', { name: '轮换', exact: true }).click()
}

async function clickRevoke(page: Page) {
  await page.locator('.security-settings').getByRole('button', { name: '撤销', exact: true }).click()
}

test('无运行会话：轮换/撤销普通确认，确认后执行', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await openAgentTokenTab(page)

  // 轮换 → 普通确认（无计数警示行）→ 确认 → 新令牌揭示（确认后执行语义）
  await clickRotate(page)
  const rotateDlg = page.locator('.n-dialog').filter({ hasText: '轮换 Agent Token' })
  await expect(rotateDlg).toBeVisible({ timeout: 5000 })
  await expect(rotateDlg.getByTestId('agent-token-running-warning')).toHaveCount(0)
  await rotateDlg.getByRole('button', { name: '确认' }).click()
  await expect(rotateDlg).toBeHidden({ timeout: 5000 })
  await expect(page.locator('.security-settings .token-plain')).toBeVisible({ timeout: 5000 })

  // 撤销 → 普通确认（无计数警示行）→ 确认 → 已揭示的明文被清除。
  // 注意不断言「撤销按钮禁用」：组件撤销后的 fetch 会 GET /agent-token，
  // 而服务端 GET 即 Ensure 自动播种（开箱即用语义），exists 恒为 true
  await clickRevoke(page)
  const revokeDlg = page.locator('.n-dialog').filter({ hasText: '撤销 Agent Token' })
  await expect(revokeDlg).toBeVisible({ timeout: 5000 })
  await expect(revokeDlg.getByTestId('agent-token-running-warning')).toHaveCount(0)
  await revokeDlg.getByRole('button', { name: '确认' }).click()
  await expect(revokeDlg).toBeHidden({ timeout: 5000 })
  await expect(page.locator('.security-settings .token-plain')).toHaveCount(0)

  // 收尾：GET 重新播种（开箱即用语义），不给后续用例留「无令牌」状态
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const headers = { 'X-Lock-Token': ((await res.json()) as { token?: string }).token || '' }
  const reseed = await request.get(`${API_BASE}/api/agent-token`, { headers })
  expect(reseed.ok()).toBeTruthy()
})

test('有运行中 agent 会话：轮换/撤销确认框含计数警示，取消不执行', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 终端会话管理页 → 新建 agent 会话（纯终端运行时：plain shell 才会执行命令
  // 并发 OSC 133 C；默认运行时拉起 claude TUI，键入进不了 shell）
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.getByRole('button', { name: '新建会话' }).first().click()
  const dlg = page.locator('.n-modal')
  await expect(dlg).toBeVisible({ timeout: 5000 })
  // 新建会话对话框 P-20261002-16 起有两枚 .n-base-selection（运行时+任务模板），
  // 裸 locator 会 strict violation——按「运行时」表单锚定（agent-runtime-guide 同款）
  await dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: '纯终端' }).click()
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'sc-rot-e2e-'))
  await dlg.locator('input').nth(1).fill(serverPath(tmpDir))
  await dlg.getByRole('button', { name: '创建' }).click()
  await expect(dlg).toBeHidden({ timeout: 10000 })

  // 在会话内跑长命令 → OSC 133 C → 管理页侧栏运行点点亮（计数同步锚点）。
  // ping 参数按服务端同机平台选择（本仓定向 e2e 服务与 runner 同机）
  const screen = view.locator('.xterm-screen:visible').last()
  await expect(screen).toBeVisible({ timeout: 20000 })
  await screen.click()
  const ping = process.platform === 'win32' ? 'ping -n 60 127.0.0.1' : 'ping -c 60 127.0.0.1'
  await page.keyboard.type(ping)
  await page.keyboard.press('Enter')
  await expect(view.locator('.ats-item-dot.running')).toBeVisible({ timeout: 30000 })

  // 轮换 → 确认框含计数警示行（N=1）；取消 → 不执行（令牌未揭示即未轮换）
  await openAgentTokenTab(page)
  await clickRotate(page)
  const rotateDlg = page.locator('.n-dialog').filter({ hasText: '轮换 Agent Token' })
  await expect(rotateDlg).toBeVisible({ timeout: 5000 })
  await expect(rotateDlg.getByTestId('agent-token-running-warning')).toBeVisible()
  await expect(rotateDlg.getByTestId('agent-token-running-warning')).toContainText('1 个运行中')
  await rotateDlg.getByRole('button', { name: '取消' }).click()
  await expect(rotateDlg).toBeHidden({ timeout: 5000 })
  await expect(page.locator('.security-settings .token-plain')).toHaveCount(0)

  // 撤销同级展示计数警示；取消收尾（afterEach 销毁会话即终止 ping）
  await clickRevoke(page)
  const revokeDlg = page.locator('.n-dialog').filter({ hasText: '撤销 Agent Token' })
  await expect(revokeDlg).toBeVisible({ timeout: 5000 })
  await expect(revokeDlg.getByTestId('agent-token-running-warning')).toBeVisible()
  await expect(revokeDlg.getByTestId('agent-token-running-warning')).toContainText('1 个运行中')
  await revokeDlg.getByRole('button', { name: '取消' }).click()
  await expect(revokeDlg).toBeHidden({ timeout: 5000 })
})

test('跨设备真值：未附着会话的第二上下文轮换确认仍见服务端计数警示', async ({ browser, request }) => {
  // 上下文 A：创建 agent 会话（纯终端运行时）并跑长命令——该上下文持有会话 WS
  const ctxA = await browser.newContext()
  const pageA = await ctxA.newPage()
  await fixedLocale(pageA)
  await gotoAndUnlock(pageA, `${API_BASE}/`)
  await projectCardByName(pageA, 'simple-coding').first().click()
  await pageA.waitForURL('**/project')

  await pageA.locator('.rail-btn[title="终端会话管理"]').click()
  const view = pageA.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.getByRole('button', { name: '新建会话' }).first().click()
  const dlg = pageA.locator('.n-modal')
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection').click()
  await pageA.locator('.n-base-select-option').filter({ hasText: '纯终端' }).click()
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'sc-rot-xdev-'))
  await dlg.locator('input').nth(1).fill(serverPath(tmpDir))
  await dlg.getByRole('button', { name: '创建' }).click()
  await expect(dlg).toBeHidden({ timeout: 10000 })

  // 会话内跑长命令 → OSC 133 C 帧：管理页侧栏运行点点亮（帧已出的同步锚点；
  // 服务端 readLoop 先于任何前端收到，此刻计数必然已点亮）
  const screen = view.locator('.xterm-screen:visible').last()
  await expect(screen).toBeVisible({ timeout: 20000 })
  await screen.click()
  const ping = process.platform === 'win32' ? 'ping -n 60 127.0.0.1' : 'ping -c 60 127.0.0.1'
  await pageA.keyboard.type(ping)
  await pageA.keyboard.press('Enter')
  await expect(view.locator('.ats-item-dot.running')).toBeVisible({ timeout: 30000 })

  // 服务端计数口权威确认（不经任何浏览器视角）：count=1 + running 清单含该会话
  const unlock = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const apiHeaders = { 'X-Lock-Token': ((await unlock.json()) as { token?: string }).token || '' }
  const countRes = await request.get(`${API_BASE}/api/terminals/running-count?kind=agent`, { headers: apiHeaders })
  const countBody = (await countRes.json()) as { data?: { count?: number; running?: string[] } }
  expect(countBody.data?.count).toBe(1)
  expect(countBody.data?.running?.length).toBe(1)

  // 上下文 B（跨设备模拟）：从未附着该会话——浏览器 runningMap 无此会话，
  // 旧实现（浏览器快照计数）在此恒为 0 个运行中；服务端计数仍见「1 个运行中」
  const ctxB = await browser.newContext()
  const pageB = await ctxB.newPage()
  await fixedLocale(pageB)
  await gotoAndUnlock(pageB, `${API_BASE}/`)
  await openAgentTokenTab(pageB)
  await clickRotate(pageB)
  const rotateDlg = pageB.locator('.n-dialog').filter({ hasText: '轮换 Agent Token' })
  await expect(rotateDlg).toBeVisible({ timeout: 5000 })
  await expect(rotateDlg.getByTestId('agent-token-running-warning')).toBeVisible()
  await expect(rotateDlg.getByTestId('agent-token-running-warning')).toContainText('1 个运行中')
  await rotateDlg.getByRole('button', { name: '取消' }).click()
  await expect(rotateDlg).toBeHidden({ timeout: 5000 })

  // 撤销同级展示；取消收尾（beforeEach 清理会话即终止 ping）
  await clickRevoke(pageB)
  const revokeDlg = pageB.locator('.n-dialog').filter({ hasText: '撤销 Agent Token' })
  await expect(revokeDlg).toBeVisible({ timeout: 5000 })
  await expect(revokeDlg.getByTestId('agent-token-running-warning')).toContainText('1 个运行中')
  await revokeDlg.getByRole('button', { name: '取消' }).click()
  await expect(revokeDlg).toBeHidden({ timeout: 5000 })

  await ctxB.close()
  await ctxA.close()
})
