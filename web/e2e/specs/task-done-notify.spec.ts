import { test, expect } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverIsRemote, serverPath } from '../../tests/dualpath'

/**
 * Agent 任务终态通知闭环 E2E（P-20261002-15）：
 *   经 POST /api/ops-notify 播种 task.progress（真实前端链路：ops-channel WS →
 *   OpsChannelBridge 终态分支 → 通知中心入账 + 桌面通知）。页面可见态下桌面
 *   通知按 useDesktopNotify 语义跳过（e2e 恒可见，天然不弹系统通知），本用例
 *   锁定通知中心侧的可见结果：
 *   1. done → 条目入账（标题=任务名、正文=已完成+耗时、terminalId 在位带跳转）
 *   2. 幂等：同 terminalId+status 短窗口重复上报只入账一条（服务端计数断言）
 *   3. failed → error 级条目（红点样式）；无 terminalId 无跳转
 *   4. 终态结论摘要（P-20261005-221）：terminalId 指向真实会话且其目录有夹具
 *      transcript → 发布口顺带提取结论尾部（done=结论/failed=报错现场），
 *      正文出现「结论：/现场：」行且敏感值被遮蔽；无会话归属保持纯状态体
 * 通知经共享实例 API 播种/清理，不残留测试数据
 */

const DONE_TASK = 'E2E通知任务'
const FAILED_TASK = 'E2E失败任务'
const TERMINAL_ID = 'e2e-notify-t1'
// 摘要链路夹具（P-20261005-221）：结论尾部标记 + 密钥形态片段（断言遮蔽）
const SUMMARY_TASK = 'E2E摘要任务'
const SCENE_TASK = 'E2E现场任务'
const SUM_SESSION = 'E2E摘要夹具会话'
const SCENE_SESSION = 'E2E现场夹具会话'
const TAIL_MARK = 'NOTIFY-TAIL-CHECK-9k'
const SCENE_MARK = 'npm ERR! NOTIFY-SCENE-4f build failed'
const SECRET = 'e2eNotifySecret8x'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

// 服务端已入账的同名条目数（幂等在防重复层完成，中心展示层的同形聚合无法区分）
async function serverCount(title: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${API_BASE}/api/notifications`, { headers })
  const list = ((await res.json()) as { data?: Array<{ title?: string }> }).data || []
  return list.filter(n => n.title === title).length
}

// 轮询等待入账（WS 链路：ops-notify 广播 → 前端桥 → POST /notifications）
async function waitServerCount(title: string, headers: Record<string, string>, timeoutMs = 8000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const n = await serverCount(title, headers)
    if (n > 0 || Date.now() > deadline) return n
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

async function enterProjectWithCenter(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // ops-channel / notifications 两条 WS 在 App 挂载即连：留出建立窗口再播种
  await page.waitForTimeout(800)
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('task.progress done → 通知中心入账（耗时+跳转），3s 内重复上报幂等仅一条', async ({ page }) => {
  test.setTimeout(60000)
  await enterProjectWithCenter(page)
  const headers = await unlockHeaders()
  const seed = (payload: Record<string, unknown>) =>
    page.request.post(`${API_BASE}/api/ops-notify`, { headers, data: { type: 'task.progress', payload } })

  await seed({ task: DONE_TASK, status: 'running', terminalId: TERMINAL_ID })
  await page.waitForTimeout(400) // 耗时起点
  await seed({ task: DONE_TASK, status: 'done', terminalId: TERMINAL_ID })
  // 幂等键 terminalId+status：窗口内重复 done 只入账一次
  await seed({ task: DONE_TASK, status: 'done', terminalId: TERMINAL_ID })

  expect(await waitServerCount(DONE_TASK, headers)).toBe(1)

  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const row = page.locator('.nc-item').filter({ hasText: DONE_TASK }).first()
  await expect(row).toBeVisible({ timeout: 8000 })
  // 正文 = 已完成 + 耗时（running→done 实测间隔折算 N.Ns）
  await expect(row).toContainText(/已完成（\d+\.\ds）/)
  // terminalId 在位 → 带跳转 action（行可点击）
  await expect(row).toHaveClass(/clickable/)
})

test('task.progress failed → error 级条目；无 terminalId 不带跳转', async ({ page }) => {
  test.setTimeout(60000)
  await enterProjectWithCenter(page)
  const headers = await unlockHeaders()
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'task.progress', payload: { task: FAILED_TASK, status: 'failed' } },
  })

  expect(await waitServerCount(FAILED_TASK, headers)).toBe(1)

  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const row = page.locator('.nc-item').filter({ hasText: FAILED_TASK }).first()
  await expect(row).toBeVisible({ timeout: 8000 })
  await expect(row).toContainText('已失败')
  // failed 走 error 级样式（红点）
  await expect(row).toHaveClass(/notif-type-error/)
  // 无 terminalId → 无跳转 action（单条行不可点击）
  await expect(row).not.toHaveClass(/clickable/)
})

// ---- 终态结论摘要（P-20261005-221）：真实会话 + 夹具 transcript ----
// 前置与 agent-cron-relay.spec 同款同机拓扑约定：本 spec 直读服务端所在机器的
// ~/.claude/projects（runtime=shell 一等选项不依赖 claude 在场）

interface SessionInfo { id?: string; name?: string }

function encodeClaudeDir(p: string): string {
  return p.replace(/[\\/:]/g, '-')
}

/** 摘要夹具：临时项目目录 + agent(shell) 会话 + 该目录下新写 transcript
 * （mtime=now 落入会话时间窗）。返回会话 id 与清理闭包。
 * transcript 落测试侧 homedir（dualpath.serverIsRemote 同 session-relay 守卫：
 * 跨拓扑服务端不可见，仅同机拓扑跑） */
async function seedSummaryFixture(headers: Record<string, string>, name: string, lines: string[]) {
  test.skip(serverIsRemote, 'claude transcript 夹具在测试侧 homedir，跨拓扑服务端不可见——仅同机拓扑')
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-task-notify-'))
  const createRes = await fetch(`${API_BASE}/api/terminals`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, kind: 'agent', runtime: 'shell', dir: serverPath(workDir) }),
  })
  expect(createRes.ok).toBeTruthy()
  const sessionId = ((await createRes.json()) as { data?: SessionInfo }).data?.id || ''
  expect(sessionId).toBeTruthy()

  const encDir = path.join(os.homedir(), '.claude', 'projects', encodeClaudeDir(workDir))
  fs.mkdirSync(encDir, { recursive: true })
  const file = path.join(encDir, `e2e-notify-summary-${Date.now()}.jsonl`)
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8') // mtime=now：窗内最新

  const cleanup = async () => {
    await fetch(`${API_BASE}/api/terminals/${sessionId}`, { method: 'DELETE', headers }).catch(() => {})
    try { fs.unlinkSync(file) } catch { /* already gone */ }
    try { fs.rmdirSync(encDir) } catch { /* gone */ }
    try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* gone */ }
  }
  return { sessionId, cleanup }
}

test('task.progress done 携真实会话 → 正文附「结论：」尾部且敏感值遮蔽', async ({ page }) => {
  test.setTimeout(60000)
  await enterProjectWithCenter(page)
  const headers = await unlockHeaders()
  const at = new Date().toISOString()
  const { sessionId: terminalId, cleanup } = await seedSummaryFixture(headers, SUM_SESSION, [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `${SUMMARY_TASK} 夹具` }, timestamp: at, cwd: process.cwd() }),
    // 密钥形态片段断言遮蔽（服务端 MaskText 主闸 + 前端 maskSensitive 兜底）；
    // 值后留空白防 CJK 紧贴让值段吞到尾（mask 模式②语义，agent-cron-relay 同注）
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `巡检完成，token=${SECRET} 遗留分片已登记，${TAIL_MARK}` }] }, timestamp: at }),
  ])
  try {
    await page.request.post(`${API_BASE}/api/ops-notify`, {
      headers,
      data: { type: 'task.progress', payload: { task: SUMMARY_TASK, status: 'done', terminalId } },
    })
    expect(await waitServerCount(SUMMARY_TASK, headers)).toBe(1)

    await page.locator('button[title="通知中心"]').first().click()
    await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
    const row = page.locator('.nc-item').filter({ hasText: SUMMARY_TASK }).first()
    await expect(row).toBeVisible({ timeout: 8000 })
    await expect(row).toContainText('结论：')
    await expect(row).toContainText(TAIL_MARK)
    await expect(row).toContainText('token=***')
    await expect(row).not.toContainText(SECRET)
  } finally {
    await cleanup()
  }
})

test('task.progress failed 携真实会话 → 正文附「现场：」报错尾部', async ({ page }) => {
  test.setTimeout(60000)
  await enterProjectWithCenter(page)
  const headers = await unlockHeaders()
  const at = new Date().toISOString()
  const { sessionId, cleanup } = await seedSummaryFixture(headers, SCENE_SESSION, [
    // failed 优先取最后一条 error 结果（排障第一现场），不取 assistant 自述
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: SCENE_MARK, is_error: true }] }, timestamp: at }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '任务未完成：构建失败' }] }, timestamp: at }),
  ])
  try {
    await page.request.post(`${API_BASE}/api/ops-notify`, {
      headers,
      data: { type: 'task.progress', payload: { task: SCENE_TASK, status: 'failed', terminalId: sessionId } },
    })
    expect(await waitServerCount(SCENE_TASK, headers)).toBe(1)

    await page.locator('button[title="通知中心"]').first().click()
    await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
    const row = page.locator('.nc-item').filter({ hasText: SCENE_TASK }).first()
    await expect(row).toBeVisible({ timeout: 8000 })
    await expect(row).toContainText('现场：')
    await expect(row).toContainText(SCENE_MARK)
  } finally {
    await cleanup()
  }
})
