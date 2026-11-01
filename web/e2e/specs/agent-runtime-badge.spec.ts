import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 新建会话对话框 runtime 可用态徽标 E2E（P-20261004-85，预检链的最后一米）：
 *   1. 已装项带版本短徽标：--version 首行取点分版本号做徽标、完整首行进
 *      title 悬停核对（utils/runtimeAvailability shortVersionLabel）；
 *   2. 伪造缺失 runtime（裸名命令、无预检豁免）→ 选项灰化禁选 + tooltip
 *      与 P-79 稳定标记同源文案（未安装或不在服务进程 PATH），点击不改变
 *      选择（naive-ui disabled 拦截、菜单不关）；
 *   3. 预检豁免链不禁选：per-runtime 自定义命令覆盖 / 路径形态包装脚本的
 *      缺失项保持可选（原样启动承诺 + db0cef05「配命令自救」路径承接）；
 *   4. auto 恒可选 → 提交走既有链（真实服务端选型/预检兜底）创建成功。
 * 对话框级 UI mock（page.route，agent-runtime-guide.spec 同款先例）；创建走
 * 真实服务端；afterEach 清理会话防残留
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

interface RtItem {
  name: string
  displayName?: string
  available: boolean
  version?: string
  defaultCommand: string
  customCommand: string
}

function rt(partial: Pick<RtItem, 'name' | 'available' | 'defaultCommand'> & Partial<RtItem>): RtItem {
  return { version: '', displayName: '', customCommand: '', ...partial }
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，防残留会话污染 .ats-item 计数） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id?: string }[] }).data || []
  for (const s of list) {
    if (s.id) await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

/** mock 运行时清单后进项目页，打开终端会话管理页与新建会话对话框 */
async function openDialog(page: Page, items: RtItem[]) {
  await page.route('**/api/agent-runtimes*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: items }),
  }))
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  const view = page.locator('.atv-root')
  // 活动栏入口（agent-terminal.spec 同款语义定位）
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.getByRole('button', { name: '新建会话' }).first().click()
  const dlg = page.locator('.n-modal')
  await expect(dlg).toBeVisible({ timeout: 5000 })
  return { dlg, view }
}

/** 打开运行时下拉（按表单行语义定位——对话框有多枚 select 的既有适配） */
async function openRuntimeMenu(page: Page, dlg: ReturnType<Page['locator']>) {
  await dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection').click()
}

test('已装项版本短徽标：点分版本号进徽标，完整首行进 title；纯文本项无徽标', async ({ page }) => {
  const { dlg } = await openDialog(page, [
    rt({ name: 'claude', available: true, version: '9.9.9 (E2E Fake 2026)', defaultCommand: 'claude' }),
    rt({ name: 'codex', available: true, version: '', defaultCommand: 'codex' }),
  ])

  // 至少一个可用 → 不出「全部不可用」提示卡
  await expect(dlg.locator('[data-testid="agent-runtime-guide"]')).toHaveCount(0)

  await openRuntimeMenu(page, dlg)
  const claudeOpt = page.locator('.n-base-select-option').filter({ hasText: 'claude' })
  await expect(claudeOpt).toBeVisible({ timeout: 5000 })
  // 徽标 = 首个点分版本号；完整首行（含装饰尾注）进 title 悬停核对
  const badge = claudeOpt.locator('.nsd-rt-version')
  await expect(badge).toHaveText('9.9.9')
  await expect(badge).toHaveAttribute('title', '9.9.9 (E2E Fake 2026)')
  // 探测失败/未取到版本（codex）不渲染徽标——空值静默降级为纯文本项
  await expect(page.locator('.n-base-select-option').filter({ hasText: 'codex' }).locator('.nsd-rt-version')).toHaveCount(0)
  // auto/shell 纯文本，不参与徽标渲染
  await expect(page.locator('.n-base-select-option').filter({ hasText: '自动（按可用性）' }).locator('.nsd-rt-version')).toHaveCount(0)
})

test('缺失项禁选 + 同源 tooltip + 点击不变；豁免链（覆盖命令/包装脚本）保持可选', async ({ page }) => {
  const { dlg } = await openDialog(page, [
    // 裸名命令 + 无覆盖：显式选择必被预检 400 → 禁选（事前不可点与 400 一致）
    rt({ name: 'sc-e2e-bare-missing', available: false, defaultCommand: 'sc-e2e-bare-missing-bin --serve' }),
    // 路径形态首词：预检豁免（原样启动承诺）→ 保持可选
    rt({ name: 'sc-e2e-wrap', available: false, defaultCommand: '/opt/e2e-wrap.sh --flag' }),
    // per-runtime 自定义命令覆盖：预检豁免（targetPrecheckName）→ 保持可选
    rt({ name: 'sc-e2e-cover', available: false, defaultCommand: 'sc-e2e-cover-bin', customCommand: '/opt/cover.sh' }),
  ])

  await openRuntimeMenu(page, dlg)
  const bareOpt = page.locator('.n-base-select-option').filter({ hasText: 'sc-e2e-bare-missing' })
  await expect(bareOpt).toBeVisible({ timeout: 5000 })
  await expect(bareOpt).toHaveClass(/-disabled/)
  // tooltip 与 P-79 稳定标记同源（KNOWN_ERROR_I18N agent.runtime.errorMissing 同短语），
  // 且附重探出路——禁选项不可达命令区说明行，tooltip 是该项唯一行动指引
  await expect(bareOpt.locator('.nsd-rt-opt')).toHaveAttribute('title', /未安装或不在服务进程 PATH/)
  await expect(bareOpt.locator('.nsd-rt-opt')).toHaveAttribute('title', /运行时检测/)

  // 豁免链：不带禁选类；「(不可用)」标注保留（既有口径）
  for (const name of ['sc-e2e-wrap', 'sc-e2e-cover']) {
    const opt = page.locator('.n-base-select-option').filter({ hasText: name })
    await expect(opt).not.toHaveClass(/-disabled/)
    await expect(opt).toContainText('不可用')
  }

  // 点击禁选项无效果：选择保持缺省 auto、菜单不关
  await bareOpt.click()
  await expect(dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection'))
    .toContainText('自动（按可用性）')

  // auto 恒可选：直选收起下拉
  await page.locator('.n-base-select-option').filter({ hasText: '自动（按可用性）' }).click()
  await expect(dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection'))
    .toContainText('自动（按可用性）')
})

test('auto 提交走既有链：真实创建成功关弹层（服务端选型/预检兜底）', async ({ page }) => {
  const { dlg, view } = await openDialog(page, [
    rt({ name: 'sc-e2e-bare-missing', available: false, defaultCommand: 'sc-e2e-bare-missing-bin' }),
  ])

  // 缺省 auto 直接提交：前端徽标是体验层非正确性层——服务端选型（可用运行时
  // 或降级纯 shell）+ 选后补检兜底，创建链照常走通
  await dlg.getByRole('button', { name: '创建' }).click()
  await expect(dlg).toBeHidden({ timeout: 20000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 10000 })
})
