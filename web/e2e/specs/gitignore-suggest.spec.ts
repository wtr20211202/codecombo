import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * .gitignore 模板创建建议 E2E（P-20261002-76）：
 *   用例1 项目根无 .gitignore 且 status 含未跟踪路径 → Git 面板顶部建议条出现
 *        （含未跟踪计数）→ 模板弹层预览联动选择 → 按 Node 模板创建 → 磁盘落盘
 *        → status 刷新后产物转为被忽略（无未跟踪）→ 建议条消失；
 *   用例2 「不再提示」dismiss → 本会话即隐；同浏览器上下文刷新后仍按项目记忆
 *        保持隐藏（safeStorage/localStorage 项目级），且此时前提仍成立（守卫
 *        假阴性：无 ignore + 有未跟踪但条不出现只可能是 dismiss 生效）。
 * 自备临时仓库（已提交 README + 三个未跟踪产物），afterAll 清理（与
 * gitignore-flow / changes-filter 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-gitignore-suggest')
const PROJ = 'e2e-gitignore-suggest'

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

let projectId = ''
let savedHeaders: Record<string, string> = {}

test.beforeAll(async () => {
  savedHeaders = await unlockHeaders()
  const headers = savedHeaders
  // 清理历史残留（失败重跑时项目名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'gitignore suggest e2e baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: gitignore 建议基线'])

  // 三个未跟踪产物（目录在 status 中折叠为单条：node_modules/ / dist/ + 文件 debug.log）
  fs.mkdirSync(path.join(REPO_DIR, 'node_modules', 'left-pad'), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, 'node_modules', 'left-pad', 'index.js'), 'module.exports = () => "x"\n')
  fs.mkdirSync(path.join(REPO_DIR, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, 'dist', 'bundle.js'), 'console.log(1)\n')
  fs.writeFileSync(path.join(REPO_DIR, 'debug.log'), 'debug\n')
  const st = git(REPO_DIR, ['status', '--porcelain'])
  expect(st.split('\n').filter((l) => l.startsWith('?'))).toHaveLength(3)

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async ({ request }) => {
  const headers = savedHeaders['X-Lock-Token'] ? savedHeaders : await unlockHeaders()
  if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // uiState 归零收尾（防布局恢复污染后续 spec）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

/** 进项目（先清 uiState 再 reload，消除跨用例/重试的异步面板恢复流竞态） */
async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.evaluate(async () => {
    // 页内同源 fetch 自动携带 HttpOnly 锁 cookie（P-20261019-2 起无头可带）
    await fetch('/api/ui-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local: null }),
    })
  })
  await page.reload()
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
}

/** 打开底部 Git 面板（rail 为 toggle，uiState 恢复态不定 → 循环归一化） */
async function openGitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.git-panel').isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.git-panel')).toBeVisible()
}

/** 服务端 status 的未跟踪路径集合（权威源；TTL 缓存 3s 内的迟滞由轮询吸收） */
async function untrackedPaths(request: import('@playwright/test').APIRequestContext): Promise<string[]> {
  const res = await request.get(`${API_BASE}/api/projects/${projectId}/status`, { headers: savedHeaders })
  const list = ((await res.json()) as { data?: { path: string; status: string }[] }).data || []
  return list.filter((f) => f.status === 'Untracked').map((f) => f.path)
}

test('无 .gitignore 且有未跟踪 → 建议条出现 → 按模板创建 → status 刷新产物被忽略 → 条消失', async ({ page, request }) => {
  await enterProject(page)
  await openGitPanel(page)

  // 建议条出现，含未跟踪计数（3 条：node_modules/ / dist/ / debug.log）
  const bar = page.locator('[data-testid="gitignore-hint-bar"]')
  await expect(bar).toBeVisible({ timeout: 10000 })
  await expect(bar).toContainText('未发现 .gitignore')
  await expect(bar).toContainText('3 个未跟踪路径')

  // 模板弹层：预设切换与内容预览联动，最终选回 Node（默认项，证明选择真实生效）
  await page.locator('[data-testid="gitignore-hint-create"]').click()
  const modal = page.locator('.n-modal')
  await expect(modal).toContainText('按模板创建 .gitignore', { timeout: 5000 })
  await expect(modal.locator('.git-tpl-item')).toHaveCount(4)
  await page.locator('[data-testid="gitignore-template-python"]').click()
  await expect(modal.locator('.git-tpl-preview')).toContainText('__pycache__/')
  await page.locator('[data-testid="gitignore-template-node"]').click()
  await expect(modal.locator('.git-tpl-preview')).toContainText('node_modules/')
  await page.locator('[data-testid="gitignore-template-create"]').click()
  await expect(modal).toBeHidden({ timeout: 5000 })

  // 磁盘：.gitignore 已按 Node 模板落盘
  const gi = fs.readFileSync(path.join(REPO_DIR, '.gitignore'), 'utf8')
  expect(gi).toContain('node_modules/')
  expect(gi).toContain('*.log')

  // status 刷新（显式 fetch + WS file.changed 双保险后）：三个产物全部转为被忽略。
  // 精确终态 = 仅新建的 .gitignore 本身未跟踪（尚未暂存），产物一个不剩
  await expect.poll(async () => untrackedPaths(request), { timeout: 15000 })
    .toEqual(['.gitignore'])

  // 建议条随 .gitignore 出现而消失（missing 复位）
  await expect(bar).toBeHidden({ timeout: 5000 })
})

test('不再提示：dismiss 本会话即隐，刷新后按项目记忆保持隐藏且前提仍成立', async ({ page, request }) => {
  // 用例自备前提：删掉用例1创建的 .gitignore，恢复「无 ignore + 有未跟踪」
  fs.rmSync(path.join(REPO_DIR, '.gitignore'), { force: true })

  await enterProject(page)
  await openGitPanel(page)
  const bar = page.locator('[data-testid="gitignore-hint-bar"]')
  await expect(bar).toBeVisible({ timeout: 10000 })

  // dismiss → 本会话立即隐藏
  await page.locator('[data-testid="gitignore-hint-dismiss"]').click()
  await expect(bar).toBeHidden({ timeout: 5000 })

  // 同浏览器上下文刷新（localStorage 保持）：建议条不再出现
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openGitPanel(page)
  await expect(bar).toBeHidden({ timeout: 5000 })

  // 守卫假阴性：此刻无 .gitignore 且未跟踪仍在——条不出现只可能是 dismiss 记忆生效
  // （服务端 status 与 UI 侧 changes store 双源确认：store 有 3 条未跟踪时条仍隐）
  expect(fs.existsSync(path.join(REPO_DIR, '.gitignore'))).toBe(false)
  await expect.poll(async () => untrackedPaths(request).then((p) => p.join(',')), { timeout: 15000 })
    .toContain('debug.log')
  await expect(page.locator('.statusbar-changes .changes-unstaged')).toHaveText('3', { timeout: 10000 })
})
