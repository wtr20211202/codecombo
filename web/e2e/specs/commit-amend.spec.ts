import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 提交面板「修补上次提交（Amend）」E2E：
 *   正向：勾选 → 回填 HEAD 完整消息（%B）→ 改写消息提交 → HEAD subject 变更且 HEAD^ 仍指旧提交
 *        （内容并入而非新提交）；提交成功后勾选自动落闸（一次性，防误触二次改写历史）；
 *        取消勾选还原勾选前草稿（回填的 HEAD 消息不残留）。
 *   负向：空仓库（无任何提交）勾选 → 复选框回弹 + 本地化警告（不直出英文底层报错）。
 *   切项目：勾选回填后经顶栏选择器应用内切项目 → 回弹 + 还原勾选前草稿
 *        （回填的 HEAD 消息不得跨项目残留）。
 * 自备临时仓库（c1 基线提交 + 空仓库各一），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-commit-amend')
const EMPTY_DIR = path.join(os.tmpdir(), 'sc-e2e-commit-amend-empty')
const AMEND_PROJ = 'e2e-commit-amend'
const EMPTY_PROJ = 'e2e-commit-amend-empty'
const FILE = '.e2e-amend.tmp'
const C1_MSG = 'c1: amend 基线提交'
const DRAFT_MSG = '草稿消息（勾选 amend 前的输入）'
// 经 UI 提交须过前端提交信息门禁（P-20261003-273）：类型须在白名单内（CLI 侧
// 的 C1_MSG 不经门禁，不受限）
const AMEND_MSG = 'fix: 修补后的新消息 (amended via UI)'

let projectId = ''
let oldHead = ''
let oldParent = ''

// 固定参数列表调用 git（无 shell 拼接），身份用 -c 内联避免依赖本机 git 配置
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
    if (p.name === AMEND_PROJ || p.name === EMPTY_PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [REPO_DIR, EMPTY_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
    fs.mkdirSync(dir, { recursive: true })
    execFileSync('git', ['init'], { cwd: dir }) // 服务端要求项目路径是 git 仓库
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
    // 仓库本地身份：服务端 UI 提交走 git CLI，本机无全局身份时 commit 会 500
    // （-c 内联只对本 spec 自建的 c1 生效，服务端进程看不到）
    execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  }
  // 两个提交：root 根提交 + c1（amend 的目标，含父提交以断言父链不变）；
  // 空仓库保持无提交（负向用例）
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'amend e2e v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 初始提交'])
  fs.appendFileSync(path.join(REPO_DIR, FILE), 'amend e2e v2\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', C1_MSG])
  oldHead = git(REPO_DIR, ['rev-parse', 'HEAD'])
  oldParent = git(REPO_DIR, ['rev-parse', 'HEAD^'])

  projectId = await registerProject(headers, AMEND_PROJ, REPO_DIR)
  await registerProject(headers, EMPTY_PROJ, EMPTY_DIR)

  // 经 API 改写并暂存：进入项目时面板即有 1 个 staged 文件（提交按钮可用）
  const put = await fetch(`${API_BASE}/api/projects/${projectId}/file`, {
    method: 'PUT', headers, body: JSON.stringify({ path: FILE, content: 'amend e2e v2\n' }),
  })
  expect(put.ok).toBeTruthy()
  const stage = await fetch(`${API_BASE}/api/projects/${projectId}/stage`, {
    method: 'POST', headers, body: JSON.stringify({ files: [FILE] }),
  })
  expect(stage.ok).toBeTruthy()
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === AMEND_PROJ || p.name === EMPTY_PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  for (const dir of [REPO_DIR, EMPTY_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  // 本 spec 运行期间 auto-save 的 uiState（提交面板视图/项目选择）会污染
  // 后续 spec 的布局恢复（实测 editor-git-tools openFile 在其之后必踩文件树
  // 重渲染竞态）——与 editor-git-tools 的 beforeAll 清理对称，归零收尾。
  // local: null = 清空整个命名空间（浅合并下传对象清不掉）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** rail「提交」是 toggle（uiState 服务端全局、跨用例恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

async function enterProject(page: import('@playwright/test').Page, name: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: name }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
}

test('amend 正向：勾选回填 HEAD 消息 → 改写提交 → subject 变更且父提交不变', async ({ page }) => {
  await enterProject(page, AMEND_PROJ)

  // 新勾选项本地化渲染（zh-CN）
  const amendLabel = page.locator('.cp-amend')
  await expect(amendLabel).toContainText('修补上次提交')

  const textarea = page.locator('.cp-commit-area textarea')
  await expect(textarea).toBeVisible()
  // 先输入一份草稿：勾选 amend 必须回填 HEAD 消息，否则陈旧草稿会静默覆盖上一条提交
  await textarea.fill(DRAFT_MSG)

  const checkbox = page.locator('.cp-amend .n-checkbox')
  await checkbox.click()
  await expect(textarea).toHaveValue(C1_MSG, { timeout: 5000 })
  await expect(checkbox).toHaveClass(/n-checkbox--checked/)

  // 取消勾选 → 还原勾选前草稿
  await checkbox.click()
  await expect(textarea).toHaveValue(DRAFT_MSG)
  await expect(checkbox).not.toHaveClass(/n-checkbox--checked/)

  // 重新勾选 → 改写消息 → 提交
  await checkbox.click()
  await expect(textarea).toHaveValue(C1_MSG, { timeout: 5000 })
  await textarea.fill(AMEND_MSG)
  const commitBtn = page.locator('.cp-commit-actions').getByRole('button', { name: /提交 \(/ })
  await expect(commitBtn).toBeEnabled({ timeout: 10000 })
  await commitBtn.click()

  // HEAD subject 变为修补消息，且父提交与提交数都不变（--amend 替换 HEAD：
  // 内容并入 c1 而非新增第 3 个提交；新 HEAD 的父链仍接 root）
  const headers = await unlockHeaders()
  await expect.poll(async () => {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/log?limit=1`, { headers })
    const body = (await res.json()) as { data?: Array<{ message?: string }> }
    return body.data?.[0]?.message || ''
  }, { timeout: 10000 }).toBe(AMEND_MSG)
  expect(git(REPO_DIR, ['rev-parse', 'HEAD']), 'HEAD 应被替换（hash 变化）').not.toBe(oldHead)
  expect(git(REPO_DIR, ['rev-parse', 'HEAD^']), '父提交应保持不变').toBe(oldParent)
  expect(git(REPO_DIR, ['rev-list', '--count', 'HEAD']), '提交总数应不变（并入而非新提交）').toBe('2')

  // 一次性落闸：提交成功后勾选自动取消，防误触二次改写历史
  await expect(checkbox).not.toHaveClass(/n-checkbox--checked/, { timeout: 5000 })
})

test('amend 负向：空仓库勾选 → 回弹 + 本地化警告', async ({ page }) => {
  await enterProject(page, EMPTY_PROJ)

  const checkbox = page.locator('.cp-amend .n-checkbox')
  await checkbox.click()
  // 空仓库 git log 报错 → 回弹 + 警告 toast（本地化文案，不直出英文底层报错）；
  // 先断言警告（catch 分支的产物），再断言勾选已回弹
  await expect(page.locator('.n-message').filter({ hasText: '仓库还没有可修补的提交' })).toBeVisible({ timeout: 5000 })
  await expect(checkbox).not.toHaveClass(/n-checkbox--checked/)
})

test('amend 切项目落闸：勾选回填后切项目 → 回弹 + 还原勾选前草稿', async ({ page }) => {
  await enterProject(page, AMEND_PROJ)

  const textarea = page.locator('.cp-commit-area textarea')
  const checkbox = page.locator('.cp-amend .n-checkbox')
  await textarea.fill(DRAFT_MSG)
  await checkbox.click()
  // 回填基准 = 当前真实 HEAD（前置正向用例已把 HEAD amend 成 AMEND_MSG，不能假定仍是 c1）
  const headMessage = git(REPO_DIR, ['log', '-1', '--format=%B'])
  await expect(textarea).toHaveValue(headMessage, { timeout: 5000 })

  // 顶栏选择器应用内切到空仓库项目（面板不卸载，watch 落闸生效）：
  // 回填的 A 项目 HEAD 消息不得残留到 B 项目——勾选回弹 + 输入框还原勾选前草稿
  await page.locator('.header-project-select').click()
  const menu = page.locator('.n-base-select-menu')
  await expect(menu).toBeVisible({ timeout: 5000 })
  await menu.locator('.n-base-select-option').filter({ hasText: EMPTY_PROJ }).click()

  await expect(checkbox).not.toHaveClass(/n-checkbox--checked/, { timeout: 5000 })
  await expect(textarea).toHaveValue(DRAFT_MSG)
})
