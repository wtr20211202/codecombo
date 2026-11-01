import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 值班大屏「交接班摘要」E2E（P-20261003-8）：
 *   1. 完整链路：项目终端跑长命令（OSC 133 C → 运行态）→ API 播种 pending
 *      审批 → 大屏一键生成 → 剪贴板摘要含运行中会话与 pending 数/审批行
 *      （SPA 内路由跳转：整页 goto 会重载丢内存 runningMap，必须走应用内导航）
 *   2. 机群空闲：摘要仍可生成（水位全零 + 清单空态），复制闭环不依赖值守事实
 * 前置（spec 内自备）：临时空项目（终端对项目路径无 git 要求）；审批/终端
 * 全局清账防残留（同 monitor-dashboard 口径）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-shift-summary'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-shift-summary')
// 长命令按服务端 shell 分支：点亮运行态只需 C 帧在账，语义两平台等价（90s 内自终）
const SLEEP_CMD = serverIsLinux ? 'sleep 90' : 'Start-Sleep -Seconds 90'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（Windows ConPTY 死会话不从会话表自移除，防僵尸累积） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers }).catch(() => {})
  }
}

/** 清理 pending 审批（审批全局广播，残留会污染后续用例的摘要计数） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    }).catch(() => {})
  }
}

/** 播种底部终端面板开合（uiState 服务端持久，跨 spec 残留不定态；CLAUDE.md
 *  「uiState 播种时机：种子须在无项目页存活时写入」惯例）：前序 spec 留下的
 *  收起/他分区态会在本页 boot 恢复时把 openFreshTerminal 归一化后的面板再翻走
 *  （实测新建后 .xterm 持续不可见）。页面加载前 GET+合并整键 PATCH 成终端分区
 *  打开，恢复直接落在目标态——layout 是顶层键整体替换，裸发两字段会把面板
 *  宽高等既有布局抹成默认 */
async function seedTerminalPanelOpen(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const stateRes = await request.get(`${BASE}/api/ui-state`, { headers })
  const body = (await stateRes.json().catch(() => null)) as { data?: Record<string, { layout?: Record<string, unknown> }> } | null
  const layout = { ...(body?.data?.local?.layout || {}), showBottomPanel: true, bottomTab: 'terminal' }
  await request.patch(`${BASE}/api/ui-state`, { headers, data: { local: { layout } } }).catch(() => { /* 尽力播种：失败回退 openFreshTerminal 归一化 */ })
}

test.beforeEach(async ({ request }) => {
  // 用例间全局清账：用例 1 遗留的运行会话/pending 审批不再污染用例 2 的
  // 「机群空闲」空态断言（同 monitor-dashboard 的 beforeEach/afterEach 口径）
  await cleanupTerminals(request)
  await cleanupApprovals(request)
})

let pid = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await request.get(`${BASE}/api/projects`, { headers })
  const oldProj = ((await stale.json()) as { data?: { id: string; name: string }[] }).data
    ?.find(p => p.name === PROJ_NAME)
  if (oldProj) await request.delete(`${BASE}/api/projects/${oldProj.id}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  const proj = await request.post(`${BASE}/api/projects`, {
    headers, data: { name: PROJ_NAME, path: serverPath(REPO_DIR) },
  })
  expect([200, 201]).toContain(proj.status())
  pid = ((await proj.json()) as { data?: { id: string } }).data?.id || ''
})

test.afterAll(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovals(request)
  const headers = await unlockHeaders(request)
  const list = await request.get(`${BASE}/api/projects`, { headers })
  const mine = ((await list.json()) as { data?: { id: string; name: string }[] }).data
    ?.find(p => p.name === PROJ_NAME)
  if (mine) await request.delete(`${BASE}/api/projects/${mine.id}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

/** 从首页进临时项目页（复用 home 卡片入口，经 gotoAndUnlock 统一解锁前置） */
async function enterProject(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
}

/** 底部面板开新终端（同 terminal-copy-last-output 的 uiState 幂等口径）。
 *  request 用于读服务端会话数：tab/xterm 渲染在 ConPTY 慢时滞后点击 1.5s+，
 *  以渲染态做重击守卫会把「首击已建会话、渲染未跟上」误判为未建而再击，
 *  双建出两个会话（大屏会话卡 2≠1）；服务端 POST 落地即计数，是唯一事实源 */
async function openFreshTerminal(page: Page, request: APIRequestContext) {
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  const panel = page.locator('.bottom-panel')
  const ensureOpen = async () => {
    if (!(await panel.isVisible().catch(() => false))) {
      await page.locator('.rail-btn[title="终端"]').click()
    }
    await expect(panel).toBeVisible({ timeout: 5000 })
  }
  await ensureOpen()
  // 清 uiState 恢复的历史 tab
  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
  await ensureOpen()
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    // uiState 恢复的 bottomTab 可能不是终端：等 tab 真正激活再找新建按钮（固定
    // 300ms 下按钮仍是旧 tab 的重渲染中间态，点击会落空）
    await expect(page.locator('.bottom-tabs button').filter({ hasText: '终端' })).toHaveClass(/primary/, { timeout: 5000 })
  }
  // 服务端会话数（POST 落地即计数）：tab/xterm 渲染在 ConPTY 慢时滞后点击
  // 1.5s+，以渲染态做重击守卫会把「首击已建会话、渲染未跟上」误判为未建
  const sessionsCount = async (): Promise<number> => {
    try {
      const res = await request.get(`${BASE}/api/terminals`)
      return (((await res.json()) as { data?: unknown[] }).data || []).length
    } catch { return 0 }
  }
  // 项目切换的异步布局应用可能在上面步骤之间把面板收起（新项目无持久化
  // 布局，apply 默认收起）：点新建前重验一次，收起则重开（幂等，同
  // terminal-copy-last-output 的 openFreshTerminal 惯例）
  await ensureOpen()
  // 基数先于点击采样：POST 落地极快，点击后再采会把首击会话算进基数，
  // 守卫误判「未建」而再击双建（实测 2≠1 复盘）
  const before = await sessionsCount()
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部
  const xterm = page.locator('.xterm:visible').last()
  // 会话恢复与新按钮重渲染竞态：点击可能落在旧按钮挂载上而未建终端——
  // 轮询兜底只认服务端会话数：点击的 POST 落地即 +1（与 tab/xterm 渲染时序
  // 无关）。Linux tmux 实例冷启动时单次 POST（new-session）可达 8s+，按固定
  // 短等待轮询会把「POST 在途未返回」误判为未建而再击双建（实测 0→2→4 复
  // 盘）——先等创建 POST 的响应（12s 上限），响应到达就绝不再击；仅在请求
  // 根本没发出（点击丢失）时才补击一次
  let postSeen = false
  try {
    await page.waitForResponse(
      (r) => r.url().includes('/api/terminals') && r.request().method() === 'POST',
      { timeout: 12000 },
    )
    postSeen = true
  } catch { /* 12s 无 POST 响应 = 点击未生效 */ }
  {
    const deadline = Date.now() + 5000
    while ((await sessionsCount()) <= before && Date.now() < deadline) {
      await page.waitForTimeout(300)
    }
    if ((await sessionsCount()) <= before && !postSeen) {
      if (await newBtn.isVisible().catch(() => false)) await newBtn.click().catch(() => { /* 重渲染瞬断 */ })
    }
  }
  await expect(xterm).toBeVisible({ timeout: 20000 })
  // 提示符按服务端 shell 分支：Windows 默认 PowerShell（PS ...）；
  // Linux bash 提示符以 $（普通用户）或 #（root，如 WSL 实例）收尾
  await expect(xterm).toContainText(serverIsLinux ? /[#$] / : 'PS ', { timeout: 20000 })
  return xterm
}

test('大屏一键生成交接班摘要：剪贴板含运行中会话与 pending 数', async ({ page, request }) => {
  // Linux 服务端（tmux 后端）保留守卫：OSC 133 消费族本体已打通（C/D 帧产出、
  // 运行态事件、面板计数均实测通过，P-20261004-82），但新挂载 pane 的首段键入
  // 存在首字节/首字符丢失（`sleep 90` 实到 bash 为残缺命令即退，运行态点不亮，
  // 与 terminal-history-snippet 的面板插入首字节丢失同族），属终端输入完整性
  // 缺陷，修复后删除本守卫。下方理由串的 P-20261004-82 系缺口登记出处（守卫
  // 解除时实证），非修复提案——修复提案落地后以其号替换并解除守卫（缺口类
  // skip 须引用提案号：check-e2e-conventions，见 CLAUDE.md「测试」节）
  test.skip(serverIsLinux, 'Linux tmux 新 pane 首段键入丢字符（终端输入完整性缺陷，独立提案跟进——P-20261004-82 实证登记），跳过')
  test.setTimeout(120000)
  const headers = await unlockHeaders(request)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await seedTerminalPanelOpen(request)
  await enterProject(page)
  const xterm = await openFreshTerminal(page, request)

  // 跑长命令：OSC 133 C 入账 → 会话进入运行态（store 内存跨路由保留）
  await xterm.click()
  await page.keyboard.type(SLEEP_CMD + '\r')
  // C 帧与命令回显同一 WS 流：回显落屏后 1.5s 富余即已入账
  await page.waitForTimeout(1500)

  // SPA 内导航回大屏：TopBar 返回首页 → 首页头部「值班大屏」入口
  await page.locator('.ide-header button[title="返回首页"]').click()
  await expect(page).toHaveURL(/\/$/)
  const entry = page.locator('.home-action-btn[title="值班大屏"]')
  await expect(entry).toBeVisible()
  await entry.click()
  await page.waitForURL('**/monitor')

  // 会话卡运行中（runningMap 驱动，坐实「运行中会话」聚合口径）。
  // 断言按本项目过滤：实例上可能并存其他来源的 shell 会话（如项目页启动期
  // 的终端恢复），大屏卡按会话全量渲染，裸 count 断言会被无关会话击穿
  const sessCard = page.locator('.mon-card.is-session').filter({ hasText: PROJ_NAME })
  await expect(sessCard).toHaveCount(1, { timeout: 10000 })
  await expect(sessCard).toContainText('运行中')

  // 播种 pending 审批（归属该会话 → 摘要审批行带 op/target）。
  // 按项目取会话：实例上可能并存其他来源的 shell 会话，[0] 未必是本会话
  const tlist = await (await request.get(`${BASE}/api/terminals`, { headers })).json()
  const sid = ((tlist?.data || []) as { id: string; projectId?: string }[])
    .find(t => t.projectId === pid)?.id || ''
  expect(sid).toBeTruthy()
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: sid, op: 'reset --hard', target: 'main', detail: 'e2e 交接班摘要验证' },
  })
  expect(appr.ok()).toBeTruthy()
  await expect(page.locator('.mon-card.is-approval')).toHaveCount(1, { timeout: 10000 })

  // 一键生成 → 复制成功提示 → 剪贴板摘要断言
  await page.locator('.mon-head-shift').click()
  await expect(page.locator('.n-message').filter({ hasText: '交接班摘要已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('【交接班摘要】')
  // 关键指标水位：运行中会话 1 / 待裁决审批 1 / 待回答提问 0
  expect(clip).toContain('运行中会话（1）')
  expect(clip).toContain('待裁决审批（1）')
  expect(clip).toContain('待回答提问（0）')
  // pending 审批清单行（op + target）与运行中会话行（时长标记）
  expect(clip).toContain('reset --hard main')
  expect(clip).toContain('已运行')
})

test('机群空闲：摘要水位全零 + 清单空态，复制闭环不依赖值守事实', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)
  await expect(page.locator('.mon-empty')).toBeVisible({ timeout: 10000 })

  await page.locator('.mon-head-shift').click()
  await expect(page.locator('.n-message').filter({ hasText: '交接班摘要已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('【交接班摘要】')
  expect(clip).toContain('运行中会话（0）')
  expect(clip).toContain('待裁决审批（0）')
  expect(clip).toContain('待回答提问（0）')
  expect(clip).toContain('（无）')
})
