import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Page, Route } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Quick Open 文件清单 SWR 陈旧换新（P-20261003-299）：清单按项目缓存（事件失效
 * P-20261003-73 之外的第二道兜底），缓存记 fetchedAt、超过 TTL 视为陈旧——打开
 * 面板时陈旧即后台静默重拉：不清空现列表、无 loading 遮罩，旧清单立即可搜，
 * 响应回来（且项目未切换/未再失效）才换新；重拉失败静默保留旧表。
 * TTL 经 window.__scQuickOpenSwrTtlMs 注入短值驱动过期路径（addInitScript，
 * 应用代码每面板打开读一次）；走真实构建产物，自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-quickopen-swr')
const PROJ = 'e2e-quickopen-swr'
const BASELINE = 'swr-baseline.txt'
// 唯一文件名：跨运行残留（清理失败）不会让断言碰到旧同名词
const NEW_FILE_BASE = `swr-agent-created-${Date.now()}`
const NEW_FILE = `${NEW_FILE_BASE}.txt`
// 注入 TTL：远小于用例内等待窗口（等待均 ≥1s），保证重开时缓存必已陈旧
const INJECTED_TTL_MS = 300

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, BASELINE), 'quickopen swr e2e baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: quickopen swr 基线'])
  await registerProject(headers, PROJ, REPO_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 注入短 TTL（应用代码读 window.__scQuickOpenSwrTtlMs，未注入用默认 30s） */
async function injectShortTtl(page: Page) {
  await page.addInitScript((ttl) => {
    ;(window as unknown as { __scQuickOpenSwrTtlMs?: number }).__scQuickOpenSwrTtlMs = ttl
  }, INJECTED_TTL_MS)
}

async function openProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
}

/** 经路由层透传计数 /file-list 与 /file-tree（Quick Open 取数端点），支持对
 *  后续请求注延迟（观察「旧表先行」窗口）与中止（观察「失败保留旧表」） */
function fileListController(page: Page) {
  let listCount = 0
  let treeCount = 0
  let aborting = false
  let delayMs = 0
  async function handle(route: Route): Promise<unknown> {
    const url = route.request().url()
    if (url.includes('/file-list')) listCount++
    else treeCount++
    if (aborting) return route.abort()
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs))
    return route.continue()
  }
  void page.route('**/file-list*', handle)
  void page.route('**/file-tree*', handle)
  return {
    listCount: () => listCount,
    treeCount: () => treeCount,
    setDelay: (ms: number) => { delayMs = ms },
    abortAll: () => { aborting = true },
  }
}

async function openQuickOpen(page: Page) {
  await page.keyboard.press('Control+p')
  await expect(page.locator('.palette-input input')).toBeVisible({ timeout: 5000 })
}

const baselineItem = (page: Page) => page.locator('.palette-item').filter({ hasText: 'swr-baseline.txt' })

test('缓存陈旧重开面板：旧表立即可搜 + 后台静默重拉换新（无文件变更纯 TTL 驱动）', async ({ page }) => {
  test.setTimeout(60000)
  await injectShortTtl(page)
  // 路由拦装必须在导航前：导航完成后 page.route 与在途请求竞态会漏计数/漏拦截（实测）
  const fl = fileListController(page)
  await openProject(page)

  // 首开：建立项目级缓存
  await openQuickOpen(page)
  await expect.poll(() => fl.listCount(), { timeout: 5000 }).toBe(1)
  await expect(baselineItem(page)).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-input input')).toBeHidden({ timeout: 5000 })

  // 无任何文件事件（不触发 P-73 事件失效），仅等 TTL 过期后重开：
  // /file-list 必须重发——这是 TTL 兜底路径存在的直接证据
  await page.waitForTimeout(1200)
  fl.setDelay(1200) // 拖住重拉响应，制造「旧表先行」可观察窗口
  await openQuickOpen(page)
  await expect(baselineItem(page)).toBeVisible({ timeout: 5000 }) // 旧清单先渲染、立即可搜
  await expect.poll(() => fl.listCount(), { timeout: 5000 }).toBe(2) // 陈旧触发后台重拉
  // 无 loading 空态（列表非空渲染旧数据即为证据）；响应落地后换新仍含基线文件
  await expect(baselineItem(page)).toBeVisible({ timeout: 5000 })
  await page.waitForTimeout(1400) // 越过注入的响应延迟，确保重拉已落地
  await expect(baselineItem(page)).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Escape')
})

test('重拉失败静默保留旧表（不清空、不闪 loading 空态）', async ({ page }) => {
  test.setTimeout(60000)
  await injectShortTtl(page)
  const fl = fileListController(page)
  await openProject(page)

  await openQuickOpen(page)
  await expect.poll(() => fl.listCount(), { timeout: 5000 }).toBe(1)
  await expect(baselineItem(page)).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-input input')).toBeHidden({ timeout: 5000 })

  // TTL 过期 + 重拉整体失败（快路径与 BFS 回退都断）：旧清单必须原地保留
  await page.waitForTimeout(1200)
  fl.abortAll()
  await openQuickOpen(page)
  await expect.poll(() => fl.listCount(), { timeout: 5000 }).toBe(2) // 重拉被尝试过
  await expect.poll(() => fl.treeCount(), { timeout: 5000 }).toBeGreaterThanOrEqual(1) // BFS 回退也断
  await expect(baselineItem(page)).toBeVisible({ timeout: 5000 }) // 失败不清空——陈旧好过空白
  await page.keyboard.press('Escape')
})

test('agent 新建文件后重开面板：首轮旧表在列，后台刷新完成后新文件可搜', async ({ page }) => {
  test.setTimeout(60000)
  await injectShortTtl(page)
  const fl = fileListController(page)
  await openProject(page)

  await openQuickOpen(page)
  await expect.poll(() => fl.listCount(), { timeout: 5000 }).toBe(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-input input')).toBeHidden({ timeout: 5000 })

  // agent 造新文件：直接落盘。TTL 已过期 → 重开面板走陈旧换新；若 P-73 事件
  // 失效先到则走全量重拉——两条失效路径都合法，最终新文件都必须可搜
  fs.writeFileSync(path.join(REPO_DIR, NEW_FILE), 'created by agent\n')
  await page.waitForTimeout(400)

  await openQuickOpen(page)
  await expect(baselineItem(page)).toBeVisible({ timeout: 5000 }) // 首轮旧表即服务
  await expect.poll(() => fl.listCount(), { timeout: 5000 }).toBeGreaterThanOrEqual(2) // 重拉发生
  await page.locator('.palette-input input').fill(NEW_FILE_BASE)
  await expect(page.locator('.palette-item').filter({ hasText: NEW_FILE_BASE })).toBeVisible({ timeout: 10000 })
  // Esc 双层退出（P-20261004-95）：有查询先清——两连 Esc 才落到关闭
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
})
