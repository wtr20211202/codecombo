import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 终端文件路径链接（P-20261001-1）E2E：
 * 终端 echo 一条 `路径:行号` → hover 出现链接态（下划线）→ Ctrl+单击 →
 * 编辑器打开对应文件并滚动定位到锚点行（P-20261002-54：裸单击不激活，
 * 路径文本不劫持终端聚焦/定位单击）。覆盖三种形态：
 *   1. 不存在路径：hover 不出链接态（存在性门禁）
 *   2. 相对路径 src/app.go:55（go build / tsc 报错主形态）+ 裸单击不开 / Ctrl+单击开
 *   3. 绝对路径（Windows 盘符 / POSIX，跨拓扑经 serverPath 折算）
 * 前置（spec 内自备）：临时空项目 + 60 行夹具文件（第 55 行为锚点，未滚动时
 * Monaco 视口不渲染该行，出现即证明行定位生效）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-file-links'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-file-links')
const APP_GO = path.join(REPO_DIR, 'src', 'app.go')
const ANCHOR = 'file-link-anchor-55'
const NEG_PATH = 'missing/ghost.txt:3'
const REL_PATH = 'src/app.go:55'

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
  fs.mkdirSync(path.dirname(APP_GO), { recursive: true })
  // 60 行夹具：锚点在第 55 行——视口未滚动时 Monaco 不渲染该行，
  // 点击链接后可见即证明 revealLineInCenter 生效
  const lines: string[] = ['package main', '']
  for (let i = 2; i < 60; i++) {
    lines.push(i === 55 ? `// ${ANCHOR}` : `// pad line ${i}`)
  }
  fs.writeFileSync(APP_GO, lines.join('\n') + '\n')
  // 注册项目：路径交给服务端一律 serverPath 折算（跨拓扑口径）
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
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部，多 tab 时 first 会选中旧屏
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText('PS ', { timeout: 20000 })
  return xterm
}

// 定位 xterm 视口中含 needle 文本的行带（优先「以 needle 开头」的纯输出行——
// 提示行经字符串拼接构造，天然不含连续 needle），返回水平中点、行带纵向范围
// 与行索引（下划线检测按行 ±1 收敛，防上一步残留 hover 态串扰）
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

// 链接态检测：xterm v6 链接 hover 的事件（onShowLinkUnderline）驱动 DOM renderer
// 重绘行内 span 加下划线样式（实测 xterm-cursor-pointer 类在本环境不可靠，
// URL 链接同样不出现，下划线为稳定信号）。行映射存在约半行偏差，检测收敛到
// 目标行 ±1 的 span（rowIdx 作参数传入——evaluate 不序列化闭包）
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

// 行带重试查询：echo 输出行渲染需百余毫秒，轮询至出现（含超时报错）
async function waitForBand(page: Page, needle: string, timeout = 10000) {
  const deadline = Date.now() + timeout
  for (;;) {
    const band = await needleBand(page, needle)
    if (band) return band
    if (Date.now() > deadline) {
      expect(band, `viewport 中找不到待 hover 文本: ${needle}`).not.toBeNull()
      return
    }
    await page.waitForTimeout(250)
  }
}

// hover 链接并等待链接态出现（自定义链接层异步解析存在性后才有链接态）。
// DOM 行带与 xterm 内部鼠标→单元格映射存在约半行的系统性偏差：按本行/相邻行
// 多个候选高度级联探测，任一出现链接态即成功（返回实际坐标供点击）
async function hoverUntilLinked(page: Page, needle: string): Promise<{ x: number; y: number }> {
  const b = await waitForBand(page, needle)
  let hit: { x: number; y: number } | null = null
  for (const k of [0.5, -0.4, 1.4, 0.1, 0.9]) {
    const y = b.top + b.height * k
    await page.mouse.move(b.x, y)
    await page.mouse.move(b.x + 1, y)
    try {
      await page.waitForFunction(rowUnderlined, b.rowIdx, { timeout: 4000 })
      hit = { x: b.x, y }
      break
    } catch { /* 该候选位置未出链接态：换下一候选 */ }
  }
  expect(hit, `hover 未出现链接态: ${needle}`).not.toBeNull()
  return hit!
}

async function hoverExpectNoLink(page: Page, needle: string) {
  const b = await waitForBand(page, needle)
  // 本行与相邻行各探一次（行映射偏差容忍）：均无链接态才判定门禁生效
  for (const k of [0.5, -0.4, 1.4]) {
    const y = b.top + b.height * k
    await page.mouse.move(b.x, y)
    await page.mouse.move(b.x + 1, y)
    await page.waitForTimeout(1000)
    const linked = await page.evaluate(rowUnderlined, b.rowIdx)
    expect(linked, `不应出现链接态: ${needle}`).toBe(false)
  }
}

test('终端路径链接：不存在路径无链接态；相对/绝对路径 Ctrl+单击直达编辑器并定位行，裸单击不激活', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto(BASE + '/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // echo 用字符串拼接构造（pwsh '+' 连接）：提示行回显不含连续 needle 文本，
  // 待 hover 的唯一命中行就是干净的输出行，规避行带歧义
  const pwshEcho = (head: string, tail: string) => `$p='${head}'+'${tail}'; echo $p\r`

  // 1. 存在性门禁：不存在的路径保持死文本，hover 无链接态
  await xterm.click()
  const negSlash = NEG_PATH.indexOf('/')
  await page.keyboard.type(pwshEcho(NEG_PATH.slice(0, negSlash), NEG_PATH.slice(negSlash)))
  await expect(xterm).toContainText(NEG_PATH, { timeout: 10000 })
  await hoverExpectNoLink(page, NEG_PATH)

  // 2. 相对路径（编译/测试报错主形态）：hover 链接态 → 裸单击不激活 →
  //    Ctrl+单击 → 编辑器打开并定位锚点行
  const relSlash = REL_PATH.indexOf('/')
  await page.keyboard.type(pwshEcho(REL_PATH.slice(0, relSlash), REL_PATH.slice(relSlash)))
  await expect(xterm).toContainText(REL_PATH, { timeout: 10000 })
  const hit = await hoverUntilLinked(page, REL_PATH)
  // 裸单击（无修饰键）：不派发打开事件，编辑器不出现 app.go 标签（P-20261002-54）
  await page.mouse.move(hit.x, hit.y)
  await page.mouse.down()
  await page.mouse.up()
  await expect(page.locator('.editor-tab').filter({ hasText: 'app.go' })).toHaveCount(0, { timeout: 5000 })
  // Ctrl+单击（keyboard.down 保住修饰键直到 mousedown 带上 ctrlKey）：打开并定位
  await page.keyboard.down('Control')
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.up('Control')
  await expect(page.locator('.editor-tab').filter({ hasText: 'app.go' })).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(ANCHOR, { timeout: 15000 })

  // 3. 绝对路径：Windows 盘符形态（跨拓扑经 serverPath 折算为服务端形态）。
  //    同样从最后一个分隔符拆成两段拼接，提示行不出现完整绝对路径
  const absNeedle = `${serverPath(APP_GO)}:55`
  const absBase = absNeedle.slice(0, -3) // 去掉 ':55'
  const sepAt = Math.max(absBase.lastIndexOf('/'), absBase.lastIndexOf('\\'))
  await xterm.click() // 步骤 2 的行定位会 focus Monaco：先聚焦回终端再输入
  await page.keyboard.type(pwshEcho(absBase.slice(0, sepAt), absBase.slice(sepAt) + ':55'))
  await expect(xterm).toContainText(path.basename(APP_GO), { timeout: 10000 })
  const hit2 = await hoverUntilLinked(page, absNeedle)
  // 绝对路径同样 Ctrl+单击激活（裸单击已在步骤 2 断言不激活）
  await page.mouse.move(hit2.x, hit2.y)
  await page.keyboard.down('Control')
  await page.mouse.down()
  await page.mouse.up()
  await page.keyboard.up('Control')
  // 文件已开：本次为切 tab + 重新定位，锚点仍可见即证明激活链路通
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(ANCHOR, { timeout: 15000 })
})
