import { test, expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 用户偏好层服务端漫游（P-20261007-1 Settings Sync）E2E：
 *   1. 旧值播种（须在服务端尚无 userPrefs 时跑——播种语义只对「服务端从未写过」
 *      生效，{} 已是显式空真值；global-setup 套件前用 PUT null 复位回「未配置」，
 *      afterAll 原样还原（null 用 PUT null），.e2e-data 残留时仍保留 skip 守卫）：
 *      全新上下文先种 localStorage
 *      （模拟主力机升级前旧值）→ 打开即播种上传，GET /settings userPrefs 出现键位
 *      覆盖与音效关闭，且本机镜像不回退
 *   2. 跨设备跟随：A 上下文经设置页关「选中即复制」（写正门直写行）→ 防抖上云，
 *      GET userPrefs.terminal.copyOnSelect=false；全新 B 上下文（独立 localStorage
 *      = 另一台设备）打开工作台，启动首拉服务端 wins → 本地镜像被漫游值覆盖
 *   3. agent 编程写 + 分轨边界：API PUT userPrefs 仅 terminal 段（agent 部分写形态）
 *      → 打开即应用跟随开关；字号镜像 font-settings（设备本地轨）不被漫游触碰
 * userPrefs 是服务端全局设置（.e2e-data 跨用例持久）：beforeAll 记录原值，
 * afterAll 原样还原（null 经 PUT null 恢复「未配置」形态，不再退化为 {}）。
 * 本 spec 显式管理服务端真值，打开新上下文时传 resetUserPrefs=false 跳过
 * tests/helpers.ts 的逐 context 复位（否则会清掉刚写入、待跟随的漫游值）。
 */

let savedUserPrefs: unknown = null

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

type UserPrefs = {
  keymap?: Record<string, string>
  notify?: { dnd?: Record<string, unknown>; sound?: boolean; simple?: boolean }
  terminal?: { copyOnSelect?: boolean; followAppTheme?: boolean }
}

async function getUserPrefs(request: APIRequestContext): Promise<UserPrefs | null> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/settings`, { headers })
  return ((await res.json()) as { data?: { userPrefs?: UserPrefs | null } }).data?.userPrefs ?? null
}

async function putUserPrefs(request: APIRequestContext, value: UserPrefs | null): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.put(`${API_BASE}/api/settings`, { headers, data: { userPrefs: value } })
  expect(res.status()).toBe(200)
}

/** 全新浏览器上下文（独立 localStorage = 另一台设备的浏览器）+ 固定 locale 过锁 */
async function openFreshDevice(
  browser: Browser,
  seed?: (ctx: BrowserContext) => void,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext()
  if (seed) seed(ctx)
  const page = await ctx.newPage()
  await fixedLocale(page)
  // 本 spec 逐用例显式布置服务端真值（播种/跨设备跟随/agent 写），跳过 context 级复位
  await gotoAndUnlock(page, `${API_BASE}/`, { resetUserPrefs: false })
  return { ctx, page }
}

test.beforeAll(async ({ request }) => {
  savedUserPrefs = await getUserPrefs(request)
})

test.afterAll(async ({ request }) => {
  // 原样还原：原值 null 经 PUT null 清空回「未配置」形态（播种分支可复现），
  // 原值对象则整体写回
  await putUserPrefs(request, savedUserPrefs as UserPrefs | null)
})

test('旧值首启播种上传（服务端无 userPrefs → 本机偏差上云）', async ({ browser, request }) => {
  // 播种前提：服务端从未写过 userPrefs（GET null）。{} 是显式空真值——此时
  // 整表替换语义会把本机偏差重置而非播种；global-setup 已用 PUT null 复位，
  // 异常残留（崩溃中断等）时仍 skip 保稳
  const existing = await getUserPrefs(request)
  test.skip(existing !== null, '服务端已有 userPrefs（持久数据面残留），播种场景仅在无漫游偏好的数据面可模拟')

  const { ctx, page } = await openFreshDevice(browser, (c) => {
    c.addInitScript(([km, snd]) => {
      window.localStorage.setItem(km, JSON.stringify({ closeTab: 'ctrl+alt+x' }))
      window.localStorage.setItem(snd, '0')
    }, ['sc.keymapOverrides', 'notify-sound'] as const)
  })
  // 首启播种：本机偏差上传，服务端出现同形偏差集
  await expect.poll(async () => await getUserPrefs(request)).toEqual({
    keymap: { closeTab: 'ctrl+alt+x' },
    notify: { sound: false },
  })
  // 播种后本机镜像不回退（服务端真值与本机一致，应用为幂等短路）
  expect(await page.evaluate((k) => localStorage.getItem(k), 'sc.keymapOverrides'))
    .toBe(JSON.stringify({ closeTab: 'ctrl+alt+x' }))
  await ctx.close()
})

test('A 端关复制选中 → 全新 B 上下文打开即跟随（跨设备漫游）', async ({ page, browser, request }) => {
  // 干净起点：清空历史偏差（回「未配置」形态），A 端启动对账短路
  await putUserPrefs(request, null)

  // 与 keymap-custom 同款入口：种子项目进项目页开设置（写路径 UI 全链路）
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // 设置 → 终端 → 选中即复制关闭（直写行：写正门即挂脏标记防抖上云）
  await page.locator('.rail-btn[title="设置"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible()
  await page.locator('.settings-nav .nav-item').filter({ hasText: '终端' }).click()
  const row = page.getByTestId('settings-terminal-copy-on-select')
  await row.scrollIntoViewIfNeeded()
  await row.locator('.n-checkbox').click()
  // 本地镜像翻转（默认开=无键，关='0'）
  await expect.poll(() => page.evaluate(() => localStorage.getItem('sc.terminal.copyOnSelect'))).toBe('0')
  // 防抖上云：服务端 userPrefs 出现 terminal 偏差
  await expect.poll(async () => (await getUserPrefs(request))?.terminal?.copyOnSelect).toBe(false)
  await page.locator('.settings-close').click()

  // 全新 B 上下文（另一台设备）：启动首拉服务端 wins，镜像被漫游值覆盖
  const { ctx, page: pageB } = await openFreshDevice(browser)
  await expect.poll(() => pageB.evaluate(() => localStorage.getItem('sc.terminal.copyOnSelect'))).toBe('0')
  await ctx.close()
})

test('agent 编程写 userPrefs 部分段 → 应用且不触碰设备本地轨', async ({ browser, request }) => {
  // agent 形态的部分写（仅 terminal 段）：键位/通知段缺省=回默认（整表替换语义）
  await putUserPrefs(request, { terminal: { followAppTheme: false } })

  const { ctx, page } = await openFreshDevice(browser)
  // 跟随开关漫游应用：镜像落 'off'（默认开=无键）
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k), 'terminal-theme-follow')).toBe('off')
  // 分轨边界：字号是设备本地轨，漫游应用不创建/不改写其镜像
  expect(await page.evaluate((k) => localStorage.getItem(k), 'font-settings')).toBeNull()
  await ctx.close()
})
