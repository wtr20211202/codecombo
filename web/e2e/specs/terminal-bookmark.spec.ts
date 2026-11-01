import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 终端 scrollback 书签（P-20261004-16）E2E：
 *   1. 标记两行——右键回滚区目标行（pointer → 缓冲行解析）「标记此行」→
 *      gutter 小旗装饰（.xterm-decoration.sc-bookmark）在屏可见 + toast 反馈 +
 *      面板行带标记行文本快照（验证行解析命中目标行）
 *   2. 列表跳转——tab 右键「书签列表」开面板，点击书签行滚动定位：目标行回屏、
 *      另一书签行离屏（两标记间隔 100+ 行 > 可见屏，断言有区分度）
 *   3. 快捷键 Ctrl+Alt+K 开关面板（历史/片段同族 doc 级面板键，VS Code Bookmarks 扩展同款默认键）
 *   4. 切换语义——已标记行右键文案翻转为「取消标记」→ 摘除后面板行随之消失；
 *      行内 ✕ 摘除 → 空态呈现
 *   前置（spec 内自备）：临时空项目（终端对项目路径无 git 要求）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-bookmark'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-bookmark')
const RUN = String(Date.now()).slice(-8)
// 标记行文本（书签快照与屏上可见性断言面）：A/B 无前缀包含关系
const MARK = (n: string) => `SC-BM-${n}-${RUN}`

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
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
})

test.afterAll(async () => {
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
  const panel = page.locator('.bottom-panel')
  const ensureOpen = async () => {
    if (!(await panel.isVisible().catch(() => false))) {
      await page.locator('.rail-btn[title="终端"]').click()
    }
    await expect(panel).toBeVisible({ timeout: 5000 })
  }
  await ensureOpen()
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
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText(serverIsLinux ? /[#$] / : 'PS ', { timeout: 20000 })
  return xterm
}

/** 屏上包含 marker 文本的 xterm 行数（.xterm-rows 直接子行 = 最后可见屏，命令块导航同款） */
function markerRowCount(page: Page, marker: string): Promise<number> {
  return page.evaluate((n) => {
    const screens = Array.from(document.querySelectorAll('.xterm')) as HTMLElement[]
    const visible = screens.filter(el => el.offsetParent !== null)
    const el = visible[visible.length - 1]
    if (!el) return -1
    const rows = Array.from(el.querySelectorAll('.xterm-rows > div')) as HTMLElement[]
    return rows.filter(r => (r.textContent || '').includes(n)).length
  }, marker)
}

/** 可见终端里 sc-bookmark 小旗装饰的可见元素数：装饰元素在行滚出视口后仍留存
 *  DOM（xterm 置 display:none，DecorationService 不删除），`:visible` 须落在
 *  装饰本身上（只限定 .xterm 会把隐藏装饰一起计入） */
function bookmarkFlagCount(page: Page): Promise<number> {
  return page.locator('.xterm:visible .xterm-decoration.sc-bookmark:visible').count()
}

/** 键盘滚动直到 marker 行出现在可见屏（dir=up 向上 / down 向下）：
 *  Shift+PageUp/Down 是 xterm 视口翻页（每按 rows-1 行，实测确定性行进，且不写
 *  PTY）；滚轮在 headless 下被平滑滚动动画吞步长（实测 600px 一次仅 ~3 行）不可靠。
 *  终端须持有键盘焦点（xterm.click 重取），翻页不写 PTY、回显零污染 */
async function scrollUntilVisible(page: Page, xterm: ReturnType<Page['locator']>, marker: string, dir: 'up' | 'down') {
  await xterm.click()
  for (let i = 0; i < 30; i++) {
    if (await markerRowCount(page, marker) > 0) return
    await page.keyboard.press(dir === 'up' ? 'Shift+PageUp' : 'Shift+PageDown')
    await page.waitForTimeout(120)
  }
  // 末次机会：连续翻页后的渲染收尾
  await expect.poll(() => markerRowCount(page, marker), { timeout: 5000 }).toBeGreaterThan(0)
}

/** 右键指定标记行 → 菜单「标记此行/取消标记」点击（切换动作返回当前态） */
async function toggleBookmarkOnRow(page: Page, marker: string, expectItemText: RegExp) {
  // 标记文本带 RUN 后缀全局唯一，单终端会话内匹配行恒 1 条；.last() 是 xterm
  // 堆叠作用域的约定取向（多 tab 时旧屏 DOM 序在前，check-e2e-conventions 门禁）
  const row = page.locator('.xterm:visible .xterm-rows > div').filter({ hasText: marker }).last()
  await expect(row).toBeVisible()
  const box = await row.boundingBox()
  if (!box) throw new Error('目标行无布局盒')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  const item = page.getByTestId('term-bookmark-line')
  await expect(item).toBeVisible()
  await expect(item).toContainText(expectItemText)
  await item.click()
}

test('标记两行 → 书签列表跳转 → 滚动定位 + 快捷键 + 切换摘除', async ({ page }) => {
  test.setTimeout(240000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 两条命令各 100 行输出：A/B 标记行间隔 100+ 行（> 可见屏），跳转断言有区分度
  for (const n of ['A', 'B']) {
    await xterm.click()
    const cmd = serverIsLinux
      ? `echo ${MARK(n)}; seq 1 100; echo ${MARK(`E${n}`)}`
      : `echo ${MARK(n)}; 1..100; echo "${MARK(`E${n}`)}"`
    await page.keyboard.type(cmd)
    await page.keyboard.press('Enter')
    await expect(xterm).toContainText(MARK(`E${n}`), { timeout: 15000 })
  }
  // 等末条命令收尾 + ConPTY/PSReadLine 末帧重绘落定（含输入态建议行清场）——
  // 与命令块导航 spec 的 D 帧入账等待同款
  await page.waitForTimeout(1200)
  // 底部空闲：两标记行均离屏
  expect(await markerRowCount(page, MARK('A'))).toBe(0)
  expect(await markerRowCount(page, MARK('B'))).toBe(0)

  // ── 标记第一行（A）：翻页回 A 区右键「标记此行」──
  await scrollUntilVisible(page, xterm, MARK('A'), 'up')
  await toggleBookmarkOnRow(page, MARK('A'), /标记此行/)
  // toast 第二确认（fixedLocale 中文文案）
  await expect(page.locator('.n-message').first()).toContainText('已标记')
  // gutter 小旗在屏可见；B 离屏（同屏可见旗恒为当前标记行这一面）
  await expect.poll(() => bookmarkFlagCount(page), { timeout: 5000 }).toBe(1)

  // ── 标记第二行（B）：翻页到 B 区右键标记，A 的旗随行离屏隐藏 ──
  await scrollUntilVisible(page, xterm, MARK('B'), 'down')
  await toggleBookmarkOnRow(page, MARK('B'), /标记此行/)
  await expect.poll(() => bookmarkFlagCount(page), { timeout: 5000 }).toBe(1)

  // ── 书签列表：tab 右键开面板，两行书签各带标记行文本快照（行解析命中验证）──
  await page.locator('.term-tab').first().click({ button: 'right' })
  await page.getByTestId('terminal-bookmark-list').click()
  const panel = page.getByTestId('terminal-bookmark-panel')
  await expect(panel).toBeVisible()
  const rows = page.getByTestId('terminal-bookmark-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.filter({ hasText: MARK('A') })).toHaveCount(1)
  await expect(rows.filter({ hasText: MARK('B') })).toHaveCount(1)

  // ── 列表跳转：点击 A 行 → A 回屏（B 离屏）；旗随行回屏 ──
  await rows.filter({ hasText: MARK('A') }).click()
  await expect.poll(() => markerRowCount(page, MARK('A')), { timeout: 5000 }).toBeGreaterThan(0)
  await expect.poll(() => bookmarkFlagCount(page), { timeout: 5000 }).toBe(1)
  expect(await markerRowCount(page, MARK('B'))).toBe(0)

  // 点击 B 行 → B 回屏（A 离屏），与 A 严格互斥
  await rows.filter({ hasText: MARK('B') }).click()
  await expect.poll(() => markerRowCount(page, MARK('B')), { timeout: 5000 }).toBeGreaterThan(0)
  expect(await markerRowCount(page, MARK('A'))).toBe(0)

  // ── 快捷键 Ctrl+Alt+K：关面板再开（历史/片段同族 doc 级面板键）──
  await page.getByTestId('terminal-bookmark-close').click()
  await expect(panel).toBeHidden()
  await page.keyboard.press('Control+Alt+K')
  await expect(panel).toBeVisible()
  await expect(rows).toHaveCount(2)

  // ── 切换语义：已标记的 B 行右键文案翻转「取消标记」→ 摘除后面板行消失 ──
  await page.getByTestId('terminal-bookmark-close').click()
  await expect(panel).toBeHidden()
  await toggleBookmarkOnRow(page, MARK('B'), /取消标记/)
  await expect(page.locator('.n-message').first()).toContainText('已取消')
  // B 摘除后视口停在 B 区：A 的小旗在视口外（display:none）→ 可见旗为 0；
  // A 的书签仍在（下方面板行数断言承接）
  await expect.poll(() => bookmarkFlagCount(page), { timeout: 5000 }).toBe(0)
  await page.keyboard.press('Control+Alt+K')
  await expect(rows).toHaveCount(1)

  // ── 行内 ✕ 摘除：最后一行移除 → 空态呈现 ──
  await page.getByTestId('terminal-bookmark-row').first().hover()
  await page.locator('.bookmark-remove').first().click()
  await expect(rows).toHaveCount(0)
  await expect(panel.locator('.bookmark-empty')).toBeVisible()
  await expect.poll(() => bookmarkFlagCount(page), { timeout: 5000 }).toBe(0)
})
