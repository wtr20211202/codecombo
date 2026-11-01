import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 提交框读取 git config commit.template 模板（P-20261003-172）E2E：
 *   配置模板（仓库根相对路径）→ 进入项目提交框预填模板内容；
 *   无配置项目 → 提交框保持空态（零变化）；
 *   框内已有草稿（跨项目共享草稿语义）→ 切项目返回后模板不得覆盖既有输入
 *   （仅空态写入）。
 * 自备临时仓库两枚（一配一不配），afterAll 清理。
 */

const TPL_DIR = path.join(os.tmpdir(), 'sc-e2e-commit-template')
const PLAIN_DIR = path.join(os.tmpdir(), 'sc-e2e-commit-template-plain')
const TPL_PROJ = 'e2e-commit-template'
const PLAIN_PROJ = 'e2e-commit-template-plain'
const FILE = '.e2e-template.tmp'
const TPL_NAME = '.e2e-commit-template-tpl'
const TPL_BODY = `# TPL-MARKER-SUBJECT: <type>(<scope>): <subject>

# TPL-MARKER-BODY: 说明动机与影响面
`
const DRAFT_MSG = '用户草稿：模板不得覆盖此输入'

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
    if (p.name === TPL_PROJ || p.name === PLAIN_PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [TPL_DIR, PLAIN_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
    fs.mkdirSync(dir, { recursive: true })
    execFileSync('git', ['init'], { cwd: dir })
    execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
    fs.writeFileSync(path.join(dir, FILE), 'template e2e v1\n')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-m', 'root: 模板基线提交'])
    fs.writeFileSync(path.join(dir, FILE), 'template e2e v2\n') // 未暂存变更让面板有内容
  }
  // 仅 TPL 仓配置模板：仓库根相对路径（团队规范载体最常见形态）
  fs.writeFileSync(path.join(TPL_DIR, TPL_NAME), TPL_BODY)
  execFileSync('git', ['config', 'commit.template', TPL_NAME], { cwd: TPL_DIR })

  await registerProject(headers, TPL_PROJ, TPL_DIR)
  await registerProject(headers, PLAIN_PROJ, PLAIN_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === TPL_PROJ || p.name === PLAIN_PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  for (const dir of [TPL_DIR, PLAIN_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  // 本 spec 运行期间 auto-save 的 uiState 会污染后续 spec 的布局恢复（commit-amend
  // 同款收尾，local: null 清空整个命名空间）
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
  // 卡片按项目名整词定位（helpers 同款约束：整卡 hasText 会误中路径含
  // simple-coding 子串的其他卡）
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  await page.locator('.project-card').filter({ has: page.locator('.project-name').filter({ hasText: re }) }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
}

// 选项文本是「<项目名>(<分支>)」——按「名字+分支括号」锚定匹配，防项目名
// 互为前缀时裸 hasText 双中 strict violation（e2e-commit-template 是
// e2e-commit-template-plain 的前缀，与 helpers projectCardByName 整词纪律同源）
function escaped(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function switchProject(page: import('@playwright/test').Page, name: string) {
  await page.locator('.header-project-select').click()
  const menu = page.locator('.n-base-select-menu')
  await expect(menu).toBeVisible({ timeout: 5000 })
  await menu.locator('.n-base-select-option').filter({ hasText: new RegExp(`${escaped(name)}\\(`) }).click()
  await page.waitForTimeout(600) // 面板数据随项目切换重拉
}

test('配模板：进入项目提交框预填 commit.template 内容', async ({ page }) => {
  await enterProject(page, TPL_PROJ)
  const textarea = page.locator('.cp-commit-area textarea')
  await expect(textarea).toBeVisible()
  // 预填是异步拉取（面板挂载后请求），标记行断言容忍 EOL 差异
  await expect(textarea).toHaveValue(/TPL-MARKER-SUBJECT[\s\S]*TPL-MARKER-BODY/, { timeout: 8000 })
})

test('无配置：提交框保持空态（零变化）', async ({ page }) => {
  await enterProject(page, PLAIN_PROJ)
  const textarea = page.locator('.cp-commit-area textarea')
  await expect(textarea).toBeVisible()
  // 该仓库未配置模板，任何时点都不会有写入，空值断言无竞态
  await expect(textarea).toHaveValue('')
})

test('仅空态写入：已有草稿切项目返回，模板不得覆盖', async ({ page }) => {
  await enterProject(page, TPL_PROJ)
  const textarea = page.locator('.cp-commit-area textarea')
  await textarea.fill(DRAFT_MSG)

  // 面板不卸载，切项目走 watch 重拉（面板挂载同链路）
  await switchProject(page, PLAIN_PROJ)
  await expect(textarea).toBeVisible()
  await switchProject(page, TPL_PROJ)

  // 框内草稿非空 → 模板跳过，既有输入原样保留
  await expect(textarea).toHaveValue(DRAFT_MSG, { timeout: 8000 })
})
