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
 * pull 后冲突状态即时收账 E2E（P-20261004-44）：本地 bare 仓库作 origin（范式同
 * pull-summary-notify / conflict-view，无网络依赖），构造真实同文件分叉冲突 pull：
 *   1. 冲突 pull 恰走 handleQuickPull catch（git 退出非零 → 服务端 409）——
 *      失败路 fetchConflictCount 收账 → 冲突横幅即时亮起（此前滞藏到聚焦/重进）
 *   2. 冲突形态错误（rawMessage 含 CONFLICT）→ 带「解决冲突」动作的错误 toast，
 *      点击直达 ConflictView（就地面板展开，无需自己发现入口）
 * 自备临时仓库，afterAll 清理（含 uiState 归零）。
 */

const WORK = path.join(os.tmpdir(), 'sc-e2e-pull-conflict')
const BARE = path.join(os.tmpdir(), 'sc-e2e-pull-conflict-bare')
const SEED = `${BARE}-seed`
const PROJ = 'e2e-pull-conflict'
const FILE = 'pull-conflict.txt'

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

function writeBase(cwd: string, line: string) {
  fs.writeFileSync(path.join(cwd, FILE), `line: ${line}\n`)
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

/** teammateConflictPush：从 bare clone 种子仓改同一行并推送（模拟队友抢先） */
function teammateConflictPush() {
  fs.rmSync(SEED, { recursive: true, force: true })
  execFileSync('git', ['clone', BARE, SEED], { stdio: 'ignore' })
  writeBase(SEED, 'teammate')
  git(SEED, ['commit', '-am', `teammate: rewrite ${FILE}`])
  git(SEED, ['push'])
}

async function clearNotifications(headers: Record<string, string>) {
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
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
  // 仓库本地身份（助手 -c 只覆盖测试侧提交）：pull 的非 FF 合并在开合并前就校验
  // committer 身份，服务端 git 无全局身份时直接 fatal（repo 不进冲突态），
  // 永远到不了 CONFLICT——server git 以 WORK 为 cwd，读得到 .git/config
  git(WORK, ['config', 'user.name', 'e2e'])
  git(WORK, ['config', 'user.email', 'e2e@test.local'])
  writeBase(WORK, 'base')
  git(WORK, ['add', '.'])
  git(WORK, ['commit', '-m', 'root: 冲突 pull 基线'])
  git(WORK, ['push', '-u', 'origin', 'main'])
  // origin URL 改写为服务端形态（P-20261005-187）：UI 拉取由服务端 git 执行
  git(WORK, ['remote', 'set-url', 'origin', serverPath(BARE)])
  // 队友改同一行并推送；本地也改同一行并落本地提交 → 双向分叉，pull 必冲突
  teammateConflictPush()
  writeBase(WORK, 'local')
  git(WORK, ['commit', '-am', 'local: rewrite same line'])
  const status = git(WORK, ['status', '--porcelain', '-b'])
  if (!status.includes('ahead')) throw new Error('expected local diverged (ahead), got: ' + status)
  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(WORK).replace(/\\/g, '/') }),
  })
  expect(created.status).toBeLessThan(300)
  await clearNotifications(headers)
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
  await clearNotifications(headers)
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

test('冲突 pull：横幅即时亮起 + toast 带「解决冲突」动作直达 ConflictView', async ({ page }) => {
  test.setTimeout(90000)
  await enterProject(page)
  await openGitPanel(page)

  // GitPanel 当前分支卡片快捷拉取（handleQuickPull；title=layout.pull「更新」，
  // 限定分支卡片防误中 TopBar 的「拉取」）——此刻 pull 必停冲突，走 catch 路
  await page.locator('.current-branch-card button[title="更新"]').click()

  // ① 失败路即时收账：冲突横幅亮起（无本修复时 headless 无 focus，横幅滞藏）
  await expect(page.locator('.conflict-banner')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.conflict-banner')).toContainText('存在合并冲突')

  // ② 冲突形态失败 → 动作 toast（拦截器通用「拉取失败」toast 之外的专属一条）
  const conflictToast = page.locator('.n-message').filter({ hasText: '拉取产生合并冲突' })
  await expect(conflictToast).toBeVisible({ timeout: 15000 })

  // 点击「解决冲突 →」→ 就地展开 ConflictView（面板标题「冲突文件」挂载）
  await conflictToast.getByRole('button', { name: '解决冲突' }).click()
  await expect(page.getByText('冲突文件', { exact: true })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('[title="pull-conflict.txt"]')).toBeVisible({ timeout: 10000 })
})
