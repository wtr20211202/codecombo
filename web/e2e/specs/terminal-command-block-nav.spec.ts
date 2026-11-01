import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 终端命令块跳过导航（P-20261003-269）E2E：
 *   1. 集成 shell 三条长输出命令（OSC 133 D 帧时刻在回显行记锚点，P-150 装饰同刻
 *      同法）→ Ctrl+Shift+↑/↓ 在命令块起点间跳转：屏上 marker 随跳转切换
 *      （.xterm-rows = 最后可见屏行，runbook-onfailure 同款断言技术；xterm v6 滚动
 *      位置由 SmoothScrollableElement 内部管理、DOM scrollTop 恒 0 不可读，故全部
 *      以「可见屏内容」为断言面），prev 逐块上移 / next 逐块下移、越过末块回到
 *      活跃提示符（末条输出哨兵回屏）
 *   2. 无 shell 集成嵌套 shell（win=cmd.exe，shellint 不覆盖 cmd；linux=bash
 *      --noprofile --norc，不走注入 rcfile）：嵌套内命令无 C/D 帧、外层启动命令的
 *      D 要等嵌套退出才到——锚点表为空，prev/next 零响应（降级现状，整屏内容不变）
 * 前置（spec 内自备）：临时空项目（终端对项目路径无 git 要求）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-block-nav'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-block-nav')
const RUN = String(Date.now()).slice(-8)
// 块起点标记（echo 行文本，即锚点行内容）：屏上可见性 = 跳转定位断言
const MARK = (n: string | number) => `SC-NAV-${n}-${RUN}`

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

/** 屏上包含 marker 文本的 xterm 行数（.xterm-rows 直接子行 = 最后可见屏，runbook 域同款） */
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

/** 最后可见屏的整屏文本：零响应断言用（跳转会改变可见行，纹丝不动则全等） */
function screenText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const screens = Array.from(document.querySelectorAll('.xterm')) as HTMLElement[]
    const visible = screens.filter(el => el.offsetParent !== null)
    const el = visible[visible.length - 1]
    return el ? (el.querySelector('.xterm-rows')?.textContent || '') : ''
  })
}

async function pressBlockNav(page: Page, dir: 'up' | 'down') {
  await page.keyboard.press(dir === 'up' ? 'Control+Shift+ArrowUp' : 'Control+Shift+ArrowDown')
}

test('集成 shell 多命令：Ctrl+Shift+↑/↓ 在命令块起点间跳转定位', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 三条长输出命令：echo 标记 = 块起点（回显行），100 行输出把上一块撑出可见屏；
  // 末尾哨兵（bash 算术展开 / PS 子表达式展开运行时构造）标记命令完成——刻意不让
  // 回显行含哨兵字面量：跳到块起点时屏上有整行命令回显，若回显含哨兵文本，
  // 「跳离底部后哨兵离屏」断言恒假。echo 行此时已滚出可见屏，不能以它等完成
  for (let n = 1; n <= 3; n++) {
    await xterm.click()
    const cmd = serverIsLinux
      ? `echo ${MARK(n)}; seq 1 100; echo SC-NAV-E$((n))-${RUN}`
      : `echo ${MARK(n)}; 1..100; echo "SC-NAV-E$(${n})-${RUN}"`
    await page.keyboard.type(cmd)
    await page.keyboard.press('Enter')
    await expect(xterm).toContainText(`SC-NAV-E${n}-${RUN}`, { timeout: 15000 })
  }
  // 等末条 D 帧 + 下一 prompt 处理入账（锚点随 D 帧在写入路径记账，与输出同流）
  await page.waitForTimeout(1200)

  // 底部空闲：末条输出哨兵在屏（=活跃提示符形态），三条块起点 marker 都不在屏
  expect(await markerRowCount(page, MARK('E3'))).toBeGreaterThan(0)
  expect(await markerRowCount(page, MARK(1))).toBe(0)
  expect(await markerRowCount(page, MARK(2))).toBe(0)
  expect(await markerRowCount(page, MARK(3))).toBe(0)

  // prev ×1：跳到末块（SC-NAV-3 回显行）——该 marker 出现、上一块不出现、底部哨兵离屏
  await pressBlockNav(page, 'up')
  await expect.poll(() => markerRowCount(page, MARK(3)), { timeout: 5000 }).toBeGreaterThan(0)
  expect(await markerRowCount(page, MARK(2))).toBe(0)
  expect(await markerRowCount(page, MARK('E3'))).toBe(0)

  // prev ×2：再上一块
  await pressBlockNav(page, 'up')
  await expect.poll(() => markerRowCount(page, MARK(2)), { timeout: 5000 }).toBeGreaterThan(0)
  expect(await markerRowCount(page, MARK(3))).toBe(0)

  // next：回下一块（与 prev 严格互逆，不停留在原块打转）
  await pressBlockNav(page, 'down')
  await expect.poll(() => markerRowCount(page, MARK(3)), { timeout: 5000 }).toBeGreaterThan(0)
  expect(await markerRowCount(page, MARK(2))).toBe(0)

  // next ×2：越过末块锚点 → 回到活跃提示符（底部哨兵回屏、块起点离屏）
  await pressBlockNav(page, 'down')
  await expect.poll(() => markerRowCount(page, MARK('E3')), { timeout: 5000 }).toBeGreaterThan(0)
  expect(await markerRowCount(page, MARK(3))).toBe(0)
})

test('无 shell 集成嵌套 shell：其命令不产生锚点（降级现状），prev/next 零响应', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 嵌套无集成 shell：cmd.exe 不在 shellint 覆盖面（win）；--noprofile --norc 不走
  // 注入 rcfile（linux）。外层启动命令的 D 帧要等嵌套 shell 退出才到（锚点记账在
  // D 时刻）——嵌套会话期间锚点表为空，嵌套内命令也永无 C/D 帧
  const launch = serverIsLinux ? 'bash --noprofile --norc' : 'cmd.exe'
  await xterm.click()
  await page.keyboard.type(launch)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)

  // 嵌套 shell 里跑两条长输出命令（末尾哨兵标记完成）：无 OSC133 → 无新锚点；
  // 长输出把早先内容撑出可见屏，「零响应 = 整屏不变」才有断言力度
  for (const n of ['B1', 'B2']) {
    await xterm.click()
    const cmd = serverIsLinux
      ? `echo ${MARK(n)}; seq 1 100; echo ${MARK(`E${n}`)}`
      : `echo ${MARK(n)} & for /l %i in (1,1,100) do @echo N-%i & echo ${MARK(`E${n}`)}`
    await page.keyboard.type(cmd)
    await page.keyboard.press('Enter')
    await expect(xterm).toContainText(MARK(`E${n}`), { timeout: 15000 })
  }
  await page.waitForTimeout(1000)

  // 底部空闲：末条哨兵在屏、早先内容（首条嵌套命令回显 / 启动命令行）已离屏
  expect(await markerRowCount(page, MARK('EB2'))).toBeGreaterThan(0)
  expect(await markerRowCount(page, MARK('B1'))).toBe(0)
  expect(await markerRowCount(page, launch)).toBe(0)
  const before = await screenText(page)

  // prev/next 交替多按：锚点表为空 → 零响应（整屏内容纹丝不动，降级现状）
  await pressBlockNav(page, 'up')
  await pressBlockNav(page, 'down')
  await pressBlockNav(page, 'up')
  await page.waitForTimeout(300)
  expect(await screenText(page)).toBe(before)
})
