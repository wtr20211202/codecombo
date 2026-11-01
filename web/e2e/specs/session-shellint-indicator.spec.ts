import { rm } from 'node:fs/promises'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { createAgentSessionApi } from '../../tests/e2e-api'
import { serverIsLinux } from '../../tests/dualpath'

/**
 * 会话 shell 集成状态指示（P-20261004-90）E2E：
 * 命令历史/空闲提示/退出码装饰/git 面板自刷新整族功能依赖 OSC 133 shell 集成，
 * 侧栏会话行 tooltip 恒显一行「shell 集成：已连接/未检测到」+ 未检测弱灰图标
 * （cwd 徽标区，data-test="session-shellint-missing"）——「为什么这个会话没有
 * 历史/空闲徽标」就地可诊断。
 *   1. 附着集成会话（默认 shell，服务端注入 shellint）：tooltip 转「已连接」、
 *      弱灰图标消失——D 帧路径真实数据驱动（shellint 每次提示符渲染发 D，含
 *      shell 启动首 prompt；附着重放的历史帧同样入账 reportOsc）
 *   2. 刚创建未附着（terminals.changed 广播新增行）：诚实滞后语义「未检测」
 *      + 图标在场；点击附着后首个 D 帧即翻转
 *   3. 真·无集成形态对照（会话级 shell 覆盖为 shellint 不支持的 cmd/sh，
 *      P-20261004-57）：附着后照常出提示符但永无 OSC 133 帧——「未检测」
 *      与图标持续在场（诊断价值本体：该会话依赖族功能不可用）
 * 判定数据（runningMap/activityMap）是前端 store 内存态，本 spec 不做 store
 * 注入——三用例全部走真实 WS 帧流（与 session-idle-hint 的注入式判据互补）。
 * 键入命令路径受 Linux tmux 新 pane 首段键入丢字符缺口扰动（P-20261004-82
 * 登记），断言不依赖键入回显：集成检测只看帧入账，附着即有启动 D（shellint
 * 首 prompt 时序），无集成形态键不出现——两形态都不需要敲命令。
 * 会话本体走 API 播种（runtime=shell 纯终端不拉起 TUI），afterEach 清理。
 */

const tempDirs: string[] = []

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，保证确定性 + 防残留 tmux 进程） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterAll(async () => {
  for (const d of tempDirs) {
    try { await rm(d, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
})

/** 管理页（docked 侧栏常开）+ 按名取会话行 */
async function openManagerAndRow(page: Page, name: string) {
  await fixedLocale(page)
  // docked 管理页开合状态持久化在 localStorage：预置打开意图，首页引导即恢复
  await page.addInitScript(() => {
    localStorage.setItem('sc.agentTerminal.openState', JSON.stringify({ visible: true, mode: 'docked' }))
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  const row = view.locator('.ats-item').filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 15000 })
  return { view, row }
}

/** 附着会话（点击行）并等提示符：平台分支同既有终端 spec——Windows 默认
 *  PowerShell/cmd 提示符以 > 收尾；Linux bash/sh 以 $（root 为 #）收尾。
 *  幂等：boot 的 ensureDockedSelection 可能已自动附着本会话，点行仍选中 */
async function attachAndWaitPrompt(page: Page, row: ReturnType<Page['locator']>): Promise<void> {
  await row.click()
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText(serverIsLinux ? /[#$] / : />/, { timeout: 20000 })
}

test('附着集成会话：tooltip 转「shell 集成：已连接」，未检测弱灰图标消失', async ({ page, request }) => {
  const created = await createAgentSessionApi(request, { name: 'shellint-ind-on' })
  tempDirs.push(created.dir)

  const { row } = await openManagerAndRow(page, 'shellint-ind-on')
  await attachAndWaitPrompt(page, row)

  // D 帧入账（启动首 prompt 的 D，重放或活帧任一路径）→ 检测行「已连接」
  await expect(row).toHaveAttribute('title', /shell 集成：已连接/, { timeout: 10000 })
  // 已检测形态无弱灰图标（诊断语义只呈现缺失态，不打扰正常会话）
  await expect(row.locator('[data-test="session-shellint-missing"]')).toHaveCount(0)
})

test('刚创建未附着：诚实滞后「未检测」+ 图标在场；附着后转「已连接」', async ({ page, request }) => {
  // 锚位会话先建先附着：被测会话在页面稳定后才创建，观察点确定「未附着」。
  // 两名错开防 hasText 子串双命中（'lag' 是 'lag-anchor' 的前缀子串形态）
  const anchor = await createAgentSessionApi(request, { name: 'shellint-ind-anchor' })
  tempDirs.push(anchor.dir)
  const { view, row: preRow } = await openManagerAndRow(page, 'shellint-ind-anchor')
  await attachAndWaitPrompt(page, preRow)

  const created = await createAgentSessionApi(request, { name: 'shellint-ind-lag' })
  tempDirs.push(created.dir)
  const row = view.locator('.ats-item').filter({ hasText: 'shellint-ind-lag' })
  await expect(row).toBeVisible({ timeout: 15000 })

  // 未附着：本浏览器无该会话的 OSC 133 帧 → 未检测（诚实滞后语义，不谎报）。
  // 注意 title 断言取整词行：锚位会话行与本行名共享前缀，locator 已按整名过滤
  await expect(row).toHaveAttribute('title', /shell 集成：未检测到/)
  await expect(row.locator('[data-test="session-shellint-missing"]')).toBeVisible()

  // 附着后首个 D 帧即翻转（判定即数据）
  await attachAndWaitPrompt(page, row)
  await expect(row).toHaveAttribute('title', /shell 集成：已连接/, { timeout: 10000 })
  await expect(row.locator('[data-test="session-shellint-missing"]')).toHaveCount(0)
})

test('无 shell 集成形态（shell 覆盖 cmd/sh）：附着后仍「未检测」+ 图标持续在场', async ({ page, request }) => {
  // 会话级 shell 覆盖（P-20261004-57）传 shellint 不支持的 shell：服务端
  // shellint.Setup 返回 nil，会话照常起但永无 OSC 133 帧
  const created = await createAgentSessionApi(request, {
    name: 'shellint-ind-none',
    shell: serverIsLinux ? '/bin/sh' : 'cmd.exe',
  })
  tempDirs.push(created.dir)

  const { row } = await openManagerAndRow(page, 'shellint-ind-none')
  await attachAndWaitPrompt(page, row)

  // 出了提示符仍「未检测」：真无集成（对照用例 1——同为附着后形态，差异只在
  // 有无帧），诊断价值本体 = 该会话历史/空闲徽标等依赖族功能不可用
  await expect(row).toHaveAttribute('title', /shell 集成：未检测到/, { timeout: 10000 })
  await expect(row.locator('[data-test="session-shellint-missing"]')).toBeVisible()
})
