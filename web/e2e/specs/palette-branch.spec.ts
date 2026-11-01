import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 命令面板快速切分支 E2E（P-20261002-102，配方同 palette-commands + branch-dirty-warning）：
 *   - Ctrl+K 命令模式输分支名 → 「切换到分支：<name>」命令出现 → Enter → 真实检出
 *   - 当前分支命令带「当前分支」标注
 *   - 脏工作区预警路径回归：面板检出与 Git 侧栏右键共用同一链路（useBranchCheckout），
 *     有未提交修改时 Enter 先弹确认，确认后才切换
 * 自备临时仓库，afterAll 清理（范式与 branch-checkout/branch-dirty-warning 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-palette-branch')
const PROJ = 'e2e-palette-branch'
const CARRY_FILE = 'carry.txt'
const CARRY_BASE = 'carry\n'
const FEATURE_BRANCH = 'e2e-pal-feature'

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
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  // master：base + carry 基线；feature 分支只追加独有文件——carry.txt 在两分支
  // 内容一致，未提交修改才能被 git 干净「携带」到目标分支（脏区预警用例依赖）
  fs.writeFileSync(path.join(REPO_DIR, 'base.txt'), 'base\n')
  fs.writeFileSync(path.join(REPO_DIR, CARRY_FILE), CARRY_BASE)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 面板切分支基线提交'])
  git(REPO_DIR, ['checkout', '-b', FEATURE_BRANCH])
  fs.writeFileSync(path.join(REPO_DIR, 'feature.txt'), 'feature 分支独有内容\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'feat: feature 分支独有提交'])
  git(REPO_DIR, ['checkout', 'master'])
  expect(git(REPO_DIR, ['branch', '--show-current'])).toBe('master')
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
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 进项目页 + Ctrl+K 开命令面板（openCommandPalette 会拉取分支清单喂命令组） */
async function openProjectAndPalette(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  return input
}

/** 脏工作区预警确认弹窗（标题含「未提交修改」） */
function dirtyDialog(page: import('@playwright/test').Page) {
  return page.locator('.n-dialog').filter({ hasText: '未提交修改' })
}

/** CLI 侧改动工作区后让前端 changes store 感知（服务端 git 状态缓存 3s TTL，
 *  等 TTL 过期后经状态栏 → 变更面板刷新按钮显式重拉；计数与面板预检同源） */
async function syncChangesStore(page: import('@playwright/test').Page, mutate: () => void) {
  mutate()
  await page.waitForTimeout(3500)
  await page.locator('.statusbar-changes').click()
  const refreshBtn = page.locator('.cp-tab-refresh')
  await expect(refreshBtn).toBeVisible({ timeout: 8000 })
  await refreshBtn.click()
}

/** 等 changes store 感知工作区文件数（状态栏未提交计数与预检同源同值） */
async function expectChangesCount(page: import('@playwright/test').Page, n: string) {
  await expect(page.locator('.statusbar-changes .changes-unstaged')).toHaveText(n, { timeout: 10000 })
}

test('命令面板输分支名 → 命令出现 → Enter 检出生效', async ({ page }) => {
  const input = await openProjectAndPalette(page)

  // 命令模式输分支名（不是完整命令文案）：分支命令过滤命中且为唯一激活项
  await input.fill(`>${FEATURE_BRANCH}`)
  const active = page.locator('.palette-item.active')
  await expect(active).toHaveText(new RegExp(`切换到分支：${FEATURE_BRANCH}`), { timeout: 5000 })

  // Enter → checkout 生效：成功提示 + CLI 当前分支切换 + 分支独有文件出现
  await page.keyboard.press('Enter')
  await expect(page.locator('.n-message').filter({ hasText: `已切换到 ${FEATURE_BRANCH}` })).toBeVisible({ timeout: 5000 })
  await expect.poll(async () => git(REPO_DIR, ['branch', '--show-current']), { timeout: 5000 }).toBe(FEATURE_BRANCH)
  expect(fs.existsSync(path.join(REPO_DIR, 'feature.txt')), '检出后 feature 独有文件应出现').toBe(true)

  // 当前分支标注：再次打开面板，feature 命令带「当前分支」副标题
  await page.keyboard.press('Control+k')
  await input.fill(`>${FEATURE_BRANCH}`)
  await expect(page.locator('.palette-item').filter({ hasText: `切换到分支：${FEATURE_BRANCH}` }).first())
    .toContainText('当前分支', { timeout: 5000 })
  // Esc 双层退出（P-20261004-95）：有查询先清——两连 Esc 才落到关闭
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
})

test('脏工作区：面板检出先弹预警确认，确认后携带修改切换成功', async ({ page }) => {
  // 归一到两分支之一（上一用例可能停在 feature），目标取另一分支，用例顺序无关
  const current = git(REPO_DIR, ['branch', '--show-current'])
  const target = current === 'master' ? FEATURE_BRANCH : 'master'
  await openProjectAndPalette(page)
  await page.keyboard.press('Escape')

  // 脏改（两分支同内容文件，可被干净携带）→ 等 TTL 过期显式重拉 → 计数归一
  await syncChangesStore(page, () => fs.writeFileSync(path.join(REPO_DIR, CARRY_FILE), 'carry\ndirty edit\n'))
  await expectChangesCount(page, '1')

  // 面板切分支 → Enter → 预警确认框（数量与目标分支已插值），未确认不检出
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(`>${target}`)
  const active = page.locator('.palette-item.active')
  await expect(active).toHaveText(new RegExp(`切换到分支：${target}`), { timeout: 5000 })
  await page.keyboard.press('Enter')

  const dlg = dirtyDialog(page)
  await expect(dlg).toBeVisible({ timeout: 3000 })
  await expect(dlg).toContainText('1 个未提交修改')
  await expect(dlg).toContainText(target)
  await expect.poll(async () => git(REPO_DIR, ['branch', '--show-current']), { timeout: 3000 }).toBe(current)

  // 确认 → 携带修改检出成功（与 Git 侧栏右键同一 useBranchCheckout 链路）
  await dlg.locator('.n-dialog__action button').filter({ hasText: '仍要切换' }).click()
  await expect(page.locator('.n-message').filter({ hasText: `已切换到 ${target}` })).toBeVisible({ timeout: 5000 })
  await expect.poll(async () => git(REPO_DIR, ['branch', '--show-current']), { timeout: 5000 }).toBe(target)
  expect(fs.readFileSync(path.join(REPO_DIR, CARRY_FILE), 'utf8')).toContain('dirty edit')
})
