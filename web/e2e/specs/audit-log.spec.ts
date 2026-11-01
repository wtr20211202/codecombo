import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import { DEFAULT_PASSWORD, LOCK_OVERLAY, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 安全事件审计日志 E2E（P-20261002-13）：
 *   - 错误解锁 3 次 → 审计表出现失败记录（时间/事件/结果/IP）+ 通知中心到达 warning
 *   - 工作区备份导出 → 审计表出现「导出工作区备份」记录（独立 /ui-state/export 端点）
 *   - GET /api/audit 管理面鉴权（无 token 423）+ limit/offset 分页
 *   - 行内过滤（P-20261003-131）：动作/结果两下拉过滤后仅显匹配行 + 组合 AND
 *     空态 + 清除恢复全量（CSV 导出不随过滤收窄，由导出用例全窗口口径守护）
 *   - 导出过滤联动（P-20261007-2）：过滤生效时导出按钮旁下拉副项「导出当前
 *     过滤结果」走参数化导出——服务端全窗口过滤，CSV 仅含匹配行且覆盖 500
 *     查看窗口之外的播种行；主按钮零参数导出行数=total（全窗口口径不变）
 * 前置：后端实例已 setup admin 密码（e2e-restart.sh 负责）。解锁限流为
 * 每分钟 10 次/IP 且失败计数跨用例残留——连发用例先等出干净窗口（见下）。
 */

const lockState = async (request: APIRequestContext) =>
  await request.get(`${API_BASE}/api/lock/state`).then(r => r.json() as Promise<{ enabled: boolean }>)

// 用 API 解锁拿 token（429 时按 retryAfter 等待重试一次，lock.spec 同款）
async function unlockToken(request: APIRequestContext): Promise<string> {
  const attempt = () =>
    request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  let res = await attempt()
  if (res.status() === 429) {
    const wait = Number(res.headers()['retry-after'] || 0) * 1000 || 5000
    await new Promise(r => setTimeout(r, Math.min(wait, 15000)))
    res = await attempt()
  }
  if (!res.ok()) throw new Error(`unlock failed: ${res.status()}`)
  return ((await res.json()) as { token: string }).token
}

async function setLockEnabled(request: APIRequestContext, enabled: boolean): Promise<void> {
  const token = await unlockToken(request)
  const res = await request.put(`${API_BASE}/api/lock/config`, {
    headers: { 'X-Lock-Token': token },
    data: { enabled, currentPassword: DEFAULT_PASSWORD },
  })
  if (!res.ok()) console.warn(`[audit-log.spec] set enabled=${enabled} failed: ${res.status()}`)
}

// 服务端解锁限流的失败计数跨用例残留（lock.spec 会留下 ≥3 的计数甚至封禁）。
// 连发通知的断言依赖「本轮从 1 数到 3」：等一个干净窗口（封禁 60s + 计数窗口
// 60s 取其大），窗口过期后首个失败必然从 1 起数
async function waitForCleanFailureWindow(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: 'probe-wrong-pwd' } })
  if (res.status() === 429) {
    const wait = Number(res.headers()['retry-after'] || 0) * 1000 || 60000
    await new Promise(r => setTimeout(r, Math.min(wait, 65000)))
  }
  // 计数窗口 60s 过期 + 5s 余量
  await new Promise(r => setTimeout(r, 65000))
}

// 锁定页连错 N 次（UI 驱动，与真实攻击路径同形）
async function wrongUnlockTimes(page: Page, times: number) {
  const input = page.locator(`${LOCK_OVERLAY} .lock-form input`).first()
  const btn = page.locator(`${LOCK_OVERLAY} button`).filter({ hasText: '解锁' }).first()
  for (let i = 0; i < times; i++) {
    await input.fill('wrong-password')
    await expect(btn).toBeEnabled({ timeout: 2000 })
    await btn.click()
    // zh-CN: lock.overlay.wrongPassword
    await expect(page.getByText('密码错误').first()).toBeVisible({ timeout: 5000 })
  }
}

// 解锁进应用 + 关掉默认密码提醒
async function unlockViaUi(page: Page) {
  const input = page.locator(`${LOCK_OVERLAY} .lock-form input`).first()
  const btn = page.locator(`${LOCK_OVERLAY} button`).filter({ hasText: '解锁' }).first()
  await input.fill(DEFAULT_PASSWORD)
  await expect(btn).toBeEnabled({ timeout: 2000 })
  await btn.click()
  await expect(page.locator(LOCK_OVERLAY)).toHaveCount(0, { timeout: 10000 })
  const laterBtn = page.getByRole('button', { name: '稍后提醒' })
  if (await laterBtn.count() > 0) {
    await laterBtn.click()
    await expect(laterBtn).toHaveCount(0, { timeout: 3000 })
  }
}

// 设置 → 安全 → 审计日志 Tab（首页「设置」按钮入口，token-warning.spec 同款）
async function openAuditTab(page: Page) {
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审计日志' }).click()
  await expect(page.getByTestId('audit-pane')).toBeVisible({ timeout: 5000 })
}

// 审计表内「解锁+失败」行定位器
function unlockFailRows(page: Page) {
  return page
    .locator('[data-testid="audit-pane"] .n-data-table-tr')
    .filter({ hasText: '解锁' })
    .filter({ hasText: '失败' })
}

// 行内过滤（P-20261003-131）：点开下拉选中含 label 的选项。naive-ui 关闭的
// 菜单 DOM 以 display:none 常驻不卸载——先等无可见菜单（上一菜单 leave 完成）
// 再点开，选中后靠 :visible 只命中当前展开菜单的选项，防新旧菜单并存被
// Playwright strict 模式双命中
async function pickSelectOption(page: Page, testid: string, label: string): Promise<void> {
  await expect(page.locator('.n-base-select-menu:visible')).toHaveCount(0)
  await page.getByTestId(testid).click()
  await page.locator('.n-base-select-option:visible').filter({ hasText: label }).first().click()
}

test.describe('安全事件审计日志', () => {
  // 锁定开关是共享实例全局态，显式启用保证用例可跑（lock.spec 同款自给自足）
  test.beforeAll(async ({ request }) => {
    await setLockEnabled(request, true)
  })
  test.afterAll(async ({ request }) => {
    await setLockEnabled(request, false)
  })

  test('错误解锁 3 次 → 审计表失败记录 + 通知中心 warning 到达', async ({ page, request }) => {
    test.skip(!(await lockState(request)).enabled, '锁定功能未启用，跳过')
    test.setTimeout(240000) // 干净窗口等待 ~65s + 用例体

    await fixedLocale(page)
    await page.goto(`${API_BASE}/`)
    await waitForAppReady(page)
    await expect(page.locator(LOCK_OVERLAY)).toBeVisible({ timeout: 10000 })

    await waitForCleanFailureWindow(request)
    // 捕获一次失败解锁响应的 X-Request-Id（rid 注入断言的跨面锚点，见下）
    let failUnlockRid = ''
    page.on('response', (r) => {
      if (r.url().includes('/api/lock/unlock') && r.status() === 401) {
        failUnlockRid = r.headers()['x-request-id'] || failUnlockRid
      }
    })
    await wrongUnlockTimes(page, 3)
    await unlockViaUi(page)

    // 审计表：切换到审计日志 Tab（懒挂载触发拉取）
    await openAuditTab(page)
    await expect(unlockFailRows(page).first()).toBeVisible({ timeout: 5000 })
    if ((await unlockFailRows(page).count()) < 3) {
      // 拉取时序兜底：点刷新重拉一页
      await page.getByTestId('audit-refresh').click()
    }
    await expect(unlockFailRows(page).nth(2)).toBeVisible({ timeout: 5000 })

    // rid 注入（P-20261006-53）：失败解锁的审计行带请求关联短码列
    //（audit-rid，ErrorLogList 同款 data-testid 模式），且行内出现与该请求
    // 响应头 X-Request-Id 同值的短码（= 访问日志行尾 rid=，三方对齐的可执行
    // 断言；头捕获失败时退化为仅格式断言，不因监听时序抖动误报）
    await expect(unlockFailRows(page).first().getByTestId('audit-rid')).toHaveText(/^[0-9a-f]{16}$/)
    if (failUnlockRid) {
      await expect(unlockFailRows(page).filter({ hasText: failUnlockRid }).first()).toBeVisible({ timeout: 5000 })
    }

    // 通知中心到达：铃铛在项目布局 TopBar（首页无），先进项目页再开面板
    await page.keyboard.press('Escape')
    await expect(page.locator('.settings-modal')).toBeHidden({ timeout: 3000 })
    await page.locator('.project-card').first().click()
    await page.waitForURL('**/project')
    await page.locator('button[title="通知中心"]').first().click()
    const card = page.locator('.nc-card')
    await expect(card).toBeVisible({ timeout: 3000 })
    await expect(card.getByText('检测到连续解锁失败').first()).toBeVisible()
    await expect(card.getByText(/连续 3 次密码错误/).first()).toBeVisible()
  })

  test('工作区备份导出入账：审计表出现「导出工作区备份」成功记录', async ({ page, request }) => {
    // uiState 播种：P-20261002-48 起数据面每次 FRESH 重建且金态不播种 uiState，
    // 而 boot 链只读不写（P-20261002-8 脏键 diff，进项目页零变更零请求）——
    // 服务端 uiState 恒为空，导出走 WorkspaceBackup 空态分支只提示不下载，
    // download 事件永不触发（纯 HEAD 同败，e2e-restart 重建实例必现）。
    // 用例开头（本页尚未进项目页，无关页补丁回写覆盖风险）API 播种一个实例
    // 命名空间让导出面有真实载荷；PATCH 键级合并不影响其他用例。不碰播种
    // 脚本（运维铁律），同域先例 replace-backup.spec 同款 API 播种手法
    const seedToken = await unlockToken(request)
    const seeded = await request.patch(`${API_BASE}/api/ui-state`, {
      headers: { 'X-Lock-Token': seedToken },
      data: { 'e2e-backup-seed': { layout: { sidePanel: 'git' } } },
    })
    expect(seeded.ok()).toBeTruthy()

    await fixedLocale(page)
    await page.goto(`${API_BASE}/`)
    await waitForAppReady(page)
    await unlockIfNeeded(page)
    await page.locator('.project-card').first().click()
    await page.waitForURL('**/project')
    await page.locator('[data-testid="rail-settings"]').click()
    await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })

    // 导出（设置默认落「通用」分区）
    const section = page.locator('.wb-section')
    await expect(section).toBeVisible({ timeout: 3000 })
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      section.getByRole('button', { name: '导出状态' }).click(),
    ])
    // 导出下载名客户端合成（WorkspaceBackup.vue），4adaf9da 品牌切换后前缀 codecombo-
    expect(download.suggestedFilename()).toMatch(/^codecombo-ui-state-\d{4}-\d{2}-\d{2}\.json$/)

    // 审计表出现刚发生的导出记录（成功）
    await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
    await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
    await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审计日志' }).click()
    await expect(page.getByTestId('audit-pane')).toBeVisible({ timeout: 5000 })
    const exportRow = page
      .locator('[data-testid="audit-pane"] .n-data-table-tr')
      .filter({ hasText: '导出工作区备份' })
    await expect(exportRow.first()).toBeVisible({ timeout: 5000 })
    await expect(exportRow.first().getByTestId('audit-result')).toHaveText('成功')
  })

  test('GET /api/audit 管理面鉴权 + limit/offset 分页', async ({ request }) => {
    // 无解锁 token → 423（LockMiddleware 门控）
    const anon = await request.get(`${API_BASE}/api/audit`)
    expect(anon.status()).toBe(423)

    const token = await unlockToken(request)
    const headers = { 'X-Lock-Token': token }

    // limit=1：单页一条，total 为全量
    const page1 = await request.get(`${API_BASE}/api/audit?limit=1&offset=0`, { headers })
    expect(page1.ok()).toBeTruthy()
    const body1 = (await page1.json()) as { data: unknown[]; total: number }
    expect(body1.data.length).toBe(1)
    expect(body1.total).toBeGreaterThanOrEqual(1)

    // offset 越界 → 空页，total 不变
    const far = await request.get(`${API_BASE}/api/audit?limit=10&offset=999999`, { headers })
    const bodyFar = (await far.json()) as { data: unknown[]; total: number }
    expect(bodyFar.data.length).toBe(0)
    expect(bodyFar.total).toBe(body1.total)

    // 非法参数回退默认（100），不 500
    const junk = await request.get(`${API_BASE}/api/audit?limit=junk&offset=junk`, { headers })
    expect(junk.ok()).toBeTruthy()
    const bodyJunk = (await junk.json()) as { data: unknown[] }
    expect(Array.isArray(bodyJunk.data)).toBe(true)
  })

  // 审计 CSV 导出（P-20261003-66）：UI 工具条下载 + 行数与列表一致 +
  // 公式注入防护样例 + 导出动作同路入账
  test('审计 CSV 导出：文件行数与列表一致 + 注入防护样例 + 导出动作入账', async ({ page, request }) => {
    const token = await unlockToken(request)
    const headers = { 'X-Lock-Token': token }

    // 注入样例播种：凭据用户名以 = 开头 → 审计 Detail 形如 =...@host (create)
    const cred = await request.post(`${API_BASE}/api/credentials`, {
      headers,
      data: { host: 'export-injection-test.example.com', username: '=1+1|calc', secret: 'irrelevant' },
    })
    expect(cred.ok()).toBeTruthy()

    await fixedLocale(page)
    await page.goto(`${API_BASE}/`)
    await waitForAppReady(page)
    await unlockIfNeeded(page)

    // 行数基准：CSV 由服务端构建完成后才入账导出事件——导出前读的 total
    // 即文件数据行数（此后到点击导出之间无其他审计写入面）
    const before = await request.get(`${API_BASE}/api/audit?limit=1`, { headers })
    const totalBefore = ((await before.json()) as { total: number }).total

    await openAuditTab(page)
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.getByTestId('audit-export').click(),
    ])
    // 下载名客户端合成（AuditLogPane.vue），4adaf9da 品牌切换后前缀 codecombo-
    expect(download.suggestedFilename()).toMatch(/^codecombo-audit-\d{4}-\d{2}-\d{2}\.csv$/)
    // 内容：表头 + 数据行数与列表一致；= 开头的 Detail 带 ' 前缀（公式注入防护）
    const csv = fs.readFileSync(await download.path(), 'utf-8')
    const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    expect(lines[0]).toBe('time,action,result,ip,detail')
    expect(lines.length - 1).toBe(totalBefore)
    expect(csv).toContain(`'=1+1|calc@export-injection-test.example.com`)

    // 导出动作同路入账：刷新后表格出现「导出审计 CSV」成功行，总数 +1
    await page.getByTestId('audit-refresh').click()
    await expect(
      page.locator('[data-testid="audit-pane"] .n-data-table-tr')
        .filter({ hasText: '导出审计 CSV' }).first(),
    ).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('audit-total')).toHaveText(`共 ${totalBefore + 1} 条`)
  })

  // 数据保留期可配（P-20261003-123）：设置·安全·审计分区两行保存回环 +
  // GET /settings 服务端读回 + 越界 400。留存调整的清理遵循由 Go 单测覆盖
  //（清理巡更是次日 tick，e2e 不等一天）；用例首尾 API 复位默认值，防
  // 共享实例残留影响其他用例
  test('数据保留期可配：设置·安全·审计分区保存回环 + 越界拒绝', async ({ page, request }) => {
    const token = await unlockToken(request)
    const headers = { 'X-Lock-Token': token }
    // 复位到默认（显式 0=回落默认 30/15；这是 API 逃生口，UI 不暴露）
    const reset = () => request.put(`${API_BASE}/api/settings`, {
      headers,
      data: { auditRetentionDays: 0, logRetentionDays: 0 },
    })
    await reset()

    await fixedLocale(page)
    await page.goto(`${API_BASE}/`)
    await waitForAppReady(page)
    await unlockIfNeeded(page)

    await openAuditTab(page)

    // 默认生效值：未配置时 GET 出参已收敛 30/15（存量兼容）
    const auditInput = page.getByTestId('settings-audit-retention-days').locator('input')
    const logInput = page.getByTestId('settings-log-retention-days').locator('input')
    await expect(auditInput).toHaveValue('30', { timeout: 5000 })
    await expect(logInput).toHaveValue('15')

    // 双向调整：合规调长审计 90 / 磁盘紧张调短日志 7，保存
    await auditInput.fill('90')
    await logInput.fill('7')
    await page.getByTestId('settings-retention-save').click()
    await expect(page.getByText('保留期已保存，将由每日清理巡检生效')).toBeVisible({ timeout: 5000 })

    // 服务端读回（重启后仍在 = settings 落盘语义）
    const res = await request.get(`${API_BASE}/api/settings`, { headers })
    const data = ((await res.json()) as { data: { auditRetentionDays: number; logRetentionDays: number } }).data
    expect(data.auditRetentionDays).toBe(90)
    expect(data.logRetentionDays).toBe(7)

    // 越界拒绝（写入端边界 1~3650；UI 已钳制，直打 API 验证服务端防线）
    const bad = await request.put(`${API_BASE}/api/settings`, { headers, data: { auditRetentionDays: 9999 } })
    expect(bad.status()).toBe(400)

    await reset()
  })

  // 行内过滤（P-20261003-131）：动作类型/结果两下拉——过滤后仅显匹配行 +
  // 组合 AND 无命中空态 + 清除恢复全量。播种走 API（凭据保存=成功事件、
  // 错误解锁=失败事件），断言用「其余动作行归零」的相对口径，不锚死绝对条数
  test('行内过滤：动作/结果下拉仅显匹配行 + 组合空态 + 清除恢复全量', async ({ page, request }) => {
    const token = await unlockToken(request)
    const headers = { 'X-Lock-Token': token }

    // 播种：锁定配置修改（成功）+ 凭据保存（成功）+ 错误解锁（失败/限流拦截）。
    // 一次错误解锁必留审计；本文件此前用例至多留 3 次失败计数，+1 仍 < 10 不触 429
    await request.put(`${API_BASE}/api/lock/config`, {
      headers,
      data: { enabled: true, currentPassword: DEFAULT_PASSWORD },
    })
    const cred = await request.post(`${API_BASE}/api/credentials`, {
      headers,
      data: { host: 'audit-filter-test.example.com', username: 'filter-user', secret: 'irrelevant' },
    })
    expect(cred.ok()).toBeTruthy()
    await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: 'wrong-filter-pwd' } })

    await fixedLocale(page)
    await page.goto(`${API_BASE}/`)
    await waitForAppReady(page)
    await unlockIfNeeded(page)
    await openAuditTab(page)

    const allRows = page.locator('[data-testid="audit-pane"] .n-data-table-tr:has(td)')
    await expect(allRows.first()).toBeVisible({ timeout: 5000 })

    // 动作过滤：选「保存 Git 凭据」→ 表内只剩该动作行（无其他动作行）
    await pickSelectOption(page, 'audit-filter-action', '保存 Git 凭据')
    const credRows = allRows.filter({ hasText: '保存 Git 凭据' })
    await expect(credRows.first()).toBeVisible({ timeout: 5000 })
    await expect(allRows.filter({ hasNotText: '保存 Git 凭据' })).toHaveCount(0)
    // 计数切换为「匹配 n / 共 N 条」+ 清除钮出现（总数行让位）
    await expect(page.getByTestId('audit-filter-count')).toContainText(/^匹配 \d+ \/ 共 \d+ 条$/)
    await expect(page.getByTestId('audit-filter-clear')).toBeVisible()

    // 组合 AND：凭据保存必成功，∩ 结果=失败 无命中 → 空态文案
    await pickSelectOption(page, 'audit-filter-result', '失败')
    await expect(page.locator('[data-testid="audit-pane"] .pane-empty'))
      .toHaveText('当前过滤条件下无匹配事件')
    await expect(page.getByTestId('audit-filter-count')).toContainText('匹配 0 /')

    // 清除过滤 → 恢复全量分页视图：总数行回来，解锁失败行可见
    await page.getByTestId('audit-filter-clear').click()
    await expect(page.getByTestId('audit-total')).toContainText(/^共 \d+ 条$/)
    await expect(unlockFailRows(page).first()).toBeVisible({ timeout: 5000 })
    await expect(page.getByTestId('audit-filter-clear')).toHaveCount(0)

    // 结果过滤单独用：只显失败行（成功行归零，解锁失败行仍在）
    await pickSelectOption(page, 'audit-filter-result', '失败')
    await expect(allRows.filter({ hasText: '成功' })).toHaveCount(0)
    await expect(unlockFailRows(page).first()).toBeVisible({ timeout: 5000 })
  })

  // 导出过滤联动（P-20261007-2）：副项导出=服务端全窗口过滤切片——CSV 仅含
  // 匹配行且覆盖前端 500 查看窗口之外的播种行（窗口外只有服务端过滤拿得到）；
  // 主按钮零参数导出行数=total（全窗口口径不随过滤收窄，P-66 设计不变）。
  // 播种布局（Time 倒序即 DOM 序）：窗口内匹配行 A（最新）→ 501 条 lock.config
  // 填充（把 C 推出 500 窗口）→ 窗口外匹配行 C——动作过滤 credential.save
  // 后服务端应回 A+C 恰 2 行，窗口裁剪导出只会拿到 1 行（C 缺席即破）
  test('导出过滤联动：副项导出仅含匹配行（含 500 窗口外播种行）+ 零参数全量口径', async ({ page, request }) => {
    test.setTimeout(300000) // 501 条填充播种（每条一次 PUT）+ 双导出
    const token = await unlockToken(request)
    const headers = { 'X-Lock-Token': token }

    // 窗口外匹配行 C：唯一 host → Detail「user@host (create)」可从 CSV 定位
    const credOut = await request.post(`${API_BASE}/api/credentials`, {
      headers,
      data: { host: 'audit-export-outwin.example.com', username: 'filter-e2e', secret: 'irrelevant' },
    })
    expect(credOut.ok()).toBeTruthy()
    // 501 条填充（lock.config 成功事件，非匹配动作）：C 落到第 503 位，
    // 恒在 500 查看窗口之外（不依赖实例既有事件数）
    for (let i = 0; i < 501; i++) {
      const res = await request.put(`${API_BASE}/api/lock/config`, {
        headers,
        data: { enabled: true, currentPassword: DEFAULT_PASSWORD },
      })
      expect(res.ok()).toBeTruthy()
    }
    // 窗口内匹配行 A：最新事件
    const credIn = await request.post(`${API_BASE}/api/credentials`, {
      headers,
      data: { host: 'audit-export-inwin.example.com', username: 'filter-e2e', secret: 'irrelevant' },
    })
    expect(credIn.ok()).toBeTruthy()

    await fixedLocale(page)
    await page.goto(`${API_BASE}/`)
    await waitForAppReady(page)
    await unlockIfNeeded(page)
    await openAuditTab(page)

    // 动作过滤「保存 Git 凭据」：窗口注记出现（总数>500），计数行切换为
    // 「匹配 n / 共 N 条」（共享实例存在其他 credential.save 存量，不锚死 n）
    await pickSelectOption(page, 'audit-filter-action', '保存 Git 凭据')
    await expect(page.getByTestId('audit-filter-count')).toContainText(/^匹配 \d+ \/ 共 \d+ 条$/)
    await expect(page.getByTestId('audit-filter-window')).toBeVisible()

    // 副项导出：下拉副柄 → 菜单「导出当前过滤结果」→ CSV 仅含匹配行
    //（逐行 action=credential.save）且含窗口外播种行 C（前端过滤面看不到它，
    // 服务端全窗口过滤拿到了——C 缺席即「过滤被 500 窗口钳制」回退）
    await expect(page.locator('.n-dropdown-menu:visible')).toHaveCount(0)
    await page.getByTestId('audit-export-filtered').click()
    const [filteredDl] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.locator('.n-dropdown-option:visible').filter({ hasText: '导出当前过滤结果' }).first().click(),
    ])
    expect(filteredDl.suggestedFilename()).toMatch(/^codecombo-audit-\d{4}-\d{2}-\d{2}-filtered\.csv$/)
    const filteredCsv = fs.readFileSync(await filteredDl.path(), 'utf-8')
    const filteredLines = filteredCsv.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    expect(filteredLines[0]).toBe('time,action,result,ip,detail')
    expect(filteredLines.length - 1).toBeGreaterThanOrEqual(2) // 至少 A+C（共享实例或有存量）
    expect(filteredCsv).toContain('audit-export-inwin.example.com')
    expect(filteredCsv).toContain('audit-export-outwin.example.com')
    for (const line of filteredLines.slice(1)) {
      expect(line.split(',')[1]).toBe('credential.save')
    }

    // 零参数全量口径：清除过滤，主按钮导出行数=导出前 total（含 501 填充行，
    // 证明过滤参数缺省 = 全窗口零变化）
    await page.getByTestId('audit-filter-clear').click()
    await expect(page.getByTestId('audit-total')).toContainText(/^共 \d+ 条$/)
    const before = await request.get(`${API_BASE}/api/audit?limit=1`, { headers })
    const totalBefore = ((await before.json()) as { total: number }).total
    const [fullDl] = await Promise.all([
      page.waitForEvent('download', { timeout: 10000 }),
      page.getByTestId('audit-export').click(),
    ])
    expect(fullDl.suggestedFilename()).toMatch(/^codecombo-audit-\d{4}-\d{2}-\d{2}\.csv$/)
    const fullCsv = fs.readFileSync(await fullDl.path(), 'utf-8')
    const fullLines = fullCsv.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    expect(fullLines.length - 1).toBe(totalBefore)
  })

  // 审批档位变更入账（P-20261005-162）：切 allow-24h → 审计面板出现「审批档位
  // 变更」成功行，Detail 携 old→new（ask → allow-24h）——安全姿态变化可追认。
  // 全局审批模式是共享实例状态（approval-* 域用例都在读写它）：先归位 ask 再
  // 翻转——本用例产生的条目 detail 恒为 `ask → allow-24h`，断言按明细文本过滤
  // 行（并发 worker 的档位翻转条目形态不同不会误命中）；finally 复位回 ask，
  // 失败路径也不留放权
  test('审批档位变更入账：切 allow-24h → 审计面板出现条目', async ({ page, request }) => {
    const token = await unlockToken(request)
    const headers = { 'X-Lock-Token': token }
    const setMode = (mode: string) =>
      request.put(`${API_BASE}/api/settings`, { headers, data: { agentApprovalMode: mode } })
    try {
      await setMode('ask')
      await setMode('allow-24h')

      await fixedLocale(page)
      await page.goto(`${API_BASE}/`)
      await waitForAppReady(page)
      await unlockIfNeeded(page)
      await openAuditTab(page)

      const row = page
        .locator('[data-testid="audit-pane"] .n-data-table-tr')
        .filter({ hasText: '审批档位变更' })
        .filter({ hasText: 'ask → allow-24h' })
      if ((await row.count()) === 0) {
        // 拉取时序兜底：点刷新重拉一页（本文件其他用例同款手法）
        await page.getByTestId('audit-refresh').click()
      }
      await expect(row.first()).toBeVisible({ timeout: 5000 })
      await expect(row.first().getByTestId('audit-result')).toHaveText('成功')
    } finally {
      await setMode('ask')
    }
  })
})
