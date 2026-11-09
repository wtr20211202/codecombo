import type { Locator, Page, APIRequestContext } from '@playwright/test'
import { expect } from '@playwright/test'
import { LOCALE_STORAGE_KEY } from '../src/stores/locale-constants'
import { API_BASE } from './api-base'

// E2E 公共辅助：所有 spec 共享的解锁 / 锁定配置 / app ready 等前置

// 默认解锁密码（与 store.DEFAULT_PASSWORD 对应）
export const DEFAULT_PASSWORD = 'admin'

// 锁定遮罩选择器（与 LockScreenOverlay.vue 的 .lock-overlay 类名绑定）
export const LOCK_OVERLAY = '.lock-overlay'

// 固定 zh-CN locale：所有 spec 的中文选择器（如「解锁」「添加项目」「稍后提醒」）
// 在 en-US 下会失效。在 page.goto 前注入 localStorage，确保 i18n 不漂移
export async function fixedLocale(page: Page, locale = 'zh-CN') {
  await page.addInitScript(([key, loc]) => {
    localStorage.setItem(key, loc)
  }, [LOCALE_STORAGE_KEY, locale])
}

// 等待 app 启动遮罩消失（main.ts boot 阶段渲染的 .app-boot-loading）
export async function waitForAppReady(page: Page) {
  await expect(page.locator('.app-boot-loading')).toHaveCount(0, { timeout: 15000 })
}

// 若启用锁定则解锁，否则直接返回
// 解锁成功后会自动弹出「建议修改默认密码」dialog，必须点「稍后提醒」关掉，否则 mask 挡住后续交互
export async function unlockIfNeeded(page: Page) {
  const overlay = page.locator(LOCK_OVERLAY)
  // 轮询等遮罩出现（visible = isLocked && isReady 的 boot 竞态）；
  // 上限 5s：锁定功能关闭的用例遮罩永不出现，超时视为未启用直接返回
  const deadline = Date.now() + 5000
  while (await overlay.count() === 0) {
    if (Date.now() > deadline) return
    await page.waitForTimeout(200)
  }
  // 全新数据目录首跑：遮罩以设密模式出现（按钮为「设置密码并进入」，表单多一个
  // 确认密码框）——与解锁共用 DEFAULT_PASSWORD，提交后即进入未锁定态。
  // 此前该形态会让「解锁」按钮定位超时，隔离实例（非共享 .e2e-data）无法直接跑 spec
  const setupBtn = overlay.locator('button').filter({ hasText: '设置密码并进入' })
  if (await setupBtn.count() > 0) {
    const fields = overlay.locator('.lock-form input')
    await fields.first().fill(DEFAULT_PASSWORD)
    await fields.nth(1).fill(DEFAULT_PASSWORD)
    await setupBtn.click()
  } else {
    // Chromium 下密码框走 text-security 主路径（非 type=password），按表单结构定位
    const input = overlay.locator('.lock-form input').first()
    const btn = overlay.locator('button').filter({ hasText: '解锁' }).first()
    await input.fill(DEFAULT_PASSWORD)
    await expect(btn).toBeEnabled({ timeout: 2000 })
    await btn.click()
  }
  await expect(overlay).toHaveCount(0, { timeout: 10000 })
  const laterBtn = page.getByRole('button', { name: '稍后提醒' })
  if (await laterBtn.count() > 0) {
    await laterBtn.click()
    await expect(laterBtn).toHaveCount(0, { timeout: 3000 })
  }
}

// 用户偏好漫游面逐 context 复位（P-20261007-1）：userPrefs 是服务端全局单键，
// 上个用例经写路径留下的键位/通知/终端偏差会泄入下个用例的启动首拉（fresh
// context 不再等于出厂默认）——每个新 context 首次 goto 前 PUT null 恢复
// 「未配置」形态（null 而非 {}：null 走播种分支，本地种子用例不被空真值清掉）。
// 同一 context 的第二标签/重复 goto 不重复复位；锁定启用/未设密时跳过（API
// 423，且不引入解锁失败限流）；失败 best-effort 不拦测试（同 global-setup 哲学）。
const prefsResetContexts = new WeakSet<object>()

async function resetUserPrefsOnce(context: object): Promise<void> {
  if (prefsResetContexts.has(context)) return
  prefsResetContexts.add(context)
  try {
    const stateRes = await fetch(`${API_BASE}/api/lock/state`, { signal: AbortSignal.timeout(3000) })
    const state = ((await stateRes.json()) as { enabled?: boolean; needsSetup?: boolean })
    if (state.enabled || state.needsSetup) return
    const getRes = await fetch(`${API_BASE}/api/settings`, { signal: AbortSignal.timeout(3000) })
    const current = ((await getRes.json()) as { data?: { userPrefs?: unknown } }).data?.userPrefs ?? null
    if (current === null) return
    await fetch(`${API_BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userPrefs: null }),
      signal: AbortSignal.timeout(3000),
    })
  } catch { /* 复位失败不拦测试：残留偏差只影响首拉断言（定向 spec 自行复位） */ }
}

// goto + 等 app ready + 容忍两种锁定状态（锁定开关被其他 spec 切换时仍稳定）
// core-workflow 等不关心锁定态的 spec 统一用这个入口，避免与 clone-flow/lock.spec 并行时互相干扰。
// resetUserPrefs=false 仅给「显式管理服务端 userPrefs 后要跨设备跟随」的 spec 用
//（如 userprefs-roaming：B 上下文必须看到 A 上下文刚写入的漫游值，不能被复位清掉）
export async function gotoAndUnlock(page: Page, url: string, opts?: { resetUserPrefs?: boolean }) {
  if (opts?.resetUserPrefs !== false) await resetUserPrefsOnce(page.context())
  await page.goto(url)
  await waitForAppReady(page)
  await unlockIfNeeded(page)
}

// 新建智能体会话（B1 对话框入口）：点侧栏「新建会话」→ 对话框以默认运行时直接确认「创建」。
// 会话出现在列表由调用方的 .ats-item 计数断言接力；这里只负责驱动完对话框并等它关闭
export async function createAgentSession(page: Page, view: Locator): Promise<void> {
  await view.getByRole('button', { name: '新建会话' }).first().click()
  const dialog = page.locator('.n-modal', { hasText: '新建智能体会话' })
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await dialog.getByRole('button', { name: '创建', exact: true }).click()
  await expect(dialog).toBeHidden({ timeout: 10000 })
}

// 读取当前上下文的锁令牌（P-20261019-2）：令牌改服务端下发的 HttpOnly cookie
// 载体（sc_lock_token），页面 JS 与 localStorage 都读不到——Playwright 的
// context.cookies() 可读 HttpOnly cookie，是 e2e 侧取令牌的唯一正道。
// 页内同源 fetch 无需再带 X-Lock-Token 头（浏览器自动携带 cookie）
export async function getLockToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies()
  return cookies.find((c) => c.name === 'sc_lock_token')?.value ?? ''
}

// 通过 API 设置锁定开关（避免 UI 多步操作）
// 前置：调用方必须已解锁（HttpOnly cookie 会话有效），否则 PUT /config 会 423
export async function setLockEnabled(page: Page, enabled: boolean): Promise<void> {
  const token = await getLockToken(page)
  const r = await page.request.put('/api/lock/config', {
    headers: { 'X-Lock-Token': token },
    data: {
      enabled,
      currentPassword: DEFAULT_PASSWORD,
      autoLockEnabled: false,
      autoLockMinutes: 120,
      tokenTTLMinutes: 120,
    },
    failOnStatusCode: false,
  })
  expect(r.ok()).toBeTruthy()
}

// 首页项目卡片按项目名精确定位（锚定 .project-name 子元素整词匹配）。
// 禁止对整卡 hasText 子串匹配：git-test 推送夹具（本地 Gitea 可达时种子）的
// 卡片路径文本为「<repo>/.e2e-data/fixtures/git-test」，其中含有 "simple-coding"
// 子串——整卡 hasText 会双中且 .first() 按服务端列表序命中 git-test 卡，
// 进错项目后文件树/分支类断言全红（远端 URL「…/coding/simple-coding.git」
// 同型误命中，file-reveal.spec 已有同款先例）
export function projectCardByName(page: Page, name: string): Locator {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.project-card').filter({
    has: page.locator('.project-name').filter({ hasText: re }),
  })
}

// 量树尾留白并给出右键点（容器内相对 y）：末行底缘之下留白 ≥16px 才算可用
//（过窄的缝量测微差就会点到行上），否则返回 -1。evaluate 直传，内聚无闭包。
function measureTreeTailGap(el: HTMLElement): number {
  const box = el.getBoundingClientRect()
  let bottom = box.top
  el.querySelectorAll('.tree-item').forEach((item) => {
    bottom = Math.max(bottom, item.getBoundingClientRect().bottom)
  })
  const gap = box.bottom - bottom
  return gap >= 16 ? Math.round(bottom - box.top + gap / 2) : -1
}

// 文件树空白区右键（= 项目根上下文菜单，「生成分享链接」path 为空串）。
// 禁止用固定坐标（如 position:{x:60,y:120}）：该 y 随树内容/行高/头部按钮
// 变化会落到某个目录行上，右键变成「分享该目录」（run24：share-ttl 等用例
// 误分享了 web 目录，「（项目根）」行自然找不到）。这里按实测最后一行底缘
// 之下取空白点——树行占满无空白时回落到容器底部留白并如实报错。
// 树内容高过容器（种子项目文件数增长，可见行撑满滚动区）时，先把树内
// overflow:auto 的滚动容器（FileTreeView 的 .virtual-list-container）滚到底
// 再量尾部留白——虚拟列表按行高记账的收尾差额会落成末行之下的可视留白，
// 语义仍是真实用户的「滚动后右键空白区」，滚动后仍无留白才如实报错。
// 文件树面板开合是服务端 uiState（跨用例共享）：前序用例可能收起侧栏，
// 用例不能假定它是开的（实测复跑时侧栏为收起态，树 0×0、行全部 hidden）；
// 按活动栏 active 类归一化到打开态，再等树量到尺寸。
export async function rightClickTreeBackground(page: Page, selector = '.tree-list'): Promise<void> {
  const tree = page.locator(selector)
  const treeReady = () => tree.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }).catch(() => false)
  if (!(await treeReady())) {
    const railFiles = page.locator('[data-testid="rail-files"]').first()
    const active = await railFiles.evaluate(el => el.classList.contains('active')).catch(() => false)
    if (!active) await railFiles.click({ force: true }).catch(() => { /* 窄屏无活动栏时交给下方轮询报错 */ })
  }
  await expect.poll(treeReady, { timeout: 5000 }).toBe(true)
  // 等首行落地再量底缘：加载窗口内量到空树会按整幅高度取点，落点可能在随后
  // 渲染出的行上
  await expect(tree.locator('.tree-item').first()).toBeVisible()
  let y = await tree.evaluate(measureTreeTailGap)
  if (y < 0) {
    await tree.evaluate((el) => {
      const scrollable = (s: Element) => {
        const oy = getComputedStyle(s).overflowY
        return (oy === 'auto' || oy === 'scroll') && s.scrollHeight > s.clientHeight
      }
      const scroller = [el, ...el.querySelectorAll('*')].find(scrollable)
      if (scroller) scroller.scrollTop = scroller.scrollHeight
    })
    // 滚动事件触发虚拟窗口切片重算后 Vue 才重排行（异步 flush），短轮询等重排
    // 落定再量——轮询耗尽仍无留白才如实报错
    const deadline = Date.now() + 5000
    while (y < 0 && Date.now() < deadline) {
      await page.waitForTimeout(100)
      y = await tree.evaluate(measureTreeTailGap)
    }
    if (y < 0) throw new Error(`${selector} 无空白区域可右键（滚动到底后树尾仍无留白）`)
  }
  await tree.click({ button: 'right', position: { x: 60, y } })
}

// dsh 控制台用例的 afterEach 收尾：先卸载 SPA 再清理服务端 uiState。
// 用例结束时控制台视图保持打开（v-show 保活），开关状态会持久化到服务端
// uiState 并在后续用例的新页面原样恢复——恢复出的全屏控制台遮挡首页项目卡，
// 曾致全量串行套件后续用例级联失败。清理必须放在页面卸载之后：SPA 销毁路径
// 上的 beforeunload sendBeacon 会把内存里的「控制台打开」状态原样写回
// （uiState.ts forceSaveCurrentState），先清必被覆盖；about:blank 卸载并留
// 短暂间隔让 beacon 落定，再走 API 清空，清完即终态
export async function closeDshConsoleAndClearState(page: Page, request: APIRequestContext, apiBase: string): Promise<void> {
  await page.goto('about:blank').catch(() => { /* 页面已销毁等场景 */ })
  await page.waitForTimeout(300)
  const res = await request.post(`${apiBase}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  const headers = { 'X-Lock-Token': token }
  const stateRes = await request.get(`${apiBase}/api/ui-state`, { headers })
  const body = (await stateRes.json().catch(() => null)) as { data?: Record<string, { dshConsole?: unknown }> } | null
  const map = body?.data
  if (!map) return
  const clear: Record<string, { dshConsole: null }> = {}
  for (const k of Object.keys(map)) {
    if (map[k]?.dshConsole !== undefined) clear[k] = { dshConsole: null }
  }
  if (Object.keys(clear).length > 0) {
    await request.put(`${apiBase}/api/ui-state`, { headers, data: clear })
  }
}

// 二维码接力 / 分享地址选址夹具（P-20261019-10 / P-20261020-2）：e2e 实例固定
// 以 localhost 打开，真实网卡清单随机器漂移（CI 可能只有回环）。这里在页面层
// 拦截两个只读源：/api/system/network 回固定候选、/api/settings GET 覆写
// externalAccessUrl / sharePublicBaseUrl——三态（回环+LAN / 回环无候选 /
// 外部地址 / 显式分享基址）可确定性断言，且不写服务端设置。
export interface RelayAddressFixture {
  ip: string
  family: 'v4' | 'v6'
  iface: string
  private: boolean
}

/** 固定默认候选（沿用页面端口；微信/浏览器扫码内容只认文本框同源值） */
export const RELAY_FIXTURE_LAN: RelayAddressFixture = { ip: '192.168.77.10', family: 'v4', iface: 'e2e0', private: true }

export async function mockRelayAddressContext(page: Page, opts: {
  addresses?: RelayAddressFixture[]
  externalAccessUrl?: string
  /** 分享外发基址（P-20261020-2）；显式空串 = 未配置，压掉实例上的真实值 */
  sharePublicBaseUrl?: string
}): Promise<void> {
  if (opts.addresses) {
    await page.route('**/api/system/network', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: opts.addresses }),
    }))
  }
  if (opts.externalAccessUrl !== undefined || opts.sharePublicBaseUrl !== undefined) {
    await page.route('**/api/settings', async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue()
        return
      }
      const response = await route.fetch()
      const body = await response.json() as { data?: Record<string, unknown> }
      const overrides: Record<string, unknown> = {}
      if (opts.externalAccessUrl !== undefined) overrides.externalAccessUrl = opts.externalAccessUrl
      if (opts.sharePublicBaseUrl !== undefined) overrides.sharePublicBaseUrl = opts.sharePublicBaseUrl
      body.data = { ...(body.data || {}), ...overrides }
      await route.fulfill({ response, json: body })
    })
  }
}

// WSL 主机记录解析（远程域 spec 环境门控的事实源，P-20261004-115）：记录由
// scripts/e2e-seed-wsl.sh 播种，端口随播种形态漂移——legacy 共享 sshd 恒 23，
// 槽位专用实例（SC_E2E_SSH_PORT）为派生端口（2300+槽位号）。探针/UI 断言一律
// 取记录端口，禁止硬编码 :23（槽位实例上会探错实例、断错卡面地址）。
// 记录缺失（未播种）或实例不可达返回 null，调用方按既有门控 skip。
// 用裸 fetch 而非 playwright request：本 helper 也服务只在 beforeAll 拿到
// 全局 fetch 的 spec（remote-console/deploy-settings 等），解耦请求上下文来源
export async function fetchWslHost(base: string): Promise<{ id: string; port: number } | null> {
  try {
    const unlock = await fetch(base + '/api/lock/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: DEFAULT_PASSWORD }),
    })
    const token = ((await unlock.json()) as { token?: string }).token || ''
    const list = (await (await fetch(base + '/api/remotehosts', {
      headers: { 'X-Lock-Token': token },
    })).json())?.data as Array<{ id?: string; name?: string; port?: number; protocol?: string }> | undefined
    const wsl = (list || []).find(h => h.name === 'WSL' && h.protocol !== 'ftp')
    if (!wsl?.id) return null
    return { id: wsl.id, port: Number(wsl.port) || 23 }
  } catch {
    return null
  }
}
