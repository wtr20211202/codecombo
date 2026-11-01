import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 跨项目搜索流式上屏 E2E（P-20261003-94）：
 * 前端并发拆分调用单仓端点（并发钳 4 对齐服务端批量池），完成一个项目原位上屏一个——
 * 慢项目（经 page.route 人为延迟，时序确定性）不再拖住快项目的首字结果；
 * 进度行「已完成/总数」计数正确（失败组也算完成）。覆盖：
 * ① 快项目结果先现 + 慢项目组头占位转圈 + 进度行 1/2 → 完成后 2/2 收口；
 * ② 单项目失败隔离（404）：失败组标错误徽标，正常组照常上屏；
 * ③ 中途取消（P-20261005-182）：取消钮中止在途请求——已上屏结果保留、
 *    进度行换「已取消（N/M 项目完成）」标注、占位转圈停；新搜索旧轮不混屏。
 * 自备临时仓库，afterAll 清理（范式与 search-projects 对称）。
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-search-stream-a')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-search-stream-b')
const REPO_C = path.join(os.tmpdir(), 'sc-e2e-search-stream-c')
const PROJ_A = 'e2e-sst-a'
const PROJ_B = 'e2e-sst-b'
const PROJ_C = 'e2e-sst-c'
// 慢项目人为延迟：远大于快项目真实耗时，时序窗口内断言稳定
const SLOW_DELAY_MS = 2500

let projIdA = ''
let projIdB = ''
let projIdC = ''

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
  if (res.ok) {
    const body = (await res.json()) as { data?: { id?: string } }
    return body.data?.id || ''
  }
  // 清理竞态兜底（残留同名项目 409）：回退取既有 id，spec 不因前轮残留而崩
  const list = (await (await fetch(`${API_BASE}/api/projects`, { headers })).json()) as {
    data?: Array<{ id: string; name: string }>
  }
  return (list.data || []).find((p) => p.name === name)?.id || ''
}

function makeRepo(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir }) // 双路径：Windows 服务端 git 也不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: 流式上屏基线'])
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_A || p.name === PROJ_B || p.name === PROJ_C) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [REPO_A, REPO_B, REPO_C]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  // 两项目各 1 行命中：组头命中数徽标即完成信号（pending 占位是转圈，无徽标）
  makeRepo(REPO_A, { 'na.txt': 'needle alpha\n' })
  makeRepo(REPO_B, { 'nb.txt': 'needle beta\n' })
  makeRepo(REPO_C, { 'nc.txt': 'needle gamma\n' })
  projIdA = await registerProject(headers, PROJ_A, REPO_A)
  projIdB = await registerProject(headers, PROJ_B, REPO_B)
  projIdC = await registerProject(headers, PROJ_C, REPO_C)
  expect(projIdA).toBeTruthy()
  expect(projIdB).toBeTruthy()
  expect(projIdC).toBeTruthy()
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_A || p.name === PROJ_B || p.name === PROJ_C) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  for (const dir of [REPO_A, REPO_B, REPO_C]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
})

async function openProjectSearch(page: import('@playwright/test').Page, projectName: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: projectName }).first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  return card
}

// n-select 下拉打开（首点偶发被开合竞态吞掉：面板刚开/输入框焦点迁移时序，
// HEAD 基线同样可复现，与本提案改动无关）——点后短等未现则再点，最多三次
async function openScopeMenu(page: import('@playwright/test').Page, card: import('@playwright/test').Locator) {
  const menu = page.locator('.n-base-select-menu')
  for (let i = 0; i < 3; i++) {
    await card.locator('.ps-project-select').click()
    try {
      await expect(menu).toBeVisible({ timeout: 800 })
      return
    } catch { /* 未开则重试 */ }
  }
  await expect(menu).toBeVisible({ timeout: 2000 })
}

// 显式多选勾选给定项目（不用「全部项目」快捷项：实例还有种子项目，进度行总数须
// 确定；每用例独立 context 无范围记忆，显式勾选让各用例自包含）。范式同 scope-memory
// spec。names[0] 须为打开面板所用项目（n-select 默认预勾选当前项目）：先按实况
// 取消再重勾，保证终态与初始态无关（同时吃掉首点被开合竞态吞掉的情形）
async function selectScope(page: import('@playwright/test').Page, card: import('@playwright/test').Locator, names: string[]) {
  await openScopeMenu(page, card)
  const menu = page.locator('.n-base-select-menu')
  const opts = menu.locator('.n-base-select-option')
  for (const [i, name] of names.entries()) {
    const opt = opts.filter({ hasText: name })
    await expect(opt).toHaveCount(1, { timeout: 3000 })
    if (i === 0 && (await opt.getAttribute('class'))?.includes('--selected')) await opt.click()
    await opt.click()
  }
  // 点结果区空白（query 为空时的提示行）收起下拉
  await card.locator('.ps-hint').click()
  await expect(menu).toBeHidden()
}

test('流式上屏：快项目结果先现 + 慢项目占位转圈 + 进度行 1/2 → 完成后两组齐', async ({ page }) => {
  const card = await openProjectSearch(page, PROJ_A)
  // 慢项目 B 的搜索请求延迟（时序确定性来源；A 走真实服务端即刻返回）
  await page.route(`**/api/projects/${projIdB}/search*`, async (route) => {
    await new Promise((r) => { setTimeout(r, SLOW_DELAY_MS) })
    await route.continue()
  })
  await selectScope(page, card, [PROJ_A, PROJ_B])

  await card.locator('.ps-input-row input').first().fill('needle')
  const groupA = page.locator('.ps-project-group').filter({ hasText: PROJ_A })
  const groupB = page.locator('.ps-project-group').filter({ hasText: PROJ_B })

  // 快项目先现：A 命中数徽标已渲染（= A 已完成上屏）时 B 仍在途（占位转圈）
  await expect(groupA.locator('.ps-project-count')).toHaveText('1', { timeout: 8000 })
  await expect(groupA.locator('.ps-file-header', { hasText: 'na.txt' })).toBeVisible()
  await expect(groupB.locator('.ps-project-pending')).toBeVisible({ timeout: 2000 })
  // 进度行计数：已完成 1 / 共 2 项目
  await expect(card.locator('.ps-stat-loading')).toContainText('1/2')

  // 慢项目落地：原位换命中数徽标，占位与进度行收口
  await expect(groupB.locator('.ps-project-count')).toHaveText('1', { timeout: 8000 })
  await expect(groupB.locator('.ps-file-header', { hasText: 'nb.txt' })).toBeVisible()
  await expect(page.locator('.ps-project-pending')).toHaveCount(0)
  await expect(card.locator('.ps-stat-loading')).toHaveCount(0)
})

test('流式失败隔离：单项目 404 → 该组标失败徽标，正常组照常上屏', async ({ page }) => {
  const card = await openProjectSearch(page, PROJ_A)
  // B 的搜索请求直接 404（silent 链路：不弹 toast，只在该组标记）
  await page.route(`**/api/projects/${projIdB}/search*`, (route) =>
    route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'not found' }) }))
  await selectScope(page, card, [PROJ_A, PROJ_B])

  await card.locator('.ps-input-row input').first().fill('needle')
  const groupA = page.locator('.ps-project-group').filter({ hasText: PROJ_A })
  const groupB = page.locator('.ps-project-group').filter({ hasText: PROJ_B })

  await expect(groupA.locator('.ps-project-count')).toHaveText('1', { timeout: 8000 })
  await expect(groupA.locator('.ps-file-header', { hasText: 'na.txt' })).toBeVisible()
  await expect(groupB.locator('.ps-project-error')).toContainText('该项目搜索失败', { timeout: 8000 })
  // 全部项目到终态（失败也是完成）：无占位转圈、无进度行
  await expect(page.locator('.ps-project-pending')).toHaveCount(0)
  await expect(card.locator('.ps-stat-loading')).toHaveCount(0)
})

test('中途取消（P-20261005-182）：已到结果保留 + 进度行标注已取消 → 新搜索旧轮不混屏', async ({ page }) => {
  const card = await openProjectSearch(page, PROJ_A)
  // B 首轮请求挂起不回（handler 不 continue/fulfill 即永不完成）——本轮唯一出路
  // 是前端取消；后续轮放行（新搜索段用）。C 恒挂起：取消后未完成组定格不转圈
  let bFirstRound = true
  await page.route(`**/api/projects/${projIdB}/search*`, async (route) => {
    if (bFirstRound) { bFirstRound = false; return }
    await route.continue()
  })
  await page.route(`**/api/projects/${projIdC}/search*`, () => { /* 挂起不回 */ })
  await selectScope(page, card, [PROJ_A, PROJ_B, PROJ_C])

  await card.locator('.ps-input-row input').first().fill('needle')
  const groupA = page.locator('.ps-project-group').filter({ hasText: PROJ_A })
  const groupB = page.locator('.ps-project-group').filter({ hasText: PROJ_B })
  const groupC = page.locator('.ps-project-group').filter({ hasText: PROJ_C })

  // 快项目 A 先到（1/3），B/C 在途占位
  await expect(groupA.locator('.ps-project-count')).toHaveText('1', { timeout: 8000 })
  await expect(groupA.locator('.ps-file-header', { hasText: 'na.txt' })).toBeVisible()
  await expect(card.locator('.ps-stat-loading')).toContainText('1/3')

  // 取消：进行中态的取消钮随点击消失；已上屏的 A 结果保留不整体丢弃；
  // 进度行换「已取消（1/3 项目完成）」标注；B/C 占位转圈定格
  await card.locator('[data-testid="ps-cancel-search"]').click()
  await expect(card.locator('[data-testid="ps-cancel-search"]')).toHaveCount(0)
  await expect(card.locator('[data-testid="ps-cancelled-note"]')).toContainText('1/3')
  await expect(groupA.locator('.ps-file-header', { hasText: 'na.txt' })).toBeVisible()
  await expect(page.locator('.ps-project-pending')).toHaveCount(0)
  // 未完成组定格为 0 计数徽标（转圈停、非错误徽标）——取消不是失败
  await expect(groupC.locator('.ps-project-count')).toHaveText('0')
  await expect(groupC.locator('.ps-project-error')).toHaveCount(0)
  await expect(card.locator('.ps-stat-loading')).toHaveCount(0)

  // 新搜索：旧轮结果不混屏——A 的上一轮命中随新轮清理，B 放行后按新查询词落地
  await card.locator('.ps-input-row input').first().fill('beta')
  await expect(card.locator('[data-testid="ps-cancelled-note"]')).toHaveCount(0)
  await expect(groupA.locator('.ps-project-count')).toHaveText('0', { timeout: 8000 })
  await expect(groupA.locator('.ps-file-header')).toHaveCount(0)
  await expect(groupB.locator('.ps-project-count')).toHaveText('1', { timeout: 8000 })
  await expect(groupB.locator('.ps-file-header', { hasText: 'nb.txt' })).toBeVisible()
  // 取消标注不复现（新轮已复位）；C 恒挂起属本用例夹具形态，不作断言
  await expect(card.locator('[data-testid="ps-cancelled-note"]')).toHaveCount(0)
})
