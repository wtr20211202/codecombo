import { test, expect } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 定时任务自动接力 E2E（P-20261005-207）：cron 任务配置 relayFrom 后到期触发
 * （经「立即试跑」走同一执行链，agent-cron-prompt-vars.spec.ts 同先例免分钟级
 * 调度等待）先取接力源会话结论注入 launchArgs 前言。
 *
 * 断言核心（shell 会话 scrollback 回显注入命令为证据，同 prompt-vars 先例）：
 *   1. 接力注入：显式会话 ID 指向夹具 transcript → launchArgs 携前言
 *      「Conclusions from the previous session: …」（服务端 relay.go 三段复刻
 *      ——结论挑选/P-108 遮蔽/保尾装箱），结论密钥形态片段被遮蔽、结论尾部
 *      标记原样直达、任务 prompt 与计划戳在后；lastRelayNote=relayed
 *   2. 降级：relayFrom 指向不存在的会话 → 任务照常发起（launchArgs 无前言），
 *      lastRelayNote=skipped:<原因>，task.relaySkipped 事件在 /api/modules
 *      模块发现面 Topics 可见（agent 监控入口），设置分区任务行显示接力标记
 *      与跳过结果（列表行语义）
 *
 * 前置：simple-coding 已运行（夹具直读服务端所在文件系统的 ~/.claude/
 * projects，与 session-relay.spec.ts 同款同机拓扑约定）；运行时无关——
 * shell 一等选项不依赖 claude 在场。
 */

const MARK = 'CRONRELAY'
const FIXTURE_DIR_NAME = 'D--e2e-cron-relay-fixtures'
// 结论尾部标记：断言结论原样注入（服务端 200 rune 条目窗内无损）
const TAIL_MARK = 'RELAY-TAIL-CHECK-cron-9z'
// 密钥形态片段：断言 P-108 遮蔽在服务端装箱前生效（原文不得进注入面）。
// 注意密钥值后必须留空白——遮蔽模式②的值段按 [^\s"']+ 吞到词尾，CJK 紧贴
// 会让「值段」一路吞到结论尾（mask.go 语义如此），尾部标记就进不了注入面
const SECRET = 'e2eSecretTokenValue7x'
const CONCLUSION = `巡检完成，token=${SECRET} 遗留分片超时已登记，${TAIL_MARK}`
const SESSION_ID = 'e2e-cron-relay-a1b2-c3d4-0001'
const createdFiles: string[] = []

interface CronItem { id?: string; name?: string; lastResult?: string; lastRelayNote?: string; lastRelayAt?: string }
interface SessionInfo { id?: string; name?: string }

function seedTranscript(sessionId: string, conclusion: string) {
  const dir = path.join(os.homedir(), '.claude', 'projects', FIXTURE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  const base = Date.now() - 30 * 60_000
  const at = (min: number) => new Date(base + min * 60_000).toISOString()
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `${MARK} 接力夹具` }, timestamp: at(0), cwd: process.cwd() }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: conclusion }] }, timestamp: at(1) }),
  ]
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  // mtime 落 activeWindow(5 分钟) 外：已结束会话判定（结论已定型）
  const idle = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, idle, idle)
  createdFiles.push(file)
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FIXTURE_DIR_NAME)) } catch { /* non-empty or gone */ }
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

async function cleanup() {
  const headers = await unlockHeaders()
  const listRes = await fetch(`${API_BASE}/api/agent-crons`, { headers })
  const crons = ((await listRes.json()) as { data?: CronItem[] }).data || []
  for (const c of crons) {
    if (c.name?.includes(MARK) && c.id) {
      await fetch(`${API_BASE}/api/agent-crons/${c.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
  const tRes = await fetch(`${API_BASE}/api/terminals`, { headers })
  const sessions = ((await tRes.json()) as { data?: SessionInfo[] }).data || []
  for (const s of sessions) {
    if (s.name?.includes(MARK) && s.id) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
  cleanupFixtures()
}

/** 去 ANSI 转义（agent-cron-prompt-vars.spec.ts 同款）：PSReadLine 语法高亮把
 *  命令回显按 token 分段插颜色码，整串 includes 前须剥离 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g, '')
}

async function createCron(headers: Record<string, string>, name: string, relayFrom: string, prompt: string) {
  const createRes = await fetch(`${API_BASE}/api/agent-crons`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name,
      hour: 2,
      minute: 0,
      weekdays: [],
      runtime: 'shell',
      prompt,
      dir: '',
      enabled: true,
      missCatchUp: true,
      relayFrom,
    }),
  })
  expect(createRes.ok).toBeTruthy()
  return ((await createRes.json()) as { data?: CronItem }).data
}

async function listCrons(headers: Record<string, string>): Promise<CronItem[]> {
  const res = await fetch(`${API_BASE}/api/agent-crons`, { headers })
  return ((await res.json()) as { data?: CronItem[] }).data || []
}

/** 立即试跑并轮询 scrollback 直到回显出现预期锚点（会话注入有进程启动延迟）；
 *  返回 (回显全文, 触发的会话 id) */
async function runAndEcho(headers: Record<string, string>, cronId: string, anchor: string): Promise<{ echoed: string; sessionId: string }> {
  const runRes = await fetch(`${API_BASE}/api/agent-crons/${cronId}/run`, { method: 'POST', headers })
  expect(runRes.ok).toBeTruthy()
  const run = ((await runRes.json()) as { data?: { id?: string; launched?: boolean } }).data
  expect(run?.launched).toBeTruthy()
  const sessionId = run?.id || ''
  expect(sessionId).toBeTruthy()
  let echoed = ''
  for (let i = 0; i < 10 && !echoed; i++) {
    const sb = await fetch(`${API_BASE}/api/terminals/${sessionId}/scrollback`, { headers })
    const text = stripAnsi(await sb.text())
    if (text.includes(anchor)) {
      echoed = text
    } else {
      await new Promise(r => setTimeout(r, 2000))
    }
  }
  expect(echoed, 'scrollback should echo the injected launchArgs').toBeTruthy()
  return { echoed, sessionId }
}

test.describe('定时任务自动接力（P-20261005-207）', () => {
  test.afterAll(async () => {
    await cleanup()
  })

  test('接力注入：试跑 launchArgs 携前言（遮蔽密钥、结论尾部直达），lastRelayNote=relayed', async () => {
    await cleanup() // 上次中断遗留的同前缀任务/会话/夹具先清
    seedTranscript(SESSION_ID, CONCLUSION)
    const headers = await unlockHeaders()
    const name = `${MARK}-inject-${Date.now()}`
    const created = await createCron(headers, name, SESSION_ID, `echo ${MARK}_PROMPT_END`)
    expect(created?.id).toBeTruthy()

    const { echoed } = await runAndEcho(headers, created!.id!, `${MARK}_PROMPT_END`)
    // 前言在前：服务端英文模板（服务端无 UI 语言上下文，同 promptVar 星期英文口径）
    expect(echoed).toContain('Conclusions from the previous session: ')
    // 结论原样注入（尾部标记在 200 rune 窗内无损直达）
    expect(echoed).toContain(TAIL_MARK)
    // 密钥形态片段装箱前已遮蔽（原文不得进注入面）
    expect(echoed).not.toContain(SECRET)
    // 任务 prompt 与计划戳在后（注入是前置，不替换任务本体）
    expect(echoed).toContain(`${MARK}_PROMPT_END [scheduled `)

    // 接力事实：lastRelayNote=relayed
    const items = await listCrons(headers)
    const item = items.find(c => c.name === name)
    expect(item?.lastRelayNote).toBe('relayed')
    expect(item?.lastRelayAt).toBeTruthy()
  })

  test('降级：源不存在任务照常发起（无前言），skipped 事实入账 + 事件在模块发现面 + 列表行标记', async ({ page }) => {
    const headers = await unlockHeaders()
    const name = `${MARK}-degrade-${Date.now()}`
    const created = await createCron(headers, name, `no-such-session-${Date.now()}`, `echo ${MARK}_DEGRADE_END`)
    expect(created?.id).toBeTruthy()

    // 任务照常发起（自动化容错优先，接力失败不停摆）；launchArgs 无前言
    const { echoed } = await runAndEcho(headers, created!.id!, `${MARK}_DEGRADE_END`)
    expect(echoed).toContain(`${MARK}_DEGRADE_END [scheduled `)
    expect(echoed).not.toContain('Conclusions from the previous session')

    // 降级事实入账：lastRelayNote = skipped: <原因>
    const items = await listCrons(headers)
    const item = items.find(c => c.name === name)
    expect(item?.lastRelayNote, 'skip note should carry the reason').toContain('skipped:')
    expect(item?.lastRelayAt).toBeTruthy()

    // task.relaySkipped 事件入模块发现面（agent 监控入口，OPS_EVENTS 目录已登记）
    const modRes = await fetch(`${API_BASE}/api/modules`, { headers })
    const mods = ((await modRes.json()) as { data?: Array<{ name?: string; topics?: string[] }> }).data || []
    expect(mods.find(m => m.name === 'agentcron')?.topics).toContain('task.relaySkipped')

    // 列表行：接力标记 + 最近一次接力结果（跳过态）
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('[data-testid="rail-settings"]').click()
    const modal = page.locator('.n-modal.settings-modal')
    await expect(modal).toBeVisible()
    await modal.locator('.nav-item').filter({ hasText: '定时任务' }).click()
    const row = page.locator(`[data-testid="agentcron-item-${name}"]`)
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row.locator('[data-testid="agentcron-relay-tag"]')).toBeVisible()
    await expect(row.locator('[data-testid="agentcron-relay-result"]')).toContainText('已跳过')

    // 编辑对话框回读：relayFrom 显式会话形态解析回「指定会话 ID」+ 输入框预填
    // （relayFrom 单字符串 ↔ 表单双字段互转的解析向）
    const relayFrom = item?.relayFrom || ''
    await row.locator('button', { hasText: '编辑' }).click()
    const dialog = page.locator('.n-modal').filter({ has: page.locator('[data-testid="agentcron-form-prompt"]') })
    await expect(dialog).toBeVisible()
    await expect(dialog.locator('[data-testid="agentcron-form-relay-mode"]')).toBeVisible()
    await expect(dialog.locator('[data-testid="agentcron-form-relay-session"] input')).toHaveValue(relayFrom)
    await dialog.locator('button', { hasText: '取消' }).click()
  })
})
