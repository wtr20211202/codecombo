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
 * pull 冲突的下一步指引直达 E2E（P-20261005-194）：本地 bare 仓库作 origin（范式同
 * conflict-pull-toast，构造真实同文件分叉冲突）。与 P-44 的差异：冲突经顶栏「拉取」
 * 触发（useProjectActions 共享拉取流，catch 不弹专属 toast）——失败反馈只剩拦截器
 * 一条，本例守的正是这条通道的行动化：
 *   服务端 PullRemote 冲突态兜底分类（CONFLICT 行写 stdout、exec 层失败即弃）→
 *   hint kind=conflict 随 409 返回 → 拦截器 toast「原因一句话 + 解决冲突按钮」→
 *   点击带起 git 底部 tab（初始关闭态）→ GitPanel 挂载消费 store 请求 → 就地展开
 *   冲突视图（P-44 openConflictFromToast 同语义收口）。
 * 自备临时仓库，afterAll 清理（含 uiState 归零）。
 */

const WORK = path.join(os.tmpdir(), 'sc-e2e-pull-conflict-hint')
const BARE = path.join(os.tmpdir(), 'sc-e2e-pull-conflict-hint-bare')
const SEED = `${BARE}-seed`
const PROJ = 'e2e-pull-conflict-hint'
const FILE = 'pull-hint-conflict.txt'

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
  // 分叉拉取钉死 merge 策略：git ≥2.34 无 reconcile 配置时 diverged pull 直接
  // fatal（到不了冲突态，服务端冲突兜底分类与横幅都无从谈起）
  git(WORK, ['config', 'pull.rebase', 'false'])
  git(WORK, ['config', 'user.name', 'e2e'])
  git(WORK, ['config', 'user.email', 'e2e@test.local'])
  writeBase(WORK, 'base')
  git(WORK, ['add', '.'])
  git(WORK, ['commit', '-m', 'root: 冲突 hint 基线'])
  git(WORK, ['push', '-u', 'origin', 'main'])
  git(WORK, ['remote', 'set-url', 'origin', serverPath(BARE)])
  teammateConflictPush()
  writeBase(WORK, 'local')
  git(WORK, ['commit', '-am', 'local: rewrite same line'])
  const status = git(WORK, ['status', '--porcelain', '-b'])
  if (!status.includes('ahead')) throw new Error('expected local diverged (ahead), got: ' + status)
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

test('pull 冲突：动作 toast 带「解决冲突」→ 点击带起 git tab 直达冲突视图', async ({ page }) => {
  test.setTimeout(90000)
  await enterProject(page)

  // 底部面板先收起（uiState 持久可能带着上次会话的开态）：本例要验证「点击按钮
  // 带起 git tab」的完整链路，起点必须关态（面板容器 v-show 常驻，断言可见性）
  const bottomPanel = page.locator('[data-testid="bottom-panel"]')
  if (await bottomPanel.isVisible().catch(() => false)) {
    await bottomPanel.locator('button[title="关闭"]').click()
  }
  await expect(bottomPanel).not.toBeVisible()

  // 顶栏「拉取」（title=toolbar.pull，全页唯一；此刻 pull 必停冲突走 409）
  await page.locator('button[title="拉取"]').click()

  // 失败 toast 已行动化：原因一句话 + 「解决冲突」直达按钮（文案复用 P-44 的
  // git.conflictOpen；共享拉取流无专属 toast，此条是唯一失败反馈）
  const hintToast = page.locator('.n-message').filter({ hasText: '操作产生了合并冲突' })
  await expect(hintToast).toBeVisible({ timeout: 15000 })
  await hintToast.getByRole('button', { name: '解决冲突' }).click()

  // 点击带起 git 底部 tab → GitPanel 挂载消费 store 请求 → 冲突视图就地展开
  await expect(bottomPanel).toBeVisible({ timeout: 10000 })
  await expect(page.getByText('冲突文件', { exact: true })).toBeVisible({ timeout: 10000 })
  await expect(page.locator(`[title="${FILE}"]`)).toBeVisible({ timeout: 10000 })
})
