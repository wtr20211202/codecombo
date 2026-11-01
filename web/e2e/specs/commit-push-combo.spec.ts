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
 * 「提交并推送」连招（P-20261003-84）E2E：本地 bare 仓库作 origin（范式同
 * push-behind-guard，无 Gitea/网络依赖）。
 *   behind=0：提交按钮旁下拉副选项「提交并推送」→ 提交落库 + 自动直推成功
 *            （远端 main 跟进到本地 HEAD）。
 *   behind>0：连招衔接 P-10 落后预检三态弹层——
 *     次操作「仍要推送」→ non-FF 被拒 → 部分成功提示「已提交，推送失败：…」
 *     且提交不回滚（本地 HEAD 保留，远端不动）；失败事实同刻入通知中心
 *     （P-20261004-142），点击条目直达 git 面板；
 *     主操作「先去拉取」→ 走共享拉取流（Pull 成功），连招提交保留在本地历史。
 * 自备临时仓库，afterAll 清理（范式同 push-behind-guard，含 uiState 归零）。
 */

const WORK = path.join(os.tmpdir(), 'sc-e2e-commit-push-combo')
const BARE = path.join(os.tmpdir(), 'sc-e2e-commit-push-combo-bare')
const SEED = `${BARE}-seed`
const PROJ = 'e2e-commit-push-combo'
const FILE = '.e2e-combo.tmp'

let projectId = ''

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

/** advanceRemote：队友推进一步 + 工作仓 fetch。预检 behind 数据源是本地
 *  remote-tracking 引用（rev-list main...origin/main），不 fetch 则恒为 0。
 *  fetch 走测试侧可解析的 BARE 原形态 + 显式 refspec 更新 origin/main——
 *  WORK.origin 已改写为服务端形态（UI 连招推送用），跨拓扑下 Windows git
 *  按 origin 名 fetch 不可解析（P-20261005-187） */
function advanceRemote() {
  teammatePush()
  git(WORK, ['fetch', BARE, 'main:refs/remotes/origin/main'])
}

/** 经 API 改写并暂存一个文件：连招需要「已暂存 + 提交消息」才可点（须在进项目
 *  前做——面板状态在挂载时拉取，进页后再 stage 列表不会自动刷新） */
async function stageViaApi(content: string) {
  const headers = await unlockHeaders()
  const put = await fetch(`${API_BASE}/api/projects/${projectId}/file`, {
    method: 'PUT', headers, body: JSON.stringify({ path: FILE, content }),
  })
  expect(put.ok).toBeTruthy()
  const stage = await fetch(`${API_BASE}/api/projects/${projectId}/stage`, {
    method: 'POST', headers, body: JSON.stringify({ files: [FILE] }),
  })
  expect(stage.ok).toBeTruthy()
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
  // 仓库本地身份：连招的提交与预检拉取流产生的 merge 提交都走服务端 git CLI，
  // 本机无全局身份时会 500（-c 内联只对本 spec 自建的提交生效）
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: WORK })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: WORK })
  fs.writeFileSync(path.join(WORK, FILE), 'combo e2e v0\n')
  git(WORK, ['add', '.'])
  // CLI 侧播种不经前端门禁；UI 连招提交的信息须过门禁（P-20261003-273）——
  // 三处消息用白名单类型 chore:（见 runCombo 调用点）
  git(WORK, ['commit', '-m', 'root: 连招基线提交'])
  git(WORK, ['push', '-u', 'origin', 'main'])
  // origin URL 改写为服务端形态（P-20261005-187）：UI 连招推送由服务端 git
  // 执行，Windows 形态路径跨拓扑不可解析；测试侧播种/断言用 BARE 原形态
  git(WORK, ['remote', 'set-url', 'origin', serverPath(BARE)])
  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(WORK).replace(/\\/g, '/') }),
  })
  expect(created.status).toBeLessThan(300)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
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

/** 解锁后延迟弹出的「建议修改默认密码」遮罩会拦后续点击：有界等一次并收起 */
async function dismissPasswordHint(page: Page) {
  const laterBtn = page.getByRole('button', { name: '稍后提醒' })
  try { await laterBtn.click({ timeout: 4500 }) } catch { /* 未弹出（锁定关闭/已加载完），继续 */ }
}

/** rail「提交」是 toggle（uiState 服务端全局、跨用例恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await dismissPasswordHint(page)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await dismissPasswordHint(page)
  await openCommitPanel(page)
}

/** 走连招入口：填提交消息 → 点提交钮旁下拉副钮 → 选「提交并推送」 */
async function runCombo(page: Page, message: string) {
  const textarea = page.locator('.cp-commit-area textarea')
  await expect(textarea).toBeVisible()
  await textarea.fill(message)
  const moreBtn = page.locator('[data-testid="commit-more"]')
  await expect(moreBtn).toBeEnabled({ timeout: 10000 })
  await moreBtn.click()
  await page.locator('.n-dropdown-option').filter({ hasText: '提交并推送' }).first().click()
}

test('behind=0：连招直推——提交落库且推送触发（远端跟进）', async ({ page }) => {
  test.setTimeout(60000)
  await stageViaApi('combo e2e v1\n')
  await enterProject(page)

  const msg = 'chore: 直推成功提交'
  await runCombo(page, msg)
  // 双段回执：提交段 + 推送段（连招即两步连做）
  await expect(page.locator('.n-message').filter({ hasText: '提交成功' })).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.n-message').filter({ hasText: 'Push 成功' })).toBeVisible({ timeout: 15000 })

  // CLI 侧真值：本地 HEAD 即连招提交，远端 main 跟进到同一提交（推送确实触发）
  expect(git(WORK, ['log', '-1', '--format=%s'])).toBe(msg)
  await expect.poll(() => {
    try { return git(BARE, ['rev-parse', 'main']) } catch { return '' }
  }, { timeout: 15000 }).toBe(git(WORK, ['rev-parse', 'HEAD']))
})

test('behind>0：预检衔接——「仍要推送」被拒 → 部分成功提示且提交不回滚', async ({ page }) => {
  test.setTimeout(90000)
  // 队友先走一步；等 5.5s 过服务端 ahead 缓存 TTL，进页拉取才取到新 behind
  advanceRemote()
  await page.waitForTimeout(5500)
  await stageViaApi('combo e2e v2\n')
  await enterProject(page)

  // 连招预检的 behind 数据源即共享 aheadBehindMap（进项目时 Layout 拉取，
  // GitPanel 徽标同源）——弹层照常弹出本身即证明 map 已含落后数据；数以
  // CLI 现算为准（重跑会累积，不写死）
  const bareBefore = git(BARE, ['rev-parse', 'main'])
  const behindN = git(WORK, ['rev-list', '--count', 'main..origin/main'])
  const msg = 'chore: 推送被拒不回滚'
  await runCombo(page, msg)

  // 连招提交先落库，推送前的落后预检弹层照常出现（P-10 衔接）
  const dlg = page.locator('.n-dialog').filter({ hasText: '远程领先' })
  await expect(dlg).toBeVisible({ timeout: 8000 })
  await expect(dlg).toContainText(`远程领先 ${behindN} 个提交`)

  // 次操作「仍要推送」→ non-FF 被拒 → 部分成功提示（提交保留 + 失败原因如实带出）
  await dlg.locator('.n-dialog__action button').filter({ hasText: '仍要推送' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '已提交，推送失败' })).toBeVisible({ timeout: 15000 })
  expect(git(WORK, ['log', '-1', '--format=%s']), '推送失败不得回滚提交').toBe(msg)
  expect(git(BARE, ['rev-parse', 'main']), '被拒推送不得改动远端').toBe(bareBefore)

  // 失败事实入通知中心持久留痕（P-20261004-142）：error 条目同刻在账，标题=
  // 部分成功语义（与 toast 的 toast+通知中心双通道，GitPanel 直推失败同形态）。
  // 历史重跑会积累同形条目折叠成组（同类聚合，×N 徽标）——有徽标先展开再点
  // 组员激活，单条直击即激活
  await page.locator('button[title="通知中心"]').first().click()
  const comboNotice = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: '已提交，推送失败' }).first()
  await expect(comboNotice).toBeVisible({ timeout: 8000 })
  if (await comboNotice.locator('.nc-group-count').isVisible().catch(() => false)) {
    await comboNotice.click()
    await page.locator('.nc-item.nc-sub').filter({ hasText: '已提交，推送失败' }).first().click()
  } else {
    await comboNotice.click()
  }
  // 点击直达：panel:git 动作分发 → 底部面板 git 页签（ahead/behind 徽标与
  // 重推入口所在），通知面板随之关闭
  await expect(page.locator('.bottom-panel .git-panel')).toBeVisible({ timeout: 8000 })
})

test('behind>0：预检主操作「先去拉取」→ 走拉取流且连招提交保留', async ({ page }) => {
  test.setTimeout(90000)
  // 承接上一用例的分叉态（本地领先 ≥1、远端领先 ≥1）再进一步，behind 确定非零
  advanceRemote()
  await page.waitForTimeout(5500)
  await stageViaApi('combo e2e v3\n')
  await enterProject(page)

  const bareBefore = git(BARE, ['rev-parse', 'main'])
  const msg = 'chore: 先去拉取保留提交'
  await runCombo(page, msg)

  // 主操作：取消推送并走共享拉取流（TopBar 同一 handlePull）
  const dlg = page.locator('.n-dialog').filter({ hasText: '远程领先' })
  await expect(dlg).toBeVisible({ timeout: 8000 })
  await dlg.locator('.n-dialog__action button').filter({ hasText: '先去拉取' }).click()
  await expect(page.locator('.n-message').filter({ hasText: 'Pull 成功' })).toBeVisible({ timeout: 15000 })

  // 连招提交经拉取流收编进本地历史（拉取时暂存区已干净——提交段先落库），
  // 推送未发生（远端不动，交用户重试）
  expect(git(WORK, ['log', '--format=%s'])).toContain(msg)
  expect(git(BARE, ['rev-parse', 'main'])).toBe(bareBefore)
})
