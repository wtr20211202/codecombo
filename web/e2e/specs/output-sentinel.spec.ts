import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 输出哨兵（P-20261004-8）E2E：
 *   1. 设置「输出哨兵」分区 UI 新建规则 → API 落库复核（pattern/scope canonical/
 *      level 默认 warning）
 *   2. 终端输出命中闭环：新会话 echo 命中标记 → 通知中心出现「哨兵命中」条目 →
 *      关掉底部终端面板后点击通知 → 面板重开并直达触发会话（xterm 含标记）→
 *      同会话防抖窗内二次命中不重复入账（服务端同名条目计数恒 1）
 *   3. API 护栏：非法 pattern（编译校验）400、规则数上限（≤10）第 11 条 400、
 *      patch 改 pattern 为非法值 400
 * 规则/通知/项目经共享实例 API 清理，不残留测试数据；用例 2 开头幂等播种规则
 * ——Playwright 重试可能重跑 beforeAll（清理会删掉用例 1 建的规则），重试路径自愈
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-sentinel'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-sentinel')
const RULE_NAME = 'e2e 输出哨兵盯标'
const MARKER = 'E2ESENTINELMARK'
const HIT_TITLE = `哨兵命中：${RULE_NAME}`

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

async function cleanupRules(): Promise<void> {
  const list = await api('GET', '/api/sentinels')
  for (const r of ((list.json?.data || []) as { id: string; name: string }[])) {
    if (r.name === RULE_NAME || r.name.startsWith('e2e-cap-') || r.name === 'e2e-bad' || r.name === 'e2e-over') {
      await api('DELETE', `/api/sentinels/${r.id}`)
    }
  }
}

/** 幂等播种：同名规则在位即复用，缺失（重试路径 beforeAll 清理后）经 API 补建 */
async function ensureRule(): Promise<void> {
  const list = await api('GET', '/api/sentinels')
  const mine = ((list.json?.data || []) as { name: string }[]).find(r => r.name === RULE_NAME)
  if (mine) return
  const res = await api('POST', '/api/sentinels', { name: RULE_NAME, pattern: MARKER, scope: 'global', level: 'warning' })
  expect([200, 201]).toContain(res.status)
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) await api('DELETE', `/api/projects/${oldProj.id}`)
  await cleanupRules()
  await api('POST', '/api/notifications/clear')
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  // 注册路径按服务端形态交接（linux 实例经 /mnt/d 同见仓库 .sc-tmp 夹具）
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
})

test.afterAll(async () => {
  await cleanupRules()
  await api('POST', '/api/notifications/clear')
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

async function switchProject(page: Page, name: string) {
  await page.locator('.header-project-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: name }).first().click()
}

async function openFreshTerminal(page: Page) {
  // 用 rail 按钮精确定位：底部面板展开时 DOM 里还有面板切换钮/新建终端钮，
  // getByRole('终端') 会命中多个元素（strict violation）。
  // 面板可能已由 uiState 恢复为展开态：此时再点 rail 会把它收起，需幂等处理
  const panel = page.locator('.bottom-panel')
  const ensureOpen = async () => {
    if (!(await panel.isVisible().catch(() => false))) {
      await page.locator('.rail-btn[title="终端"]').click()
    }
    await expect(panel).toBeVisible({ timeout: 5000 })
  }
  await ensureOpen()
  // 清 uiState 恢复的历史 tab
  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
  await ensureOpen()
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部，多 tab 时 first 会选中旧屏
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  // 提示符按服务端 shell 分支：Windows PowerShell（PS ...）/ Linux bash（$ 或 #）
  await expect(xterm).toContainText(/[$#] |PS /, { timeout: 20000 })
  return xterm
}

/** 服务端已入账的哨兵命中条目数（按存储 Title 精确匹配） */
async function hitCount(): Promise<number> {
  const res = await api('GET', '/api/notifications')
  const list = ((res.json?.data || []) as Array<{ title?: string }>)
  return list.filter(n => n.title === HIT_TITLE).length
}

/** 轮询等待命中入账（readLoop tap → Notification.Add → WS 广播） */
async function waitHitCount(timeoutMs = 15000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const n = await hitCount()
    if (n > 0 || Date.now() > deadline) return n
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** 整串粘贴命令进终端（xterm textarea paste 事件 → xterm paste handler →
 *  onData 一次整串达 PTY）。逐字符 keyboard.type 的命令回显按字符分帧过哨兵
 *  滑窗，滑窗在回显中间态（如 `echo hit-…-no`，末字符未回显）已含完整 pattern
 *  → 首命中即报且摘录取当时行内容，5min 防抖窗把完整回显行/输出行的命中全部
 *  锁在窗外——通知摘录停在截断行。粘贴是产品合法输入路径（高危命令粘贴预检
 *  闸门对 echo 不命中），整串单帧回显无中间态。clipboardData 用假体注入
 *  （add-clone-suggest.spec 同款，不依赖真实剪贴板授权） */
async function pasteCommand(page: Page, xterm: ReturnType<Page['locator']>, text: string) {
  await xterm.locator('textarea').evaluate((el, t) => {
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: { getData: () => t } })
    el.dispatchEvent(ev)
  }, text)
}

test('设置分区新建哨兵规则并落库（scope canonical + level 默认 warning）', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.goto(`${BASE}/`)
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 设置 → 输出哨兵分区
  await page.locator('[data-testid="rail-settings"]').click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible()
  await modal.locator('.nav-item').filter({ hasText: '输出哨兵' }).click()
  const manager = modal.locator('[data-testid="sentinel-manager"]')
  await expect(manager).toBeVisible()

  // 新建规则：名称 + 匹配模式（作用域默认全部会话、级别默认警告）。
  // 表单弹窗是 NModal（teleport 到 body）不在设置弹窗子树内——页面级定位；
  // NInput/NInput-textarea 的 testid 落在包裹层，取内嵌 input/textarea
  await manager.locator('[data-testid="sentinel-add"]').click()
  await page.locator('[data-testid="sentinel-form-name"] input').fill(RULE_NAME)
  await page.locator('[data-testid="sentinel-form-pattern"] textarea').fill(MARKER)
  await page.locator('[data-testid="sentinel-form-save"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已保存' })).toBeVisible({ timeout: 5000 })

  // 列表出现该规则（级别徽标 + 作用域展示）
  const item = manager.locator(`[data-testid="sentinel-item-${RULE_NAME}"]`)
  await expect(item).toBeVisible({ timeout: 5000 })
  await expect(item).toContainText('警告')
  await expect(item).toContainText('全部终端会话')

  // API 落库复核：pattern 原样、scope canonical=global、level canonical=warning
  const list = await api('GET', '/api/sentinels')
  const mine = ((list.json?.data || []) as Array<{ name: string; pattern: string; scope: string; level: string }>)
    .find(r => r.name === RULE_NAME)
  expect(mine, 'sentinel rule persisted').toBeTruthy()
  expect(mine!.pattern).toBe(MARKER)
  expect(mine!.scope).toBe('global')
  expect(mine!.level).toBe('warning')
})

test('终端输出命中 → 通知入账 → 点击直达触发会话；防抖窗内二次命中不重复', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto(`${BASE}/project`)
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 重试路径自愈：beforeAll 重跑的清理可能已删掉用例 1 建的规则
  await ensureRule()

  // 终端输出命中标记（命令回显即含标记，PTY 输出流必经哨兵滑窗）。
  // 键入走整串粘贴（见 pasteCommand 注记）：逐字符 type 的回显分帧会让首命中
  // 落在回显中间态，防抖窗锁死后摘录缺 `-now` 后缀。执行符单独按 Enter。
  // 计数取相对基线：重试路径 beforeAll 未重跑时上一轮遗留条目不误伤断言
  const base = await hitCount()
  await xterm.click()
  await pasteCommand(page, xterm, `echo hit-${MARKER}-now`)
  await page.keyboard.press('Enter')
  expect(await waitHitCount()).toBe(base + 1)

  // 关掉底部终端面板制造「跳转前不可见」基线（通知中心蒙层会拦面板点击，
  // 必须在打开中心之前关）
  const panel = page.locator('.bottom-panel')
  await page.locator('.bottom-actions button[title="关闭"]').click()
  await expect(panel).toBeHidden({ timeout: 5000 })

  // 通知中心出现命中条目（标题 = 哨兵命中：<规则名>，正文含命中摘录）
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const row = page.locator('.nc-item').filter({ hasText: RULE_NAME }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  await expect(row).toContainText(`hit-${MARKER}-now`)
  await expect(row).toHaveClass(/clickable/)

  // 点击通知应重开面板并直达该会话
  await row.click()
  await expect(panel).toBeVisible({ timeout: 5000 })
  const jumped = page.locator('.xterm:visible').last()
  await expect(jumped).toContainText(MARKER, { timeout: 5000 })

  // 防抖：同会话窗内（5min）二次命中不重复入账——等服务端安静后计数仍基线 +1
  await jumped.click()
  await page.keyboard.type(`echo hit-${MARKER}-again\r`)
  await page.waitForTimeout(2500)
  expect(await hitCount()).toBe(base + 1)
})

test('API 护栏：非法 pattern 400、规则数上限 400、patch 非法 pattern 400', async () => {
  test.setTimeout(60000)
  await cleanupRules() // 上限护栏从干净基线起算（用例 1 的规则不计入）

  // 编译校验：非法正则写入口拒绝
  const bad = await api('POST', '/api/sentinels', { name: 'e2e-bad', pattern: '([unclosed' })
  expect(bad.status).toBe(400)

  // 规则数上限（≤10）：第 11 条拒绝；删一条后可再建
  const ids: string[] = []
  for (let i = 0; i < 10; i++) {
    const r = await api('POST', '/api/sentinels', { name: `e2e-cap-${i}`, pattern: `CAPMARK${i}` })
    expect(r.status).toBe(201)
    ids.push(r.json?.data?.id)
  }
  const over = await api('POST', '/api/sentinels', { name: 'e2e-over', pattern: 'X' })
  expect(over.status).toBe(400)

  // patch 改 pattern 为非法值同样拒绝（合法 patch 走通）
  const badPatch = await api('PUT', `/api/sentinels/${ids[0]}`, { pattern: '*bad' })
  expect(badPatch.status).toBe(400)
  const okPatch = await api('PUT', `/api/sentinels/${ids[0]}`, { level: 'error' })
  expect(okPatch.status).toBe(200)
  expect(okPatch.json?.data?.level).toBe('error')
})
