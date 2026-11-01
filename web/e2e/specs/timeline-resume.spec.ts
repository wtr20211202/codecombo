import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverIsRemote } from '../../tests/dualpath'

/**
 * 回放时间线「继续此会话」（P-20261002-96）：弹层 footer 主按钮 → 复用恢复
 * 链路（新建 agent 终端注入 `claude --resume <id>`，dir=会话 cwd）→ 成功后
 * 弹层关闭 + 终端管理页切回会话列表并选中新会话。
 *
 * 前置：simple-coding 已运行；拓扑与服务实例同机（transcript 种在真实
 * ~/.claude/projects，同 claude-timeline.spec 约定，afterAll 精确删除）。
 *
 * 满种方式对齐 approval-replay.spec：夹具目录（mkdtemp）同时充当会话 cwd 与
 * transcript cwd。创建请求真实放行（服务端建会话行为有既有域用例与本用例
 * 双重覆盖；fixture 会话 id 不存在时 claude 启动即报错退出/或本机无 claude
 * 走 launched=false 纯 shell，两条路会话都真实在列，选中态断言不受对账刷新
 * 影响）；请求体契约（kind/runtime/dir/launchArgs）经 waitForResponse 捕获断言。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const MARK = '[e2e-tlr]'
const STEP_COUNT = 3
const SESSION_ID = 'e2e-tlr-a1b2c3d4-e5f6'
const createdFiles: string[] = []
let fixtureDir = ''

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，保证确定性 + 防残留运行时进程） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 播种 fixture transcript：STEP_COUNT 条用户指令步（时间正序），mtime 控制
 * 在服务端 activeWindow(5 分钟) 外避免被判「进行中」（进行中不显示续聊按钮）。
 * cwd 写夹具目录（server EncodePath 同规则派生 claude 存储子目录名） */
async function buildFixtures(): Promise<void> {
  const claudeDir = path.join(
    os.homedir(), '.claude', 'projects', fixtureDir.replace(/[\\/]/g, '-').replace(':', '-'),
  )
  await mkdir(claudeDir, { recursive: true })
  const file = path.join(claudeDir, `${SESSION_ID}.jsonl`)
  const lines: string[] = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
  ]
  for (let i = 0; i < STEP_COUNT; i++) {
    const at = new Date(Date.now() - (13 - i) * 60_000).toISOString()
    lines.push(
      `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} 续聊步骤 ${i}"},"timestamp":"${at}","cwd":"${fixtureDir.replace(/\\/g, '\\\\')}"}`,
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
  if (fixtureDir) {
    // transcript 存储子目录（可能被真拉起的运行时补写）与夹具目录一并清
    await rm(path.join(os.homedir(), '.claude', 'projects', fixtureDir.replace(/[\\/]/g, '-').replace(':', '-')),
      { force: true, recursive: true }).catch(() => { /* non-empty or gone */ })
    await rm(fixtureDir, { force: true, recursive: true }).catch(() => { /* 句柄延迟占用忽略 */ })
  }
}

async function openClaudeTab(page: Page) {
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.ats-tab', { hasText: 'Claude' }).click()
  const picker = view.locator('.csp-root')
  await expect(picker).toBeVisible({ timeout: 8000 })
  return picker
}

test.describe('回放时间线继续此会话（P-20261002-96）', () => {
  // transcript 夹具种在测试侧 ~/.claude/projects（头注同机前置），跨拓扑时
  // 服务端 homedir 结构性不可见，无服务端写入 API 可翻译——按环境门控 skip
  // （dualpath.serverIsRemote，P-20261005-187）
  test.skip(serverIsRemote, 'claude transcript 夹具在测试侧 homedir，跨拓扑服务端不可见——仅同机拓扑')
  test.beforeEach(async ({ request }) => {
    await cleanupTerminals(request)
    fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'sc-tlr-'))
    await buildFixtures()
  })
  // 用例真实创建了一个 agent 会话：用后即清（连带杀掉被拉起的运行时进程）
  test.afterEach(async ({ request }) => {
    await cleanupTerminals(request)
  })
  test.afterAll(() => cleanupFixtures())

  test('弹层 footer 继续此会话：--resume 请求契约 → 弹层关闭 → 列表选中新会话', async ({ page }) => {
    test.setTimeout(60000)
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await fixedLocale(page)
    const picker = await openClaudeTab(page)

    // 搜索标记 → 唯一 fixture 行 → 行内「回放」角标打开时间线弹层
    const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
    await picker.locator('input').fill(MARK)
    await searchResp
    const row = picker.locator('.csp-row').filter({ hasText: MARK }).first()
    await expect(row).toBeVisible({ timeout: 15000 })
    await row.hover()
    await row.locator('.csp-row-replay').click()
    const modal = page.locator('.n-modal .cstl-root')
    await expect(modal).toBeVisible({ timeout: 10000 })

    // footer 续聊主按钮在场（fixture 会话非活跃）
    const resumeBtn = modal.locator('[data-test="timeline-resume"]')
    await expect(resumeBtn).toBeVisible()

    // 点击 → 新建 agent 终端请求：runtime=claude、dir=会话 cwd、--resume 注入
    const createResp = page.waitForResponse(r => r.url().includes('/api/terminals') && r.request().method() === 'POST')
    await resumeBtn.click()
    const createBody = ((await (await createResp).request().postDataJSON()) ?? {}) as Record<string, unknown>
    expect(createBody).toMatchObject({
      kind: 'agent',
      runtime: 'claude',
      dir: fixtureDir,
      launchArgs: `--resume ${SESSION_ID}`,
    })

    // 成功即关弹层，管理页切回终端会话页签并选中新会话（恢复链路激活 + 上抛；
    // 新会话真实在列，服务端对账刷新不清洗）
    await expect(modal).toHaveCount(0, { timeout: 10000 })
    const view = page.locator('.atv-root')
    await expect(view.locator('.ats-tab.active')).toContainText('终端', { timeout: 10000 })
    await expect(view.locator('.ats-item.active').filter({ hasText: MARK }).first())
      .toBeVisible({ timeout: 10000 })
  })
})
