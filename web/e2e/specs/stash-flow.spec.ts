import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 提交面板「Stash」E2E（核心 git 操作此前零 UI 覆盖）：
 *   创建（带消息）→ 工作区变干净 + stash 列表出现 → 恢复（pop）→ 变更回到工作区
 *   且 stash 消失 → 再创建 → 删除（drop）→ 变更不回工作区。
 * 全程以 git CLI 校验仓库真实状态，UI 只负责驱动操作。
 * 自备临时仓库，afterAll 清理（项目/目录/uiState 归零，与 commit-amend 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-stash')
const PROJ = 'e2e-stash'
const FILE = '.e2e-stash.tmp'
const STASH_MSG = 'e2e: stash 流验证消息'

let projectId = ''

// 固定参数列表调用 git（无 shell 拼接），身份 -c 内联不依赖本机 git 配置
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
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

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
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'stash e2e v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: stash 基线提交'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
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
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // uiState 归零收尾（与 commit-amend 对称，防布局恢复污染后续 spec）
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
}

/** 经 API 写入工作区变更（服务端同路径写文件，status 面板可见） */
async function makeWorkingChange(headers: Record<string, string>, content: string) {
  const put = await fetch(`${API_BASE}/api/projects/${projectId}/file`, {
    method: 'PUT', headers, body: JSON.stringify({ path: FILE, content }),
  })
  expect(put.ok).toBeTruthy()
}

/** 切到 stash 页签（提交面板页签语义锚点，P-20261002-151） */
async function openStashTab(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="cp-tab-stash"]').click()
  await expect(page.locator('.cp-stash-toolbar')).toBeVisible({ timeout: 3000 })
}

/** 创建弹窗的消息输入框（P-20261003-119 起弹窗带范围单选组——n-radio 自带隐藏
 *  input，裸 `.n-dialog input` 会 strict mode 撞多元素；限定 NInput 包装层） */
function stashDialogInput(page: import('@playwright/test').Page) {
  return page.locator('.n-dialog .n-input input')
}

/** 用例开头清空 stash（CLAUDE.md 测试节「跨用例共享状态的服务端域，用例
 *  开头先 API 清空」惯例）：上一用例（创建用例会留一条 stash 不弹）或失败
 *  重试遗留的条目，会让 pop/drop 用例的「列表清空」断言面向不确定初始态 */
async function clearStashes(headers: Record<string, string>) {
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/stashes`, { headers })
    const list = ((await res.json()) as { data?: unknown[] }).data || []
    if (list.length === 0) return
    const del = await fetch(`${API_BASE}/api/projects/${projectId}/stash/0`, { method: 'DELETE', headers })
    expect(del.ok, '前置：清理遗留 stash 条目').toBeTruthy()
  }
}

test('stash 创建：变更 → 带消息创建 → 工作区干净 + 列表出现', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearStashes(headers)
  await enterProject(page)
  await makeWorkingChange(headers, 'stash e2e v2\n')
  expect(git(REPO_DIR, ['status', '--porcelain']), '前置：工作区应有变更').not.toBe('')

  await openStashTab(page)
  await page.locator('.cp-stash-toolbar').getByRole('button', { name: '创建 Stash' }).click()

  // promptDialog：填消息 → 确定
  const dialogInput = stashDialogInput(page)
  await expect(dialogInput).toBeVisible({ timeout: 3000 })
  await dialogInput.fill(STASH_MSG)
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()

  await expect(page.locator('.n-message').filter({ hasText: 'Stash 创建成功' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.cp-stash-item')).toHaveCount(1, { timeout: 5000 })
  await expect(page.locator('.cp-stash-msg').first()).toContainText('stash 流验证消息')

  // 仓库真实状态：工作区干净，stash 里留着带消息的条目
  expect(git(REPO_DIR, ['status', '--porcelain'])).toBe('')
  expect(git(REPO_DIR, ['stash', 'list'])).toContain(STASH_MSG)
})

test('stash 恢复（pop）：变更回工作区 + stash 消失', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearStashes(headers)
  await makeWorkingChange(headers, 'stash e2e v2\n')
  // stash 经 API 创建（UI 创建路径由上一用例覆盖），本用例聚焦 UI 恢复——
  // 上行已清空上条用例/重试遗留的条目，本用例的 stash 是列表唯一成员，
  // 「pop 后列表清空」断言才面向确定的初始态（失败重试同样成立）
  const create = await fetch(`${API_BASE}/api/projects/${projectId}/stash`, {
    method: 'POST', headers, body: JSON.stringify({ message: STASH_MSG }),
  })
  expect(create.ok).toBeTruthy()
  expect(git(REPO_DIR, ['stash', 'list'])).toContain(STASH_MSG)

  await enterProject(page)
  await openStashTab(page)
  await page.locator('.cp-stash-item').first().getByRole('button', { name: '恢复' }).click()

  await expect(page.locator('.n-message').filter({ hasText: 'Stash 已恢复' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.cp-stash-item')).toHaveCount(0, { timeout: 5000 })

  // 仓库真实状态：变更回到工作区，stash 清空（pop 后 refs/stash 更新在
  // Windows 文件层有可观测的短暂滞后 → poll 轮询而非单次读取）
  expect(git(REPO_DIR, ['status', '--porcelain'])).not.toBe('')
  await expect.poll(async () => git(REPO_DIR, ['stash', 'list']), { timeout: 5000 }).toBe('')
  // 文件内容随 pop 还原（trimEnd：API 写文件可能带尾随换行归一化）
  const content = fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')
  expect(content.trimEnd()).toBe('stash e2e v2')
})

test('stash 删除（drop）：变更不回工作区', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearStashes(headers)
  await enterProject(page)
  await makeWorkingChange(headers, 'stash e2e v3\n')

  await openStashTab(page)
  await page.locator('.cp-stash-toolbar').getByRole('button', { name: '创建 Stash' }).click()
  const dialogInput = stashDialogInput(page)
  await expect(dialogInput).toBeVisible({ timeout: 3000 })
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.cp-stash-item')).toHaveCount(1, { timeout: 5000 })

  await page.locator('.cp-stash-item').first().getByRole('button', { name: '删除' }).click()

  await expect(page.locator('.n-message').filter({ hasText: 'Stash 已删除' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.cp-stash-item')).toHaveCount(0, { timeout: 5000 })

  // 仓库真实状态：drop 后变更不可找回——工作区保持干净（refs/stash 更新
  // 在 Windows 文件层有可观测的短暂滞后 → poll 轮询而非单次读取）
  expect(git(REPO_DIR, ['status', '--porcelain'])).toBe('')
  await expect.poll(async () => git(REPO_DIR, ['stash', 'list']), { timeout: 5000 }).toBe('')
})

// ============== 选择性 stash（P-20261003-119 范围三态） ==============
// 部分暂存场景：s.txt 已暂存 + f.txt 未暂存修改并存，按范围建 stash 后以 git CLI
// 核对「工作区留什么、stash 收什么」的两半语义。
const STAGED_FILE = '.e2e-stash-staged.tmp'
const STAGED_MSG = 'e2e: 仅未暂存范围 stash'
const STAGEDONLY_MSG = 'e2e: 仅已暂存范围 stash'

/** 部分暂存底座：s.txt 经 API 写入后 git add（已暂存），f.txt 修改（未暂存） */
async function makePartiallyStaged(headers: Record<string, string>) {
  const put = await fetch(`${API_BASE}/api/projects/${projectId}/file`, {
    method: 'PUT', headers, body: JSON.stringify({ path: STAGED_FILE, content: 'staged file\n' }),
  })
  expect(put.ok).toBeTruthy()
  git(REPO_DIR, ['add', STAGED_FILE])
  await makeWorkingChange(headers, 'stash e2e v9\n')
  const st = git(REPO_DIR, ['status', '--porcelain'])
  expect(st).toContain(`A  ${STAGED_FILE}`)
  expect(st).toContain(` M ${FILE}`)
}

test('stash 范围=仅未暂存：暂存保留工作区、stash 收未暂存变更', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearStashes(headers)
  await enterProject(page)
  await makePartiallyStaged(headers)

  await openStashTab(page)
  await page.locator('.cp-stash-toolbar').getByRole('button', { name: '创建 Stash' }).click()
  const dialogInput = stashDialogInput(page)
  await expect(dialogInput).toBeVisible({ timeout: 3000 })
  // 范围三态选「仅未暂存」（固定中文 locale，标签即 i18n 文案）
  await page.locator('.n-dialog .n-radio').filter({ hasText: '仅未暂存' }).click()
  await dialogInput.fill(STAGED_MSG)
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()

  await expect(page.locator('.n-message').filter({ hasText: 'Stash 创建成功' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.cp-stash-item')).toHaveCount(1, { timeout: 5000 })
  await expect(page.locator('.cp-stash-msg').first()).toContainText('仅未暂存范围 stash')

  // 仓库真实状态：已暂存变更原样保留在工作区（A  s.txt），未暂存修改被收走
  //（f.txt 回基线内容）；stash 条目含未暂存变更文件。--keep-index 的 git 语义
  // 是 stash 收下全部已跟踪变更（含已暂存部分）、工作区/索引保留已暂存——所以
  // 这里不断言 stash 排除 s.txt，只断言「工作区留什么 + stash 含未暂存」
  const st = git(REPO_DIR, ['status', '--porcelain'])
  expect(st).toContain(`A  ${STAGED_FILE}`)
  expect(st).not.toContain(` M ${FILE}`)
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8').trimEnd()).toBe('stash e2e v1')
  const stashFiles = git(REPO_DIR, ['stash', 'show', '--name-only', 'stash@{0}'])
  expect(stashFiles).toContain(FILE)
})

test('stash 范围=仅已暂存：未暂存留工作区、只收已暂存（git 2.35+）', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearStashes(headers)
  // 能力位感知：服务端 git < 2.35 时该档在弹窗中被禁用（降级语义），用例如实跳过
  const list = await (await fetch(`${API_BASE}/api/projects/${projectId}/stashes`, { headers })).json() as { stagedSupported?: boolean }
  test.skip(list.stagedSupported !== true, '服务端 git 不支持 stash --staged（< 2.35）')
  await enterProject(page)
  await makePartiallyStaged(headers)

  await openStashTab(page)
  await page.locator('.cp-stash-toolbar').getByRole('button', { name: '创建 Stash' }).click()
  const dialogInput = stashDialogInput(page)
  await expect(dialogInput).toBeVisible({ timeout: 3000 })
  await page.locator('.n-dialog .n-radio').filter({ hasText: '仅已暂存' }).click()
  await dialogInput.fill(STAGEDONLY_MSG)
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()

  await expect(page.locator('.n-message').filter({ hasText: 'Stash 创建成功' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.cp-stash-item')).toHaveCount(1, { timeout: 5000 })

  // 仓库真实状态：只收已暂存——索引清空（s.txt 入栈），未暂存修改原样留在工作区
  //（status 单行时 git() helper 的 trim() 会裁掉行首空格，按 trim 后整行断言）
  const st = git(REPO_DIR, ['status', '--porcelain'])
  expect(st).not.toContain(`A  ${STAGED_FILE}`)
  expect(st).toBe(`M ${FILE}`)
  const stashFiles = git(REPO_DIR, ['stash', 'show', '--name-only', 'stash@{0}'])
  expect(stashFiles).toBe(STAGED_FILE)
})
