import { test, expect, type Page, type Locator } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 远程主机列表滚动可达性 + 单行密度 E2E（P-20261030-3）：
 * 用户实测多主机后列表无滚动条、末位主机看不到也点不到——根因是包裹态 n-spin
 * 的 .n-spin-container/.n-spin-content 两层普通块盒拦断了 flex 纵向滚动链
 * （.host-tree 的 overflow-y:auto + flex:1 永不生效，被 .remote-sidebar
 * overflow:hidden 裁剪）。修复后本 spec 以 16 台主机夹具回归：
 *   1. 内嵌形态（项目页 ActivityBar 入口）：.host-tree 可滚动（scrollHeight >
 *      clientHeight = 滚动链贯通的判别断言）→ 滚动到底后末位卡片完整可见可点，
 *      点击开编辑弹窗且名称对机；
 *   2. 独立形态（首页全屏 overlay）：同套滚动可达断言（双宿主形态同链）；
 *   3. 密度：单行紧凑形态（foot 信息行已移除、地址次显灰显、首卡高度 < 44px）
 *      + 全局界面密度档联动（uidensity=compact 时卡片随 --row-pad-y 收窄，
 *      经服务端 settings 持久化链路）。
 * 主机经 API 播种/清理，不动其他 spec 依赖的既有主机（WSL 等）。
 */

const BASE = API_BASE
const HOST_COUNT = 16
const HOST_NAMES = Array.from({ length: HOST_COUNT }, (_, i) => `e2e-scroll-${String(i).padStart(2, '0')}`)

/** 小视口保证 16 台主机必然溢出列表视口（默认 1280×720 下不溢出无断言力） */
test.use({ viewport: { width: 1000, height: 560 } })

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理远程管理持久化状态（服务端 uiState）：空分组起步，全部卡片落根级行序确定 */
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

async function seedHosts() {
  const headers = await unlockHeaders()
  for (const name of HOST_NAMES) {
    const res = await fetch(`${BASE}/api/remotehosts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, host: '127.0.0.1', port: 22, user: 'e2e', authType: 'password', protocol: 'ssh', password: 'scroll-e2e-secret' }),
    })
    expect(res.ok, `播种主机 ${name} 应成功`).toBeTruthy()
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

/** API 列表序 = 前端 store 序（服务端按 key 字母序，与卡片渲染序同源），
 * 取本夹具在列表中的最后一台 = 夹具内最靠后的卡片 */
async function lastSeededHostName(): Promise<string> {
  const headers = await unlockHeaders()
  const list = await (await fetch(`${BASE}/api/remotehosts`, { headers })).json()
  const names = ((list?.data || []) as Array<{ name?: string }>).map(h => h.name || '')
  return HOST_NAMES.filter(n => names.includes(n)).at(-1) || ''
}

async function getUidensity(): Promise<string | undefined> {
  const headers = await unlockHeaders()
  const res = await fetch(`${BASE}/api/settings`, { headers })
  return ((await res.json()) as { data?: { uidensity?: string } }).data?.uidensity
}

async function putUidensity(v: string) {
  const headers = await unlockHeaders()
  const res = await fetch(`${BASE}/api/settings`, { method: 'PUT', headers, body: JSON.stringify({ uidensity: v }) })
  expect(res.ok).toBeTruthy()
}

test.beforeAll(async () => {
  await clearRemoteConsoleState()
  await deleteSeededHosts() // 上轮失败中断的残留兜底（幂等）
  await seedHosts()
})

test.afterAll(async () => {
  await deleteSeededHosts()
  await clearRemoteConsoleState()
})

/** 列表视口内完整可见（底边不超出滚动容器底缘）——「看得见」的精确判据 */
async function expectFullyInScrollView(card: Locator, tree: Locator) {
  const cb = await card.boundingBox()
  const tb = await tree.boundingBox()
  expect(cb, '卡片应有 boundingBox').toBeTruthy()
  expect(tb, 'host-tree 应有 boundingBox').toBeTruthy()
  expect(cb!.y, '卡片顶边应在列表视口内').toBeGreaterThanOrEqual(tb!.y - 1)
  expect(cb!.y + cb!.height, '卡片底边应不超出列表视口底缘').toBeLessThanOrEqual(tb!.y + tb!.height + 1)
}

/** 打开编辑弹窗并核对主机名（点击卡片 = 编辑弹窗是 P-20261030-3 的定调语义） */
async function expectClickOpensEditModal(page: Page, card: Locator) {
  const name = (await card.locator('.host-card-name').textContent())?.trim() || ''
  expect(name, '卡片应有名称文本').not.toBe('')
  await card.click()
  const modal = page.locator('.n-modal').filter({ hasText: '编辑远程主机' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  const nameInput = modal.locator('.n-form-item').filter({
    has: page.locator('.n-form-item-label', { hasText: '名称' }),
  }).locator('input')
  await expect(nameInput).toHaveValue(name, '编辑弹窗名称应与点击的卡片对机')
  // 关弹窗（取消钮），不影响后续断言
  await modal.locator('button').filter({ hasText: '取消' }).first().click()
  await expect(modal).toBeHidden({ timeout: 5000 })
}

test('内嵌形态：超长主机列表可滚动，末位主机可达可点开编辑弹窗，单行密度', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/project`)
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  const tree = page.locator('.host-tree')
  await expect(tree).toBeVisible({ timeout: 10000 })
  // 共享实例可能还有其他 spec 的主机（金态 WSL 等）：只保证夹具 16 台都在
  await expect(page.locator('.host-card')).toHaveCount(HOST_COUNT + 1, { timeout: 10000 })

  // 判别断言：滚动链贯通后 .host-tree 高度被约束 → 内容溢出自身视口；
  // 修复前 host-tree 被内容撑高（scrollHeight == clientHeight），溢出发生在
  // n-spin 容器层且被侧栏 overflow:hidden 裁剪——无滚动条也不可达
  const scrollable = await tree.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
  expect(scrollable, 'host-tree 应可滚动（scrollHeight > clientHeight）').toBe(true)

  // 滚动到底 → 末位卡片完整进入视口并可点击开编辑弹窗
  await tree.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(200)
  const lastCard = page.locator('.host-card').last()
  await expect(lastCard).toBeVisible()
  await expectFullyInScrollView(lastCard, tree)
  await expectClickOpensEditModal(page, lastCard)

  // 夹具内最靠后的主机（可能不是全列表末位——共享实例还有其他 spec 的主机）
  const lastName = await lastSeededHostName()
  expect(lastName, '夹具主机应存在').not.toBe('')
  const lastSeeded = page.locator('.host-card').filter({ hasText: lastName }).first()
  await lastSeeded.scrollIntoViewIfNeeded()
  await expectFullyInScrollView(lastSeeded, tree)
  await expectClickOpensEditModal(page, lastSeeded)

  // 单行密度终态：foot 信息行（终端数/开终端提示/诊断时间）已移除，
  // 地址次显保留，首卡高度为单行量级
  await tree.evaluate((el) => { el.scrollTop = 0 })
  await expect(page.locator('.host-card-foot')).toHaveCount(0)
  await expect(page.locator('.host-card').first().locator('.host-card-addr')).toBeVisible()
  const h = (await page.locator('.host-card').first().boundingBox())?.height || 0
  expect(h, `单行卡片高度应 < 44px（实测 ${h}px）`).toBeLessThan(44)
})

test('独立形态（首页 overlay）：超长列表同样可滚动，末位主机可达', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.home-action-btn[title="远程管理"]').click()
  const overlay = page.locator('.remote-console-overlay')
  await expect(overlay).toBeVisible({ timeout: 10000 })
  const tree = overlay.locator('.host-tree')
  await expect(tree).toBeVisible({ timeout: 10000 })
  // 共享实例可能还有其他 spec 的主机（金态 WSL 等）：只保证夹具 16 台都在
  await expect(overlay.locator('.host-card')).toHaveCount(HOST_COUNT + 1, { timeout: 10000 })

  const scrollable = await tree.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
  expect(scrollable, 'overlay 内 host-tree 应可滚动').toBe(true)

  await tree.evaluate((el) => { el.scrollTop = el.scrollHeight })
  await page.waitForTimeout(200)
  const lastCard = overlay.locator('.host-card').last()
  await expect(lastCard).toBeVisible()
  await expectFullyInScrollView(lastCard, tree)
  await expectClickOpensEditModal(page, lastCard)
})

test('密度档联动：uidensity=compact 经服务端持久化后卡片收窄', async ({ page }) => {
  const original = await getUidensity()
  // 舒适档基线（未配置 = comfortable 缺省）
  await putUidensity('comfortable')
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/project`)
  await page.locator('.rail-btn[title="远程管理"]').click()
  const tree = page.locator('.host-tree')
  await expect(tree).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.host-card').first()).toBeVisible({ timeout: 10000 })
  const comfy = (await page.locator('.host-card').first().boundingBox())?.height || 0

  // 紧凑档：uidensity 走服务端 settings（store 首拉 + settings.changed 多端跟随），
  // reload 后 boot 从服务端读档 → --row-pad-y 注入 3px → 卡片高度收窄
  await putUidensity('compact')
  await page.reload()
  await gotoAndUnlock(page, page.url())
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(tree).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.host-card').first()).toBeVisible({ timeout: 10000 })
  const compact = (await page.locator('.host-card').first().boundingBox())?.height || 0
  expect(compact, `紧凑档卡片应矮于舒适档（compact=${compact} comfortable=${comfy}）`).toBeLessThan(comfy)

  // 还原档位（共享实例全局态，勿泄入其他 spec）
  await putUidensity(typeof original === 'string' ? original : 'comfortable')
})
