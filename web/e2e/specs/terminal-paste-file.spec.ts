import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 终端文件粘贴（P-20261024-2）E2E：OS 复制文件 → 终端 Ctrl+V（此处合成原生
 * paste 事件——键盘链经 useTerminalKeys 放行后派发的正是该事件，文件只在
 * paste 事件 clipboardData.files 暴露）→ paste-file 形态上传 sc-paste-* →
 * 路径文本贴入终端。三用例：
 *   1. 多文件粘贴：逐文件上传（file 字段）+ 逐文件一行路径贴入 + 汇总 toast，
 *      落盘文件内容逐字节一致（白名单 .txt/.md）
 *   2. 白名单外类型（.exe）：无上传请求、即时「不支持类型」反馈、终端无路径
 *   3. 目录形态载荷（types 含 Files、零类型项）：「拖入文件树」引导，不上传
 * 前置（spec 内自备）：临时空项目。image 字段截图链由 paste-image-compress.spec
 * 守护，此处不重复
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-terminal-paste-file'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-terminal-paste-file')

let unlockToken = ''
const servedPaths: string[] = []

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

test.afterEach(async () => {
  // 清理本用例落盘的 sc-paste-* 临时文件（服务端 24h 清理兜底，这里用完即清）
  while (servedPaths.length > 0) {
    const p = servedPaths.pop()!
    try { fs.rmSync(p, { force: true }) } catch { /* 忽略 */ }
  }
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
  await expect(xterm).toContainText(/[$#] |PS /, { timeout: 20000 })
  return xterm
}

/** 焦点进终端（activeElement 落 xterm helper textarea——attachNativePaste 的归属守卫）， */
async function focusTerminal(page: Page) {
  const textarea = page.locator('.xterm:visible .xterm-helper-textarea').last()
  await textarea.focus()
  await expect.poll(() => page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false)).toBe(true)
}

/** 在终端焦点域合成 paste 事件：files 走真实 DataTransfer（主通道路径），
 *  或 stub clipboardData（目录形态——DataTransfer 构造无法注入零类型项） */
async function dispatchPaste(page: Page, payload: { files?: Array<{ name: string; type: string; content: string }>, folderLike?: boolean }) {
  await page.evaluate((payload) => {
    const el = document.activeElement
    let dt: DataTransfer | { files: File[]; types: string[]; items: Array<{ kind: string; type: string }> }
    if (payload.folderLike) {
      dt = { files: [], types: ['Files'], items: [{ kind: 'file', type: '' }] }
    } else {
      const real = new DataTransfer()
      for (const f of payload.files ?? []) real.items.add(new File([f.content], f.name, { type: f.type }))
      dt = real
    }
    const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: dt })
    el!.dispatchEvent(ev)
  }, payload)
}

const pasteImageUrl = '/api/terminals/paste-image'

test('多文件粘贴：file 字段逐个上传、路径贴入终端、汇总 toast', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)
  await focusTerminal(page)

  // 双响应捕获用 on('response') 收集器而非并发 waitForResponse：两个同谓词
  // waitForResponse 会对第一个匹配响应各自解析（Playwright 等待者互不消费事件），
  // 拿到同一响应两份——串行上传的第二份真实落盘反而漏捕（首轮 e2e 实证形态）
  const captured: Array<{ status: () => number; json: () => Promise<{ data?: { path?: string } }> }> = []
  const onResp = (resp: { url: () => string; request: () => { method: () => string }; status: () => number; json: () => Promise<{ data?: { path?: string } }> }) => {
    if (resp.url().includes(pasteImageUrl) && resp.request().method() === 'POST') captured.push(resp)
  }
  page.on('response', onResp)
  await dispatchPaste(page, {
    files: [
      { name: 'e2e-paste-file-a.txt', type: 'text/plain', content: 'terminal paste file A 你好' },
      { name: 'e2e-paste-file-b.md', type: 'text/markdown', content: '# terminal paste file B' },
    ],
  })
  try {
    // 逐文件串行上传：恰好两个响应（多于两个 = 重复上传回归，同样不过）
    await expect.poll(() => captured.length, { timeout: 30000 }).toBe(2)
  } finally {
    page.off('response', onResp)
  }
  for (const resp of captured) {
    expect(resp.status()).toBe(200)
    const body = await resp.json()
    expect(body.data?.path).toBeTruthy()
    servedPaths.push(body.data!.path!)
  }
  // 两路径互异：同毫秒批量上传不共享落盘名（服务端 O_EXCL 防碰撞语义）
  expect(new Set(servedPaths).size).toBe(2)

  // 汇总 toast（i18n pasteFile.done，n=2）
  await expect(page.locator('.n-message').filter({ hasText: '2 个文件路径已贴入终端' })).toBeVisible({ timeout: 5000 })
  // 路径文本贴入终端（逐文件一行：两行 sc-paste-* 均在缓冲）
  await expect(xterm).toContainText('sc-paste-', { timeout: 20000 })

  // 落盘内容逐字节一致（白名单 .txt/.md 直存不转码）
  const contents = await Promise.all(servedPaths.map(p => fs.promises.readFile(p, 'utf8')))
  expect(contents.sort()).toEqual(['# terminal paste file B', 'terminal paste file A 你好'])
})

test('白名单外类型：不上传、即时「不支持类型」反馈、终端无路径', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)
  await focusTerminal(page)

  let uploadSeen = false
  const onReq = (r: { url: () => string; method: () => string }) => {
    if (r.url().includes(pasteImageUrl) && r.method() === 'POST') uploadSeen = true
  }
  page.on('request', onReq)
  try {
    await dispatchPaste(page, {
      files: [{ name: 'e2e-evil.exe', type: 'application/octet-stream', content: 'MZ' }],
    })
    await expect(page.locator('.n-message').filter({ hasText: '不支持的文件类型' })).toBeVisible({ timeout: 5000 })
    await page.waitForTimeout(1200)
    expect(uploadSeen).toBe(false)
  } finally {
    page.off('request', onReq)
  }
  await expect(xterm).not.toContainText('sc-paste-')
})

test('目录形态粘贴：引导拖入文件树，不上传', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)
  await focusTerminal(page)

  let uploadSeen = false
  const onReq = (r: { url: () => string; method: () => string }) => {
    if (r.url().includes(pasteImageUrl) && r.method() === 'POST') uploadSeen = true
  }
  page.on('request', onReq)
  try {
    await dispatchPaste(page, { folderLike: true })
    await expect(page.locator('.n-message').filter({ hasText: '拖入文件树' })).toBeVisible({ timeout: 5000 })
    await page.waitForTimeout(1200)
    expect(uploadSeen).toBe(false)
  } finally {
    page.off('request', onReq)
  }
  await expect(xterm).not.toContainText('sc-paste-')
})
