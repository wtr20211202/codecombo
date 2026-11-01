import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话输出对比 E2E（P-20261005-210）：同命令双环境 A/B 验证——终端 tab 右键
 * 「对比输出…」→ 会话选择浮层 → 双侧取数进 DiffEditor 快照对比（纯前端组装，
 * 取数走既有 GET /terminals/:id/export P-100 原语，无新端点）：
 *   1. API 链路：对比取数原语的会话隔离性——两个会话各自 echo 唯一标记后，
 *      各自 /export 含己方标记、不含对方标记（diff 两侧内容正确性的数据面前提；
 *      导出契约本身（404 门/附件名/零 ESC）由 terminal-export-output.spec 守）
 *   2. UI 链路：两会话造差异化输出 → tab 右键「对比输出…」→ 浮层点选另一会话
 *      → 弹层进 diff 态：标题含两会话名 + 快照时刻、摘要条 +N/-M 非零（N/M 来自
 *      Monaco getLineChanges 视图真值）、双标记行都在弹层内
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || API_BASE
const PROJECT_NAME = 'simple-coding'
const API_MARK_A = 'SC-CMP-API-A-4210'
const API_MARK_B = 'SC-CMP-API-B-4210'
const UI_MARK_A = 'SC-CMP-UI-A-4210'
const UI_MARK_B = 'SC-CMP-UI-B-4210'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function createTerminal(request: APIRequestContext, headers: Record<string, string>, name: string): Promise<string> {
  const projects = await request.get(`${BASE}/api/projects`, { headers })
  const list = ((await projects.json()) as { data?: { id: string; name: string }[] }).data || []
  const projectId = list.find(x => x.name === PROJECT_NAME)?.id
  if (!projectId) throw new Error(`project ${PROJECT_NAME} not found`)
  const res = await request.post(`${BASE}/api/terminals`, { headers, data: { projectId, name } })
  expect(res.ok()).toBeTruthy()
  const data = ((await res.json()) as { data?: { id?: string } }).data
  if (!data?.id) throw new Error('terminal id missing')
  return data.id
}

async function echoInto(request: APIRequestContext, headers: Record<string, string>, sessionId: string, mark: string): Promise<void> {
  // broadcast-write 原始 PTY 输入（尾部 \r 执行）——与 terminal-export-output 同款
  const wr = await request.post(`${BASE}/api/terminals/broadcast-write`, {
    headers, data: { ids: [sessionId], data: `echo ${mark}\r` },
  })
  expect(wr.ok()).toBeTruthy()
}

async function exportBody(request: APIRequestContext, headers: Record<string, string>, sessionId: string): Promise<string> {
  const res = await request.get(`${BASE}/api/terminals/${sessionId}/export`, { headers })
  expect(res.status()).toBe(200)
  return await res.text()
}

test('API 链路：对比取数原语会话隔离——各 /export 含己方标记不含对方标记', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const idA = await createTerminal(request, headers, 'e2e-cmp-a')
  const idB = await createTerminal(request, headers, 'e2e-cmp-b')
  try {
    await echoInto(request, headers, idA, API_MARK_A)
    await echoInto(request, headers, idB, API_MARK_B)

    // 轮询等 PTY 回显落进服务端缓冲（terminal-export-output 同款节奏）
    let bodyA = ''
    let bodyB = ''
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500))
      bodyA = await exportBody(request, headers, idA)
      bodyB = await exportBody(request, headers, idB)
      if (bodyA.includes(API_MARK_A) && bodyB.includes(API_MARK_B)) break
    }
    // 会话隔离：diff 左右两侧各取各的缓冲——串味即对比结果失真
    expect(bodyA).toContain(API_MARK_A)
    expect(bodyA).not.toContain(API_MARK_B)
    expect(bodyB).toContain(API_MARK_B)
    expect(bodyB).not.toContain(API_MARK_A)
  } finally {
    await request.delete(`${BASE}/api/terminals/${idA}`, { headers })
    await request.delete(`${BASE}/api/terminals/${idB}`, { headers })
  }
})

test('UI 链路：tab 右键「对比输出…」→ 浮层选会话 → DiffEditor 双栏 + 摘要条', async ({ page }) => {
  test.setTimeout(90_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).click()
  await page.waitForURL('**/project')

  // 归一化：底部终端面板可见（面板开合是 uiState 持久态，随跑序而异）
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }

  // 会话 A：新建终端 → 记下激活 tab 名（新建即激活）→ 敲唯一标记
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(2500)
  const nameA = (await page.locator('.term-tab.is-active .term-tab-name').textContent()) || ''
  expect(nameA.length).toBeGreaterThan(0)
  await page.locator('.xterm-screen:visible').last().click()
  await page.keyboard.type(`echo ${UI_MARK_A}`)
  await page.keyboard.press('Enter')

  // 会话 B：同链路（新建即激活，type 落 B 的屏）
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(2500)
  const nameB = (await page.locator('.term-tab.is-active .term-tab-name').textContent()) || ''
  await page.locator('.xterm-screen:visible').last().click()
  await page.keyboard.type(`echo ${UI_MARK_B}`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)

  // 右键 B 的 tab（创建序在 .term-tablist 尾部）→「对比输出…」（teleport 到 body，
  // 多提案热区走专属 testid；showTabContextMenu 同步 selectTab，左=B 右=目标）
  await page.locator('.term-tablist .term-tab').last().click({ button: 'right' })
  const compareItem = page.locator('[data-testid="terminal-compare-output"]')
  await expect(compareItem).toBeVisible({ timeout: 3000 })
  await compareItem.click()

  // 选择浮层：按精确名点选会话 A（浮层列全部 shell/agent/remote 候选，排除自身；
  // 服务端可能有历史残留会话且名字可能是子串关系（终端 1 ⊂ 终端 10），
  // getByText exact 全等匹配防误点）
  const pick = page.locator('[data-testid="term-compare-pick"]')
  await expect(pick).toBeVisible({ timeout: 5000 })
  const candA = page.locator('.tcm-item').filter({
    has: page.getByText(nameA, { exact: true }),
  }).first()
  await candA.click()

  // diff 态：标题含两会话名 + 快照时刻（时点快照语义），双侧取数走 export 链
  const modal = page.locator('[data-testid="term-compare-modal"]')
  const head = page.locator('[data-testid="term-compare-head"]')
  await expect(head).toBeVisible({ timeout: 10000 })
  await expect(head).toContainText(nameB)
  await expect(head).toContainText(nameA)
  await expect(head).toContainText(/快照 \d{2}:\d{2}:\d{2}/)

  // 摘要条（+N/-M）：N/M 来自 Monaco getLineChanges 视图真值——两标记行互异，
  // added 与 removed 均必 ≥1；含金量高于断言具体数值（两侧 shell 横幅行数随环境）
  const stats = page.locator('[data-testid="term-compare-stats"]')
  await expect(stats).toBeVisible({ timeout: 10000 })
  await expect(stats).toContainText(/\+[1-9]\d*/)
  await expect(stats).toContainText(/-[1-9]\d*/)

  // 双标记行都在对比弹层内（左=A 侧原文、右=B 侧原文——取数正确性的 UI 端到端）。
  // 弹层已裁掉滚回首尾空白行（ConPTY 重排残渣实测 20~35 行，不裁则有效内容
  // 沉底出 Monaco 虚拟化视口），裁后内容即 shell 横幅+标记行，首屏可见
  await expect(modal).toContainText(UI_MARK_A, { timeout: 15000 })
  await expect(modal).toContainText(UI_MARK_B, { timeout: 15000 })
})
