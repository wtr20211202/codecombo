import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * TUI 运行时 git 写活动的服务端感知（P-20261004-81）E2E：
 * 会话内子进程 git commit/switch（TUI/脚本形态，前端 OSC 133 检测链对它全盲）
 * → 服务端 readLoop 输出嗅探命中 → git.activity 定向广播落项目 WS → 面板秒级跟上。
 *
 * 与 git-panel-autorefresh.spec（P-74）的关键差异：那里命令敲在挂载中的 UI 终端
 * （OSC 133 前端链是被测特性）；这里全部 git 操作走「无头会话」——API 创建会话 +
 * broadcast-write 写 PTY，页面从头到尾不挂载任何终端 pane，前端检测链结构性缺席。
 * 变更/分支面板仍能刷新，唯一路径就是服务端嗅探链（被测特性）。
 *
 * 三个用例：
 *   1. 无头会话 git add+commit → 变更面板自动清空（无 pane 无 file.changed 无手动刷新）
 *   2. 无头会话 git switch -c → 分支面板拉到新分支（switch 模式族）
 *   3. 项目 WS 订阅面：真实 WebSocket 收到 {type:'git.activity'}，载荷契约
 *      {kind,ref,sessionId,projectId}（agent 感知面——子协议携令牌可订阅）
 * 自备临时仓库（2 提交 + 1 处工作区改动），afterAll 清理。
 * 注：switch 文案按英文 locale git 断言（嗅探模式表保守起跑的同一假设）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-git-activity-tui')
const PROJ = 'e2e-git-activity-tui'
const README = 'README.md'
const TUI_BRANCH = 'e2e-tui-branch'
const WS_BRANCH = 'e2e-tui-ws-branch'

let projectId = ''
let unlockToken = ''
let sessionId = ''

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

/** 向无头会话写一行命令（PTY 原始输入，自带 \r 执行） */
async function typeInSession(command: string) {
  const res = await api('POST', '/api/terminals/broadcast-write', { ids: [sessionId], data: command + '\r' })
  expect(res.status).toBe(200)
  expect((res.json?.data?.missing || []) as string[]).not.toContain(sessionId)
}

/** 轮询会话 scrollback 直到出现标记（shell 就绪 / 命令已执行的确定通道）。
 *  匹配前剥 ANSI：PSReadLine 回显带逐词色码（`git add -A` → `git^[[37madd`），
 *  git 彩色输出同理——裸串匹配会被转义序列割裂 */
async function waitForScrollback(marker: RegExp, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let text = ''
  while (Date.now() < deadline) {
    const res = await fetch(`${API_BASE}/api/terminals/${sessionId}/scrollback`, { headers: { 'X-Lock-Token': unlockToken } })
    if (res.ok) text = await res.text()
    if (marker.test(stripAnsi(text))) return
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`scrollback 未出现 ${marker}，末尾内容：${stripAnsi(text).slice(-400)}`)
}

/** 剥 CSI 与 OSC 转义序列（与终端搜索 StripANSI 同语义的用例内实现） */
function stripAnsi(s: string) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
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

  // 无头会话：纯 API 创建，页面不挂载任何 pane（readLoop 无 WS 客户端也运转）
  const created = await api('POST', '/api/terminals', { projectId, name: 'tui-sniff-headless' })
  expect(created.status).toBe(200)
  sessionId = (created.json?.data as { id: string }).id
  // shell 就绪：scrollback 出现提示符字符再写命令，防启动期写入被行编辑器吞掉
  await waitForScrollback(/>|[$#]\s/)
})

test.afterAll(async () => {
  // 只清本 spec 创建的终端会话（PTY 进程兜底回收），不动其他 spec 的会话
  if (sessionId) await api('DELETE', `/api/terminals/${sessionId}`)
  if (projectId) await api('DELETE', `/api/projects/${projectId}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
}

test('无头会话 git commit → 变更面板秒级清空（无 pane 无 file.changed 无手动刷新）', async ({ page }) => {
  test.setTimeout(120000)
  await enterProject(page)

  // 侧栏变更面板：uiState 跨用例持久且 boot 恢复异步落定（恢复会覆盖显式 rail
  // 点击的状态），rail 是 toggle 语义——循环归一化到「稳定可见」基线
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

  // 全程只经无头会话跑 git：页面没有终端 pane（前端 OSC 133 检测链结构性缺席），
  // add/commit 只动 .git（fsnotify 跳过，无 file.changed）——变更面板刷新的
  // 唯一路径 = 服务端 readLoop 嗅探 → git.activity 定向广播（被测特性）
  await typeInSession('git add -A')
  await waitForScrollback(/git add -A/) // 命令已被执行（回显出现）再发下一条
  // 提交信息带 run 级唯一后缀：失败重试时工作区已干净，二次 commit 无摘要行可等
  const msg = `e2e: tui sniff ${Date.now()}`
  await typeInSession(`git commit -m "${msg}"`)

  // 提交摘要行出现于会话输出（摘要/回显共含提交信息；面板断言自带 15s 窗）
  // → 嗅探命中 → 面板秒级跟上
  await waitForScrollback(new RegExp(msg))
  await expect(commitPanel.locator('.cp-empty').filter({ hasText: '没有变更' })).toBeVisible({ timeout: 15000 })
})

test('无头会话 git switch -c → 分支面板拉到新分支', async ({ page }) => {
  test.setTimeout(120000)
  await enterProject(page)

  // 底部面板归一（uiState 跨用例持久，可能处于关闭态）→ git tab（GitBranchesSection 挂载，
  // 启动拉取出现本地 main 基线）
  const panel = page.locator('[data-testid="bottom-panel"]')
  if (!(await panel.isVisible().catch(() => false))) {
    await page.locator('.rail-btn[title="终端"]').click()
  }
  await expect(panel).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="bottom-tab-git"]').click()
  const localHeader = page.locator('.section-header').filter({ hasText: '本地' })
  await expect(localHeader).toBeVisible({ timeout: 10000 })
  // 本地 main 行以 .branch-marker（● 当前分支）锚定，防远程分组 origin/main 同名双命中
  const localMain = page.locator('.branch-item').filter({ has: page.locator('.branch-marker') }).filter({ hasText: 'main' })
  await expect(localMain).toBeVisible({ timeout: 10000 })

  // 无头会话建分支：Switched to a new branch '...' → switch 模式族命中。
  // 分支名带 run 级唯一后缀——失败重试时同名 -c 建分支会报 already exists。
  // 断言锚 .branch-marker（● 当前分支）：切出的新分支即当前分支，且与变更
  // 面板分支下拉的 wt-item 行（同名 displayName）区分防 strict 双命中
  const branch = `${TUI_BRANCH}-${Date.now()}`
  await typeInSession(`git switch -c ${branch}`)
  await waitForScrollback(new RegExp(`Switched to a new branch '${branch}'`))
  await expect(
    page.locator('.branch-item').filter({ has: page.locator('.branch-marker') }).filter({ hasText: branch }),
  ).toBeVisible({ timeout: 15000 })
})

test('项目 WS 订阅面：git.activity 定向广播载荷契约（agent 感知面）', async ({ page }) => {
  test.setTimeout(120000)
  await enterProject(page)

  // 页面内开第二条真实 WebSocket 订阅项目通道（子协议携解锁令牌——agent 用
  // 智能体令牌同形态）。onopen 即 resolve：open ≈ 服务端 101 完成 = hub 注册
  // 完成——必须先注册再触发 switch，否则广播与注册同秒竞速（实测差 ~0.1s
  // 探针就漏收）；消息箱留在页面侧，waitForFunction 轮询消费
  await page.evaluate(({ pid, token }) => {
    return new Promise<void>((resolve, reject) => {
      const w = window as unknown as { __gitActivityMsgs?: Array<{ type?: string; data?: Record<string, unknown> }> }
      w.__gitActivityMsgs = []
      const ws = new WebSocket(`ws://${location.host}/ws/projects/${pid}`, [token])
      ws.onmessage = (ev) => {
        try {
          w.__gitActivityMsgs!.push(JSON.parse(ev.data as string))
        } catch { /* 忽略非 JSON 帧 */ }
      }
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('probe ws handshake failed'))
      setTimeout(() => reject(new Error('probe ws open timeout')), 10000)
    })
  }, { pid: projectId, token: unlockToken })

  // 无头会话新建分支触发 switch 嗅探（-c 建新分支恒打印 Switched to a new
  // branch，与他用例留下的当前分支状态无关；不改工作区文件，无 file.changed 干扰面）。
  // 分支名带 run 级唯一后缀——失败重试时同名 -c 建分支会报 already exists
  const branch = `${WS_BRANCH}-${Date.now()}`
  await typeInSession(`git switch -c ${branch}`)
  await waitForScrollback(new RegExp(`Switched to a new branch '${branch}'`))

  await page.waitForFunction(
    () => (window as unknown as { __gitActivityMsgs?: Array<{ type?: string }> }).__gitActivityMsgs?.some(m => m?.type === 'git.activity'),
    undefined,
    { timeout: 15000 },
  )
  const msgs = await page.evaluate(
    () => (window as unknown as { __gitActivityMsgs?: Array<{ type?: string; data?: Record<string, unknown> }> }).__gitActivityMsgs ?? [],
  )
  const activity = msgs.find(m => m.type === 'git.activity')!
  const data = activity.data as { kind?: string; ref?: string; sessionId?: string; projectId?: string }
  expect(data.kind).toBe('switch')
  expect(data.ref).toBe(branch)
  expect(data.sessionId).toBe(sessionId)
  expect(data.projectId).toBe(projectId)
})
