import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverIsLinux, serverPath } from '../../tests/dualpath'

/**
 * 外部 tmux 会话接管（P-20261005-189）E2E——tmux 后端 Windows 不可用，本 spec
 * 仅 Linux 服务端形态可跑（WSL 形态 / wsl-e2e 全量；e2e-cross 跨拓扑经 wsl.exe
 * 驱动服务端 tmux）：外部会话住用户默认 socket，与本项目专属 socket（-L
 * simple-coding）隔离——夹具经 tmux 默认 socket 真建会话：
 *   1. 列举 + 接管：UI 新建对话框「接管已有 tmux 会话」选择即接管（origin=
 *      external 落列表，external-sessions 回 takenOver=true）
 *   2. 默认只读：接管会话 pane 输入锁默认开（键入不达），主动解锁后可写
 *   3. close 不杀：DELETE 缺省=解除接管——本系统列表摘除，底层 tmux 会话存活
 *      （可再接管）
 *   4. kill 确认：DELETE ?kill=1 显式终结——tmux has-session 消失
 *   5. 审计留痕（P-20261008-16）：接管→terminal.external.takeover 台账+面板条目，
 *      kill=1→terminal.external.kill 条目，close 普通释放无条目（非破坏性不入账）
 * 环境门控：serverIsLinux（E2E_SERVER_OS=linux 或测试进程自身 Linux）+ 服务端
 * tmux-info available；Windows 形态（金态 :9999/:9993）自动跳过
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

/** 服务端 tmux 驱动：测试进程与服务器可能跨 WSL 边界（e2e-cross 形态）——
 * Windows 侧经 wsl.exe 落到服务端同一默认 distro 的默认 socket；Linux 形态直调 */
const isWin = process.platform === 'win32'
function runTmux(args: string[]): Promise<{ code: number; out: string }> {
  const file = isWin ? 'wsl.exe' : 'tmux'
  const argv = isWin ? ['-e', 'tmux', ...args] : args
  return new Promise((resolve) => {
    execFile(file, argv, { timeout: 15000 }, (err, stdout) => {
      // wsl.exe 的退出码即 tmux 退出码；stderr 仅用于诊断不参与断言
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, out: stdout })
    })
  })
}

let serverTmuxUp = false

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function apiGet(request: APIRequestContext, url: string) {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}${url}`, { headers })
  return { status: res.status(), json: await res.json().catch(() => null) }
}

async function apiDelete(request: APIRequestContext, url: string) {
  const headers = await unlockHeaders(request)
  const res = await request.delete(`${BASE}${url}`, { headers })
  return { status: res.status(), json: await res.json().catch(() => null) }
}

type AuditEvent = { action: string; detail?: string; result: string }

/** 轮询审计台账直至出现匹配动作 + Detail 片段的事件（Append 同步入账，轮询只为
 *  台账读取面留缓冲；terminal-export-audit waitAudit 同款） */
async function waitAudit(
  request: APIRequestContext,
  action: string,
  detailFragment: string,
): Promise<AuditEvent> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const list = await apiGet(request, '/api/audit?limit=500')
    const events = (list.json?.data as AuditEvent[] | undefined) || []
    const hit = events.find(e => e.action === action && (e.detail || '').includes(detailFragment))
    if (hit) return hit
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`${action} audit with detail ~ "${detailFragment}" never appeared within 15s`)
}

/** 无条目断言：审计 Append 在 handler 内同步落账（响应返回时已定局），两次间隔
 *  读取均无匹配即如实判「不入账」——防偶发乱序的冗余复查而非等待竞态收敛 */
async function expectNoAudit(request: APIRequestContext, action: string, detailFragment: string) {
  for (let i = 0; i < 2; i++) {
    const list = await apiGet(request, '/api/audit?limit=500')
    const events = (list.json?.data as AuditEvent[] | undefined) || []
    const hit = events.find(e => e.action === action && (e.detail || '').includes(detailFragment))
    expect(hit, `${action} must not be audited for "${detailFragment}" (close release is non-destructive)`).toBeFalsy()
    if (i === 0) await new Promise(r => setTimeout(r, 1000))
  }
}

/** 清理全部终端会话（外部会话缺省 close=解除接管，tmux 会话体由 afterAll 收尾） */
async function cleanupSessions(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

test.beforeAll(async ({ request }) => {
  test.skip(!serverIsLinux, 'tmux 域 spec 仅 Linux 服务端形态可跑（Windows 金态跳过）')
  const info = await apiGet(request, '/api/terminals/tmux-info')
  serverTmuxUp = !!info.json?.data?.available
  test.skip(!serverTmuxUp, '服务端 tmux 不可用（未安装/版本过低），跳过')
})

const fixtureNames: string[] = []
function makeFixtureName(): string {
  const name = `sc-e2e-ext-${Date.now()}-${Math.floor(Math.random() * 1000)}`
  fixtureNames.push(name)
  return name
}

// 全新实例首页无 rail（项目空态）：注册本仓库为项目拿「项目页 → rail → 终端
// 会话管理」入口（金态实例已播种 simple-coding，本 spec 自带注册对两种形态都成立）
const PROJECT_NAME = 'sc-ext-e2e'
/** 幂等注册本仓库为项目，返回实际可用的项目名（路径已被其他名注册时复用该名——
 *  服务端按路径去重，同路径异名 add 会 "project path already added"） */
async function ensureProject(request: APIRequestContext): Promise<string> {
  // 翻译拆两步声明：payload 行内保持 serverPath(...)/.server 可见形态（dualpath
  // 门禁为行级静态对账，翻译必须在交服务端的那一行可见——repoPath 变量名入
  // absVars 集的连写写法会被判未翻译）
  const repoAbs = path.resolve(process.cwd(), '..')
  const repoPath = serverPath(repoAbs)
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { name: string; path: string }[] }).data || []
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const byPath = list.find(p => norm(p.path) === norm(serverPath(repoPath)))
  if (byPath) return byPath.name
  await request.post(`${BASE}/api/projects`, {
    data: { name: PROJECT_NAME, path: serverPath(repoAbs) }, headers,
  })
  const res2 = await request.get(`${BASE}/api/projects`, { headers })
  const list2 = ((await res2.json()) as { data?: { name: string }[] }).data || []
  if (!list2.some(p => p.name === PROJECT_NAME)) {
    throw new Error(`project ${PROJECT_NAME} registration failed (path=${serverPath(repoPath)})`)
  }
  return PROJECT_NAME
}

test.afterAll(async () => {
  for (const name of fixtureNames) {
    await runTmux(['kill-session', '-t', name])
  }
})

test.beforeEach(async ({ request }) => {
  if (!serverTmuxUp) return
  await cleanupSessions(request)
})

/** 建外部 tmux 会话夹具（默认 socket）并回显一个可在 pane 中断言的标记 */
async function createExternalFixture(): Promise<string> {
  const name = makeFixtureName()
  const created = await runTmux(['new-session', '-d', '-s', name, '-x', '100', '-y', '30'])
  expect(created.code, `tmux new-session failed: ${name}`).toBe(0)
  await runTmux(['send-keys', '-t', name, `echo EXT-MARK-${name}`, 'Enter'])
  return name
}

/** 打开管理页并选中外接管会话（API 接管后经列表刷新进入侧栏）。
 *  全新实例需先注册项目（首页空态无 rail），经项目页 rail 进管理页 */
async function openManagerAndSelect(page: Page, request: APIRequestContext, sessionId: string) {
  const projectName = await ensureProject(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, projectName).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  const item = view.locator('.ats-item').filter({ hasText: sessionId })
  await expect(item).toBeVisible({ timeout: 15000 })
  await item.click()
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  return xterm
}

test('列举 + UI 接管：新建对话框选择即接管，origin=external 落列表', async ({ page, request }) => {
  test.setTimeout(120000)
  const name = await createExternalFixture()

  // 列举端点：外部会话在列（未被接管）
  const list1 = await apiGet(request, '/api/terminals/external-sessions')
  expect(list1.status).toBe(200)
  const found = (list1.json?.data || []).find((s: { name: string }) => s.name === name)
  expect(found, `external session ${name} not listed`).toBeTruthy()
  expect(found.takenOver).toBe(false)

  // UI：新建对话框 → 接管折叠区 → 选择即接管（经项目页 rail 进管理页）
  const projectName = await ensureProject(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, projectName).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.getByRole('button', { name: '新建会话' }).first().click()
  const dlg = page.locator('.n-modal')
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('.n-collapse-item__header').filter({ hasText: '接管已有 tmux 会话' }).click()
  const select = dlg.locator('[data-testid="agent-takeover-select"]')
  await expect(select).toBeVisible({ timeout: 10000 })
  await select.click()
  await page.locator('.n-base-select-option').filter({ hasText: name }).click()
  // 选择即接管：弹层关闭 + 侧栏出现接管会话
  await expect(dlg).toBeHidden({ timeout: 15000 })
  const item = view.locator('.ats-item').filter({ hasText: name })
  await expect(item).toBeVisible({ timeout: 15000 })

  // 列表契约：origin=external；external-sessions 回 takenOver=true
  const terms = await apiGet(request, '/api/terminals')
  const session = (terms.json?.data || []).find((s: { id: string }) => s.id === name)
  expect(session?.origin).toBe('external')
  expect(session?.kind).toBe('agent')
  const list2 = await apiGet(request, '/api/terminals/external-sessions')
  const found2 = (list2.json?.data || []).find((s: { name: string }) => s.name === name)
  expect(found2?.takenOver).toBe(true)

  // 接管 pane 可围观外部会话内容（send-keys 的回显经 capture-pane 重放到达）
  await item.click()
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText(`EXT-MARK-${name}`, { timeout: 20000 })
})

test('默认只读：接管会话 pane 输入锁默认开，解锁后键入到达', async ({ page, request }) => {
  test.setTimeout(180000)
  const name = await createExternalFixture()
  const taken = await request.post(`${BASE}/api/terminals`, {
    data: { attachTmux: name },
    headers: await unlockHeaders(request),
  })
  expect(taken.status()).toBe(200)

  const xterm = await openManagerAndSelect(page, request, name)
  // 默认锁定：描边在位（用户未做任何解锁动作）——默认只读接管的判据
  await expect(page.locator('.term-container.is-input-locked')).toHaveCount(1, { timeout: 10000 })
  await expect(page.locator('[data-testid="term-pane-input-lock"]:visible')).toHaveClass(/is-locked/)

  // 锁定期键入不达（tmux 会话内无回显）
  const lockedMarker = `SC-EXT-LOCKED-${Date.now()}`
  await xterm.click()
  await page.keyboard.type(`echo ${lockedMarker}\r`)
  await page.waitForTimeout(2500)
  await expect(xterm).not.toContainText(lockedMarker)

  // 主动解锁 → 键入到达外部会话（bash 回显标记；点击 xterm 取回焦点——
  // 点锁按钮后焦点在按钮上，键入不进终端）
  await page.locator('[data-testid="term-pane-input-lock"]:visible').click()
  await expect(page.locator('.term-container.is-input-locked')).toHaveCount(0)
  await xterm.click()
  const marker = `SC-EXT-TYPED-${Date.now()}`
  await page.keyboard.type(`echo ${marker}\r`)
  await expect(xterm).toContainText(marker, { timeout: 15000 })
})

test('close 不杀：DELETE 缺省=解除接管，tmux 会话存活可再接管', async ({ request }) => {
  test.setTimeout(60000)
  const name = await createExternalFixture()
  const taken = await request.post(`${BASE}/api/terminals`, {
    data: { attachTmux: name },
    headers: await unlockHeaders(request),
  })
  expect(taken.status()).toBe(200)

  // 关闭（缺省）：会话从本系统列表摘除
  const closed = await apiDelete(request, `/api/terminals/${name}`)
  expect(closed.status).toBe(200)
  const terms = await apiGet(request, '/api/terminals')
  expect((terms.json?.data || []).find((s: { id: string }) => s.id === name)).toBeFalsy()

  // 底层 tmux 会话原样存活（close≠kill 的核心断言）
  const alive = await runTmux(['has-session', '-t', name])
  expect(alive.code).toBe(0)

  // 可再接管（解除后二次 attach 语义闭环）
  const retaken = await request.post(`${BASE}/api/terminals`, {
    data: { attachTmux: name },
    headers: await unlockHeaders(request),
  })
  expect(retaken.status()).toBe(200)
})

test('kill 确认：DELETE ?kill=1 显式终结，tmux 会话消失', async ({ request }) => {
  test.setTimeout(60000)
  const name = await createExternalFixture()
  const taken = await request.post(`${BASE}/api/terminals`, {
    data: { attachTmux: name },
    headers: await unlockHeaders(request),
  })
  expect(taken.status()).toBe(200)

  const killed = await apiDelete(request, `/api/terminals/${name}?kill=1`)
  expect(killed.status).toBe(200)
  const terms = await apiGet(request, '/api/terminals')
  expect((terms.json?.data || []).find((s: { id: string }) => s.id === name)).toBeFalsy()

  // kill-session 落在默认 socket：会话真没了（与 close 不杀形成对照）
  const alive = await runTmux(['has-session', '-t', name])
  expect(alive.code).not.toBe(0)
})

test('审计留痕：接管/显式终结入账，close 普通释放无条目', async ({ page, request }) => {
  test.setTimeout(120000)
  const name = await createExternalFixture()

  // 接管 → 台账 terminal.external.takeover（Detail 携 tmux 会话名稳定锚点）
  const taken = await request.post(`${BASE}/api/terminals`, {
    data: { attachTmux: name },
    headers: await unlockHeaders(request),
  })
  expect(taken.status()).toBe(200)
  const ev = await waitAudit(request, 'terminal.external.takeover', `tmux=${name}`)
  expect(ev.result).toBe('success')
  expect(ev.detail).toContain(`name=${name}`)

  // close 普通分流=解除接管（非破坏性）：无 kill 条目——审计分流的核心断言
  const closed = await apiDelete(request, `/api/terminals/${name}`)
  expect(closed.status).toBe(200)
  await expectNoAudit(request, 'terminal.external.kill', name)
  const alive = await runTmux(['has-session', '-t', name])
  expect(alive.code).toBe(0)

  // 再接管 → kill=1 显式终结 → 台账 terminal.external.kill
  const retaken = await request.post(`${BASE}/api/terminals`, {
    data: { attachTmux: name },
    headers: await unlockHeaders(request),
  })
  expect(retaken.status()).toBe(200)
  const killed = await apiDelete(request, `/api/terminals/${name}?kill=1`)
  expect(killed.status).toBe(200)
  const kev = await waitAudit(request, 'terminal.external.kill', `tmux=${name}`)
  expect(kev.result).toBe('success')
  expect(kev.detail).toContain(`name=${name}`)

  // 审计面板自然可见：设置·安全·审计日志，两动作行（i18n 词条接通——未知动作
  // 会回退原始串，词条断言连带守住 actionLabel 映射）
  const projectName = await ensureProject(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, projectName).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审计日志' }).click()
  await expect(page.getByTestId('audit-pane')).toBeVisible({ timeout: 5000 })
  const takeoverRow = page
    .locator('[data-testid="audit-pane"] .n-data-table-tr')
    .filter({ hasText: '接管外部 tmux 会话' })
    .filter({ hasText: name })
  await expect(takeoverRow.first()).toBeVisible({ timeout: 5000 })
  const killRow = page
    .locator('[data-testid="audit-pane"] .n-data-table-tr')
    .filter({ hasText: '终结外部 tmux 会话' })
    .filter({ hasText: name })
  await expect(killRow.first()).toBeVisible({ timeout: 5000 })
})
