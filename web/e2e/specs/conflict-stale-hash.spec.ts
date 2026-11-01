import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 冲突解决写回 BaseHash 乐观锁 E2E（P-20261004-27）：解析载入到写回之间文件被
 * 外部（agent/他会话）改动的分钟级窗口收口——
 *   1. 打开冲突 → 逐块应用（携带载入基线 hash）→ 外部改盘使基线失配 →
 *      409 本地化提示 + 引导横幅；写回被拒：磁盘外部改动原样保留、冲突未标记解决
 *   2. 「重新解析」重走快照（新基线含外部改动）→ 二次应用成功且外部改动可见
 * 环境敏感点同 conflict-hunks.spec.ts：仓库放系统临时目录、服务端形态路径注册。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const REPO_DIR = path.join(process.env.TEMP || osTmp(), 'sc-e2e-conflict-stale')
const PROJ_NAME = 'conflict-stale-demo'
const FILE = 'single.txt'

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

// 重建单块合并冲突（abort → 回 main edit → 再 merge）
function seedConflict() {
  try { git(REPO_DIR, ['merge', '--abort']) } catch { /* 非合并中忽略 */ }
  git(REPO_DIR, ['reset', '--hard', mainEditHash])
  let merged = false
  try {
    git(REPO_DIR, ['merge', 'feature'])
    merged = true
  } catch { /* 冲突即预期：非零退出 */ }
  if (merged) throw new Error('expected merge conflict did not happen')
  const status = git(REPO_DIR, ['status', '--porcelain'])
  if (!status.includes('UU')) throw new Error('expected UU conflict entry, got: ' + status)
}

let projectId = ''
let mainEditHash = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const list = await (await request.get(`${BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_NAME) await request.delete(`${BASE}/api/projects/${p.id}`, { headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'value = base\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'base'])
  git(REPO_DIR, ['checkout', '-b', 'feature'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'value = feature\n')
  git(REPO_DIR, ['commit', '-qam', 'feature edit'])
  git(REPO_DIR, ['checkout', 'main'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'value = main\n')
  git(REPO_DIR, ['commit', '-qam', 'main edit'])
  mainEditHash = git(REPO_DIR, ['rev-parse', 'HEAD']).trim()
  seedConflict()

  const created = await request.post(`${BASE}/api/projects`, {
    headers,
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

// 幂等打开 Git 面板并展开冲突面板（同 conflict-hunks.spec.ts：rail 是 toggle，
// 以冲突面板标题可见为收敛目标循环重试）
async function openConflictPanel(page: Parameters<typeof gotoAndUnlock>[0]) {
  test.setTimeout(90000)
  const banner = page.locator('.conflict-banner')
  const panelTitle = page.getByText('冲突文件', { exact: true })
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await panelTitle.isVisible().catch(() => false)) return
    if (await banner.isVisible().catch(() => false)) {
      await banner.click()
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

test('解析窗口期外部改盘：应用被 409 拒绝且外部改动保留 → 重新解析后二次成功', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await openConflictPanel(page)

  // 逐块模式：单块冲突（载入即记录磁盘基线 hash）
  await page.locator('[data-test="conflict-mode-hunks"]').click()
  const blocks = page.locator('[data-test="conflict-hunk-block"]')
  await expect(blocks).toHaveCount(1, { timeout: 10000 })

  // 用户逐块斟酌窗口期：agent 外部改盘（冲突内容尾追加干扰行，块行区间不变）
  const filePath = path.join(REPO_DIR, FILE)
  fs.writeFileSync(filePath, '<<<<<<< HEAD\nvalue = main\n=======\nvalue = feature\n>>>>>>> feature\nagent appended\n')

  // 块取我方 → 应用：携带陈旧基线 → 服务端 409 拒绝
  await blocks.nth(0).getByRole('button', { name: '取我方' }).click()
  const applyBtn = page.getByRole('button', { name: '应用解决' })
  await expect(applyBtn).toBeEnabled()
  await applyBtn.click()

  // 409 本地化提示 + 引导横幅（写回被拒）
  await expect(page.locator('.n-message').filter({ hasText: '冲突文件在解决期间被修改' })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('[data-test="conflict-stale-hint"]')).toBeVisible()

  // 写回未发生：磁盘 = 外部改动 + 冲突标记原样；resolve 标记未触达（仍 UU）
  const rejected = fs.readFileSync(filePath, 'utf8')
  expect(rejected).toBe('<<<<<<< HEAD\nvalue = main\n=======\nvalue = feature\n>>>>>>> feature\nagent appended\n')
  expect(git(REPO_DIR, ['status', '--porcelain'])).toContain('UU')
  await expect(page.locator('.conflict-banner')).toBeVisible()

  // 「重新解析」重走快照：横幅退场、新基线（含外部改动）就位
  await page.locator('[data-test="conflict-stale-reload"]').click()
  await expect(page.locator('[data-test="conflict-stale-hint"]')).toBeHidden({ timeout: 10000 })
  await expect(blocks).toHaveCount(1, { timeout: 10000 })

  // 二次应用：新基线一致 → 写回成功，磁盘同时含解决结果与外部改动
  await blocks.nth(0).getByRole('button', { name: '取我方' }).click()
  await expect(applyBtn).toBeEnabled()
  await applyBtn.click()
  await expect(page.locator('.conflict-banner')).toBeHidden({ timeout: 10000 })
  const content = fs.readFileSync(filePath, 'utf8')
  expect(content).toBe('value = main\nagent appended\n')
  expect(content).not.toContain('<<<<<<<')
})
