import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * OSC 7 会话 cwd 实时追踪（P-20261004-59）E2E：
 * shellint（PowerShell prompt）发射 OSC 7 → 双路旁挂解析联动——
 *   服务端 readLoop（GET /api/terminals currentDir 字段，agent 感知面）+
 *   前端写入路径（terminal store currentDir → 树定位按钮/tooltip 消费位）；
 * 文件链接相对路径按「新 cwd」解析（cd 前死文本 → cd 后可点，链接层消费位）；
 * cd 出项目 → 定位按钮置灰（迁移反向语义：位置错了不再错挂）。
 * 回落不回归：创建即 root 未 cd 时读创建 dir（步骤 1 断言）+ 既有
 * terminal-file-links / terminal-locate-tree 两 spec（全程不 cd）守门。
 * 前置（spec 内自备）：临时项目 + 子目录夹具 inner.txt（第 3 行锚）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-cwd-track'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-cwd-track')
const SUB_DIR = 'e2e-cwd-sub'
const INNER_TXT = path.join(REPO_DIR, SUB_DIR, 'inner.txt')
// 相对路径探针：解析基准 = 会话 cwd——root 下不存在（死文本），子目录下存在（可点）
const NEEDLE = './inner.txt:3'

let unlockToken = ''
let projId = ''

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

interface SessionRow {
  id: string
  kind: string
  projectId: string
  path: string
  createdAt: string
  currentDir?: string
}

/** 本 spec 的项目终端会话（最新创建的 kind=shell 项目会话） */
async function mySession(): Promise<SessionRow | undefined> {
  const res = await api('GET', '/api/terminals')
  const list = (res.json?.data || []) as SessionRow[]
  const mine = list.filter(s => s.kind === 'shell' && s.projectId === projId)
  mine.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
  return mine[mine.length - 1]
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
  fs.mkdirSync(path.dirname(INNER_TXT), { recursive: true })
  fs.writeFileSync(INNER_TXT, 'line one\nline two\n// anchor-line-3\nline four\n')
  // 注册项目：路径交给服务端一律 serverPath 折算（跨拓扑口径）
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
  projId = String(proj.json?.data?.id || '')
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
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部，多 tab 时 first 会选中旧屏
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText('PS ', { timeout: 20000 })
  return xterm
}

// 定位 xterm 视口中含 needle 文本的行带（输出行经字符串拼接构造，天然不含
// 连续 needle），返回水平中点与行带纵向范围、行索引
function needleBand(page: Page, needle: string): Promise<{ x: number; top: number; height: number; rowIdx: number } | null> {
  return page.evaluate((n) => {
    const rows = Array.from(document.querySelectorAll('.xterm-rows > div')) as HTMLElement[]
    const candidates = rows.filter(r => (r.textContent || '').startsWith(n))
      .concat(rows.filter(r => !(r.textContent || '').startsWith(n) && (r.textContent || '').includes(n)))
    for (const row of candidates) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const t = node.textContent || ''
        const i = t.indexOf(n)
        if (i < 0) continue
        const range = document.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + n.length)
        const rect = range.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          return { x: rect.left + rect.width / 2, top: rect.top, height: rect.height, rowIdx: rows.indexOf(row) }
        }
      }
    }
    return null
  }, needle)
}

function rowUnderlined(idx: number): boolean {
  const rows = document.querySelectorAll('.xterm-rows > div')
  for (let i = Math.max(0, idx - 1); i <= Math.min(rows.length - 1, idx + 1); i++) {
    const spans = rows[i]!.querySelectorAll('span')
    for (const span of spans) {
      if ((getComputedStyle(span).textDecorationLine || '').includes('underline')) return true
    }
  }
  return false
}

// hover 链接并等链接态（自定义链接层异步探测存在性后才有下划线；行映射约半行
// 系统性偏差，按本行 ±1 多候选高度级联探测——terminal-file-links 同款收敛）
async function hoverUntilLinked(page: Page, needle: string): Promise<void> {
  const deadline = Date.now() + 10000
  let band = await needleBand(page, needle)
  while (!band && Date.now() < deadline) {
    await page.waitForTimeout(250)
    band = await needleBand(page, needle)
  }
  expect(band, `viewport 中找不到待 hover 文本: ${needle}`).not.toBeNull()
  for (const k of [0.5, -0.4, 1.4, 0.1, 0.9]) {
    const y = band!.top + band!.height * k
    await page.mouse.move(band!.x, y)
    await page.mouse.move(band!.x + 1, y)
    try {
      await page.waitForFunction(rowUnderlined, band!.rowIdx, { timeout: 4000 })
      return
    } catch { /* 该候选未出链接态：换下一候选 */ }
  }
  throw new Error(`hover 未出现链接态: ${needle}`)
}

test('OSC7 cwd 实时追踪：双路旁挂联动消费位，链接按新 cwd 解析，cd 出项目置灰', async ({ page }) => {
  test.setTimeout(240000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto(BASE + '/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 0) 回落基线：创建即 root 未 cd——无帧回落创建 dir，定位按钮为「无 dir」形态
  const locateBtn = page.getByTestId('terminal-locate-in-tree')
  await expect(locateBtn).toBeVisible({ timeout: 10000 })
  await expect(locateBtn).toHaveAttribute('title', '在文件树中定位', { timeout: 10000 })
  await expect(locateBtn).toBeEnabled()
  const session0 = await mySession()
  expect(session0, '项目终端会话应已创建').toBeTruthy()

  // 1) cwd 追踪前的链接基线：相对路径 ./inner.txt 按创建 dir（root）解析 → 不存在 → 死文本
  await xterm.click()
  // pwsh echo 用字符串拼接构造（提示行回显不含连续 needle，输出行才唯一命中）
  await page.keyboard.type(`$p='./inner.t'+'xt:3'; echo $p\r`)
  await expect(xterm).toContainText(NEEDLE, { timeout: 10000 })
  {
    const deadline = Date.now() + 10000
    let band = await needleBand(page, NEEDLE)
    while (!band && Date.now() < deadline) {
      await page.waitForTimeout(250)
      band = await needleBand(page, NEEDLE)
    }
    expect(band, 'viewport 中找不到基线探针输出').not.toBeNull()
    for (const k of [0.5, -0.4, 1.4]) {
      const y = band!.top + band!.height * k
      await page.mouse.move(band!.x, y)
      await page.mouse.move(band!.x + 1, y)
      await page.waitForTimeout(1000)
      const linked = await page.evaluate(rowUnderlined, band!.rowIdx)
      expect(linked, '创建 dir 下 ./inner.txt 不存在，不应出链接态').toBe(false)
    }
  }

  // 2) cd 进子目录 → 下一条 prompt 发射 OSC 7：
  //    a) 服务端链路（shellint → readLoop 旁挂 → 快照字段）
  //    b) 前端链路（写路径旁挂 → store → 树定位按钮/tooltip 消费位）
  await page.keyboard.type(`cd ${SUB_DIR}\r`)
  await expect.poll(async () => (await mySession())?.currentDir ?? '', { timeout: 20000 })
    .toContain(SUB_DIR)
  // 前端消费位迁移：定位按钮标题携带子目录（root 时为动作名本身）
  await expect(locateBtn).toHaveAttribute('title', new RegExp(SUB_DIR), { timeout: 15000 })
  // 活动 tab tooltip（同源 dirByTabId）同步跟随
  const activeTab = page.locator('.term-tab.is-active')
  await expect(activeTab).toHaveAttribute('title', new RegExp(SUB_DIR), { timeout: 15000 })

  // 3) 链接按新 cwd 解析：同一条相对路径探针再 echo——现在落在子目录内 → 可点
  await page.keyboard.type(`$p='./inner.t'+'xt:3'; echo $p\r`)
  await expect(xterm).toContainText(NEEDLE, { timeout: 10000 })
  await hoverUntilLinked(page, NEEDLE)

  // 4) cd 出项目：迁移反向语义——定位按钮置灰（不再错挂项目树），
  //    API currentDir 同步为项目外路径
  await page.keyboard.type(`cd ~\r`)
  await expect.poll(async () => {
    const s = await mySession()
    return s?.currentDir ?? ''
  }, { timeout: 20000 }).not.toContain('e2e-term-cwd-track')
  await expect(locateBtn).toBeDisabled({ timeout: 15000 })
  await expect(locateBtn).toHaveAttribute('title', '会话目录不在当前项目内', { timeout: 15000 })
})
