import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, closeDshConsoleAndClearState, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * agent runtime 创建前预检与友好失败（P-20261003-79）+ 对话框可用态徽标
 * （P-20261004-85）：
 *   1. 伪造缺失 runtime（注册自定义智能体指向必然不存在的裸名二进制）→
 *      POST /api/terminals kind=agent 即 400，错误带运行时名稳定标记；
 *      shell 一等选项同端点放行（对照，证明 400 来自预检而非端点故障）
 *   2. 新建会话对话框同链路（P-20261004-85 反转 db0cef05）：缺失 runtime
 *      （无预检豁免）选项灰化禁选 + 同源 tooltip，点击不改变选择；auto 恒
 *      可选，提交走既有链（服务端选型/预检兜底）创建成功
 *   3. 设置·通用分区「运行时检测」按钮：逐 runtime 行显版本/未安装诊断态
 *     （codex/dsh 本机未安装 → 未安装态是确定断言），点击经 refresh=1 重探
 *      后列表保持、缺失态如实保留
 * 自定义智能体写的是全局 settings——beforeAll 注册、afterAll 删除，不污染
 * 其他用例；服务端注册表经 SyncCustomAgents 即时生效，无需重启
 */

const MISSING_RT = 'sc-e2e-missing-rt'
const MISSING_DISPLAY = 'E2E Missing RT'
// 命令首词为裸名（无路径分隔符）→ 不吃「包装脚本路径形态」豁免，预检必达
const MISSING_CMD = 'sc-e2e-missing-rt-bin --serve'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function registerMissingRuntime(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  // upsert 语义：重跑残留同名项直接覆盖，不撞重复名校验
  const res = await request.post(`${API_BASE}/api/settings/custom-agents`, {
    headers,
    data: { name: MISSING_RT, displayName: MISSING_DISPLAY, command: MISSING_CMD },
  })
  if (!res.ok()) throw new Error(`register missing runtime failed: ${res.status()}`)
}

test.beforeAll(async ({ request }) => {
  await registerMissingRuntime(request)
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  await request.delete(`${API_BASE}/api/settings/custom-agents/${MISSING_RT}`, { headers }).catch(() => { /* 不存在即目标态 */ })
})

/** 清理全部终端会话（test 2 的 auto 提交走真实创建链，防残留污染后续用例） */
test.afterEach(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id?: string }[] }).data || []
  for (const s of list) {
    if (s.id) await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
})

/** 解锁后延迟出现的「建议修改默认密码」提醒遮罩会拦截点击，先收起（既有惯例） */
async function dismissPasswordTip(page: Page): Promise<void> {
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

async function enterProject(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await dismissPasswordTip(page)
}

test('创建即明确错误：缺失 runtime 400 带运行时名；shell 对照放行', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${API_BASE}/api/terminals`, {
    headers,
    data: { name: 'precheck-probe', kind: 'agent', runtime: MISSING_RT },
  })
  expect(res.status()).toBe(400)
  const body = (await res.json()) as { error?: string }
  // 稳定标记是对外契约（server/agentops/precheck.go PrecheckError.Error ↔
  // web/src/api/http.ts KNOWN_ERROR_I18N），改任一侧须同步
  expect(body.error || '').toContain(`runtime ${MISSING_RT} is not installed or not in the service process PATH`)

  // 对照组：shell 一等选项同端点放行——400 确来自预检而非端点故障；
  // 创建出的会话用后即删（shell 走真实 PTY，不留僵尸给后续用例）
  const ok = await request.post(`${API_BASE}/api/terminals`, {
    headers,
    data: { name: 'precheck-shell-control', kind: 'agent', runtime: 'shell' },
  })
  expect(ok.status()).toBe(200)
  const created = ((await ok.json()) as { data?: { id?: string } }).data
  if (created?.id) await request.delete(`${API_BASE}/api/terminals/${created.id}`, { headers })
})

test('对话框缺失 runtime 灰化禁选（P-20261004-85）：auto 恒可选，提交走既有链', async ({ page }) => {
  await enterProject(page)

  // 终端会话管理 → 新建会话对话框
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.getByRole('button', { name: '新建会话' }).first().click()
  const dlg = page.locator('.n-modal')
  await expect(dlg).toBeVisible({ timeout: 5000 })

  // P-20261002-16 落任务模板下拉后对话框出现第二枚 select，裸 .n-base-selection 会 strict violation
  // （与 agent-terminal.spec:90 同款语义定位适配）
  await dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection').click()
  // P-20261004-85 可用态注入：缺失运行时（裸名命令、无覆盖）灰化禁选——
  // 显式选择会被服务端预检 400（test 1 已断言该链），死路选择前置归零；
  // tooltip 与预检稳定标记（未安装或不在服务进程 PATH）同源。
  // 原行为（db0cef05「探测不可用不禁用」→ 选中后提交吃 400 toast）已被本提案
  // 反转：豁免链（自定义命令覆盖/路径形态包装脚本）保持可选，自救路径不堵
  const missingOpt = page.locator('.n-base-select-option').filter({ hasText: MISSING_DISPLAY })
  await expect(missingOpt).toBeVisible({ timeout: 15000 }) // 打开即 refresh=1 重探，列表稍慢
  await expect(missingOpt).toHaveClass(/-disabled/)
  await expect(missingOpt.locator('.nsd-rt-opt')).toHaveAttribute('title', /未安装或不在服务进程 PATH/)

  // 点击禁选项无效果：选择保持缺省 auto、菜单不关（naive-ui disabled 拦截）
  await missingOpt.click()
  const runtimeSelect = dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection')
  await expect(runtimeSelect).toContainText('自动（按可用性）')

  // auto 恒可选（回落语义保留在 auto 链）：选中即提交走既有链——服务端
  // 选型（可用运行时）+ 选后补检兜底，创建成功关弹层
  await page.locator('.n-base-select-option').filter({ hasText: '自动（按可用性）' }).click()
  await expect(runtimeSelect).toContainText('自动（按可用性）')
  await dlg.getByRole('button', { name: '创建' }).click()
  await expect(dlg).toBeHidden({ timeout: 20000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 10000 })
})

test('设置·运行时检测按钮：逐行显版本/未安装态，点击重探保持', async ({ page }) => {
  await fixedLocale(page)
  await closeDshConsoleAndClearState(page, page.request, API_BASE)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await dismissPasswordTip(page)
  await page.locator('[data-testid="rail-settings"]').click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible()

  // 逐 runtime 行：伪造缺失行呈「未安装」诊断态；本机未装的内置运行时
  // （codex/dsh）同为未安装，claude 装有 → 行在（版本文本机器相关不断言内容）
  const rows = modal.locator('.rt-status .rt-item')
  const missingRow = rows.filter({ hasText: MISSING_DISPLAY })
  await expect(missingRow).toBeVisible({ timeout: 15000 })
  await expect(missingRow).toContainText('未安装')
  await expect(rows.filter({ hasText: 'claude' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'codex' })).toHaveCount(1)
  await expect(rows.filter({ hasText: 'codex' })).toContainText('未安装')

  // 「运行时检测」→ 服务端失效两层探测缓存重探（refresh=1）：按钮 loading
  // 归位（慢探测留 20s），列表保持、缺失态如实保留
  const detectBtn = modal.getByRole('button', { name: '运行时检测' })
  await detectBtn.click()
  await expect(detectBtn).toBeEnabled({ timeout: 20000 })
  await expect(missingRow).toBeVisible()
  await expect(missingRow).toContainText('未安装')
})
