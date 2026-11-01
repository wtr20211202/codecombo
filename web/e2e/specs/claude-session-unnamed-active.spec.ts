import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { DEFAULT_PASSWORD, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverIsRemote } from '../../tests/dualpath'

/**
 * Claude 会话列表双修 E2E（P-20261031-1）：僵尸「进行中」判定修复 + 纯噪声
 * 首条消息的标题硬化。
 *
 * 1. 标题硬化：首条用户消息是整串替换符（终端二进制输出转发的实测形态，
 *    8×U+FFFD）时 parseHead 跳过纯噪声文本、取后续真实消息作标题——行不再
 *    显示豆腐块/回退 id，恢复可导航（服务端 isTitleWorthy 硬化的端到端裁决）。
 * 2. Active 精确判定：行点击恢复（claude --resume <id> 经 Codecombo 拉起）
 *    → 终端存活期行显「进行中」（活终端注册表精确挂载，与 mtime 无关）→
 *    API 关闭终端 → 列表即刻非活跃（claudeassoc 持久关联 + 实时校正，不再等
 *    mtime 5 分钟窗口过期）——「恢复」入口立即可用。
 *
 * 测试数据：播种 fixture transcript 到真实 ~/.claude/projects（claude-timeline
 * 同款约定，MARK 标记 + utimes 控制在 activeWindow 之外），恢复链样例需要真实
 * 工作目录（终端 dir=会话 cwd），故 cwd 取 os.tmpdir() 下真实存在的目录，
 * 存储目录名按 EncodePath 规则（分隔符/盘符冒号 → '-'）推得。afterAll 精确
 * 清理：终端会话（best-effort）/ transcript 文件 / 两处目录。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects 且 claude 二进制
 * 须可用（恢复链 launched=true 是关联落库的前提），仅同机拓扑可跑
 * （dualpath.serverIsRemote，claude-timeline 同款门控）。
 */

const MARK_A = '[e2e-csu-a]'
const MARK_B = '[e2e-csu-b]'
// 会话 id 用 hex+dash 形态（claude 真实 id 是 UUID；恢复链服务端按
// `--resume <id>` 提取目标，形态须可解析）
const SESSION_A = 'c5aea1ea-1111-4000-8000-a00000000001'
const SESSION_B = 'c5aea1ea-1111-4000-8000-b00000000002'
const WORK_DIR = path.join(os.tmpdir(), 'e2e-csu-fixtures')
// EncodePath：路径分隔符与盘符冒号统一替换为 '-'（server/claudesessions.EncodePath）
const STORAGE_DIR_NAME = WORK_DIR.replace(/[\\/:]/g, '-')
const createdFiles: string[] = []
let terminalId = ''

function buildFixtures() {
  fs.mkdirSync(WORK_DIR, { recursive: true })
  const dir = path.join(os.homedir(), '.claude', 'projects', STORAGE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const escapedCwd = WORK_DIR.replace(/\\/g, '\\\\')

  // 会话 A：首条用户消息 = 纯噪声（8×U+FFFD），其后才是真实指令
  const noise = '\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD'
  const fileA = path.join(dir, `${SESSION_A}.jsonl`)
  const at = new Date(Date.now() - 10 * 60_000).toISOString()
  fs.writeFileSync(fileA, [
    `{"type":"last-prompt","sessionId":"${SESSION_A}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${noise}"},"timestamp":"${at}","cwd":"${escapedCwd}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK_A} 噪声标题回退样例"},"timestamp":"${at}","cwd":"${escapedCwd}"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]},"timestamp":"${at}"}`,
  ].join('\n') + '\n', 'utf-8')
  createdFiles.push(fileA)

  // 会话 B：正常标题，恢复链样例（mtime 在 activeWindow 外 = 初始非活跃可恢复）
  const fileB = path.join(dir, `${SESSION_B}.jsonl`)
  fs.writeFileSync(fileB, [
    `{"type":"last-prompt","sessionId":"${SESSION_B}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK_B} 恢复链样例"},"timestamp":"${at}","cwd":"${escapedCwd}"}`,
    `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]},"timestamp":"${at}"}`,
  ].join('\n') + '\n', 'utf-8')
  createdFiles.push(fileB)

  for (const f of createdFiles) {
    const old = new Date(Date.now() - 10 * 60_000)
    fs.utimesSync(f, old, old)
  }
}

async function apiHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function cleanupFixtures() {
  // 恢复链创建的终端会话 best-effort 关闭（正常路径测试体内已关）
  if (terminalId) {
    try {
      const headers = await apiHeaders()
      await fetch(`${API_BASE}/api/terminals/${terminalId}`, { method: 'DELETE', headers })
    } catch { /* already gone */ }
  }
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', STORAGE_DIR_NAME)) } catch { /* non-empty or gone */ }
  try { fs.rmSync(WORK_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
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

/** 原地重开 Claude 列表（恢复链打开 docked 终端后用：跨页 goto 会撞 uiState
 *  记忆的首页 agt-home-overlay 浮层遮项目卡——session-runtime-groups 同款
 *  既有纪律；面板开关是 toggle 语义，active 即已开勿盲点） */
async function reopenPickerInPlace(page: Page) {
  await page.reload()
  const railBtn = page.locator('.rail-btn[title="终端会话管理"]')
  await railBtn.waitFor({ state: 'visible', timeout: 15000 })
  const cls = await railBtn.getAttribute('class')
  if (!cls?.includes('active')) await railBtn.click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.ats-tab', { hasText: 'Claude' }).click()
  const picker = view.locator('.csp-root')
  await expect(picker).toBeVisible({ timeout: 8000 })
  return picker
}

/** 搜索 MARK 定位唯一 fixture 行（Claude 会话侧栏为 global 形态，跨 cwd 可见） */
async function searchRow(page: Page, picker: ReturnType<Page['locator']>, mark: string) {
  const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
  await picker.locator('input').fill(mark)
  await searchResp
}

test.describe('Claude 会话列表双修（P-20261031-1）', () => {
  // transcript 夹具与 claude 二进制在测试侧同机——跨拓扑结构性不可见，skip
  test.skip(serverIsRemote, 'claude transcript 夹具与恢复链 claude 二进制在测试侧同机——仅同机拓扑')

  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(async () => {
    await cleanupFixtures()
  })

  test('纯噪声首条消息不吞标题：行标题取后续真实消息', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const picker = await openClaudeTab(page)
    await searchRow(page, picker, MARK_A)

    const row = picker.locator(`[data-test="session-row-${SESSION_A}"]`)
    await expect(row).toBeVisible({ timeout: 15000 })
    // 硬化后：parseHead 跳过 8×U+FFFD 噪声首消息，标题 = 后续真实消息
    //（硬化前该行显示豆腐块噪声或回退 id——用户截图的行失语形态）
    await expect(row.locator('.csp-row-title')).toContainText('噪声标题回退样例', { timeout: 15000 })
    const titleText = await row.locator('.csp-row-title').innerText()
    expect(titleText, '标题不得残留替换符噪声').not.toContain('\uFFFD')
    // meta 段短 id 恒可见（P-20261031-1 会话 id 可见性基线）
    await expect(row.locator('.csp-meta-id')).toContainText(SESSION_A.slice(0, 8))
  })

  test('恢复→关终端：存活期「进行中」，关闭即刻非活跃（不等 mtime 窗口）', async ({ page, request }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const picker = await openClaudeTab(page)
    await searchRow(page, picker, MARK_B)
    const row = picker.locator(`[data-test="session-row-${SESSION_B}"]`)
    await expect(row).toBeVisible({ timeout: 15000 })
    // 初始（mtime 在 activeWindow 外）：非活跃、可恢复
    await expect(row).not.toHaveClass(/is-active/)

    // 行点击 = 恢复（新建 agent 会话注入 claude --resume <id>）。点标题元素：
    // 行几何中心可能落在 meta 段的「复制会话 id」角标上（@click.stop 语义），
    // 标题无独立点击语义、冒泡到行按钮即恢复动作
    // launched=false（环境无 claude 二进制）会让关联链缺席——如实失败
    const createResp = page.waitForResponse(r => r.url().includes('/api/terminals') && r.request().method() === 'POST')
    await row.locator('.csp-row-title').click()
    const body = await (await createResp).json() as { data?: { id?: string; launched?: boolean } }
    terminalId = body.data?.id || ''
    expect(terminalId, '恢复链应创建终端会话').toBeTruthy()
    expect(body.data?.launched, 'claude 二进制可用时恢复链真实拉起').toBe(true)
    // meta 异步落库（创建漏斗 goroutine）：留出毫秒级窗口，防止下一页列表
    // 取数时精确关联尚未可查（活终端挂载判据读 meta）
    await page.waitForTimeout(1500)

    // 终端存活期：活终端注册表精确挂载 → 行显「进行中」（mtime 无关）
    const pickerLive = await reopenPickerInPlace(page)
    await searchRow(page, pickerLive, MARK_B)
    const rowLive = pickerLive.locator(`[data-test="session-row-${SESSION_B}"]`)
    await expect(rowLive).toBeVisible({ timeout: 15000 })
    await expect(rowLive).toHaveClass(/is-active/, { timeout: 15000 })
    await expect(rowLive.locator('.csp-row-live')).toContainText('进行中')

    // 关闭终端（claude 进程随 PTY 关闭即死）
    const headers = await apiHeaders()
    const del = await request.delete(`${API_BASE}/api/terminals/${terminalId}`, { headers })
    expect(del.ok()).toBeTruthy()
    terminalId = ''

    // 列表即刻非活跃（claudeassoc 持久关联 + 实时校正，零延迟）——
    // 硬化前此处最长 5 分钟仍显「进行中」且恢复被禁
    const pickerAfter = await reopenPickerInPlace(page)
    await searchRow(page, pickerAfter, MARK_B)
    const rowAfter = pickerAfter.locator(`[data-test="session-row-${SESSION_B}"]`)
    await expect(rowAfter).toBeVisible({ timeout: 15000 })
    await expect(rowAfter).not.toHaveClass(/is-active/, { timeout: 15000 })
    await expect(rowAfter.locator('.csp-row-live')).toHaveCount(0)
    // 恢复入口立即可用：行右键菜单「复制会话 id」+ 恢复动作可及（非活跃行菜单项不置灰）
    await rowAfter.hover()
    await rowAfter.click({ button: 'right' })
    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible({ timeout: 8000 })
    await expect(menu.locator('.n-dropdown-option', { hasText: '复制会话 id' })).toBeEnabled()
  })
})
