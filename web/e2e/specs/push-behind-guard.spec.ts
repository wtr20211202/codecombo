import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 推送前落后预检（P-20261003-10）E2E：本地 bare 仓库作 origin（范式同
 * fetch-all，无 Gitea/网络依赖）。
 *   behind>0：「队友」先推进一步 + 工作仓 fetch 回远端引用 → 分支区快捷「推送」
 *             → 预检弹层「远程领先 N 个提交」→ 主操作「先去拉取」走拉取流
 *             （Pull 成功 toast）→ behind 归零后再次推送不再拦截
 *   behind=0：直推零感知（无弹层，Push 成功）。
 *   次操作「仍要推送」：交给 git 兜底——non-FF 被拒，本地 HEAD 不动。
 * 自备临时仓库，afterAll 清理（范式同 branch-merge-rebase，含 uiState 归零）。
 */

const WORK = path.join(os.tmpdir(), 'sc-e2e-push-behind')
const BARE = path.join(os.tmpdir(), 'sc-e2e-push-behind-bare')
const SEED = `${BARE}-seed`
const PROJ = 'e2e-push-behind'

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

/** teammatePush：从 bare clone 种子仓推进一步（模拟队友先提交） */
function teammatePush() {
  fs.rmSync(SEED, { recursive: true, force: true })
  execFileSync('git', ['clone', BARE, SEED], { stdio: 'ignore' })
  fs.writeFileSync(path.join(SEED, 'morning.txt'), `teammate ${Date.now()}\n`)
  git(SEED, ['add', '.'])
  git(SEED, ['commit', '-m', 'teammate: 先行提交'])
  git(SEED, ['push'])
}

/** advanceRemote：队友推进一步 + 工作仓 fetch。behind 数据源是本地
 *  remote-tracking 引用（rev-list main...origin/main），不 fetch 则恒为 0。
 *  fetch 走测试侧可解析的 BARE 原形态 + 显式 refspec 更新 origin/main——
 *  WORK.origin 已改写为服务端形态（UI 推送用），跨拓扑下 Windows git
 *  按 origin 名 fetch 不可解析（P-20261005-187） */
function advanceRemote() {
  teammatePush()
  git(WORK, ['fetch', BARE, 'main:refs/remotes/origin/main'])
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [WORK, BARE, SEED]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  execFileSync('git', ['init', '--bare', '-b', 'main', BARE])
  fs.mkdirSync(WORK, { recursive: true })
  execFileSync('git', ['clone', BARE, WORK], { stdio: 'ignore' })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: WORK }) // 双路径：Windows 服务端 git 也不 smudge
  git(WORK, ['config', 'pull.rebase', 'false']) // 分叉拉取钉死 merge 策略：git ≥2.34 无 reconcile 配置时 diverged pull 直接 fatal（P-20261005-187）
  git(WORK, ['commit', '--allow-empty', '-m', 'root: 推送预检基线'])
  git(WORK, ['push', '-u', 'origin', 'main'])
  // origin URL 改写为服务端形态（P-20261005-187）：UI 推送/拉取由服务端 git
  // 执行，Windows 形态路径跨拓扑不可解析；测试侧播种/断言用 BARE 原形态
  git(WORK, ['remote', 'set-url', 'origin', serverPath(BARE)])
  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(WORK).replace(/\\/g, '/') }),
  })
  expect(created.status).toBeLessThan(300)
  const body = (await created.json()) as { data?: { id?: string } }
  const projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
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
  for (const dir of [WORK, BARE, SEED]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 打开项目页 git 分区（面板开合是 uiState 持久的 toggle 语义，先查可见再点） */
async function openGitPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.current-branch-card').isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.current-branch-card')).toBeVisible()
}

/** 解锁后延迟弹出的「建议修改默认密码」遮罩会拦后续点击：有界等一次并收起 */
async function dismissPasswordHint(page: Page) {
  const laterBtn = page.getByRole('button', { name: '稍后提醒' })
  try { await laterBtn.click({ timeout: 4500 }) } catch { /* 未弹出（锁定关闭/已加载完），继续 */ }
}

/** 回首页 → 进项目 → 等 bootstrap aheadBehind 落定 → 打开 git 分区 */
async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await dismissPasswordHint(page)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await dismissPasswordHint(page)
  await openGitPanel(page)
}

function behindDialog(page: Page) {
  return page.locator('.n-dialog').filter({ hasText: '远程领先' })
}

function quickPushBtn(page: Page) {
  // 限定当前分支卡片：顶栏「推送」按钮同 title，会误中
  return page.locator('.current-branch-card button[title="推送"]')
}

test('behind>0：推送弹预检层 → 主操作先去拉取 → 拉取流跑通且不再拦', async ({ page }) => {
  test.setTimeout(90000)
  // 队友先走一步（重跑幂等：失败重试时工作仓可能已在上次拉取后的同步态）；
  // 等 5.5s 过服务端 ahead 缓存 TTL，首页首次拉取才取到新 behind
  advanceRemote()
  await page.waitForTimeout(5500)
  await enterProject(page)

  // behind 数以 CLI 现算为准（重跑会累积，不写死 1）；
  // 徽章可见 = 共享 aheadBehindMap 已含落后数据（预检同源）
  const behindN = git(WORK, ['rev-list', '--count', 'main..origin/main'])
  expect(Number(behindN)).toBeGreaterThanOrEqual(1)
  await expect(page.locator('.cbc-behind')).toHaveText(new RegExp(`\\b${behindN}\\b`), { timeout: 8000 })

  await quickPushBtn(page).click()
  const dlg = behindDialog(page)
  await expect(dlg).toBeVisible({ timeout: 3000 })
  await expect(dlg).toContainText(`远程领先 ${behindN} 个提交`)

  // 主操作：取消推送并走拉取流
  await dlg.locator('.n-dialog__action button').filter({ hasText: '先去拉取' }).click()
  await expect(page.locator('.n-message').filter({ hasText: 'Pull 成功' })).toBeVisible({ timeout: 15000 })
  await expect(dlg).toBeHidden({ timeout: 3000 })

  // 拉取后 behind 归零：徽章消失，紧接着的推送不再被预检拦截（次用例直推）
  await expect(page.locator('.cbc-behind')).toHaveCount(0, { timeout: 8000 })
})

test('behind=0：直推零感知（无预检弹层，Push 成功）', async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page)
  await expect(page.locator('.cbc-behind')).toHaveCount(0, { timeout: 8000 })

  await quickPushBtn(page).click()
  await expect(behindDialog(page)).toHaveCount(0, { timeout: 2500 })
  await expect(page.locator('.n-message').filter({ hasText: 'Push 成功' })).toBeVisible({ timeout: 15000 })
})

test('次操作「仍要推送」：交给 git 兜底（non-FF 被拒，HEAD 不动）', async ({ page }) => {
  test.setTimeout(90000)
  // 造分叉：本地先行提交 + 队友再走一步（ahead≥1 behind≥1，直推必被
  // non-FF 拒绝——严格落后而无本地提交时 push 只是 up-to-date 成功，验证不了兜底）
  fs.writeFileSync(path.join(WORK, 'local.txt'), `local work ${Date.now()}\n`)
  git(WORK, ['add', '.'])
  git(WORK, ['commit', '-m', 'local: 分叉提交'])
  advanceRemote()
  await page.waitForTimeout(5500) // 服务端 ahead 缓存 TTL 5s：过期后首页拉取才取到新 behind
  await enterProject(page)
  const behindN = git(WORK, ['rev-list', '--count', 'main..origin/main'])
  expect(Number(behindN)).toBeGreaterThanOrEqual(1)
  await expect(page.locator('.cbc-behind')).toHaveText(new RegExp(`\\b${behindN}\\b`), { timeout: 8000 })

  // 基线在造分叉之后取：远端此刻停在队友提交（≠本地 HEAD），断言的是
  // 「推送动作不改变两端」而非「远端等于本地」
  const headBefore = git(WORK, ['rev-parse', 'HEAD'])
  const bareBefore = git(BARE, ['rev-parse', 'main'])
  await quickPushBtn(page).click()
  const dlg = behindDialog(page)
  await expect(dlg).toBeVisible({ timeout: 3000 })

  // 次操作：仍要推送 → git 拒绝 non-FF（错误提示进通知中心，此处以
  // 本地 HEAD 与远端 main 均不动作 CLI 侧断言，证明确实没有静默强推）
  await dlg.locator('.n-dialog__action button').filter({ hasText: '仍要推送' }).click()
  await expect(dlg).toBeHidden({ timeout: 3000 })
  await page.waitForTimeout(3000) // 给直推请求足够时间落定
  expect(git(WORK, ['rev-parse', 'HEAD'])).toBe(headBefore)
  expect(git(BARE, ['rev-parse', 'main'])).toBe(bareBefore)
})
