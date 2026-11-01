import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 跨项目实时变更流 E2E（P-20261003-232）：
 *   1. API 契约：写文件 → GET /api/watch/activity 快照含事件且 projectId 归属正确
 *   2. 双项目时间线：两个注册项目各写一个文件 → 值班大屏变更流卡两项目条目
 *      （项目徽标 + 相对文件路径）；写后 5s 轮询周期内呈现（实时感知链路）
 *   3. 去抖聚合生效：同项目 2s 窗内连写 8 个文件 → 单一批次行（count=8，
 *      预览 4 条 + 「等 4 个文件」），不逐文件刷行
 *   4. 独立面板入口：活动栏开侧栏面板呈现时间线；同项目条目点击直开文件
 *      （P-20261006-52 条目深链）
 *   5. 跨项目深链：值班卡点项目 B 条目 → 守卫切至 B 且文件打开（两段式全程）
 *   6. 降级只切项目：路径剥不出可靠相对路径（根不匹配，经 route 拦截注入）
 *      → 点击只切项目不开文件
 * 自备临时仓库，afterAll 清理（watch-fallback 同款对称）。
 */

const DIR_A = path.join(os.tmpdir(), 'sc-e2e-stream-a')
const DIR_B = path.join(os.tmpdir(), 'sc-e2e-stream-b')
const PROJ_A = 'e2e-stream-alpha'
const PROJ_B = 'e2e-stream-beta'

let idA = ''
let idB = ''

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

/** 造一个最小 git 仓库（watcher 注册后文件事件才有归属） */
function seedRepo(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'base.txt'), 'baseline\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: baseline'])
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

/** 注册项目（返回 id）；同名残留先删（失败重跑防撞名） */
async function addProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === name) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  const id = body.data?.id || ''
  expect(id).not.toBe('')
  return id
}

async function removeProject(headers: Record<string, string>, id: string): Promise<void> {
  if (!id) return
  await fetch(`${API_BASE}/api/projects/${id}`, { method: 'DELETE', headers }).catch(() => {})
}

interface ActivityResp {
  data?: { events?: { ts: number; projectId: string; path: string }[]; dropped?: number }
}

async function getActivity(headers: Record<string, string>): Promise<ActivityResp['data']> {
  const res = await fetch(`${API_BASE}/api/watch/activity?limit=200`, { headers })
  expect(res.status).toBe(200)
  return ((await res.json()) as ActivityResp).data
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  seedRepo(DIR_A)
  seedRepo(DIR_B)
  idA = await addProject(headers, PROJ_A, DIR_A)
  idB = await addProject(headers, PROJ_B, DIR_B)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await removeProject(headers, idA)
  await removeProject(headers, idB)
  try { fs.rmSync(DIR_A, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  try { fs.rmSync(DIR_B, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
})

test('API 契约：文件变更进快照且 projectId 归属正确', async () => {
  test.setTimeout(30000)
  const headers = await unlockHeaders()
  // 注册后 watcher 已挂（project.added 即时 TrackProject）；沉降 1s 避开
  // 建项目自身的目录事件噪声窗口
  await settle()
  fs.writeFileSync(path.join(DIR_A, 'api-contract.txt'), 'stream api contract\n')
  const deadline = Date.now() + 15_000
  for (;;) {
    const data = await getActivity(headers)
    const hit = (data?.events || []).find(ev => ev.projectId === idA && ev.path.endsWith('api-contract.txt'))
    if (hit) {
      expect(hit.ts).toBeGreaterThan(0)
      break
    }
    if (Date.now() > deadline) throw new Error('activity snapshot never contained the write')
    await settle(1000)
  }
})

/** 测试进程内沉降（等 watcher 注册/事件落环） */
function settle(ms = 1000): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('双项目改文件 → 值班大屏变更流卡两项目条目（5s 轮询周期内）', async ({ page }) => {
  test.setTimeout(60000)
  await settle(1000)
  fs.writeFileSync(path.join(DIR_A, 'card-alpha.txt'), 'alpha change\n')
  fs.writeFileSync(path.join(DIR_B, 'card-beta.txt'), 'beta change\n')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  const card = page.locator('[data-testid="monitor-change-stream-card"]')
  await expect(card).toBeVisible()
  // 挂载即拉 + 5s 轮询：12s 覆盖一个轮询周期（写入可发生在开页前后）。
  // 行 testid 按项目锚定，但同项目多个 2s 窗批次各自成行（去抖设计，单测
  // 「超出时间窗开新批」同款）——test 1 写入的 api-contract.txt 批次仍在
  // 环内时同项目有两行，须按本用例写入的文件名过滤出目标批次行（与下方
  // 去抖/面板两用例的 hasText 过滤同纪律）
  const rowA = card.locator(`[data-testid="stream-row-${idA}"]`).filter({ hasText: 'card-alpha.txt' })
  await expect(rowA).toBeVisible({ timeout: 12_000 })
  await expect(card.locator(`[data-testid="stream-row-${idB}"]`).filter({ hasText: 'card-beta.txt' })).toBeVisible({ timeout: 12_000 })
  // 相对路径展示（服务端绝对路径剥项目根）与项目名徽标
  await expect(rowA.locator('.cs-file').first()).toHaveText('card-alpha.txt')
  await expect(rowA.locator('.cs-badge')).toHaveText(PROJ_A)
})

test('去抖聚合：2s 窗内同项目连写 8 文件合并为单批次行（预览 4 + 「等 4 个文件」）', async ({ page }) => {
  test.setTimeout(60000)
  await settle(1000)
  // 一次性连写 8 个文件：同毫秒级落盘 → 全部落入同一去抖窗（时间线新→旧，
  // 预览=后写的 4 个 burst-7..4，先写的 4 个进溢出计数）
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(path.join(DIR_A, `burst-${i}.txt`), `burst ${i}\n`)
  }

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  const card = page.locator('[data-testid="monitor-change-stream-card"]')
  await expect(card).toBeVisible()
  const row = card.locator(`[data-testid="stream-row-${idA}"]`).filter({ hasText: 'burst-7.txt' })
  await expect(row).toBeVisible({ timeout: 12_000 })
  // 单批次行：count=8 → 预览 4 条 + 溢出计数「等 4 个文件」（zh locale）
  await expect(row.locator('.cs-file')).toHaveCount(4)
  await expect(row.locator('.cs-more')).toHaveText('等 4 个文件')
})

test('独立面板入口：活动栏按钮开侧栏面板并呈现时间线；同项目条目点击直开文件', async ({ page }) => {
  test.setTimeout(60000)
  await settle(1000)
  fs.writeFileSync(path.join(DIR_B, 'panel-beta.txt'), 'panel entry change\n')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 进任一项目页（Layout 承载活动栏）——卡片名整词定位（helpers 纪律）
  await projectCardByName(page, PROJ_B).click()
  await page.waitForURL('**/project')
  // 活动栏按钮（面板注册表 rail-top id=stream，zh title=panelTitle）→ 侧栏面板
  const railBtn = page.locator('.rail-btn[title="跨项目变更流"]')
  await expect(railBtn).toBeVisible()
  await railBtn.click()
  const panel = page.locator('[data-testid="change-stream-panel"]')
  await expect(panel).toBeVisible()
  // 挂载即拉：B 项目条目呈现（徽标=项目名；条目可点——行本体即 button，P-52）
  const row = panel.locator(`[data-testid="stream-row-${idB}"]`).filter({ hasText: 'panel-beta.txt' })
  await expect(row).toBeVisible({ timeout: 12_000 })
  await expect(row.locator('.cs-badge')).toHaveText(PROJ_B)
  await expect(row).toHaveRole('button')
  // 同项目条目点击直开文件（深链消费链跳过切换）；MVP 单条目粒度：只开批内
  // 最新一个文件，不整批开（本批单文件，防误开 N tab 边界在单测/实现注记）
  await row.click()
  const tab = page.locator('.editor-tab', { hasText: 'panel-beta.txt' })
  await expect(tab).toBeVisible({ timeout: 30000 })
  await expect(tab).toHaveClass(/active/)
  // 消费后清 query（深链消费链既有语义）
  await expect(page).toHaveURL(/\/project$/)
  // 再点一次 = toggle 语义收面板；面板隐藏（v-show）后轮询停表（不可直接断言，
  // 此处只验开关行为本身）
  await page.locator('.rail-btn[title="跨项目变更流"]').click()
  await expect(panel).not.toBeVisible()
})

test('跨项目深链：值班卡点项目 B 条目 → 切至 B 且文件打开（两段式）', async ({ page }) => {
  test.setTimeout(90000)
  await settle(1000)
  fs.writeFileSync(path.join(DIR_B, 'link-beta.txt'), 'beta deep link change\n')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  const card = page.locator('[data-testid="monitor-change-stream-card"]')
  await expect(card).toBeVisible()
  // 值班卡内项目 B 条目（行 testid 按项目锚定 + 本用例文件名过滤，同上纪律）
  const rowB = card.locator(`[data-testid="stream-row-${idB}"]`).filter({ hasText: 'link-beta.txt' })
  await expect(rowB).toBeVisible({ timeout: 12_000 })
  // 点击 → /project?project=&file= 深链：consumeFileQuery 消费链守卫切项目 +
  // 开文件 + 清 query（行点击后的两段式全程断言）
  await rowB.click()
  await page.waitForURL('**/project')
  const tab = page.locator('.editor-tab', { hasText: 'link-beta.txt' })
  await expect(tab).toBeVisible({ timeout: 30000 })
  await expect(tab).toHaveClass(/active/)
  // 内容断言即证明读自项目 B；TopBar 项目选择器已切到 B
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('beta deep link change', { timeout: 10000 })
  await expect(page.locator('.header-project-select')).toContainText(PROJ_B)
  await expect(page).toHaveURL(/\/project$/)
})

test('降级只切项目：路径剥不出可靠相对路径（根不匹配）→ 切项目不开文件', async ({ page }) => {
  test.setTimeout(90000)
  // 拦截快照端点喂一条根不匹配事件（真实 watcher 只产项目内路径，「目录类/
  // 无可靠文件」降级分支经此注入验证）：展示层退 basename，点击只能切项目
  const ghostPath = '/elsewhere/sc-e2e-ghost/ghost.txt'
  await page.route('**/api/watch/activity*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          events: [{ ts: Date.now(), projectId: idB, path: ghostPath }],
          dropped: 0,
        },
      }),
    }))
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  const card = page.locator('[data-testid="monitor-change-stream-card"]')
  await expect(card).toBeVisible()
  const rowB = card.locator(`[data-testid="stream-row-${idB}"]`).filter({ hasText: 'ghost.txt' })
  await expect(rowB).toBeVisible({ timeout: 12_000 })
  await expect(rowB).toHaveRole('button')
  await rowB.click()
  await page.waitForURL('**/project')
  // 项目已切至 B；ghost 文件未被打开（无可靠相对路径不硬开——防同名异实）
  await expect(page.locator('.header-project-select')).toContainText(PROJ_B)
  await expect(page.locator('.editor-tab', { hasText: 'ghost.txt' })).toHaveCount(0)
})
