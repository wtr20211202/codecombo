import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { DND_STORAGE_KEY } from '../../src/stores/dnd'

/**
 * 免打扰解除摘要行 E2E（P-20261003-64）：
 * 免打扰时段结束后通知中心顶部出现「免打扰期间新增 N 条」摘要行：
 *   1. N 正确：窗口内播种的条目计数（窗口外对照条目不计）
 *   2. 点击切换过滤视图：仅显窗口内条目（对照隐藏），摘要转激活态
 *   3. 退出过滤视图 / 点 × 手动关闭 → 摘要消隐（会话内态），过滤同步退出
 * 播种约束：服务端 POST /api/notifications 显式清零 time（入账时刻即事实，
 * 无法回填），故用「窗口覆盖播种时刻、约 1 分钟后自然结束」的确定性等待——
 * start=now-2min / end=now+75s，HH:mm 分钟截断后仍保证播种时刻严格落在
 * [start, end) 内（end 截断只减不增 ≥ now+15s，start 截断只减不增 ≤ now-2min）。
 * 窗口判定取面板打开时刻（nowMs 时钟锚），故顺序为：窗口内播种 → 导航项目页
 * → 等墙钟越过窗口结束（解除）→ 播种窗外对照 → 开面板断言摘要。
 * 免打扰偏好存 localStorage（addInitScript 预置，每用例独立 context 互不泄漏，
 * 同 approval-sound.spec）；通知列表为服务端全局状态：每用例开头先清空。
 */

const IN_WINDOW = ['e2e-dnd-sum-甲', 'e2e-dnd-sum-乙', 'e2e-dnd-sum-丙']
const OUT_WINDOW = 'e2e-dnd-sum-窗外对照'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function clearNotes(headers: Record<string, string>): Promise<void> {
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
}

async function seed(headers: Record<string, string>, titles: string[]): Promise<void> {
  for (const title of titles) {
    const res = await fetch(`${API_BASE}/api/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'info', category: 'system', title, body: '' }),
    })
    expect(res.ok).toBeTruthy()
  }
}

// 解除前窗口规划：返回 localStorage 配置与「真实结束时刻」（HH:mm 分钟截断
// 后的墙钟毫秒）。截断把 end 往早修最多 59s，若修到了播种+10s 以内（跨午夜
// 形态落到今天已过去的时刻）则 +24h 修正——等待上限仍 ~77s
function planWindow(t0: number): { start: string; end: string; endTs: number } {
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = (ms: number) => {
    const d = new Date(ms)
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  const endHm = hm(t0 + 75_000)
  const [eh, em] = endHm.split(':').map(Number)
  const endDate = new Date(t0)
  endDate.setHours(eh, em, 0, 0)
  if (endDate.getTime() < t0 + 10_000) endDate.setDate(endDate.getDate() + 1)
  return { start: hm(t0 - 120_000), end: endHm, endTs: endDate.getTime() }
}

// 等墙钟越过窗口结束（免打扰解除）+2s 余量
async function waitWindowEnd(w: { endTs: number }): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, Math.max(0, w.endTs + 2000 - Date.now())))
}

// 解锁后延迟弹出的「建议修改默认密码」提醒遮罩会拦项目卡片点击（时序不定），
// 出现则先「稍后提醒」收起（notification-center.spec 同款处理）
async function dismissPwdTip(page: import('@playwright/test').Page): Promise<void> {
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

// 预置免打扰偏好（窗口覆盖播种时刻）并导航到项目页——面板不打开（窗口判定
// 在面板打开时刻重算，须等解除后再开）
async function gotoProjectWithDnd(
  page: import('@playwright/test').Page,
  w: { start: string; end: string },
): Promise<void> {
  // addInitScript 回调被序列化执行，Node 侧常量不在浏览器闭包里——key 走参数
  // 传入（approval-sound.spec 同款注释）
  await page.addInitScript(([k, v]) => {
    localStorage.setItem(k, v)
  }, [DND_STORAGE_KEY, JSON.stringify({ enabled: true, start: w.start, end: w.end })])
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await dismissPwdTip(page)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await clearNotes(headers)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await clearNotes(headers)
})

test('摘要行：N 正确 → 点击仅显窗口内条目 → 退出消隐', async ({ page }) => {
  test.setTimeout(150_000)
  const headers = await unlockHeaders()
  await clearNotes(headers)

  const t0 = Date.now()
  const w = planWindow(t0)
  await seed(headers, IN_WINDOW) // 播种时刻落在窗口内

  await gotoProjectWithDnd(page, w)
  await waitWindowEnd(w)
  await seed(headers, [OUT_WINDOW]) // 解除后入账：窗外对照

  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })

  const summary = page.locator('[data-testid="notif-dnd-summary"]')
  const rows = page.locator('.nc-item:not(.nc-sub)')
  await expect(summary).toContainText('免打扰期间新增 3 条', { timeout: 5000 })
  await expect(summary).not.toHaveClass(/active/)

  // 点击 → 过滤视图：窗口内 3 条，窗外对照隐藏，摘要转激活态
  await summary.click()
  await expect(summary).toHaveClass(/active/)
  await expect(rows).toHaveCount(3, { timeout: 5000 })
  await expect(rows.filter({ hasText: OUT_WINDOW })).toHaveCount(0)

  // 再点退出 → 摘要消隐（已查看），过滤同步退出恢复全量
  await summary.click()
  await expect(summary).toHaveCount(0)
  await expect(rows).toHaveCount(4)
  await expect(rows.filter({ hasText: OUT_WINDOW })).toHaveCount(1)
})

test('摘要行手动关闭：× 消隐且过滤不生效', async ({ page }) => {
  test.setTimeout(150_000)
  const headers = await unlockHeaders()
  await clearNotes(headers)

  const t0 = Date.now()
  const w = planWindow(t0)
  await seed(headers, IN_WINDOW)

  await gotoProjectWithDnd(page, w)
  await waitWindowEnd(w)
  await seed(headers, [OUT_WINDOW])

  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })

  const summary = page.locator('[data-testid="notif-dnd-summary"]')
  const rows = page.locator('.nc-item:not(.nc-sub)')
  await expect(summary).toContainText('免打扰期间新增 3 条', { timeout: 5000 })

  await summary.locator('[data-testid="notif-dnd-summary-close"]').click()
  await expect(summary).toHaveCount(0)
  // 过滤未生效：全量 4 条（窗内 3 + 窗外对照 1）原样可见
  await expect(rows).toHaveCount(4)
  await expect(rows.filter({ hasText: OUT_WINDOW })).toHaveCount(1)
})
