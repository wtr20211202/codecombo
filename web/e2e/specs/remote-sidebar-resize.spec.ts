import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, unlockIfNeeded, waitForAppReady, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 远程主机列表侧栏可调宽度 E2E（P-20261106-5）：
 *   1. 拖拽调宽：把手 pointer 拖拽 → .remote-sidebar 实时变宽 + localStorage
 *      记忆落盘（sc.remoteConsole.sidebarWidth）；反向拖过下界收在 min 钳制；
 *   2. 宽度记忆：拖宽后刷新页面恢复持久宽度（load 读回）；双击把手恢复默认
 *      260；键盘（聚焦后方向键/Home/End）微调即落盘——ARIA slider 语义。
 * 主机经 API 播种/清理，不动其他 spec 依赖的既有主机（WSL 等）。
 */

const BASE = API_BASE
const WIDTH_KEY = 'sc.remoteConsole.sidebarWidth'
const DEFAULT_W = 260
const MIN_W = 200
const MAX_W = 480
const HOST_NAMES = ['e2e-resize-alpha', 'e2e-resize-beta']

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function seedHosts() {
  const headers = await unlockHeaders()
  for (const name of HOST_NAMES) {
    await fetch(`${BASE}/api/remotehosts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, host: '127.0.0.1', port: 22, user: 'e2e', authType: 'password', protocol: 'ssh', password: 'resize-e2e-secret' }),
    })
  }
}

async function deleteSeededHosts() {
  const headers = await unlockHeaders()
  const list = await (await fetch(`${BASE}/api/remotehosts`, { headers })).json()
  for (const h of ((list?.data || []) as Array<{ id?: string; name?: string }>)) {
    if (h.name && HOST_NAMES.includes(h.name)) {
      await fetch(`${BASE}/api/remotehosts/${h.id}`, { method: 'DELETE', headers })
    }
  }
}

test.beforeAll(async () => {
  await deleteSeededHosts() // 上轮失败中断的残留兜底（幂等）
  await seedHosts()
})

test.afterAll(async () => {
  await deleteSeededHosts()
})

/** 进入内嵌远程管理视图（项目页 ActivityBar 入口，zh-CN 固定 locale） */
async function openRemoteConsole(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/project`)
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.remote-sidebar')).toBeVisible({ timeout: 10000 })
}

/** 刷新后重新进入（同 context：locale 注入仍在，只补就绪等待/解锁与导航） */
async function openRemoteConsoleAfterReload(page: Page) {
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.remote-sidebar')).toBeVisible({ timeout: 10000 })
  await expectSeededHosts(page)
}

/** 夹具主机已渲染（共享实例还有金态 WSL 等其他主机，不按总数断言——只等本夹具两台到位） */
async function expectSeededHosts(page: Page) {
  for (const name of HOST_NAMES) {
    await expect(page.locator('.host-card').filter({ hasText: name })).toHaveCount(1, { timeout: 10000 })
  }
}

/** 侧栏实测宽（border-box：与内联 width px 值一致） */
async function sidebarWidth(page: Page): Promise<number> {
  const box = await page.locator('.remote-sidebar').boundingBox()
  expect(box, '侧栏应有 boundingBox').toBeTruthy()
  return box!.width
}

/** 抓住把手水平拖 delta px（pointer 事件链：down → move(steps) → up） */
async function dragResizer(page: Page, delta: number) {
  const handle = page.locator('.remote-root .sidebar-resizer')
  const box = await handle.boundingBox()
  expect(box, '宽度把手应有 boundingBox').toBeTruthy()
  const cx = box!.x + box!.width / 2
  const cy = box!.y + box!.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + delta, cy, { steps: 5 })
  await page.mouse.up()
}

test('拖拽调宽：侧栏实时变宽 + localStorage 落盘 + 越下界收在 min 钳制', async ({ page }) => {
  await openRemoteConsole(page)
  await expectSeededHosts(page)

  // 默认宽度 = 旧固定宽 260（行为兼容：未拖拽过的存量会话形态不变）
  expect(await sidebarWidth(page)).toBeCloseTo(DEFAULT_W, 0)

  // 右拖 +120：侧栏实时变宽，松开落盘
  await dragResizer(page, 120)
  const widened = await sidebarWidth(page)
  expect(widened, '拖拽 +120px 后侧栏应变宽').toBeCloseTo(DEFAULT_W + 120, 0)
  const stored = await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY)
  expect(stored, '宽度应写入 localStorage 记忆键').toBe(String(DEFAULT_W + 120))

  // 左拖远超下界（380-300=80 < 200）：收在 200 钳制（参数化 min，不塌缩到不可用）
  await dragResizer(page, -300)
  expect(await sidebarWidth(page)).toBeCloseTo(MIN_W, 0)
  expect(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY)).toBe(String(MIN_W))
})

test('宽度记忆：刷新恢复持久宽度；双击复位默认；键盘方向键/Home/End 微调', async ({ page }) => {
  await openRemoteConsole(page)
  await expectSeededHosts(page)

  // 拖宽到 400 → 刷新 → 重新进入远程管理 → 恢复 400（非默认 260 = load 读回生效）
  await dragResizer(page, 140)
  expect(await sidebarWidth(page)).toBeCloseTo(400, 0)
  await page.reload()
  await openRemoteConsoleAfterReload(page)
  expect(await sidebarWidth(page)).toBeCloseTo(400, 0)

  // ARIA slider 语义：role/valuemin/valuemax/valuenow 与实际宽度一致
  const handle = page.locator('.remote-root .sidebar-resizer')
  await expect(handle).toHaveAttribute('role', 'slider')
  await expect(handle).toHaveAttribute('aria-valuemin', String(MIN_W))
  await expect(handle).toHaveAttribute('aria-valuemax', String(MAX_W))
  await expect(handle).toHaveAttribute('aria-valuenow', '400')

  // 双击复位默认 260 并落盘
  await handle.dblclick()
  expect(await sidebarWidth(page)).toBeCloseTo(DEFAULT_W, 0)
  expect(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY)).toBe(String(DEFAULT_W))

  // 键盘可达：聚焦后 →/← 步进 ±16 即落盘；Home 到 min、End 到 max
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  expect(await sidebarWidth(page)).toBeCloseTo(DEFAULT_W + 16, 0)
  await page.keyboard.press('Shift+Tab') // 让焦点离开把手，验证宽度不是焦点巧合
  await page.keyboard.press('ArrowRight')
  expect(await sidebarWidth(page)).toBeCloseTo(DEFAULT_W + 16, 0)
  await handle.focus()
  await page.keyboard.press('Home')
  expect(await sidebarWidth(page)).toBeCloseTo(MIN_W, 0)
  await page.keyboard.press('End')
  expect(await sidebarWidth(page)).toBeCloseTo(MAX_W, 0)
  expect(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY)).toBe(String(MAX_W))
})
