import { test, expect, type APIRequestContext } from '@playwright/test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverIsRemote, serverPath } from '../../tests/dualpath'

/**
 * 审批卡「查看会话回放」（P-20261002-82）：审批记录自带 sessionId 与 createdAt，
 * 卡片头部「回放」按钮 → 解析发起会话工作目录下的 Claude 对话 → 打开
 * SessionTimeline 并滚动定位到「最近早于审批时刻」的条目呼吸高亮 2s。
 *
 * 前置：simple-coding 已运行；拓扑与服务实例同机（transcript 种在真实
 * ~/.claude/projects，同 claude-timeline.spec 约定，afterAll 精确删除）。
 *
 * 满种方式对齐 approval-jump.spec：API 造系统会话（纯终端 runtime，不拉起
 * claude TUI）+ 以其 id 造 pending 审批；夹具目录同时充当终端 dir 与
 * transcript cwd（解析链按 cwd 相等匹配会话）；transcript 时间戳围绕服务端
 * 返回的审批 createdAt 构造（-5..-1 分钟五条 + +30s 一条），断言高亮落在
 * -1 分钟那步（最近早于审批时刻；+30s 那条晚于审批时刻必须不被选中）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const MARK = '[e2e-ar]'
const STEP_COUNT = 6
/** 期望高亮的步序号：第 i 步在审批时刻 -(STEP_COUNT-1-i) 分钟（最后一步 +30s） */
const FOCUS_STEP = STEP_COUNT - 2
const createdFiles: string[] = []

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，保证确定性 + 防残留 tmux 进程） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 清理 pending 审批（卡片全局常驻，残留会污染后续用例的 .aprv-card 计数） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

/** 播种 fixture transcript：STEP_COUNT 条用户指令步围绕审批时刻分布，
 * mtime 控制在服务端 activeWindow(5 分钟) 外避免被判「进行中」。
 * cwd 写终端会话同款目录（server EncodePath 同规则派生 claude 存储子目录名） */
async function buildFixtures(termDir: string, approvalAt: Date): Promise<void> {
  const claudeDir = path.join(
    os.homedir(), '.claude', 'projects', termDir.replace(/[\\/]/g, '-').replace(':', '-'),
  )
  await mkdir(claudeDir, { recursive: true })
  const sessionId = `e2e-ar-${path.basename(termDir).slice('sc-appr-replay-'.length)}`
  const file = path.join(claudeDir, `${sessionId}.jsonl`)
  const lines: string[] = [
    `{"type":"last-prompt","sessionId":"${sessionId}"}`,
  ]
  for (let i = 0; i < STEP_COUNT; i++) {
    const offsetMin = i < STEP_COUNT - 1 ? -(STEP_COUNT - 1 - i) : 0.5
    const at = new Date(approvalAt.getTime() + offsetMin * 60_000).toISOString()
    lines.push(
      `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} 回放定位步骤 ${i}"},"timestamp":"${at}","cwd":"${termDir.replace(/\\/g, '\\\\')}"}`,
    )
  }
  await writeFile(file, lines.join('\n') + '\n', 'utf-8')
  const quiet = new Date(Date.now() - 10 * 60_000)
  await utimes(file, quiet, quiet)
  createdFiles.push(file)
}

async function cleanupFixtures(): Promise<void> {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    await rm(f, { force: true }).catch(() => { /* already gone */ })
  }
}

test.describe('审批卡查看会话回放（P-20261002-82）', () => {
  // 头注「拓扑与服务实例同机」前置的机器化执行：transcript 夹具种在测试侧
  // ~/.claude/projects，跨拓扑时服务端 homedir 结构性不可见，无服务端写入
  // API 可翻译——按 dualpath.serverIsRemote 门控 skip（P-20261005-187）
  test.skip(serverIsRemote, 'claude transcript 夹具在测试侧 homedir，跨拓扑服务端不可见——仅同机拓扑')
  test.beforeEach(async ({ request }) => {
    await cleanupTerminals(request)
    await cleanupApprovals(request)
  })
  test.afterAll(() => cleanupFixtures())

  test('卡片回放按钮 → 时间线打开并定位高亮到审批时刻条目', async ({ page, request }) => {
    test.setTimeout(60000)
    const headers = await unlockHeaders(request)
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')

    // 夹具目录 = 终端 dir = transcript cwd（回放解析按 cwd 相等匹配会话）
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sc-appr-replay-'))

    // API 造系统会话（纯终端 runtime，避免拉起 claude TUI）+ pending 审批
    const created = await request.post(`${BASE}/api/terminals`, {
      headers,
      // 终端 dir 按服务端形态交接（同机拓扑恒等返回；跨拓扑已被上方 skip 门控）
      data: { kind: 'agent', name: 'appr-replay-agent', runtime: 'shell', dir: serverPath(dir) },
    })
    expect(created.ok()).toBeTruthy()
    const tlist = await (await request.get(`${BASE}/api/terminals`, { headers })).json()
    const session = ((tlist?.data || []) as { id: string; name: string }[])
      .find(s => s.name === 'appr-replay-agent')
    expect(session).toBeTruthy()

    const appr = await request.post(`${BASE}/api/ops-confirm`, {
      headers,
      data: { sessionId: session!.id, op: 'deploy --env prod', target: 'web', detail: 'e2e 回放定位验证' },
    })
    expect(appr.ok()).toBeTruthy()
    const apprId = ((await appr.json()) as { data?: { id?: string } }).data?.id ?? ''
    const alist = await (await request.get(`${BASE}/api/ops-confirm`, { headers })).json()
    const rec = ((alist?.data || []) as { id: string; createdAt?: string }[]).find(x => x.id === apprId)
    const approvalAt = rec?.createdAt && !Number.isNaN(new Date(rec.createdAt).getTime())
      ? new Date(rec.createdAt)
      : new Date()
    await buildFixtures(dir, approvalAt)

    // 卡片出现 +「回放」按钮（sessionId 存在才显示）
    const card = page.locator('.aprv-card')
    await expect(card).toHaveCount(1, { timeout: 10000 })
    await expect(card).toContainText('deploy --env prod')
    const replayBtn = card.locator('[data-test="aprv-replay"]')
    await expect(replayBtn).toBeVisible()

    // 点击 → 时间线弹层（回放只读，transcript 在即活会话/死终端都可回看）
    await replayBtn.click()
    const modal = page.locator('.n-modal .cstl-root')
    await expect(modal).toBeVisible({ timeout: 15000 })

    // 定位高亮：唯一 is-focus 落在「最近早于审批时刻」的那步（-1 分钟步），
    // +30s 那步不得当选
    const focus = modal.locator('.cstl-step.is-focus')
    await expect(focus).toHaveCount(1, { timeout: 15000 })
    await expect(focus).toContainText(`回放定位步骤 ${FOCUS_STEP}`)
    await expect(focus).toBeInViewport()

    // 呼吸高亮 2s 后消退（定位器不带 is-focus 过滤——摘除后元素仍在原位）
    const focusStep = modal.locator(`[data-step="${FOCUS_STEP}"]`)
    await expect(focusStep).not.toHaveClass(/is-focus/, { timeout: 4000 })

    await rm(dir, { recursive: true, force: true }).catch(() => { /* 句柄延迟占用忽略 */ })
  })
})
