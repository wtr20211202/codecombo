import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 会话数量软阈值提示 E2E（P-20261003-183）：
 *  - 阈值内创建不提示，管理页头部总数标签随创建/关闭实时正确（②常驻可见性）
 *  - 第 21 个创建（前端常量 SESSIONS_WARN_THRESHOLD=20）轻提示一次
 *    「会话较多（21 个），注意资源」——非阻断：会话照常创建成功
 *  - episode 门控：超阈时段内继续创建（第 22 个）不重复弹；经 API 关闭会话
 *    落回阈值以内（快照对账复位）后再次越阈重新提示
 *
 * 播种方式：第 1~20 个经 API 直建（kind=agent runtime=shell 纯终端——与
 * agent-terminal.spec 同款，真实 PTY 但无智能体启动开销）；「创建动作」经管理页
 * 新建会话对话框走前端 store（toast 在创建响应路径触发，API 直建不经过浏览器
 * store，正好分离「播种」与「被测动作」）。
 *
 * 本文件用例数与阈值常量耦合：前端 SESSIONS_WARN_THRESHOLD 变更须同步本文件
 * 的 THRESHOLD 与各用例的播种数量。
 */

test.setTimeout(120_000)

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
/** 镜像 web/src/stores/terminal-sessions.ts 的 SESSIONS_WARN_THRESHOLD */
const THRESHOLD = 20

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部终端会话（服务端全局共享；shell/agent 全清保证计数确定性） */
async function cleanupAllSessions(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers }).catch(() => {})
  }
}

/** API 直建纯终端会话直至存活数达标（对账补齐式播种）：Windows 下并发 ConPTY
 *  spawn 有少量即时退出的环境形态（实测并发 5×4 会掉 0~11 个），阈值用例的
 *  确定性不能依赖单次 spawn 成功率——逐个创建 + 每轮对账存活数补差额，稳定
 *  停留达标后返回。上限 8 轮防环境劣化时死循环 */
async function seedSessions(request: APIRequestContext, dir: string, n: number): Promise<void> {
  const headers = await unlockHeaders(request)
  const aliveCount = async (): Promise<number> => {
    const res = await request.get(`${BASE}/api/terminals`, { headers })
    const list = ((await res.json()) as { data?: { id: string }[] }).data || []
    return list.length
  }
  for (let round = 0; round < 8; round++) {
    const alive = await aliveCount()
    if (alive >= n) {
      // 稳定停留确认：等 1.5s 再对账一次仍达标（早死者暴露窗口）才算播种完成
      await new Promise((r) => setTimeout(r, 1500))
      if (await aliveCount() >= n) return
      continue
    }
    for (let i = alive; i < n; i++) {
      const r = await request.post(`${BASE}/api/terminals`, {
        headers,
        // 会话 dir 按服务端形态交接（服务端校验目录须已存在，Windows 形态
        // 跨拓扑不可解析，P-20261005-187）；测试侧 fs 清理用原形态
        data: { kind: 'agent', runtime: 'shell', name: `e2e-count-r${round}-${i}`, dir: serverPath(dir) },
      })
      if (!r.ok()) throw new Error(`seed ${i} failed: ${r.status()}`)
    }
  }
  throw new Error(`seed failed: alive sessions below ${n} after 8 rounds`)
}

/** 进入项目页并打开终端会话管理页（docked） */
async function openManager(page: Page) {
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
  const railBtn = page.locator('.rail-btn[title="终端会话管理"]')
  await expect(railBtn).toHaveCount(1)
  await railBtn.click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  return view
}

/** 对话框创建一个纯终端会话（新建会话按钮 → 纯终端 → 创建） */
async function createViaDialog(page: Page, view: ReturnType<Page['locator']>, dir: string) {
  await view.getByRole('button', { name: '新建会话' }).first().click()
  const dlg = page.locator('.n-modal')
  await expect(dlg).toBeVisible({ timeout: 5000 })
  // 运行时下拉按表单行语义定位（对话框有两枚 .n-base-selection，P-20261002-16）
  await dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: '纯终端' }).click()
  await dlg.locator('input').nth(1).fill(serverPath(dir))
  await dlg.getByRole('button', { name: '创建' }).click()
  await expect(dlg).toBeHidden({ timeout: 15000 })
}

/** 轻提示 toast（离散 message 与应用内 provider 同为 .n-message DOM 形态） */
function warnToast(page: Page) {
  return page.locator('.n-message').filter({ hasText: '会话较多' })
}

test.beforeEach(async ({ request }) => {
  await cleanupAllSessions(request)
})

test.afterAll(async ({ request }) => {
  await cleanupAllSessions(request)
})

test('阈值内创建不提示；管理页总数标签随创建实时正确', async ({ page }) => {
  await fixedLocale(page)
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'sc-count-warn-'))
  try {
    await seedSessions(page.request, tmpDir, 2)
    const view = await openManager(page)

    // ②管理页总数：头部标签「2 个会话」
    await expect(view.locator('.atv-count')).toHaveText('2 个会话', { timeout: 10000 })

    // 第 3 个经对话框创建（阈值内）→ 不提示；总数跟到 3
    await createViaDialog(page, view, tmpDir)
    await expect(view.locator('.atv-count')).toHaveText('3 个会话', { timeout: 10000 })
    await page.waitForTimeout(1500)
    await expect(warnToast(page)).toHaveCount(0)
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('第 21 个创建轻提示一次（非阻断，会话照常创建）；第 22 个不重复弹', async ({ page }) => {
  await fixedLocale(page)
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'sc-count-warn-'))
  try {
    await seedSessions(page.request, tmpDir, THRESHOLD)
    const view = await openManager(page)
    await expect(view.locator('.atv-count')).toHaveText(`${THRESHOLD} 个会话`, { timeout: 10000 })

    // 第 21 个：轻提示 + 总数跟到 21（非阻断——会话正常入列）
    await createViaDialog(page, view, tmpDir)
    await expect(warnToast(page).filter({ hasText: `会话较多（${THRESHOLD + 1} 个）` })).toBeVisible({ timeout: 10000 })
    await expect(view.locator('.atv-count')).toHaveText(`${THRESHOLD + 1} 个会话`, { timeout: 10000 })

    // episode 门控：等首条 toast 自动消失后，第 22 个创建不再弹
    await expect(warnToast(page)).toBeHidden({ timeout: 15000 })
    await createViaDialog(page, view, tmpDir)
    await expect(view.locator('.atv-count')).toHaveText(`${THRESHOLD + 2} 个会话`, { timeout: 10000 })
    await page.waitForTimeout(1500)
    await expect(warnToast(page)).toHaveCount(0)
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('落回阈值以内复位 episode：再次越阈重新提示', async ({ page }) => {
  await fixedLocale(page)
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'sc-count-warn-'))
  try {
    await seedSessions(page.request, tmpDir, THRESHOLD)
    const view = await openManager(page)
    await expect(view.locator('.atv-count')).toHaveText(`${THRESHOLD} 个会话`, { timeout: 10000 })

    // 越阈：第 21 个提示
    await createViaDialog(page, view, tmpDir)
    await expect(warnToast(page)).toBeVisible({ timeout: 10000 })
    await expect(warnToast(page)).toBeHidden({ timeout: 15000 })

    // API 关一个（21→20）：快照对账复位 episode——总数标签跟到 20 即对账已应用
    const headers = await unlockHeaders(page.request)
    const res = await page.request.get(`${BASE}/api/terminals`, { headers })
    const list = ((await res.json()) as { data?: { id: string }[] }).data || []
    await page.request.delete(`${BASE}/api/terminals/${list[0]!.id}`, { headers })
    await expect(view.locator('.atv-count')).toHaveText(`${THRESHOLD} 个会话`, { timeout: 10000 })

    // 再次越阈（20→21）：重新提示
    await createViaDialog(page, view, tmpDir)
    await expect(warnToast(page).filter({ hasText: `会话较多（${THRESHOLD + 1} 个）` })).toBeVisible({ timeout: 10000 })
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})
