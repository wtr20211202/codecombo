import { test, expect, type Page } from '@playwright/test'
import net from 'node:net'
import { gotoAndUnlock, fixedLocale, fetchWslHost } from '../../tests/helpers'

/**
 * 远程部署设置页回归（用户报告的两类问题）：
 *   1. 从首页打开设置 → 远程部署 → 点主机卡片「诊断 / 执行」必须弹出
 *      对应弹窗（此前弹窗只挂在项目页 Layout，首页点击毫无反应）
 *   2. 凭据行 user@host:port 不得逐字换行（卡片重构后主操作只有「终端」+「更多」，
 *      host-detail 有 nowrap 保护）
 *
 * 「终端直达」实流用例依赖 WSL 主机在线：WSL sshd 不可达时跳过（与其他
 * 实流用例同款环境门控——历史上 WSL 常驻在线故从未暴露此脆弱性）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

// 主机行文本与探针共用播种记录端口（槽位专用实例非 23，P-20261004-115）；
// 记录缺失时回落 23——此时主机行本身不会出现，可见性断言先行失败
let wslPort = 23
let wslSeeded = false

function wslReachable(timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: wslPort })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

test.beforeAll(async () => {
  const wslHost = await fetchWslHost(BASE)
  wslPort = wslHost?.port || 23
  // 记录在场性即卡片数据源在场性：缺失（播种未跑，如跨拓扑金态无 WSL 域）
  // = 环境边界，用例按门控 skip 而非卡片定位失败（P-20261005-187）
  wslSeeded = wslHost !== null
})

// 从首页进入设置并切到远程部署分区，点开 WSL 主机的「更多」菜单
async function openHostMoreMenu(page: Page) {
  const addr = `root@127.0.0.1:${wslPort}`
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  // 首页顶栏齿轮打开设置
  await page.locator('.home-action-btn[title="设置"]').click()
  // 左侧导航切到「远程部署」
  await page.locator('.settings-nav .nav-item').filter({ hasText: '远程部署' }).click()
  // 主机卡片行出现（凭据不逐字换行：一行内完整可见）
  const detail = page.locator('.host-detail').filter({ hasText: addr }).first()
  await expect(detail).toBeVisible({ timeout: 10000 })
  // 换行体检：元素高度应接近单行（~18px），逐字换行会超过 2 倍高度
  const box = await detail.boundingBox()
  if (box) expect(box.height).toBeLessThan(30)
  // 展开该主机的「更多」下拉（最后一个按钮 = EllipsisHorizontal）
  const row = page.locator('.host-row').filter({ hasText: addr }).first()
  await row.locator('.host-actions .n-button').last().click()
}

test('首页设置 → 主机卡片 → 诊断弹窗可达（App 全局弹窗）', async ({ page }) => {
  test.skip(!wslSeeded, 'WSL 主机记录未播种（跨拓扑金态无 WSL 域），跳过')
  await openHostMoreMenu(page)
  await page.locator('.n-dropdown-option').filter({ hasText: '诊断' }).first().click()
  await expect(page.locator('.diag-title')).toContainText('远程主机诊断', { timeout: 10000 })
  await expect(page.locator('.diag-title')).toContainText('WSL')
})

test('首页设置 → 主机卡片 → 远程执行弹窗可达', async ({ page }) => {
  test.skip(!wslSeeded, 'WSL 主机记录未播种（跨拓扑金态无 WSL 域），跳过')
  await openHostMoreMenu(page)
  await page.locator('.n-dropdown-option').filter({ hasText: '执行' }).first().click()
  await expect(page.locator('.rexec-title')).toContainText('远程命令执行', { timeout: 10000 })
})

test('设置卡片「终端」主按钮直达远程控制台（内嵌视图）并预选主机', async ({ page }) => {
  test.skip(!wslSeeded, 'WSL 主机记录未播种（跨拓扑金态无 WSL 域），跳过')
  test.skip(!(await wslReachable()), 'WSL sshd 不可达，跳过实流用例')
  test.setTimeout(120000)
  await fixedLocale(page)
  // 关 tab 免确认：用例结束清场，防残留 tab 影响后续运行（恢复出 WSL · 2 之类）
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.home-action-btn[title="设置"]').click()
  await page.locator('.settings-nav .nav-item').filter({ hasText: '远程部署' }).click()
  const row = page.locator('.host-row').filter({ hasText: `root@127.0.0.1:${wslPort}` }).first()
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.getByRole('button', { name: '终端' }).click()
  // 跳到项目页内嵌远程控制台视图（?view=remote&host=... 的 query 即刻被清理，
  // 断言视图与自动开的终端，而非 URL）
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  // 自动为预选主机开终端 → tab 出现
  await expect(page.locator('.remote-tab').filter({ hasText: 'WSL · 1' })).toBeVisible({ timeout: 20000 })

  // 清场：关掉打开的 tab（免确认已设置）
  while (await page.locator('.remote-tab .remote-tab-close').count() > 0) {
    await page.locator('.remote-tab .remote-tab-close').first().click()
    await page.waitForTimeout(400)
  }
})
