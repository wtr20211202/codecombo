import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端 shell 选择 E2E（P-20261004-57）：
 * - 候选探测：GET /api/terminals/shell-candidates 返回 platform/candidates/
 *   defaultShell，且 defaultShell 与「不带 shell 新建会话」的落点一致（缺省
 *   不回归——存量硬编码序行为零变化）。
 * - 设置链路：PUT terminalDefaultShell（不存在路径 400 + 稳定标记原文；有效
 *   值保存回读；空串清除回落）→ 新建纯终端会话跟随设置（响应 data.shell）。
 * - 会话级覆盖优先于设置：显式 shell 压过 terminalDefaultShell；agent 运行时
 *   会话忽略覆盖（claude 未安装环境跳过该档）。
 * - OSC133 注入 bash 形态：shell=bash 的纯终端会话经 --rcfile 注入 bash.sh，
 *   首个 prompt 即发 OSC 133 序列（scrollback 可见），且 `echo $BASH_VERSION`
 *   展开出 `<n>(1)-release` 形态——pwsh 会话同命令打印空行，形态判别成立。
 * - UI 入口：设置·终端「默认 Shell」下拉（候选来自服务端探测，选择保存落
 *   盘）；会话创建对话框纯终端形态高级折叠区「Shell」选择（创建请求携 shell）。
 *
 * 实例为 Windows native 后端（本域用例同 topology 约定）；bash 形态断言依赖
 * 候选清单里的 bash 可用（LookPath 探测），不可用环境 skip。
 */

const BASE = API_BASE

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function setSettings(request: APIRequestContext, patch: Record<string, unknown>): Promise<number> {
  const res = await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: patch,
  })
  return res.status()
}

async function readSetting(request: APIRequestContext, key: string): Promise<unknown> {
  const res = await request.get(`${BASE}/api/settings`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: Record<string, unknown> }).data?.[key]
}

interface ShellCandidate { name: string; path: string; available: boolean }
interface ShellCandidatesData {
  platform: string
  settingShell: string
  defaultShell: string
  candidates: ShellCandidate[]
}

async function getShellCandidates(request: APIRequestContext): Promise<ShellCandidatesData> {
  const res = await request.get(`${BASE}/api/terminals/shell-candidates`, { headers: await unlockHeaders(request) })
  expect(res.status()).toBe(200)
  return ((await res.json()) as { data?: ShellCandidatesData }).data!
}

async function createSession(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<{ status: number; id?: string; shell?: string; body: string }> {
  const res = await request.post(`${BASE}/api/terminals`, {
    headers: await unlockHeaders(request),
    data: body,
  })
  const text = await res.text()
  let data: { id?: string; shell?: string } = {}
  try { data = (JSON.parse(text) as { data?: { id?: string; shell?: string } }).data || {} } catch { /* 400 等非 data 形态 */ }
  return { status: res.status(), id: data.id, shell: data.shell, body: text }
}

async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 轮询 scrollback 直到正则命中（bash 集成注入是异步链：PTY 起进程 → rcfile
 *  source → 首个 prompt 触发 PROMPT_COMMAND 输出 OSC 133） */
async function waitForScrollback(
  request: APIRequestContext,
  sessionId: string,
  pattern: RegExp,
  message: string,
): Promise<string> {
  const headers = await unlockHeaders(request)
  let last = ''
  await expect.poll(async () => {
    const res = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
    last = (await res.body()).toString('utf-8')
    return pattern.test(last) ? 'hit' : ''
  }, { timeout: 20000, message }).toBe('hit')
  return last
}

test.describe('终端 shell 选择（P-20261004-57）', () => {
  let bashCandidate: ShellCandidate | undefined

  test.afterEach(async ({ request }) => {
    // 设置先清（防残留影响其他 spec 的会话创建），再清会话
    await setSettings(request, { terminalDefaultShell: '' })
    await cleanupTerminals(request)
  })

  test('候选探测 + 缺省不回归：无 shell 新建会话落点与 defaultShell 一致', async ({ request }) => {
    const data = await getShellCandidates(request)
    expect(data.platform).toBeTruthy()
    expect(data.settingShell).toBe('')
    expect(data.defaultShell).toBeTruthy()
    expect(data.candidates.length).toBeGreaterThan(0)
    // 平台缺省必须在可用候选之列（探测面完整性）
    const defaultResolved = data.candidates.find(
      c => c.available && (c.path === data.defaultShell || c.name === data.defaultShell),
    )
    expect(defaultResolved, `defaultShell ${data.defaultShell} 应在可用候选中`).toBeTruthy()

    const created = await createSession(request, { kind: 'agent', name: 'shell-default-probe', runtime: 'shell' })
    expect(created.status).toBe(200)
    // 缺省不回归锚点：不携 shell 的新会话 = 历史硬编码序的解析结果
    expect(created.shell).toBe(data.defaultShell)
  })

  test('设置链路：不存在路径 400 + 有效值保存回读 + 新会话跟随设置', async ({ request }) => {
    // 不存在的自定义路径 → 400 + 稳定标记原文（写入面早反馈）
    const bad = await createSession(request, { kind: 'agent', name: 'x', runtime: 'shell', shell: 'no-such-shell-e2e-xyz' })
    expect(bad.status).toBe(400)
    expect(bad.body).toContain('shell not found')

    const data = await getShellCandidates(request)
    // 用平台缺省自身作为设置值（一定存在，且与覆盖档用同一候选池）
    const setting = data.defaultShell
    expect(await setSettings(request, { terminalDefaultShell: setting })).toBe(200)
    expect(await readSetting(request, 'terminalDefaultShell')).toBe(setting)

    // 跟随设置：不带 shell 的新会话 = 设置值
    const created = await createSession(request, { kind: 'agent', name: 'shell-follow-setting', runtime: 'shell' })
    expect(created.status).toBe(200)
    expect(created.shell).toBe(setting)

    // 候选端点同面回读（settingShell/defaultShell 一并下发）
    const after = await getShellCandidates(request)
    expect(after.settingShell).toBe(setting)
    expect(after.defaultShell).toBe(setting)

    // 空串清除 → 回落平台缺省
    expect(await setSettings(request, { terminalDefaultShell: '' })).toBe(200)
    expect(await readSetting(request, 'terminalDefaultShell')).toBe('')
    const cleared = await createSession(request, { kind: 'agent', name: 'shell-after-clear', runtime: 'shell' })
    expect(cleared.shell).toBe(data.defaultShell)
  })

  test('会话级覆盖优先于设置；项目会话同链生效', async ({ request }) => {
    const data = await getShellCandidates(request)
    const override = data.candidates.find(c => c.available && c.path !== data.defaultShell)
      || data.candidates.find(c => c.available && c.path !== undefined)
    expect(override, '至少一个可用候选作覆盖值').toBeTruthy()

    // 设置指向 A，会话显式指 B → B（覆盖压过设置）
    expect(await setSettings(request, { terminalDefaultShell: data.defaultShell })).toBe(200)
    const created = await createSession(request, {
      kind: 'agent', name: 'shell-override-wins', runtime: 'shell', shell: override!.path,
    })
    expect(created.status).toBe(200)
    expect(created.shell).toBe(override!.path)

    // 项目会话（kind=shell）同链透传：需要真实项目——FRESH 数据面由播种器建
    // simple-coding 项目卡；直接取项目列表第一个
    const res = await request.get(`${BASE}/api/projects`, { headers: await unlockHeaders(request) })
    const projects = ((await res.json()) as { data?: { id: string }[] }).data || []
    test.skip(projects.length === 0, '实例无项目（播种缺失），项目会话档跳过')
    const proj = await createSession(request, {
      projectId: projects[0]!.id, name: 'shell-project-ovr', shell: override!.path,
    })
    expect(proj.status).toBe(200)
    expect(proj.shell).toBe(override!.path)
  })

  test('OSC133 注入 bash 形态：设置默认后新会话 rcfile 链生效 + BASH_VERSION 展开判别', async ({ request }) => {
    const data = await getShellCandidates(request)
    bashCandidate = data.candidates.find(c => c.name === 'bash' && c.available)
    test.skip(!bashCandidate, '本机候选探测无可用 bash（LookPath 未命中），形态断言跳过')

    // 提案口径「设置 git-bash → 新纯终端会话」：设置默认后不带 shell 创建
    expect(await setSettings(request, { terminalDefaultShell: bashCandidate!.path })).toBe(200)
    const created = await createSession(request, { kind: 'agent', name: 'shell-bash-form', runtime: 'shell' })
    expect(created.status).toBe(200)
    expect(created.shell).toBe(bashCandidate!.path)

    // bash.sh 经 --rcfile 注入：首个 prompt 即输出 OSC 133（A/D 序列落 scrollback）
    await waitForScrollback(request, created.id!, /\x1b\]133;[AD]/, 'bash 会话 scrollback 应出现 OSC 133 序列（shell 集成注入）')

    // 形态判别：bash 展开 $BASH_VERSION 出 `<n>(1)-release`；pwsh 同命令打空行
    //（typed 命令回显只含字面量，不会命中该正则）
    const wr = await request.post(`${BASE}/api/terminals/broadcast-write`, {
      headers: await unlockHeaders(request),
      data: { ids: [created.id], data: 'echo $BASH_VERSION\r' },
    })
    expect(wr.status()).toBe(200)
    await waitForScrollback(request, created.id!, /\d+\.\d+\.\d+\(\d+\)-release/, 'bash 会话应展开 BASH_VERSION（bash 形态判别）')
  })

  test('UI：设置·终端「默认 Shell」下拉选择保存落盘', async ({ page, request }) => {
    const data = await getShellCandidates(request)
    const pick = data.candidates.find(c => c.available)
    test.skip(!pick, '无可用候选（理论不可达：defaultShell 恒可用），跳过')

    await fixedLocale(page)
    await gotoAndUnlock(page, `${BASE}/`)
    // rail-settings 挂在项目页活动栏（settings-remember-tab 同款导航）
    await page.locator('.project-card').first().click()
    await page.waitForURL('**/project')
    await page.locator('[data-testid="rail-settings"]').click()
    await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
    await page.locator('.settings-nav .nav-item').filter({ hasText: '终端' }).click()
    const pane = page.locator('[data-testid="settings-pane-terminal"]')

    const select = pane.locator('[data-testid="settings-terminal-default-shell"]')
    await expect(select).toBeVisible()
    // 缺省档带当前生效值预览（可发现性）
    await expect(select.locator('.n-base-selection-label')).toContainText('跟随平台默认')

    // 选候选 → 保存 → API 侧落盘对账（设置弹窗保存走 PUT /settings）。
    // 注意不能用 hasText: name 裸匹配——「跟随平台默认（当前 …<defaultPath>）」
    // 的预览段会含候选名，.first() 会误点跟随档（实测踩坑）；候选行唯一形
    // 态是 `name · path`
    await select.click()
    await page.locator('.n-base-select-option').filter({ hasText: `${pick!.name} · ` }).first().click()
    await page.locator('.settings-footer button').filter({ hasText: '保存' }).click()
    await expect.poll(async () => readSetting(request, 'terminalDefaultShell'), {
      timeout: 5000,
      message: 'terminalDefaultShell 应随设置页保存落盘',
    }).toBe(pick!.path)
  })

  test('UI：纯终端会话高级折叠区选择 shell，创建请求携带', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${BASE}/`)
    // 项目卡进项目页 → 活动栏终端会话管理
    await page.locator('.project-card').first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })

    // 新建会话 → 运行时切纯终端 → 高级折叠区出现
    await page.locator('.ats-new').filter({ hasText: '新建会话' }).click()
    const dialog = page.locator('.n-modal').filter({ hasText: '新建智能体会话' })
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(dialog.locator('.n-collapse')).toHaveCount(0) // 非 shell 运行时无折叠区
    // 运行时下拉按 testid 定位：对话框首个 .n-select 可能是「目标实例」选择器
    // （P-04-101，注册实例 >1 即出现，种子含 wsl-server——曾是本用例误点源）
    await dialog.locator('[data-testid="agent-runtime-select"]').click()
    await page.locator('.n-base-select-option').filter({ hasText: '纯终端' }).first().click()
    const collapse = dialog.locator('.n-collapse')
    await expect(collapse).toBeVisible()

    // 展开折叠区（惰性拉候选）→ 选「跟随设置」外的可用候选
    await collapse.locator('.n-collapse-item__header').click()
    const shellSelect = dialog.locator('[data-testid="agent-shell-select"]')
    await expect(shellSelect).toBeVisible()
    await expect(shellSelect.locator('.n-base-selection-label')).toContainText('跟随设置（当前')
    await shellSelect.click()
    // 候选行形如 `pwsh · C:\...`（path 存在才可选），点第一个未禁用项
    const option = page.locator('.n-base-select-option').filter({ hasText: ' · ' }).first()
    await option.click()
    const picked = (await option.textContent()) || ''

    // 创建请求断言：POST /api/terminals 携带所选 shell
    const respPromise = page.waitForResponse(
      r => r.url().includes('/api/terminals') && r.request().method() === 'POST',
    )
    await dialog.locator('button').filter({ hasText: '创建' }).click()
    const resp = await respPromise
    const payload = resp.request().postDataJSON() as { shell?: string; runtime?: string }
    expect(payload.runtime).toBe('shell')
    expect(payload.shell, `创建请求应携带所选 shell（选中 ${picked.trim()}）`).toBeTruthy()
    expect((payload.shell || '').length).toBeGreaterThan(0)
    const respBody = (await resp.json()) as { data?: { shell?: string } }
    expect(respBody.data?.shell).toBe(payload.shell)
  })
})
