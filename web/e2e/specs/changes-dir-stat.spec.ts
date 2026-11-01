import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更树「组头统计」E2E（P-20261003-280）：目录分组行右缘组级计数「N 文件 +x -y」
 * （组内 diffstat 聚合，P-239 numstat 数据面同源——组级改动量一眼）。核心守护：
 *   1. 数值正确：组头 N=组内 status 文件数（二进制也计为文件），+x/-y=组内增删行数
 *      合计（二进制不计行——「宁缺毋谎」P-219 同口径）；
 *   2. 文件行不出组头统计（组级能力只挂目录行）；仓库根的裸文件行同样不受影响；
 *   3. 与状态过滤正交：过滤收窄视图后组头统计跟随可见集（所见即所报，树按可见集
 *      构建、聚合随树走）。
 * 夹具三组目录：alpha 两文件（+11 -2 含删除行）、zoo 一文本一二进制（N 只计文本行）、
 * mid 一已暂存文件；另加根级裸文件。自备临时仓库，afterAll 清理
 *（与 changes-size-sort-heat 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-dir-stat')
const PROJ = 'e2e-dir-stat'
const BRANCH = 'e2e-ds-main'
const F_A = 'alpha/a.txt' // +10（未暂存）
const F_B = 'alpha/b.txt' // +1 -2（未暂存，含删除行）→ alpha 组 2 文件 +11 -2
const F_BIG = 'zoo/big.txt' // +200（未暂存）
const F_BIN = 'zoo/blk.bin' // 二进制改动：计入文件数不计行 → zoo 组 2 文件 +200 -0
const F_MID = 'mid/mid.txt' // +80（已暂存）→ mid 组 1 文件 +80 -0
const F_TOP = 'top.txt' // 根级裸文件（不落任何目录组，守卫文件行无组头统计）

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

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init', '-b', BRANCH], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，行数三平台一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  const write = (rel: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(REPO_DIR, rel)), { recursive: true })
    fs.writeFileSync(path.join(REPO_DIR, rel), content)
  }
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`).join('\n') + '\n'
  write(F_A, 'a v1\n')
  write(F_B, 'b1\nb2\nb3\n')
  write(F_BIG, 'big v1\n')
  write(F_BIN, Buffer.from([0x00, 0x01, 0x02, 0x03])) // 含 NUL：git 判二进制
  write(F_MID, 'mid v1\n')
  write(F_TOP, 'top v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 组头统计基线'])
  // 三组改动量（注册项目前造好：注册使 status 缓存失效，首拉即含全量）；
  // mid 暂存——numstat HEAD 口径下已暂存文件同样计入组级行数
  write(F_A, 'a v1\n' + lines(10, 'a')) // +10 -0（保留首行）
  write(F_B, 'b1\nb9\n') // +1 -2
  write(F_BIG, 'big v1\n' + lines(200, 'big')) // +200 -0
  write(F_BIN, Buffer.from([0x00, 0x09, 0x08, 0x07])) // 二进制：numstat 出 `- -`
  write(F_MID, 'mid v1\n' + lines(80, 'mid')) // +80 -0
  write(F_TOP, 'top v2\n') // +1 -1（根级，无组可挂）
  git(REPO_DIR, ['add', F_MID])
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(6)

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // uiState 归零收尾（防布局恢复污染后续 spec）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: 'big.txt' })).toBeVisible({ timeout: 10000 })
}

/** 指定目录行的组头统计（numstat 去抖取数到位前元素不存在） */
function dirStatOf(page: import('@playwright/test').Page, dirName: string) {
  return page.locator('.cp-node').filter({ hasText: dirName }).locator('[data-testid="cp-dir-stat"]')
}

test('组头统计数值正确：N 含二进制文件、行数只计文本（+增 -删分色），文件行不挂统计', async ({ page }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')

  // 行数面为去抖按需取数（≤1s 去抖 + RTT），等任一组头统计就位再逐组断言
  await expect(dirStatOf(page, 'alpha')).toBeVisible({ timeout: 10000 })
  // alpha：2 文件，+11 -2（删除行如实计入）
  await expect(dirStatOf(page, 'alpha')).toHaveText('2 文件+11-2')
  // zoo：二进制改动计入文件数（2 文件）但不计行（+200 -0，「宁缺毋谎」）
  await expect(dirStatOf(page, 'zoo')).toHaveText('2 文件+200-0')
  // mid：已暂存文件同样进组级聚合
  await expect(dirStatOf(page, 'mid')).toHaveText('1 文件+80-0')
  // 增删分色（绿增红删 = GitHub 提交列表同视觉语）
  await expect(dirStatOf(page, 'alpha').locator('.cp-dir-stat-add')).toHaveText('+11')
  await expect(dirStatOf(page, 'alpha').locator('.cp-dir-stat-del')).toHaveText('-2')

  // 文件行不挂组头统计（组级能力只属目录行；根级裸文件行同样不挂）
  expect(await panel.locator('.cp-node').filter({ hasText: 'top.txt' }).locator('[data-testid="cp-dir-stat"]').count()).toBe(0)
})

test('与状态过滤正交：已暂存 chip 收窄后组头统计跟随可见集（所见即所报）', async ({ page }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')

  await expect(dirStatOf(page, 'mid')).toBeVisible({ timeout: 10000 })
  // 已暂存 chip：只剩 mid 组（mid.txt 已暂存），组头统计按可见集聚合
  await page.locator('[data-testid="cp-status-filter-staged"]').click()
  await expect(panel.locator('.cp-node').filter({ hasText: 'big.txt' })).toHaveCount(0)
  await expect(panel.locator('.cp-node').filter({ hasText: 'a.txt' })).toHaveCount(0)
  await expect(panel.locator('.cp-node').filter({ hasText: 'mid.txt' })).toBeVisible()
  await expect(panel.locator('.cp-filter-count')).toHaveText('1/6')
  await expect(dirStatOf(page, 'mid')).toHaveText('1 文件+80-0')
})
