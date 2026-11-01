import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, LOCK_OVERLAY } from '../../tests/helpers'

/**
 * 远程实例切换冒烟 E2E
 *
 * 前置条件（环境相关，缺失时用例会失败）：
 * - 本地服务 :9999 运行（默认密码 admin、已配置名为 wsl-server 的远程实例）
 * - 远程实例可达且含名为 demo 的项目
 *
 * 覆盖：
 * - 解锁 → UI 切换到远程实例 → 远程项目列表可见
 * - 打开项目看到远程文件树（HTTP 代理链路）
 * - 打开终端面板 → 新建终端 → xterm 渲染 + 命令回显（WS 代理链路）
 * - 期间无 WebSocket 握手错误、无 429 限流
 */

const REMOTE_INSTANCE_NAME = 'wsl-server'
const REMOTE_PROJECT_NAME = 'demo'

// 环境门控：依赖预配置的远程实例 wsl-server（指向 WSL 内 9998 systemd 服务）。
// 全新数据目录没有该实例，属环境缺失而非功能缺陷，跳过（与 wslUp 同惯例）
let remoteInstancePresent = false
test.beforeAll(async ({ request }) => {
  const unlock = await request.post('/api/lock/unlock', { data: { password: DEFAULT_PASSWORD } })
  const token = ((await unlock.json()) as { token?: string }).token || ''
  const res = await request.get('/api/instances', { headers: { 'X-Lock-Token': token } })
  const list = ((await res.json()) as { data?: { name: string }[] }).data || []
  remoteInstancePresent = list.some(i => i.name === REMOTE_INSTANCE_NAME)
})

// 解锁：boot 竞态（LockScreenOverlay 的 visible = isLocked && isReady）下
// 先等遮罩出现或主界面可见，再填密码。
// 注意：Chromium 走 text-security 主路径（.lock-form input），Firefox 回退 type=password
async function unlockIfNeeded(page: Page) {
  const input = page.locator(`${LOCK_OVERLAY} .lock-form input`).first()
  await Promise.race([
    expect(input).toBeVisible({ timeout: 10000 }).catch(() => {}),
    page.locator('.instance-indicator').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {}),
  ])
  if (await input.isVisible().catch(() => false)) {
    await input.fill(DEFAULT_PASSWORD)
    await page.locator(`${LOCK_OVERLAY} button[type="submit"]`).first().click()
    await expect(input).toBeHidden({ timeout: 10000 })
  }
}

test('切换到远程实例：项目浏览 + 文件树 + 终端', async ({ page }) => {
  test.skip(!remoteInstancePresent, '预配置远程实例 wsl-server 不存在（全新数据目录），跳过')
  const wsErrors: string[] = []
  const limitedErrors: string[] = []
  page.on('console', msg => {
    const text = msg.text()
    if (text.includes('WebSocket handshake')) wsErrors.push(text)
    if (text.includes('429')) limitedErrors.push(text)
  })

  await page.goto('/')
  await unlockIfNeeded(page)

  // 默认密码安全提示弹窗：点「稍后提醒」关闭
  const remindBtn = page.getByRole('button', { name: '稍后提醒' })
  if (await remindBtn.isVisible().catch(() => false)) {
    await remindBtn.click()
    await expect(remindBtn).toBeHidden({ timeout: 5000 })
  }
  await page.waitForTimeout(800)

  // 打开实例菜单切换到远程实例
  await page.locator('.instance-indicator').click()
  const menu = page.locator('.menu-panel')
  await expect(menu).toBeVisible({ timeout: 5000 })
  await menu.locator('.instance-row').filter({ hasText: REMOTE_INSTANCE_NAME }).click()
  await page.waitForTimeout(3000)

  // 子实例锁是环境侧状态（token TTL 过期 / 120min 自动锁回锁）：中心令牌对
  // 子实例无效，切换后前端静默展示子实例自己的锁定遮罩——用 e2e 默认密码
  // 就地解锁；解不开（密码被改）沿用环境门控哲学跳过
  const childInput = page.locator(`${LOCK_OVERLAY} .lock-form input`).first()
  if (await childInput.isVisible().catch(() => false)) {
    await childInput.fill(DEFAULT_PASSWORD)
    await page.locator(`${LOCK_OVERLAY} button[type="submit"]`).first().click()
    await page.waitForTimeout(1200)
    if (await page.locator(LOCK_OVERLAY).isVisible().catch(() => false)) {
      test.skip(true, 'WSL 子实例锁定且非默认密码，无法在测试内解除，跳过')
    }
  }

  // 默认密码修改提醒按实例各自弹出：切到子实例后会再次拦截点击，处置
  const remindAfterSwitch = page.getByRole('button', { name: '稍后提醒' })
  if (await remindAfterSwitch.isVisible().catch(() => false)) {
    await remindAfterSwitch.click()
    await expect(remindAfterSwitch).toBeHidden({ timeout: 5000 })
  }

  // 远程项目列表可见并进入项目
  await expect(page.getByText(REMOTE_PROJECT_NAME).first()).toBeVisible({ timeout: 15000 })
  await page.getByText(REMOTE_PROJECT_NAME).first().click()
  await page.waitForTimeout(2500)

  // 远程文件树（HTTP 代理）
  await expect(page.getByText('README.md').first()).toBeVisible({ timeout: 15000 })

  // 终端面板 → 新建终端（WS 代理）。
  // rail-btn 的 active 类精确反映 showBottomPanel && bottomTab==='terminal'——
  // uiState 可能恢复其他 bottomTab（git/console）或已开终端面板，盲目点击会 toggle 关闭
  const termBtn = page.locator('.rail-btn[title="终端"]')
  const termActive = async () => (await termBtn.getAttribute('class'))?.includes('active')
  if (!(await termActive())) {
    await termBtn.click()
    await page.waitForTimeout(1200)
  }
  // 已有 tab（uiState 恢复）则无空态按钮，直接用工具栏「新建终端」
  const newBtn = page.locator('.bottom-panel button[aria-label="新建终端"], .bottom-panel .term-toolbar button').first()
  await newBtn.click()
  // 新建后重连激活逻辑可能短暂切换 activeTab（残留 tab 恢复），等激活收敛再断言
  await page.waitForTimeout(1000)

  // 激活 tab 的内容容器（v-show 下唯一 display!=none 的 .term-tab-content）
  const activeContent = page.locator('.term-tab-content:visible')
  await expect(activeContent).toHaveCount(1, { timeout: 15000 })

  // 等屏幕渲染出 shell 提示符（WS 连接 + scrollback 重放完成，DOM 趋稳）再点击聚焦
  await expect
    .poll(async () => (await activeContent.locator('.xterm-rows').allInnerTexts()).join('\n'), { timeout: 15000 })
    .toMatch(/\$|#|>/)
  await activeContent.locator('.xterm').click({ timeout: 15000 })
  await page.keyboard.type('echo UI_TERM_OK', { delay: 40 })
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await activeContent.locator('.xterm-rows').allInnerTexts()).join('\n'), { timeout: 10000 })
    .toContain('UI_TERM_OK')

  // 全程不应出现 WS 握手失败 / 429 限流
  expect(wsErrors, wsErrors.join('\n')).toHaveLength(0)
  expect(limitedErrors, limitedErrors.join('\n')).toHaveLength(0)
})
