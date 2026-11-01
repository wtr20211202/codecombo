import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * push 被拒的下一步指引 E2E（P-20261005-194）：本地 bare 仓库作 origin（范式同
 * push-behind-guard，无网络依赖）。严格落后（ahead=0 behind>0）时快捷推送弹预检层，
 * 次操作「仍要推送」交 git 兜底 → 服务端 non-fast-forward 分类 hint 随错误响应返回
 * → 拦截器把裸 toast 升级为「原因一句话 + 先拉取按钮」→ 点击走既有拉取流（pull
 * 成功、behind 归零）——「点按钮直达」替代读 git 原文猜修法。
 * 自备临时仓库，afterAll 清理（含 uiState 归零）。
 */

const WORK = path.join(os.tmpdir(), 'sc-e2e-push-rejected-hint')
const BARE = path.join(os.tmpdir(), 'sc-e2e-push-rejected-hint-bare')
const SEED = `${BARE}-seed`
const PROJ = 'e2e-push-rejected-hint'

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

/** 队友推进一步 + 工作仓 fetch 回远端引用（behind 徽标数据源；origin 已改写为
 *  服务端形态，跨拓扑下按 origin 名 fetch 不可解析，P-20261005-187） */
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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: WORK })
  git(WORK, ['config', 'pull.rebase', 'false']) // 分叉拉取钉死 merge 策略（git ≥2.34 无配置时 diverged pull 直接 fatal）
  git(WORK, ['commit', '--allow-empty', '-m', 'root: push 被拒指引基线'])
  git(WORK, ['push', '-u', 'origin', 'main'])
  git(WORK, ['remote', 'set-url', 'origin', serverPath(BARE)])
  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(WORK).replace(/\\/g, '/') }),
  })
  expect(created.status).toBeLessThan(300)
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

/** 解锁后延迟弹出的「建议修改默认密码」遮罩会拦后续点击：有界等一次并收起 */
async function dismissPasswordHint(page: Page) {
  const laterBtn = page.getByRole('button', { name: '稍后提醒' })
  try { await laterBtn.click({ timeout: 4500 }) } catch { /* 未弹出（锁定关闭/已加载完），继续 */ }
}

/** 回首页 → 进项目页（projectCardByName 整词定位，CLAUDE.md e2e 纪律） */
async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await dismissPasswordHint(page)
  await projectCardByName(page, PROJ).first().click()
  await page.waitForURL('**/project')
  await dismissPasswordHint(page)
}

/** 打开项目页 git 分区（面板开合是 uiState 持久的 toggle 语义，先查可见再点） */
async function openGitPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.current-branch-card').isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.current-branch-card')).toBeVisible()
}

test('push 被拒：动作 toast 带「先拉取」→ 点击走既有拉取流（behind 归零）', async ({ page }) => {
  test.setTimeout(90000)
  // 队友先走一步（本地保持不动 = 严格落后 ahead=0：push 拒绝形态为 fetch first /
  // non-fast-forward；若本地也有提交则分叉 divergence，指引文案不同——各归各类）
  advanceRemote()
  await page.waitForTimeout(5500) // 服务端 ahead 缓存 TTL：过期后首页拉取才取到新 behind
  await enterProject(page)
  await openGitPanel(page)

  const behindN = git(WORK, ['rev-list', '--count', 'main..origin/main'])
  expect(Number(behindN)).toBeGreaterThanOrEqual(1)

  // 快捷推送 → 预检层拦截 → 次操作「仍要推送」交 git 兜底 → 必被拒
  await page.locator('.current-branch-card button[title="推送"]').click()
  const dlg = page.locator('.n-dialog').filter({ hasText: '远程领先' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('.n-dialog__action button').filter({ hasText: '仍要推送' }).click()

  // 失败 toast 已行动化：原因一句话 + 「先拉取」直达按钮（10s 点击窗）
  const hintToast = page.locator('.n-message').filter({ hasText: '推送被拒：远端分支已有你本地没有的新提交' })
  await expect(hintToast).toBeVisible({ timeout: 15000 })
  await hintToast.getByRole('button', { name: '先拉取' }).click()

  // 点击直达既有拉取流：Pull 成功 toast + behind 归零（CLI 口径为准）
  await expect(page.locator('.n-message').filter({ hasText: 'Pull 成功' })).toBeVisible({ timeout: 15000 })
  await expect.poll(() => git(WORK, ['rev-list', '--count', 'main..origin/main']), { timeout: 15000 }).toBe('0')
})
