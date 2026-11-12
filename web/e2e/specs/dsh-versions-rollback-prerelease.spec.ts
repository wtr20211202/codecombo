import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * dsh 版本管理：回退入口常驻化 + 预发布通道分档 E2E（P-20261010-2）。
 *
 * 用户实测场景：升级 0.21-alpha.2 成功但新版功能性损坏时，升级流程不处于
 * failed 态，原「仅失败态」回退入口不可见——用户被锁死。本 spec 用对话框级
 * API mock（agent-runtime-badge.spec 同款 page.route 先例）驱动版本弹窗：
 *   1. config 有回退点（升级成功后形态）→ 弹窗常驻「升级前版本」行，确认后
 *      走 POST /tools/dsh/rollback，回退完成行隐藏（已在该版本上无回退语义）；
 *   2. 预发布默认滤除：注册表里比当前新的 alpha 不进可升级列表、不出升级角标
 *      ——「已是最新」按稳定版判定；开关打开才可见；
 *   3. 当前已是 prerelease：通道提示 + 双信息文案「已是预发布最新（稳定版：Y）」
 *      + 不自动降级（更旧的稳定版不进列表，回退只走显式常驻行）。
 */

interface VerFixture {
  current: string
  latest: string
  versions: { version: string; date: string }[]
  rollbackVersion: string
}

/** 解锁令牌头（agent-runtime-badge.spec 同款） */
async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

test.beforeEach(async ({ request }) => {
  // dsh 控制台开合是服务端 uiState（local 实例命名空间，套件共享 :9999 实例）：
  // 任何先例 spec（含本 spec 前一用例）开过控制台，页面加载即 restoreDshConsoleOnce
  // 自愈展开首页浮层，挡住本 spec 要点的首页按钮——每例前置压回关闭
  // （/api/ui-state PATCH 播种沿 agent-new-session-draft.spec 同款）
  const headers = await unlockHeaders(request)
  await request.patch(`${API_BASE}/api/ui-state`, {
    headers,
    data: { local: { dshConsole: { open: false } } },
  })
})

test.afterEach(async ({ request }) => {
  // 本 spec 自身会开控制台：出例还原关闭，不给后续 spec 留浮层（同源状态卫生）
  const headers = await unlockHeaders(request)
  await request.patch(`${API_BASE}/api/ui-state`, {
    headers,
    data: { local: { dshConsole: { open: false } } },
  })
})

const T0 = '2026-10-01T00:00:00.000Z'
const T1 = '2026-10-02T00:00:00.000Z'
const T2 = '2026-10-03T00:00:00.000Z'

/** mock dsh 工具族接口（嵌入探测/目标/版本/changelog/回退）并打开版本弹窗。
 *  available=false → 嵌入体走「未检测到」空态，spec 只关心工具栏与弹窗层 */
async function openVersionsModal(page: Page, ver: VerFixture) {
  const rollbackCalls: string[] = []
  await page.route('**/api/tools/dsh/url*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { url: '', available: false, exposeAll: true, degraded: false, tokenState: '', proxyScheme: 'http', tlsServedOnce: true } }),
  }))
  await page.route('**/api/tools/dsh/targets', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [] }),
  }))
  await page.route('**/api/tools/dsh/changelog', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [] }),
  }))
  await page.route('**/api/tools/dsh/versions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: ver }),
  }))
  await page.route('**/api/tools/dsh/rollback', (route) => {
    rollbackCalls.push(route.request().url())
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { ok: true, available: true, version: ver.rollbackVersion, logPath: '' } }),
    })
  })

  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  // 首页动作区「dsh 控制台」按钮 → 主区控制台视图（工具栏常驻版本标签是弹窗唯一入口）
  await page.locator('button[title="dsh 控制台"]').click()
  await expect(page.locator('.dsh-root')).toBeVisible({ timeout: 10000 })
  await page.locator('.dsh-upgrade-tag').click()
  const dlg = page.locator('.n-modal').filter({ hasText: 'dsh 版本管理' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  return { dlg, rollbackCalls }
}

test('升级成功形态：弹窗常驻「升级前版本」行，确认回退重装旧版并隐藏；alpha 默认不在推荐列表', async ({ page }) => {
  // 形态 = 一次成功升级之后：current 0.21.0（升级前 0.20.1），注册表最新 dist-tag 是 alpha
  const { dlg, rollbackCalls } = await openVersionsModal(page, {
    current: '0.21.0',
    latest: '0.21.1-alpha.1',
    versions: [
      { version: '0.20.1', date: T0 },
      { version: '0.21.0', date: T1 },
      { version: '0.21.1-alpha.1', date: T2 },
    ],
    rollbackVersion: '0.20.1',
  })

  // 常驻回退行：config 有回退点即呈现（不要求升级流程处于 failed 态）
  const row = dlg.locator('[data-test="dsh-rollback-row"]')
  await expect(row).toBeVisible()
  await expect(row).toContainText('升级前版本：v0.20.1')

  // alpha 比当前新但被稳定版默认档滤除：列表空 →「已是最新版本」
  await expect(dlg.locator('[data-test="dsh-ver-empty"]')).toContainText('已是最新版本')
  await expect(dlg.locator('.ver-item')).toHaveCount(0)

  // 开关打开后 alpha 才进列表（预发布分档：用户自决进入不稳定通道）
  await dlg.locator('[data-test="dsh-prerelease-toggle"]').click()
  await expect(dlg.locator('.ver-item').filter({ hasText: 'v0.21.1-alpha.1' })).toBeVisible()

  // 常驻行走确认弹层（交代 npm 重装 + 重启），确认后回退完成：版本回 0.20.1，行隐藏
  await dlg.locator('[data-test="dsh-rollback-btn"]').click()
  const confirm = page.locator('.n-dialog').filter({ hasText: '将 npm 重装 v0.20.1 并重启 dsh' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '确认' }).click()
  await expect(dlg.locator('.ver-current').locator('.n-tag').first()).toHaveText('0.20.1', { timeout: 10000 })
  await expect(row).toHaveCount(0)
  expect(rollbackCalls).toHaveLength(1)
})

test('已是 prerelease：通道提示 + 双信息文案，不自动降级，回退点常驻', async ({ page }) => {
  const { dlg } = await openVersionsModal(page, {
    current: '0.21.1-alpha.1',
    latest: '0.21.1-alpha.1',
    versions: [
      { version: '0.20.9', date: T0 },
      { version: '0.21.0', date: T1 },
      { version: '0.21.1-alpha.1', date: T2 },
    ],
    rollbackVersion: '0.21.0',
  })

  // 当前版本如实显示 + 通道提示
  await expect(dlg.locator('[data-test="dsh-prerelease-channel"]')).toHaveText('您在预发布通道')

  // 默认列表空：双信息文案（预发布最新 + 稳定版参照），且不把更旧的稳定版 0.21.0
  // 当「可升级」塞进列表（不自动降级——回退只走显式常驻行）
  await expect(dlg.locator('[data-test="dsh-ver-empty"]')).toContainText('已是预发布最新（稳定版：v0.21.0）')
  await expect(dlg.locator('.ver-item')).toHaveCount(0)

  // 回退点常驻（升级前 0.21.0），逃生通道仍在
  const row = dlg.locator('[data-test="dsh-rollback-row"]')
  await expect(row).toBeVisible()
  await expect(row).toContainText('升级前版本：v0.21.0')
})

// 已知缺陷标注（P-20261111-2-S2）：S1 诊断实锤 0.2.2-rc.1 插件加载失败拖垮页面
// （rc.2 修复条目直接命中），版本面标注+引导升级，反代面零兜底
test('当前版本命中已知缺陷登记：弹窗警示引导升级 rc.2+，工具栏版本标签转警示态', async ({ page }) => {
  // 形态 = 用户实测故障版本：current 0.2.2-rc.1（修复版 0.2.2-rc.2 为预发布，
  // 默认稳定档列表为空——引导文案须点名「显示预发布版本」开关）
  const { dlg } = await openVersionsModal(page, {
    current: '0.2.2-rc.1',
    latest: '0.2.2-rc.2',
    versions: [
      { version: '0.2.1-rc.5', date: T0 },
      { version: '0.2.2-rc.1', date: T1 },
      { version: '0.2.2-rc.2', date: T2 },
    ],
    rollbackVersion: '0.2.1-rc.5',
  })

  // 弹窗警示块：命中登记条目，交代缺陷表现并引导升级到 rc.2+
  const banner = dlg.locator('[data-test="dsh-known-issue-banner"]')
  await expect(banner).toBeVisible()
  await expect(banner).toContainText('已启用/已装插件加载失败')
  await expect(banner).toContainText('v0.2.2-rc.2')

  // 工具栏版本标签转警示态（title 可断言；naive-ui tag type 只进 CSS 变量不进 class）
  const tag = page.locator('.dsh-upgrade-tag')
  await expect(tag).toHaveAttribute('title', '当前版本存在已知缺陷——点此查看详情与升级引导')
  await expect(tag).toHaveText('v0.2.2-rc.1')

  // 当前版本自身不进可升级列表；开预发布开关后 rc.2 可见可选（升级动作可达）
  await expect(dlg.locator('.ver-item')).toHaveCount(0)
  await dlg.locator('[data-test="dsh-prerelease-toggle"]').click()
  await expect(dlg.locator('.ver-item').filter({ hasText: 'v0.2.2-rc.2' })).toBeVisible()
})

test('已知缺陷版本出现在可升级列表：条目标注「已知缺陷」防升进缺陷版本', async ({ page }) => {
  const { dlg } = await openVersionsModal(page, {
    current: '0.2.1-rc.5',
    latest: '0.2.2-rc.2',
    versions: [
      { version: '0.2.1-rc.5', date: T0 },
      { version: '0.2.2-rc.1', date: T1 },
      { version: '0.2.2-rc.2', date: T2 },
    ],
    rollbackVersion: '',
  })

  // 当前版本未命中登记：无警示块
  await expect(dlg.locator('[data-test="dsh-known-issue-banner"]')).toHaveCount(0)

  // 预发布开关打开：rc.1 条目带「已知缺陷」标注，rc.2 无标注
  await dlg.locator('[data-test="dsh-prerelease-toggle"]').click()
  const rc1 = dlg.locator('.ver-item').filter({ hasText: 'v0.2.2-rc.1' })
  await expect(rc1).toBeVisible()
  await expect(rc1.locator('[data-test="dsh-known-issue-tag"]')).toHaveText('已知缺陷')
  const rc2 = dlg.locator('.ver-item').filter({ hasText: 'v0.2.2-rc.2' })
  await expect(rc2.locator('[data-test="dsh-known-issue-tag"]')).toHaveCount(0)
})
