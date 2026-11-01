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
 * push 首推「创建 PR」直达（P-20261005-215）E2E：本地 bare 仓库作 origin
 * （范式同 push-behind-guard，无 Gitea/网络依赖）。
 *   首推新分支：快捷推送成功 toast 附「创建 PR」外链按钮 → 点击走既有
 *               create-pr 链（服务端 PlatformAdapter 按远端 host 出 URL）→
 *               window.open 新窗（noopener）且 URL 呈 Gitea compare 形态；
 *   非首推再推：裸成功文案零按钮（PR 已建场景防重复打扰）。
 * URL 形态断言用 gitea.com 静态匹配 host（registry 静态优先，不走网络 Probe）；
 * window.open 页内 stub（md-preview-links 同款：真实 popup 会请求外网不可控）。
 */

const WORK = path.join(os.tmpdir(), 'sc-e2e-push-pr-work')
const BARE = path.join(os.tmpdir(), 'sc-e2e-push-pr-bare')
const PROJ = 'e2e-push-pr-link'
const BRANCH = 'feat-pr-link'

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

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [WORK, BARE]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  execFileSync('git', ['init', '--bare', '-b', 'main', BARE])
  execFileSync('git', ['clone', BARE, WORK], { stdio: 'ignore' })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: WORK })
  git(WORK, ['commit', '--allow-empty', '-m', 'root: pr link 基线'])
  git(WORK, ['push', '-u', 'origin', 'main'])
  // origin 改写为服务端形态（UI 推送由服务端 git 执行，P-20261005-187 同款）
  git(WORK, ['remote', 'set-url', 'origin', serverPath(BARE)])
  // 首推主角：无跟踪引用的新分支（判定事实源）
  git(WORK, ['checkout', '-b', BRANCH])
  git(WORK, ['commit', '--allow-empty', '-m', 'feat: pr link 主角提交'])
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
  for (const dir of [WORK, BARE]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

async function openGitPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.current-branch-card').isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.current-branch-card')).toBeVisible()
}

async function dismissPasswordHint(page: Page) {
  const laterBtn = page.getByRole('button', { name: '稍后提醒' })
  try { await laterBtn.click({ timeout: 4500 }) } catch { /* 未弹出（锁定关闭/已加载完），继续 */ }
}

async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await dismissPasswordHint(page)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
  await dismissPasswordHint(page)
  await openGitPanel(page)
}

/** 页内 window.open stub（md-preview-links 同款：真实 popup 会请求外网不可控） */
function lastOpen(page: Page): Promise<{ url: string; target: string; features: string } | undefined> {
  return page.evaluate(() => (window as unknown as { __lastOpen?: { url: string; target: string; features: string } }).__lastOpen)
}
async function stubWindowOpen(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __lastOpen?: { url: string; target: string; features: string } }
    w.__lastOpen = undefined
    window.open = ((url: string, target: string, features: string) => {
      w.__lastOpen = { url, target, features }
      return null
    }) as typeof window.open
  })
}

test('首推新分支：toast 附「创建 PR」→ 点击打开 Gitea compare 形态外链', async ({ page }) => {
  test.setTimeout(90000)
  await enterProject(page)
  await stubWindowOpen(page)

  // 快捷推送当前分支（feat-pr-link，无跟踪引用 → 服务端判首推）
  await page.locator('.current-branch-card button[title="推送"]').click()
  const toast = page.locator('.n-message').filter({ hasText: 'Push 成功' })
  await expect(toast).toBeVisible({ timeout: 15000 })

  // 首推专属按钮在 toast 上（行动化 10s 档，留足点击窗口）
  const prBtn = toast.locator('[data-testid="push-pr-link"]')
  await expect(prBtn).toBeVisible()

  // 按钮点击前把 origin 换成 gitea.com（registry 静态匹配 Gitea，不走网络 Probe）：
  // 断言既有 create-pr 链按远端 host 出 Gitea compare 形态 URL——纯本地事实可断言，
  // 与网络解耦；推送已完成，set-url 不影响判定（判定在 push 时已定）
  git(WORK, ['remote', 'set-url', 'origin', 'https://gitea.com/team/repo.git'])
  await prBtn.click()

  await expect.poll(() => lastOpen(page), { timeout: 10000 }).toEqual({
    url: 'https://gitea.com/team/repo/compare/main...feat-pr-link',
    target: '_blank',
    features: 'noopener',
  })
  // 打开后回执提示（与项目菜单 handleCreatePr 同语义）
  await expect(page.locator('.n-message').filter({ hasText: 'PR 链接已生成' })).toBeVisible({ timeout: 8000 })

  // 还原 origin 给下一用例（非首推再推仍走本地 bare）
  git(WORK, ['remote', 'set-url', 'origin', serverPath(BARE)])
})

test('非首推再推：裸成功文案，不展示「创建 PR」入口', async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page)

  // 上一用例已把 feat-pr-link 推上远端（post-push fetch 已建跟踪引用）→ 非首推
  await page.locator('.current-branch-card button[title="推送"]').click()
  const toast = page.locator('.n-message').filter({ hasText: 'Push 成功' })
  await expect(toast).toBeVisible({ timeout: 15000 })
  await expect(toast.locator('[data-testid="push-pr-link"]')).toHaveCount(0)
})
