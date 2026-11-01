import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 冲突委派 agent 会话 E2E（P-20261005-190）：ConflictView 两枚入口（工具条
 * 单文件「交给智能体解决」/ 列表头部「全部交给智能体解决」）经确认弹层发起，
 * 断言 create 请求载荷（launchArgs 即 prompt，ask-selection 同款请求拦截口径）：
 *   1. 单文件：模板可编辑（预填缺省 → 改写生效），载荷含模板行 + 文件定位行 +
 *      场景行（merge 冲突处理中，conflictApi.list 的 inProgress）+ 冲突体节选
 *      （带标记冲突块 + 两侧正文），总额 ≤500 字节（服务端硬上限）
 *   2. 批量（整个冲突集单会话）：载荷含清单头 + 全部文件路径行、无单文件定位行
 *   3. 模板记忆（P-20261008-10）：发起随用随存（服务端 uiState 键级补丁对账）→
 *      重开弹层回填存值 → 恢复默认一键回默认+清存值（重开不复活）
 *   4. 防凝固口径：默认模板发起不播种（i18n 派生文案不落盘）、留空发起是
 *      临时态不动存值（偏好不被临时清空摧毁）
 * 自备临时仓库构造两文件合并冲突，afterEach 清理全部终端会话，afterAll 清理
 * 项目与夹具与模板记忆（uiState.local.conflictAgent 是实例级全局键，不清理会
 * 串扰后续 spec/重跑）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const REPO_BASE = path.join(process.env.TEMP || '/tmp', 'sc-e2e-conflict-delegate')
// 仓库名带进程号：本 spec 会真的拉起 agent 会话（cwd=仓库），运行时进程偶发
// 滞留会让目录句柄悬持——retry 重开 worker（新 pid）时固定名目录必撞 EPERM
// （实测复现），按进程隔离一劳永逸；陈旧目录在 beforeAll 尽力清扫
const REPO_DIR = `${REPO_BASE}-${process.pid}`
const PROJ_NAME = 'conflict-delegate-demo'
const FILES = ['demo-a.txt', 'demo-b.txt']
const DEFAULT_TEMPLATE = '解决冲突并说明两侧取舍理由，完成后保持文件可 stage 状态'
const CUSTOM_TEMPLATE = '逐块合并两侧改动，优先保留业务语义，完成后说明取舍'

function osTmp(): string {
  return process.env.TEMP || '/tmp'
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], {
    cwd, encoding: 'utf8',
  })
}

async function unlockHeaders(request: APIRequestContext) {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话：断言基于「空白会话表」计数，残留会话会污染 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 服务端 uiState 的 local 记录（键级对账用，uistate-multitab 同款口径） */
async function readLocalUIState(request: APIRequestContext): Promise<Record<string, unknown>> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ui-state`, { headers })
  const body = (await res.json()) as { data?: Record<string, Record<string, unknown>> }
  return body.data?.local || {}
}

/** 冲突模板记忆（uiState.local.conflictAgent.template）当前值 */
async function readTemplateMemory(request: APIRequestContext): Promise<string | undefined> {
  const local = await readLocalUIState(request)
  const ns = local.conflictAgent as { template?: string } | undefined
  return ns?.template
}

/** 清冲突模板记忆（幂等）：PATCH 键级补丁归零 conflictAgent 命名空间（单子键
 *  整键替换无剥键风险），await 返回即服务端合并完成——后继弹层 GET 必然读到
 *  已清状态，无在途竞态 */
async function clearTemplateMemory(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.patch(`${BASE}/api/ui-state`, {
    headers, data: { local: { conflictAgent: { template: '' } } },
  })
  if (!res.ok()) throw new Error(`clear template memory failed: ${res.status()}`)
}

/** 捕获 POST /api/terminals（创建会话）请求体：断言 launchArgs 即 prompt 内容 */
function watchAgentCreate(page: Page) {
  const payloads: { kind?: string; dir?: string; launchArgs?: string }[] = []
  page.on('request', (req) => {
    if (req.method() !== 'POST') return
    try {
      if (new URL(req.url()).pathname.endsWith('/api/terminals')) {
        payloads.push(req.postDataJSON() as { kind?: string; dir?: string; launchArgs?: string })
      }
    } catch { /* URL 解析失败非创建请求，忽略 */ }
  })
  return payloads
}

let projectId = ''
let mainEditHash = ''

// 会话 dir 断言统一正斜杠口径：项目注册路径是 forward-slash 形态（本 spec
// 注册时 replace），agent 会话 dir 取项目 store 的注册原样值
function normPath(p: string): string {
  return p.replace(/\\/g, '/')
}

/** 重建两文件合并冲突（幂等：retry 重跑时先回已知态再 merge，conflict-view 同款） */
function seedConflicts() {
  try { git(REPO_DIR, ['merge', '--abort']) } catch { /* 非合并中忽略 */ }
  git(REPO_DIR, ['reset', '--hard', mainEditHash])
  let merged = false
  try {
    git(REPO_DIR, ['merge', 'feature'])
    merged = true
  } catch { /* 冲突即预期：非零退出 */ }
  if (merged) throw new Error('expected merge conflict did not happen')
  const status = git(REPO_DIR, ['status', '--porcelain'])
  if (!status.includes('UU')) throw new Error('expected UU conflict entries, got: ' + status)
}

/** rmSync 轮询重试：服务端对已注册项目目录持有 fsnotify/扫描句柄（Windows
 *  目录句柄未释放时 rmSync EPERM/EBUSY）——删项目后句柄释放有延迟，逐次重试
 *  到释放为止（~5s 上限，超限抛真错误） */
async function rmRepoWithRetry() {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.rmSync(REPO_DIR, { recursive: true, force: true })
      return
    } catch (err) {
      if (attempt >= 15) throw err
      await new Promise(r => setTimeout(r, 300))
    }
  }
}

async function setupRepo() {
  await rmRepoWithRetry()
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false'])
  // base：两分支共同祖先（两个文件各一行可冲突行）
  for (const f of FILES) {
    const tag = f.replace('demo-', '').replace('.txt', '').toUpperCase()
    fs.writeFileSync(path.join(REPO_DIR, f), `line1: base ${tag}\nline2: shared ${tag}\n`)
  }
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'base'])
  // feature：改两个文件的 line2
  git(REPO_DIR, ['checkout', '-b', 'feature'])
  for (const f of FILES) {
    const tag = f.replace('demo-', '').replace('.txt', '').toUpperCase()
    fs.writeFileSync(path.join(REPO_DIR, f), `line1: base ${tag}\nline2: feature changed ${tag}\n`)
  }
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'feature edit'])
  // main：同一行不同改法 → 合并两个文件都冲突
  git(REPO_DIR, ['checkout', 'main'])
  for (const f of FILES) {
    const tag = f.replace('demo-', '').replace('.txt', '').toUpperCase()
    fs.writeFileSync(path.join(REPO_DIR, f), `line1: base ${tag}\nline2: main changed ${tag}\n`)
  }
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'main edit'])
  mainEditHash = git(REPO_DIR, ['rev-parse', 'HEAD']).trim()
  seedConflicts()
}

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const list = await (await request.get(`${BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_NAME) await request.delete(`${BASE}/api/projects/${p.id}`, { headers })
  }
  // 陈旧运行目录尽力清扫（滞留句柄的目录清不掉就留给系统临时目录清理，不阻塞）
  try {
    for (const d of fs.readdirSync(process.env.TEMP || '/tmp')) {
      if (!d.startsWith('sc-e2e-conflict-delegate')) continue
      try { fs.rmSync(path.join(process.env.TEMP || '/tmp', d), { recursive: true, force: true }) } catch { /* 句柄悬持忽略 */ }
    }
  } catch { /* TEMP 不可读忽略 */ }
  // 服务端对旧项目路径的在途 git 巡检（index.lock）与新夹具构建存在小概率
  // 竞态（retry 重开 worker 时实测复现一次）：400ms 落定后重试一次，双败仍抛
  try {
    await setupRepo()
  } catch {
    await new Promise(r => setTimeout(r, 400))
    await setupRepo()
  }

  const created = await request.post(`${BASE}/api/projects`, {
    headers,
    data: { name: PROJ_NAME, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  if (!projectId) throw new Error('project registration failed')
  // 模板记忆是实例级全局键：清掉上次运行/retry 残留，用例起点对齐无存值
  await clearTemplateMemory(request)
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  await clearTemplateMemory(request)
  if (projectId) await request.delete(`${BASE}/api/projects/${projectId}`, { headers })
  // 滞留句柄（cwd 在仓库里的运行时进程）会让 rm 失败：尽力而为不阻塞收尾
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

// 幂等打开冲突面板（conflict-view 同款收敛循环：rail toggle + 横幅点击）
async function openConflictPanel(page: Page) {
  test.setTimeout(90000)
  const banner = page.locator('.conflict-banner')
  const panelTitle = page.getByText('冲突文件', { exact: true })
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await panelTitle.isVisible().catch(() => false)) return
    if (await banner.isVisible().catch(() => false)) {
      await banner.click()
      await expect(panelTitle).toBeVisible({ timeout: 3000 })
      return
    }
    const rail = page.locator('.rail-btn[title="Git 管理"]')
    if ((await rail.getAttribute('aria-expanded').catch(() => null)) !== 'true') {
      await rail.click()
    }
    await page.waitForTimeout(1500)
  }
  await expect(banner).toBeVisible({ timeout: 10000 })
}

async function enterProject(page: Page) {
  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await openConflictPanel(page)
  // 两文件都在清单（批量入口 ≥2 文件才渲染的前提）
  await expect(page.locator('[title="demo-a.txt"]')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('[title="demo-b.txt"]')).toBeVisible({ timeout: 10000 })
}

test('单文件委派：模板可编辑，载荷含模板/文件/场景/冲突体节选 ≤500 字节', async ({ page, request }) => {
  seedConflicts()
  await enterProject(page)
  const payloads = watchAgentCreate(page)

  // 工具条单文件入口（默认选中第一个冲突文件 demo-a.txt）
  await page.locator('[data-test="conflict-agent-btn"]').click()
  const dialog = page.locator('[data-test="conflict-agent-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  // 目标行 = 选中文件 + merge 语境徽标（conflictApi.list 顺带返回的 inProgress）
  await expect(dialog.locator('[data-test="conflict-agent-target"]')).toContainText('demo-a.txt')
  await expect(dialog.locator('[data-test="conflict-agent-target"]')).toContainText('merge')
  // 模板预填缺省 → 改写为自定义（可编辑）
  const templateBox = dialog.locator('[data-test="conflict-agent-template"] textarea')
  await expect(templateBox).toHaveValue(DEFAULT_TEMPLATE)
  await templateBox.fill(CUSTOM_TEMPLATE)
  await dialog.locator('[data-test="conflict-agent-launch"]').click()
  await expect(dialog).toBeHidden({ timeout: 5000 })

  // create 载荷：kind=agent、dir=项目根、launchArgs = 模板行 + 文件行 + 场景行 + 冲突体
  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(1)
  const body = payloads[0]!
  expect(body.kind, '全局 agent 会话').toBe('agent')
  expect(normPath(body.dir || ''), '会话工作目录 = 项目根').toBe(normPath(serverPath(REPO_DIR)))
  const prompt = body.launchArgs || ''
  expect(prompt, '改写后的模板行（首行，会话名派生源）').toContain(CUSTOM_TEMPLATE)
  expect(prompt, '文件定位行（项目相对路径）').toContain('文件：demo-a.txt')
  expect(prompt, '场景行 = inProgress 语境').toContain('场景：merge 冲突处理中')
  expect(prompt, '冲突体节选带标记原文').toContain('<<<<<<<')
  expect(prompt, '我方正文（loadContent 既有数据源）').toContain('main changed A')
  expect(prompt, '他方正文').toContain('feature changed A')
  expect(prompt, '不串到未选中文件的内容').not.toContain('changed B')
  // 服务端按字节计 500 上限（超限直接 400）：载荷组装必须已内建装箱
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(500)

  // docked 管理页出现、恰好一个会话且激活；服务端会话表 dir=项目根
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 15000 })
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string; path?: string }[] }).data || []
  const agents = list.filter(s => s.kind === 'agent')
  expect(agents, '服务端恰好一个 agent 会话').toHaveLength(1)
  expect(normPath(agents[0]!.path || ''), '会话工作目录 = 项目根（正斜杠口径）').toBe(normPath(serverPath(REPO_DIR)))
})

// 模板记忆全链（P-20261008-10）：发起随用随存 → 服务端落盘对账 → 重开回填
// → 恢复默认（回默认+清存值）→ 重开不复活
test('模板记忆：发起随用随存，重开回填存值，恢复默认清存值不复活', async ({ page, request }) => {
  seedConflicts()
  await enterProject(page)
  const payloads = watchAgentCreate(page)

  // 起点无存值（beforeAll 已清，retry 后这里幂等兜底）：打开弹层应回 i18n 默认
  await clearTemplateMemory(request)
  await page.locator('[data-test="conflict-agent-btn"]').click()
  const dialog = page.locator('[data-test="conflict-agent-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  const templateBox = dialog.locator('[data-test="conflict-agent-template"] textarea')
  await expect(templateBox).toHaveValue(DEFAULT_TEMPLATE)

  // 改写发起 → 随用随存：服务端键级对账（真落盘，非仅前端内存），await 返回
  // 即 PATCH 落定，后继重开弹层的 GET 必然读到新值，无在途竞态
  await templateBox.fill(CUSTOM_TEMPLATE)
  await dialog.locator('[data-test="conflict-agent-launch"]').click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  await expect.poll(() => readTemplateMemory(request), { timeout: 10000 }).toBe(CUSTOM_TEMPLATE)

  // 重开弹层 → 存值回填（记忆即默认；打开瞬间先默认后接管，toHaveValue 轮询覆盖窗口）
  await page.locator('[data-test="conflict-agent-btn"]').click()
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(templateBox).toHaveValue(CUSTOM_TEMPLATE, { timeout: 5000 })

  // 恢复默认 → 立即回默认；取消关闭（不走发起链，不写存值）
  await dialog.locator('[data-test="conflict-agent-template-reset"]').click()
  await expect(templateBox).toHaveValue(DEFAULT_TEMPLATE)
  await dialog.locator('.cag-actions button').first().click()
  await expect(dialog).toBeHidden({ timeout: 5000 })

  // 服务端对账存值已清，再重开 → 仍是默认（清存值持久生效，坏存值不复活）
  await expect.poll(() => readTemplateMemory(request), { timeout: 10000 }).toBe('')
  await page.locator('[data-test="conflict-agent-btn"]').click()
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(templateBox).toHaveValue(DEFAULT_TEMPLATE, { timeout: 5000 })
})

// 防凝固口径（P-20261008-10）：i18n 派生的默认文案不播种落盘（语言切换后才不
// 被旧语言默认冒充偏好）；留空发起是临时态，不动已有存值
test('模板记忆防凝固：默认发起不播种，留空发起不动存值', async ({ page, request }) => {
  seedConflicts()
  await enterProject(page)
  const payloads = watchAgentCreate(page)

  await clearTemplateMemory(request)
  // 打开弹层（默认文案）不改直接发起 → 不播种（服务端无 conflictAgent 记忆）
  await page.locator('[data-test="conflict-agent-btn"]').click()
  const dialog = page.locator('[data-test="conflict-agent-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await dialog.locator('[data-test="conflict-agent-launch"]').click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(1)
  await expect.poll(() => readTemplateMemory(request), { timeout: 10000 }).toBe('')

  // 沉淀偏好（存值 = CUSTOM）→ 重开回填后清空再发起（临时只想发结构化上下文）
  await page.locator('[data-test="conflict-agent-btn"]').click()
  await expect(dialog).toBeVisible({ timeout: 5000 })
  const templateBox = dialog.locator('[data-test="conflict-agent-template"] textarea')
  await templateBox.fill(CUSTOM_TEMPLATE)
  await dialog.locator('[data-test="conflict-agent-launch"]').click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  await expect.poll(() => readTemplateMemory(request), { timeout: 10000 }).toBe(CUSTOM_TEMPLATE)
  await page.locator('[data-test="conflict-agent-btn"]').click()
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(templateBox).toHaveValue(CUSTOM_TEMPLATE, { timeout: 5000 })
  await templateBox.fill('')
  await dialog.locator('[data-test="conflict-agent-launch"]').click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(3)

  // 重开 → 偏好仍在（临时清空未摧毁存值）；载荷无模板行但定位/场景行在
  await expect.poll(() => readTemplateMemory(request), { timeout: 10000 }).toBe(CUSTOM_TEMPLATE)
  await page.locator('[data-test="conflict-agent-btn"]').click()
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(templateBox).toHaveValue(CUSTOM_TEMPLATE, { timeout: 5000 })
  expect(payloads[2]!.launchArgs || '', '空模板载荷无模板行').not.toContain(CUSTOM_TEMPLATE)
  expect(payloads[2]!.launchArgs || '', '空模板载荷仍带定位行').toContain('文件：demo-a.txt')
})

test('批量委派：整个冲突集单会话，载荷含完整清单头与文件行', async ({ page }) => {
  seedConflicts()
  await enterProject(page)
  const payloads = watchAgentCreate(page)

  // 列表头部批量入口（≥2 冲突文件才渲染）
  await page.locator('[data-test="conflict-agent-batch-btn"]').click()
  const dialog = page.locator('[data-test="conflict-agent-dialog"]')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(dialog.locator('[data-test="conflict-agent-target"]')).toContainText('2 个冲突文件')
  // 前一用例随用随存的模板记忆会回填（P-20261008-10）：恢复默认归零后再发起
  // （顺带覆盖恢复默认按钮的回默认+清存值行为）
  await dialog.locator('[data-test="conflict-agent-template-reset"]').click()
  const templateBox = dialog.locator('[data-test="conflict-agent-template"] textarea')
  await expect(templateBox).toHaveValue(DEFAULT_TEMPLATE)
  // 模板保持缺省（不改），直接发起
  await dialog.locator('[data-test="conflict-agent-launch"]').click()
  await expect(dialog).toBeHidden({ timeout: 5000 })

  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(1)
  const body = payloads[0]!
  expect(body.kind).toBe('agent')
  expect(normPath(body.dir || ''), '会话工作目录 = 项目根').toBe(normPath(serverPath(REPO_DIR)))
  const prompt = body.launchArgs || ''
  expect(prompt, '缺省模板行（首行）').toContain(DEFAULT_TEMPLATE)
  expect(prompt, '场景行 = inProgress 语境').toContain('场景：merge 冲突处理中')
  expect(prompt, '清单头带数量').toContain('共 2 个冲突文件：')
  expect(prompt, '冲突集全部文件在列').toContain('- demo-a.txt')
  expect(prompt, '冲突集全部文件在列').toContain('- demo-b.txt')
  expect(prompt, '批量语义无单文件定位行').not.toContain('文件：demo-a.txt')
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(500)
})
