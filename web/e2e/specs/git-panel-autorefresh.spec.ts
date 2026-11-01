import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * git 面板自动刷新（P-20261003-74）E2E：
 *   1. 变更面板全链路——底部终端跑 `git add -A` / `git commit`（只动 .git，不产生
 *      file.changed），侧栏变更面板在数秒内自动更新暂存态/清空列表（无手动刷新）
 *   2. 分支面板监听——挂载中的分支列表在收到刷新事件后拉到外部新建的分支
 *      （合成事件打点：检测链路由用例 1 + isGitWriteCommand 单测覆盖）
 *   3. 去抖单拉——连续多个刷新事件合并为一次分支列表拉取（尾沿去抖）
 * 自备临时仓库（2 提交 + 1 处工作区改动），afterAll 清理。
 * 事件名与 useGitPanelAutoRefresh 的 GIT_PANEL_AUTO_REFRESH 常量一致。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-git-panel-autorefresh')
const PROJ = 'e2e-git-panel-autorefresh'
const README = 'README.md'
const AUTO_REFRESH_EVENT = 'sc:git-panel-autorefresh'
const NEW_BRANCH = 'e2e-auto-new-branch'

let projectId = ''
let unlockToken = ''

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const list = await api('GET', '/api/projects')
  const old = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
  if (old) await api('DELETE', `/api/projects/${old.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  // repo 级身份：终端里的 git commit（无 -c 覆盖）继承此配置，不依赖运行机全局 config
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, README), 'v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: init'])
  // 工作区改动先于页面打开：进项目时的启动 status 拉取即能看到（用例 1 的基线）
  fs.writeFileSync(path.join(REPO_DIR, README), 'v1\nv2 modified\n')

  const proj = await api('POST', '/api/projects', { name: PROJ, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
  projectId = (proj.json?.data as { id: string }).id
})

test.afterAll(async () => {
  // 只清本 spec 创建的终端会话（PTY 进程兜底回收），不动其他 spec 的会话
  const list = await api('GET', '/api/terminals')
  for (const s of ((list.json?.data || []) as { id: string; projectId?: string }[])) {
    if (s.projectId === projectId) await api('DELETE', `/api/terminals/${s.id}`)
  }
  if (projectId) await api('DELETE', `/api/projects/${projectId}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
}

/** 打开底部终端 tab 并新建会话（面板开合/uiState 跨用例持久，全部状态感知归一） */
async function openFreshTerminal(page: import('@playwright/test').Page) {
  const panel = page.locator('[data-testid="bottom-panel"]')
  if (!(await panel.isVisible().catch(() => false))) {
    await page.locator('.rail-btn[title="终端"]').click()
  }
  await expect(panel).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="bottom-tab-terminal"]').click()
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  // 提示符按服务端 shell 分支：Windows 默认 PowerShell（shellint 注入 OSC 133 钩子）；
  // Linux bash 提示符以 $（普通用户）或 #（root，如 WSL 实例）收尾
  await expect(xterm).toContainText(serverIsLinux ? /[#$] / : 'PS ', { timeout: 20000 })
  return xterm
}

test('变更面板自动刷新：终端 git add/commit 后暂存态与列表秒级跟上（无 file.changed 无手动刷新）', async ({ page }) => {
  test.setTimeout(120000)
  await enterProject(page)

  // 侧栏变更面板：uiState 跨用例持久且 boot 恢复异步落定（恢复会覆盖显式 rail
  // 点击的状态），rail 是 toggle 语义——循环归一化到「稳定可见」基线（CLAUDE.md 面板开关条款）
  const commitPanel = page.locator('[data-testid="commit-panel"]')
  for (let i = 0; i < 3; i++) {
    if (await commitPanel.isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(1200)
  }
  await expect(commitPanel).toBeVisible({ timeout: 5000 })
  // 基线：工作区改动已出现在列表（未暂存 ○）
  const readmeRow = commitPanel.locator('.cp-node').filter({ hasText: README })
  await expect(readmeRow).toBeVisible({ timeout: 10000 })
  await expect(commitPanel.locator('.cp-stage-toggle:not(.staged)')).toBeVisible()

  // 底部终端跑 git add -A：只动 .git/index，fsnotify 不产生 file.changed——
  // 变更面板的暂存态更新只能来自 OSC 133 检测链（被测特性）
  const xterm = await openFreshTerminal(page)
  await xterm.click()
  await page.keyboard.type('git add -A\r')
  await expect(commitPanel.locator('.cp-stage-toggle.staged')).toBeVisible({ timeout: 10000 })

  // 连续第二命令：git commit 后列表自动清空（同样无 file.changed 可依赖）
  await page.keyboard.type('git commit -m "e2e: auto refresh"\r')
  await expect(commitPanel.locator('.cp-empty').filter({ hasText: '没有变更' })).toBeVisible({ timeout: 10000 })
})

test('分支面板监听刷新：挂载中收到事件即拉到外部新建的分支', async ({ page }) => {
  await enterProject(page)

  // 底部 git tab（GitBranchesSection 挂载，启动拉取出现本地分支基线）
  await page.locator('[data-testid="bottom-tab-git"]').click()
  const localHeader = page.locator('.section-header').filter({ hasText: '本地' })
  await expect(localHeader).toBeVisible({ timeout: 10000 })
  // 本地 main 行以 .branch-marker（● 当前分支）锚定——远程分组里 origin/main
  // 的 displayName 同为 "main"，裸 hasText 会双命中触发 strict 冲突
  const localMain = page.locator('.branch-item').filter({ has: page.locator('.branch-marker') }).filter({ hasText: 'main' })
  await expect(localMain).toBeVisible({ timeout: 10000 })

  // 面板外建分支（不经 UI，不产生任何前端已知事件）
  git(REPO_DIR, ['branch', NEW_BRANCH])

  // 合成事件打点：面板侧监听+去抖+复用 fetch 链（检测链由用例 1 与单测覆盖）
  await page.evaluate((name) => window.dispatchEvent(new CustomEvent(name)), AUTO_REFRESH_EVENT)
  await expect(page.locator('.branch-item').filter({ hasText: NEW_BRANCH })).toBeVisible({ timeout: 10000 })
})

test('去抖单拉：连续多个刷新事件合并为一次分支列表拉取', async ({ page }) => {
  await enterProject(page)

  await page.locator('[data-testid="bottom-tab-git"]').click()
  const localHeader = page.locator('.section-header').filter({ hasText: '本地' })
  await expect(localHeader).toBeVisible({ timeout: 10000 })

  // 计数器在启动拉取完成后安装，只统计刷新事件触发的分支列表请求
  let branchFetches = 0
  await page.route('**/api/projects/*/branches', (route) => {
    branchFetches++
    return route.continue()
  })

  for (let i = 0; i < 3; i++) {
    await page.evaluate((name) => window.dispatchEvent(new CustomEvent(name)), AUTO_REFRESH_EVENT)
    await page.waitForTimeout(150)
  }
  // 尾沿去抖 1s：3 个事件只落 1 次拉取；再等 0.8s 排除 trailing 二次触发
  await page.waitForTimeout(1800)
  expect(branchFetches).toBe(1)
})
