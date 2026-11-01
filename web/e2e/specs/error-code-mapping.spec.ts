import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 错误码映射消费层 E2E（P-20261005-153）：前端按结构化错误码（P-305 响应体
 * {error, code}）优先命中 KNOWN_ERROR_I18N（http.ts ERROR_CODE_I18N 表）。
 *   1. 锁定项目（project.locked 码）→ UI 文件树内联新建文件 → 403 → toast 为
 *      code 映射文案「项目已锁定…」（非英文原文）；
 *   2. 错误中心展开该条 → 英文原文旁 code 徽标可见（报障引用锚点），点击复制；
 *   3. 徽标可见性区分：无 code 的普通错误（拦截 500 {error}，无 code 字段）
 *      展开后不渲染徽标。
 * 自备临时 git 仓库 + 锁定态，用后经 API 清理注册（project-hard-lock 骨架）。
 */

const NAME_PREFIX = 'sc-e2e-errcode-'
const PROBE_DIR = 'docs'
const NOCODE_MARKER = 'SCSEED-NOCODE-QQ77'
let projDir = ''
let projName = ''
let projectId = ''

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理历史运行残留：按名称前缀删注册（磁盘目录保留） */
async function cleanupProjects(): Promise<void> {
  try {
    const headers = await unlockHeaders()
    const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
    for (const p of ((list?.data || []) as { id: string; name: string }[])) {
      if (p.name.startsWith(NAME_PREFIX)) {
        await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
      }
    }
  } catch { /* 清理失败不阻塞用例 */ }
}

async function setLocked(locked: boolean): Promise<void> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/locked`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ locked }),
  })
  expect(res.status).toBe(200)
}

test.beforeAll(async () => {
  await cleanupProjects()
  projDir = fs.mkdtempSync(path.join(os.tmpdir(), NAME_PREFIX))
  projName = path.basename(projDir)
  // 真实 git 仓库 + docs 子目录（探针右键位：根目录条目少不填虚拟列表，docs 可直接右键）
  execSync('git init', { cwd: projDir })
  execSync('git config core.autocrlf false', { cwd: projDir })
  execSync('git config user.email sc-e2e@example.com', { cwd: projDir })
  execSync('git config user.name sc-e2e', { cwd: projDir })
  fs.writeFileSync(path.join(projDir, 'README.md'), 'errcode probe\n')
  fs.mkdirSync(path.join(projDir, PROBE_DIR))
  execSync('git add README.md', { cwd: projDir })
  execSync('git commit -m init', { cwd: projDir })
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: projName, path: serverPath(projDir) }),
  })
  const body = await res.json() as { data?: { id?: string } }
  if (!body.data?.id) throw new Error(`register project failed: ${res.status} ${JSON.stringify(body)}`)
  projectId = body.data.id
})

test.afterAll(async () => {
  await setLocked(false).catch(() => {})
  await cleanupProjects()
  try { fs.rmSync(projDir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

/** 锁定态进入项目页（先种一条无 code 的 500 错误），打开文件树 */
async function enterLockedProject(page: Page): Promise<void> {
  await setLocked(true)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, projName).first().waitFor({ state: 'visible', timeout: 8000 })
  // 首页自身的拉取先落地，再注册「首败后放行」的 status 拦截（errorlog-filter 同款：
  // 单次 500 {error} 无 code 字段 → 种一条无 code 的错误条目作徽标可见性对照组）
  await page.waitForTimeout(1000)
  let statusFails = 0
  await page.route('**/api/projects/*/status', route => {
    if (statusFails++ === 0) {
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: NOCODE_MARKER }) })
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
  })
  await projectCardByName(page, projName).first().click()
  await page.waitForURL('**/project', { timeout: 10000 })
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续点击（errorlog-filter 先例）
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——奇数次点击保证最终打开
  for (let i = 0; i < 3; i++) {
    if (await page.getByText('README.md').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

test('锁定项目 UI 写操作：toast 为 code 映射文案；错误详情 code 徽标可见性区分', async ({ page }) => {
  test.setTimeout(90000)
  await enterLockedProject(page)

  // ── UI 写操作撞硬锁：docs 右键 → 内联新建文件 → 403（响应体携 code project.locked）──
  const docs = itemByName(page, PROBE_DIR)
  await expect(docs).toBeVisible({ timeout: 8000 })
  await docs.click({ button: 'right' })
  await expect(page.locator('.n-dropdown-menu')).toBeVisible()
  await page.locator('.n-dropdown-menu').getByText('新建文件', { exact: true }).click()
  const inlineInput = page.locator('.inline-input-row input')
  await expect(inlineInput).toBeVisible()
  await inlineInput.fill('blocked.txt')
  await inlineInput.press('Enter')

  // toast 为 code 映射文案（errors.known.projectLocked），非英文原文
  await expect(
    page.locator('.n-message-container').getByText('项目已锁定').first(),
  ).toBeVisible({ timeout: 8000 })

  // ── 错误中心：code 条目展开后徽标可见（英文原文旁），无 code 条目无徽标 ──
  const consoleTab = page.locator('.bottom-tabs button').filter({ hasText: '控制台' })
  if (!(await consoleTab.isVisible().catch(() => false))) {
    await page.keyboard.press('Control+`')
    await consoleTab.waitFor({ state: 'visible', timeout: 5000 })
  }
  await consoleTab.click()
  await page.locator('.sub-tab').filter({ hasText: '错误' }).click()

  const rows = page.locator('.log-row')
  const codeRow = rows.filter({ hasText: '项目已锁定' }).first()
  await expect(codeRow).toBeVisible({ timeout: 10000 })

  // 展开 code 条目（点文案区避开类别徽标）：徽标即结构化码本身
  await codeRow.locator('.user-msg').click()
  const badge = codeRow.locator('[data-testid="errorlog-code-badge"]')
  await expect(badge).toBeVisible()
  await expect(badge).toHaveText('project.locked')
  // 点击徽标复制码值：文案转「已复制」反馈（报障引用闭环；localhost 是
  // secure context，copyText 主路径可用——remote-files 同款断言先例）
  await badge.click()
  await expect(badge).toHaveText('已复制')

  // 对照组：无 code 字段的普通错误展开后不渲染徽标（可见性即区分）。
  // 标记串只在 rawMessage 里（折叠行不可见），用过滤搜索框隔离该条
  const search = page.locator('.errorlog-filter-input input')
  await search.fill(NOCODE_MARKER)
  await expect(rows).toHaveCount(1)
  const noCodeRow = rows.first()
  await noCodeRow.locator('.user-msg').click()
  await expect(noCodeRow.locator('[data-testid="errorlog-code-badge"]')).toHaveCount(0)
  await expect(noCodeRow.locator('.raw')).toContainText(NOCODE_MARKER)
})
