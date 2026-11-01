import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 冲突全解后的「继续变基」操作条 E2E（P-20261002-46）：
 * rebase 冲突解决链的最后一米——此前 ConflictView 全解后用户只能去终端手打
 * git rebase --continue。自备临时仓库构造真实变基冲突
 * （base → feature 双提交，main 改同一行 → feature 上 rebase main 停在首个提交），
 * 注册为项目后走 UI 全流程：
 *   1. 冲突横幅 → 冲突面板 →「采用他方」全解（暂存态，含变基语义的他方=被重放提交）
 *   2. 冲突清零后操作条出现（inProgress=rebase）：继续变基 / 中止变基
 *   3. 继续变基 → 剩余提交重放完成 → 操作条/横幅消失，分支包含 main 提交
 *   4. 重建冲突态后走中止：确认弹窗 → 变基丢弃，分支回到变基前
 * 环境敏感点：仓库必须放系统临时目录且以服务端形态路径注册（serverPath，
 * 与 conflict-view 的 REPO_DIR 同理）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const REPO_DIR = path.join(process.env.TEMP || osTmp(), 'sc-e2e-rebase-continue')
const PROJ_NAME = 'rebase-continue-demo'
const FILE = 'f.txt'

function osTmp(): string {
  return process.env.TEMP || '/tmp'
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], {
    cwd, encoding: 'utf8',
  })
}

async function unlockHeaders(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''
// 变基前 feature 指针（中止用例断言「回到变基前」的基准）
let preRebaseHead = ''

// 构造 rebase 冲突：feature 两个提交，featA 改 f.txt 的 line2（与 main 冲突）、
// featB 新增 g.txt（干净重放）——继续变基须重放完 featA' 与 featB' 才算收尾
function createRebaseConflict() {
  try { git(REPO_DIR, ['rebase', '--abort']) } catch { /* 非变基中忽略 */ }
  git(REPO_DIR, ['checkout', 'feature'])
  git(REPO_DIR, ['reset', '--hard', preRebaseHead])
  let conflicted = false
  try {
    git(REPO_DIR, ['rebase', 'main'])
    conflicted = true
  } catch { /* 冲突即预期：非零退出 */ }
  if (conflicted) throw new Error('expected rebase conflict did not happen')
  const status = git(REPO_DIR, ['status', '--porcelain'])
  if (!status.includes('UU')) throw new Error('expected UU conflict entry, got: ' + status)
  if (!fs.existsSync(path.join(REPO_DIR, '.git', 'rebase-merge'))) {
    throw new Error('expected rebase-merge directory after conflicted rebase')
  }
}

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  // 清理同名旧项目与残留目录
  const list = await (await request.get(`${BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_NAME) await request.delete(`${BASE}/api/projects/${p.id}`, { headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  // 提交身份写入仓库级配置：服务端执行的 git rebase --continue 会落一个提交，
  // 走的是仓库配置（测试侧逐命令 -c 传不到服务端）
  git(REPO_DIR, ['config', 'user.name', 'e2e'])
  git(REPO_DIR, ['config', 'user.email', 'e2e@test.local'])
  // base：两分支共同祖先
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'line1\nline2\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'base'])
  // feature：featA 改 line2 并追加 line3（他方解决后有非空暂存差，可被继续变基提交）
  git(REPO_DIR, ['checkout', '-b', 'feature'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'line1\nline2-featA\nline3-featA\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'featA'])
  // featB：新增文件（干净重放）
  fs.writeFileSync(path.join(REPO_DIR, 'g.txt'), 'g1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'featB'])
  preRebaseHead = git(REPO_DIR, ['rev-parse', 'HEAD']).trim()
  // main：改同一行 line2 → rebase 必冲突
  git(REPO_DIR, ['checkout', 'main'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'line1\nline2-main\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'mainEdit'])

  createRebaseConflict()

  const created = await request.post(`${BASE}/api/projects`, {
    headers,
    // 注册路径按服务端形态交接（linux 实例经 /mnt/c 同见 %TEMP% 夹具）
    data: { name: PROJ_NAME, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  if (!projectId) throw new Error('project registration failed')
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await request.delete(`${BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

// 幂等打开 Git 面板并展开冲突面板（与 conflict-view 同款 rail toggle 收敛循环：
// rail 是 toggle——读 aria-expanded 只在收起时点击，展开态盲点会误关）
async function openConflictPanel(page: Parameters<typeof gotoAndUnlock>[0]) {
  test.setTimeout(60000) // 收敛循环 + 收尾断言需要超出默认 30s 的预算
  const banner = page.locator('.conflict-banner')
  const panelTitle = page.getByText('冲突文件', { exact: true })
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await panelTitle.isVisible().catch(() => false)) return
    if (await banner.isVisible().catch(() => false)) {
      await banner.click() // 横幅展开冲突面板
      await expect(panelTitle).toBeVisible({ timeout: 3000 })
      return
    }
    const rail = page.locator('.rail-btn[title="Git 管理"]')
    if ((await rail.getAttribute('aria-expanded').catch(() => null)) !== 'true') {
      await rail.click()
    }
    await page.waitForTimeout(1500)
  }
  await expect(banner).toBeVisible({ timeout: 10000 })
}

test('冲突全解后操作条出现：继续变基完成，分支状态刷新无冲突横幅', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await openConflictPanel(page)

  // 「采用他方」：变基语义下他方 = 被重放的 featA，解决后暂存差非空可继续。
  // 冲突清零（横幅卸载）但 rebase-merge 仍在 → 收尾操作条出现
  await page.getByRole('button', { name: '采用他方' }).first().click()
  await expect(page.locator('.conflict-banner')).toBeHidden({ timeout: 10000 })
  const opBar = page.locator('.git-op-bar')
  await expect(opBar).toBeVisible({ timeout: 10000 })
  await expect(opBar.getByRole('button', { name: '继续变基' })).toBeVisible()
  await expect(opBar.getByRole('button', { name: '中止变基' })).toBeVisible()

  // 继续变基：featA' 提交 + featB' 干净重放 → 变基完成 → 操作条消失且横幅不再出现
  await opBar.getByRole('button', { name: '继续变基' }).click()
  await expect(opBar).toBeHidden({ timeout: 15000 })
  await expect(page.locator('.conflict-banner')).toBeHidden({ timeout: 10000 })

  // 仓库态断言：变基收尾完成——rebase-merge 移除、featB 重放、f.txt 为解决内容、
  // 分支包含 main 的提交（变基语义达成）
  expect(fs.existsSync(path.join(REPO_DIR, '.git', 'rebase-merge'))).toBe(false)
  const log = git(REPO_DIR, ['log', '--format=%s', 'feature'])
  for (const subject of ['featA', 'featB', 'mainEdit']) {
    if (!log.includes(subject)) throw new Error(`feature log missing ${subject}: ${log}`)
  }
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).toContain('line2-featA')
  expect(fs.existsSync(path.join(REPO_DIR, 'g.txt'))).toBe(true)
})

test('操作条中止变基：确认弹窗后丢弃进度，分支回到变基前', async ({ page }) => {
  // 上一用例已完成变基——重建冲突态（回退 feature 指针并重新 rebase）
  createRebaseConflict()

  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await openConflictPanel(page)
  await page.getByRole('button', { name: '采用他方' }).first().click()
  const opBar = page.locator('.git-op-bar')
  await expect(opBar).toBeVisible({ timeout: 10000 })

  // 中止变基（破坏性，确认弹窗）→ 确认后执行
  await opBar.getByRole('button', { name: '中止变基' }).click()
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await dialog.getByRole('button', { name: '中止变基' }).click()

  // 操作条消失（rebase-merge 移除 → inProgress 清空）
  await expect(opBar).toBeHidden({ timeout: 15000 })
  await expect(page.locator('.conflict-banner')).toBeHidden({ timeout: 10000 })

  // 仓库态断言：分支指针回到变基前，工作区恢复 featA 原内容
  expect(fs.existsSync(path.join(REPO_DIR, '.git', 'rebase-merge'))).toBe(false)
  expect(git(REPO_DIR, ['rev-parse', 'feature']).trim()).toBe(preRebaseHead)
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).toContain('line3-featA')
})
