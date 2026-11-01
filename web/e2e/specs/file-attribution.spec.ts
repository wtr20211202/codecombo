import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件改动来源归因（P-20261005-170）E2E：
 *   1. 编辑器保存（PUT /file 的 API 写链）→ 归因账 source=editor 非命令窗
 *      （自环过滤），文件树右键「改动来源」弹窗在列；
 *   2. 会话跑 `echo x > f; rm g` → 两事件归因该命令（source=command，
 *      会话名 + 命令摘要在列；rm 的 remove 事件同窗归因）。
 * 前置（spec 内自备）：临时项目 + 直写夹具（rm 目标先于命令存在）。
 * 会话用 UI 造（服务端 shellint 注入 C/D 帧——服务端 oscstate 窗即归因面），
 * 命令经 xterm 键入（terminal-cwd-track 同配方，`;` 分隔跨 PS/bash）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ = 'e2e-fs-attrib'
const DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-fs-attrib')

// 探针名（项目根直放，文件树免展开；worker/repeat 维度隔离防复跑撞残留）
function probeName(testInfo: { workerIndex: number; repeatEachIndex: number }, tag: string): string {
  return `e2e-fsa-${tag}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}.txt`
}

let unlockToken = ''
let projectId = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

interface AttributionEvent {
  at: string
  path: string
  op?: string
  source: 'command' | 'editor' | 'unattributed'
  attributions?: { terminalId: string; sessionName: string; command?: string; running?: boolean }[]
  overlap?: boolean
}

/** 归因账查询（带重试轮询由调用方 expect.poll 驱动）：返回该路径全部事件 */
async function queryAttribution(relPath: string): Promise<AttributionEvent[]> {
  const res = await api('GET', `/api/projects/${projectId}/fs-attribution?path=${encodeURIComponent(relPath)}&limit=50`)
  expect(res.status).toBe(200)
  return (res.json?.data || []) as AttributionEvent[]
}

// 直写探针内容（PUT /file 走生产写路径——API 写标记在该链路上打点）
async function apiWrite(relPath: string, content: string) {
  const res = await api('PUT', `/api/projects/${projectId}/file`, { path: relPath, content })
  if (res.status !== 200) throw new Error(`write ${relPath}: ${res.status}`)
}

async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const projectCard = page.locator('.project-card').filter({ hasText: PROJ }).first()
  await projectCard.click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——奇数次点击保证最终打开
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.tree-item').first().isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

async function openAttributionModal(page: Page, name: string) {
  const item = page.locator('.tree-item').filter({ has: page.locator('.item-name', { hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) }) }).first()
  await expect(item).toBeVisible({ timeout: 10000 })
  await item.click({ button: 'right' })
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  await menu.getByText('改动来源', { exact: true }).click()
  const modal = page.locator('[data-testid="fs-attribution-modal"]')
  await expect(modal).toBeVisible({ timeout: 8000 })
  return modal
}

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const list = await api('GET', '/api/projects')
  const old = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
  if (old) await api('DELETE', `/api/projects/${old.id}`)
  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(DIR, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ, path: serverPath(DIR) })
  expect([200, 201]).toContain(proj.status)
  projectId = (proj.json?.data as { id: string }).id
})

test.afterAll(async () => {
  const list = await api('GET', '/api/terminals')
  for (const s of ((list.json?.data || []) as { id: string; kind: string; projectId: string }[])) {
    if (s.kind === 'shell' && s.projectId === projectId) await api('DELETE', `/api/terminals/${s.id}`)
  }
  if (projectId) await api('DELETE', `/api/projects/${projectId}`)
  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('编辑器保存（API 写链）归因「编辑器」非命令窗，树右键弹窗在列', async ({ page }, testInfo) => {
  test.setTimeout(120000)
  const name = probeName(testInfo, 'ed')
  const rel = name

  await apiWrite(rel, 'fsa-editor-marker\n')
  // 账面异步入账（watcher → 总线 → fsattr），轮询至 editor 事件出现
  let events: AttributionEvent[] = []
  await expect.poll(async () => {
    events = await queryAttribution(rel)
    return events.filter(e => e.source === 'editor').length
  }, { timeout: 15000 }).toBeGreaterThanOrEqual(1)
  expect(events[0].source).toBe('editor')

  // 树右键「改动来源」→ 弹窗列出编辑器归因（人侧入口在位）
  await enterProject(page)
  const modal = await openAttributionModal(page, name)
  await expect(modal.getByText('编辑器').first()).toBeVisible({ timeout: 8000 })
})

test('会话跑 echo 重定向 + rm：两事件归因该命令（会话名/命令摘要/退出码在列）', async ({ page }, testInfo) => {
  test.setTimeout(180000)
  const created = probeName(testInfo, 'mk')
  const deleted = probeName(testInfo, 'rm')
  // rm 目标先于命令存在（直写夹具；项目已在册，写入事件本身可能入账为
  // unattributed——不影响本用例只看 rm 的 remove 事件归因）
  fs.writeFileSync(path.join(DIR, deleted), 'bye\n')

  // 底部终端面板 + UI 造 shell 会话（服务端 shellint 注入 C/D 帧）
  await enterProject(page)
  const panel = page.locator('.bottom-panel')
  for (let i = 0; i < 3 && !(await panel.isVisible().catch(() => false)); i++) {
    await page.locator('.rail-btn[title="终端"]').click()
    await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态，重试 */ })
  }
  await expect(panel).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: '新建终端' }).first().click()
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText('PS ', { timeout: 20000 })
  await xterm.click()

  // 会话名（归因账展示面）：GET /terminals 取本项目最新 shell 会话
  const list = await api('GET', '/api/terminals')
  const mine = ((list.json?.data || []) as { id: string; name: string; kind: string; projectId: string }[])
    .filter(s => s.kind === 'shell' && s.projectId === projectId)
  expect(mine.length).toBeGreaterThanOrEqual(1)
  const sessionName = mine[mine.length - 1].name

  // `;` 分隔跨 shell（PS 5.1 无 &&）：echo 重定向写 f、rm 删 g——两事件应同窗
  // 归因该命令（命令文本经 E 帧入账）
  await page.keyboard.type(`echo fsa-marker > ${created}; rm ${deleted}\r`)

  // f 的写事件归因命令（命令摘要 + 会话名）。running 不作断言：账面在事件
  // 入账当时判定，事件常在命令仍在跑（D 未至）时先落——true/false 皆诚实
  let events: AttributionEvent[] = []
  await expect.poll(async () => {
    events = await queryAttribution(created)
    return events.filter(e => e.source === 'command').length
  }, { timeout: 20000 }).toBeGreaterThanOrEqual(1)
  const cmd = events.find(e => e.source === 'command')!
  expect(cmd.attributions?.length ?? 0).toBeGreaterThanOrEqual(1)
  expect(cmd.attributions![0].sessionName).toBe(sessionName)
  expect(cmd.attributions![0].command).toContain(created)

  // g 的删除事件同窗归因该命令（remove/rename 形态随平台，归因不随）
  let delEvents: AttributionEvent[] = []
  await expect.poll(async () => {
    delEvents = await queryAttribution(deleted)
    return delEvents.filter(e => e.source === 'command').length
  }, { timeout: 20000 }).toBeGreaterThanOrEqual(1)
  expect(delEvents[0].attributions?.[0]?.sessionName).toBe(sessionName)
})
