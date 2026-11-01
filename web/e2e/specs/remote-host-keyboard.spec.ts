import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, fetchWslHost } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 远程主机列表键盘导航 E2E：
 *   - ↑↓ 在可见行序列（目录头 + 主机卡）环绕移动，is-nav-active 高亮
 *   - 折叠目录的成员不参与导航（↓ 从目录头直接到根级主机）
 *   - Enter 激活目录头 = 折叠/展开（主机卡 Enter 与点击同语义，
 *     开终端为真实 SSH 连接，不在本 spec 触发）
 * 两台临时主机 + 一个目录：分组经 uiState API 直写（HTML5 合成拖拽在本环境
 * 不可用、naive-ui 子菜单项合成点击不稳，均非本 spec 受测面）；根级只剩既有
 * WSL 主机，行序完全确定。回环清理，不动 remote-console.spec 依赖的 WSL 主机。
 */

const BASE = API_BASE
const HOST_A = `e2e-kbd-host-a-${Math.random().toString(36).slice(2, 6)}`
const HOST_B = `e2e-kbd-host-b-${Math.random().toString(36).slice(2, 6)}`
const GROUP_NAME = `e2e-kbd-目录-${Math.random().toString(36).slice(2, 6)}`

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理远程管理持久化状态（服务端 uiState），保证用例从空分组开始 */
async function clearRemoteConsoleState() {
  const headers = await unlockHeaders()
  const res = await fetch(`${BASE}/api/ui-state`, { headers })
  const body = (await res.json().catch(() => null)) as { data?: Record<string, { remoteConsole?: unknown }> } | null
  const map = body?.data
  if (!map) return
  const clear: Record<string, { remoteConsole: null }> = {}
  for (const k of Object.keys(map)) {
    if (map[k]?.remoteConsole !== undefined) clear[k] = { remoteConsole: null }
  }
  if (Object.keys(clear).length > 0) {
    await fetch(`${BASE}/api/ui-state`, { method: 'PUT', headers, body: JSON.stringify(clear) })
  }
}

async function seedHost(name: string) {
  const headers = await unlockHeaders()
  const res = await fetch(`${BASE}/api/remotehosts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, host: '127.0.0.1', port: 22, user: 'e2e', authType: 'password', protocol: 'ssh', password: 'kbd-e2e-secret' }),
  })
  expect(res.ok).toBeTruthy()
}

async function deleteSeededHosts() {
  const headers = await unlockHeaders()
  const list = await (await fetch(`${BASE}/api/remotehosts`, { headers })).json()
  for (const h of ((list?.data || []) as Array<{ id?: string; name?: string }>)) {
    if (h.name === HOST_A || h.name === HOST_B) {
      await fetch(`${BASE}/api/remotehosts/${h.id}`, { method: 'DELETE', headers })
    }
  }
}

/** 根级主机确定性：删掉 WSL 之外的一切主机（共享实例上其他 spec 的残留
 *  会混进根级卡片、打乱行序；WSL 是 remote-console.spec 的依赖，保留） */
async function deleteNonWslHosts() {
  const headers = await unlockHeaders()
  const list = await (await fetch(`${BASE}/api/remotehosts`, { headers })).json()
  for (const h of ((list?.data || []) as Array<{ id?: string; name?: string }>)) {
    if (h.name && h.name !== 'WSL') {
      await fetch(`${BASE}/api/remotehosts/${h.id}`, { method: 'DELETE', headers })
    }
  }
}

/** node 侧直写 remoteConsole.groups：两台临时主机入组（uiState 按命名空间浅合并）。
 * 必须在页面卸载后写、写完再进页面：SPA 卸载路径的 beforeunload sendBeacon
 * 会把内存里的旧状态原样写回（uiState.ts forceSaveCurrentState），先写必被
 * 覆盖（tests/helpers.ts closeDshConsoleAndClearState 同款结论） */
async function writeGroupsViaNode() {
  const headers = await unlockHeaders()
  const hosts = await (await fetch(`${BASE}/api/remotehosts`, { headers })).json()
  const idOf = (n: string) => ((hosts?.data || []) as Array<{ name?: string; id?: string }>).find(h => h.name === n)?.id || ''
  const uiBody = await (await fetch(`${BASE}/api/ui-state`, { headers })).json()
  const map = (uiBody?.data || {}) as Record<string, Record<string, unknown>>
  const patch: Record<string, { remoteConsole: { groups: Array<{ id: string; name: string; hostIds: string[] }> } }> = {}
  for (const k of Object.keys(map)) {
    patch[k] = { remoteConsole: { groups: [{ id: 'grp-e2e-kbd', name: GROUP_NAME, hostIds: [idOf(HOST_A), idOf(HOST_B)] }] } }
  }
  if (Object.keys(patch).length > 0) {
    const put = await fetch(`${BASE}/api/ui-state`, { method: 'PUT', headers, body: JSON.stringify(patch) })
    expect(put.ok).toBeTruthy()
  }
}

async function openRemoteView(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/project`)
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
}

test.beforeAll(async () => {
  await clearRemoteConsoleState()
  await deleteNonWslHosts()
  await seedHost(HOST_A)
  await seedHost(HOST_B)
})

test.afterAll(async () => {
  await deleteSeededHosts()
  await clearRemoteConsoleState()
})

test('↑↓ 环绕移动高亮，目录头 Enter 折叠/展开，折叠成员不参与导航', async ({ page }) => {
  // 分组导航用例锚定金态 WSL 卡；记录缺失（跨拓扑金态无 WSL 域）= 环境边界
  // 按门控 skip（P-20261005-187）
  test.skip(!(await fetchWslHost(BASE)), 'WSL 主机记录未播种（跨拓扑金态无 WSL 域），跳过')
  await openRemoteView(page)
  // 卸载页面（让 beforeunload beacon 先落定）→ 写分组 → 再进页面读到新分组
  await page.goto('about:blank')
  await page.waitForTimeout(400)
  await writeGroupsViaNode()

  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/project`)
  await page.locator('.rail-btn[title="远程管理"]').click()
  const group = page.locator('.host-group').filter({ hasText: GROUP_NAME })
  await expect(group).toBeVisible({ timeout: 10000 })
  const wslCard = page.locator('.host-root .host-card').filter({ hasText: 'WSL' })
  await expect(page.locator('.host-root .host-card')).toHaveCount(1, { timeout: 5000 })

  // 聚焦侧栏：activeIdx=0 → 目录头高亮
  const sidebar = page.locator('.remote-sidebar')
  const groupHead = group.locator('.group-head')
  const cardA = group.locator('.host-card').filter({ hasText: HOST_A })
  const cardB = group.locator('.host-card').filter({ hasText: HOST_B })
  await sidebar.focus()
  await expect(groupHead).toHaveClass(/is-nav-active/)

  await page.keyboard.press('ArrowDown')
  await expect(cardA).toHaveClass(/is-nav-active/)
  await page.keyboard.press('ArrowDown')
  await expect(cardB).toHaveClass(/is-nav-active/)
  await page.keyboard.press('ArrowDown')
  await expect(wslCard).toHaveClass(/is-nav-active/)
  // 越界回绕到目录头
  await page.keyboard.press('ArrowDown')
  await expect(groupHead).toHaveClass(/is-nav-active/)
  await page.keyboard.press('ArrowUp')
  await expect(wslCard).toHaveClass(/is-nav-active/)

  // 回到目录头，Enter 折叠：体隐藏 + 箭头转向；↓ 直达根级主机（折叠成员不参与）
  await page.keyboard.press('ArrowDown')
  await expect(groupHead).toHaveClass(/is-nav-active/)
  await expect(group.locator('.group-body')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(group.locator('.group-body')).toBeHidden()
  await expect(groupHead.locator('.group-caret')).toHaveClass(/is-collapsed/)
  await page.keyboard.press('ArrowDown')
  await expect(wslCard).toHaveClass(/is-nav-active/)
  // 再 Enter 展开恢复
  await page.keyboard.press('ArrowUp')
  await expect(groupHead).toHaveClass(/is-nav-active/)
  await page.keyboard.press('Enter')
  await expect(group.locator('.group-body')).toBeVisible()
})
