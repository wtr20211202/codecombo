import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverIsRemote, serverPath } from '../../tests/dualpath'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * agent 会话自动命名 E2E（P-20261111-6 S1+S2）：新会话发首条消息 → 会话名按
 * 转写内容变更。
 *
 * 服务端链路：观察器周期检测 claude 运行时 agent 会话（名字仍为系统派生形态
 * Derived 且未 Named）的 transcript 首条用户消息落盘 → 首行文本 ~40 rune 截断
 * 作标题 → 经 rename 单点写入（Named 不置位）+ terminals.changed 广播。本
 * spec 用 agentLaunchCommands[claude] 注入睡眠命令 stub（长会话通知 spec 同款
 * 惯例：自定义命令覆盖跳过可用性门控，PTY 进程保活让会话留在注册表），
 * transcript 夹具播种到真实 ~/.claude/projects（claude-session-unnamed-active
 * 同款约定：cwd=真实临时目录、存储目录名按 EncodePath 规则、timestamp 在会话
 * 创建之后），不依赖 claude 二进制真实在场。
 *
 * 用例（S1）：
 *   1. 未命名 claude 会话 + 首条用户消息落盘 → 列表名字 = 首行文本（多行取首行）
 *   2. 首行超 40 rune → 截断加省略号（提案口径 ~40 字符）
 *   3. 手动改名（PUT rename，Named 置位）→ 播种首条消息后名字不再被覆盖
 *      （用户意志优先）
 * 用例（S2）：
 *   4. 侧栏名即时变更：页面开着 → 播种首条消息 → docked 侧栏行名字随
 *      terminals.changed 广播即时翻转（无整页刷新——提案「前端侧栏即时跟随」）
 *   5. 开关关闭零行为：settings agentAutoNameEnabled=false → 观察器整体旁路
 *      （两个观察周期名字不变）；重开 → 下一轮恢复命名（开关是唯一闸）
 *
 * 拓扑：夹具播种进服务端所在文件系统的 ~/.claude/projects——仅同机拓扑可跑
 * （dualpath.serverIsRemote 门控）。命名观察器 5s 周期 + meta 异步落库，
 * 断言统一 expect.poll（30s 上界）。每用例独立 WORK_DIR（同目录两个待命名
 * claude 会话会触发服务端「候选归属不明」保守跳过——刻意隔离）。
 * afterEach 清理终端会话/夹具目录，afterAll 还原 agentLaunchCommands 与
 * agentAutoNameEnabled、清理 UI 导航项目。
 */

const FIRST_MESSAGE = '修复 update 看门狗竞态\n补充：从 e2e 夹具复现首条消息命名'
const LONG_MESSAGE = '重构会话快照广播链路'.repeat(5) + '\n第二行不进标题'
const MANUAL_NAME = 'e2e-手动命名优先'
const UI_FIRST_MESSAGE = '梳理侧栏广播跟随夹具任务'
const UI_PROJ_NAME = 'e2e-agent-autoname-nav'
// EncodePath：路径分隔符与盘符冒号统一替换为 '-'（server/claudesessions.EncodePath）
const storageDirName = (p: string) => p.replace(/[\\/:]/g, '-')

const STUB_CLAUDE_CMD =
  process.platform === 'win32' ? 'Start-Sleep -Seconds 240' : 'sleep 240'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 每用例独立工作目录 + 夹具登记（afterEach 精确清理） */
const workDirs: string[] = []

function newWorkDir(): string {
  const dir = path.join(os.tmpdir(), `sc-e2e-autoname-${workDirs.length + 1}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  workDirs.push(dir)
  return dir
}

/** 播种 transcript 夹具：首条用户消息（timestamp 在会话创建之后——候选归属
 *  过滤要求 transcript 晚于终端创建） */
function seedTranscript(workDir: string, sessionUUID: string, firstMessage: string): void {
  const dir = path.join(os.homedir(), '.claude', 'projects', storageDirName(workDir))
  fs.mkdirSync(dir, { recursive: true })
  const escapedCwd = workDir.replace(/\\/g, '\\\\')
  const at = new Date().toISOString()
  const line = JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: firstMessage },
    timestamp: at,
    cwd: escapedCwd,
  })
  fs.writeFileSync(path.join(dir, `${sessionUUID}.jsonl`), line + '\n', 'utf-8')
}

test.describe('agent 会话自动命名（P-20261111-6 S1+S2）', () => {
  // transcript 夹具播种在服务端所在文件系统——跨拓扑结构性不可见，skip
  test.skip(serverIsRemote, 'transcript 夹具播种在服务端所在文件系统——仅同机拓扑')

  let savedLaunchCommands: Record<string, string> | null = null
  let savedAutoNameEnabled: boolean | null = null
  let navProjectId = ''

  test.beforeAll(async ({ request }) => {
    // 保存既有 agentLaunchCommands（整体替换语义），注入 claude 睡眠 stub：
    // claude 运行时会话拉起 stub 保活（native 后端进程退出即自移除，会话消失
    // 观察器就无从命名）；顺带记录自动命名开关现值（S2 用例改写后 afterAll 还原）
    const res = await request.get(`${API_BASE}/api/settings`, { headers: await unlockHeaders(request) })
    const settings = ((await res.json()) as { data?: { agentLaunchCommands?: Record<string, string>; agentAutoNameEnabled?: boolean } }).data
    savedLaunchCommands = settings?.agentLaunchCommands ?? null
    savedAutoNameEnabled = settings?.agentAutoNameEnabled ?? null
    const merged = { ...(savedLaunchCommands || {}), claude: STUB_CLAUDE_CMD }
    const put = await request.put(`${API_BASE}/api/settings`, {
      headers: await unlockHeaders(request),
      data: { agentLaunchCommands: merged },
    })
    expect(put.status(), '注入 claude 启动 stub 失败').toBe(200)

    // UI 导航项目（docked 管理页的活动栏入口在项目路由 Layout 上，
    // session-identity 同款）；与本 spec 的 claude 会话夹具目录互不相干
    const navDir = path.join(os.tmpdir(), `sc-e2e-autoname-nav-${Date.now()}`)
    fs.mkdirSync(navDir, { recursive: true })
    const pres = await request.post(`${API_BASE}/api/projects`, {
      headers: await unlockHeaders(request),
      data: { name: UI_PROJ_NAME, path: serverPath(navDir) },
    })
    expect(pres.ok(), '创建 UI 导航项目失败').toBe(true)
    navProjectId = ((await pres.json()) as { data?: { id?: string } }).data?.id || ''
    fs.rmSync(navDir, { recursive: true, force: true })
  })

  test.afterAll(async ({ request }) => {
    // 还原整体替换语义：原值为 null = 本无映射，写空对象等价清除；
    // 自动命名开关还原 GET 现值（PUT 指针语义无「未配置」位，写布尔即等价默认）
    await request
      .put(`${API_BASE}/api/settings`, {
        headers: await unlockHeaders(request),
        data: { agentLaunchCommands: savedLaunchCommands ?? {} },
      })
      .catch(() => {})
    if (savedAutoNameEnabled !== null) {
      await request
        .put(`${API_BASE}/api/settings`, {
          headers: await unlockHeaders(request),
          data: { agentAutoNameEnabled: savedAutoNameEnabled },
        })
        .catch(() => {})
    }
    if (navProjectId) {
      await request
        .delete(`${API_BASE}/api/projects/${navProjectId}`, { headers: await unlockHeaders(request) })
        .catch(() => {})
    }
  })

  test.afterEach(async ({ request }) => {
    const headers = await unlockHeaders(request)
    // 终端会话清理（stub 进程随 PTY 终结）
    const res = await request.get(`${API_BASE}/api/terminals`, { headers })
    const list = ((await res.json()) as { data?: { id: string }[] }).data || []
    for (const s of list) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
    // 夹具精确清理：本 spec 的 claude projects 子目录 + 工作目录
    for (const dir of workDirs.splice(0)) {
      fs.rmSync(path.join(os.homedir(), '.claude', 'projects', storageDirName(dir)), {
        recursive: true,
        force: true,
      })
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* Windows 文件占用竞态：tmp 目录留给系统清理 */
      }
    }
  })

  test('未命名 claude 会话发首条消息：列表名字 = 首行文本（多行取首行）', async ({ request }) => {
    const workDir = newWorkDir()
    const created = await createAgentSessionApi(request, { name: '', runtime: 'claude', dir: workDir })
    // 创建响应即带身份标记（P-20261023-3 契约）：名字是系统派生 → 可被自动命名
    expect(created.data.derived).toBe(true)
    expect(String(created.data.name)).toMatch(/^(终端|Terminal) \d+$/)

    seedTranscript(workDir, 'a1000000-0000-4000-8000-000000000001', FIRST_MESSAGE)
    const headers = await unlockHeaders(request)
    await expect
      .poll(
        async () => {
          const res = await request.get(`${API_BASE}/api/terminals`, { headers })
          const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
          return list.find(s => s.id === created.id)?.name ?? ''
        },
        { timeout: 30_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe('修复 update 看门狗竞态')
  })

  test('首行超 40 rune：截断加省略号（提案 ~40 字符口径）', async ({ request }) => {
    const workDir = newWorkDir()
    const created = await createAgentSessionApi(request, { name: '', runtime: 'claude', dir: workDir })

    seedTranscript(workDir, 'a2000000-0000-4000-8000-000000000002', LONG_MESSAGE)
    const expected = [...'重构会话快照广播链路'.repeat(5)].slice(0, 40).join('') + '…'
    const headers = await unlockHeaders(request)
    await expect
      .poll(
        async () => {
          const res = await request.get(`${API_BASE}/api/terminals`, { headers })
          const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
          return list.find(s => s.id === created.id)?.name ?? ''
        },
        { timeout: 30_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe(expected)
  })

  test('手动改名后首条消息不再覆盖（用户意志优先）', async ({ request }) => {
    const workDir = newWorkDir()
    const created = await createAgentSessionApi(request, { name: '', runtime: 'claude', dir: workDir })

    // 先手动改名（rename 端点置 meta.Named——资格面与写入面双闸的来源）
    const headers = await unlockHeaders(request)
    const ren = await request.put(`${API_BASE}/api/terminals/${created.id}/rename`, {
      headers,
      data: { name: MANUAL_NAME },
    })
    expect(ren.status()).toBe(200)

    // 改名后再播种首条消息：跨观察器两个周期名字保持手动值
    seedTranscript(workDir, 'a3000000-0000-4000-8000-000000000003', FIRST_MESSAGE)
    await new Promise(resolve => setTimeout(resolve, 11_000))
    const res = await request.get(`${API_BASE}/api/terminals`, { headers })
    const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
    const mine = list.find(s => s.id === created.id)
    expect(mine?.name, '手动改名过的会话永不覆盖').toBe(MANUAL_NAME)
  })

  // ============== S2：变更透出与可关闭 ==============

  /** 进项目页并打开 docked 管理页（活动栏入口在项目路由 Layout 上，
   *  session-identity/agent-session-name 同款导航） */
  async function openAgentDocked(page: Page) {
    await fixedLocale(page)
    // docked 开合状态是 localStorage（每用例新 context 天然干净），防御性清一次
    await page.addInitScript(() => {
      localStorage.removeItem('sc.agentTerminal.openState')
    })
    await gotoAndUnlock(page, `${API_BASE}/`)
    await page.locator('.project-card').filter({ hasText: UI_PROJ_NAME }).first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    return view
  }

  test('S2 侧栏名即时变更：播种首条消息后 docked 侧栏随广播翻转（无整页刷新）', async ({ page, request }) => {
    const workDir = newWorkDir()
    const created = await createAgentSessionApi(request, { name: '', runtime: 'claude', dir: workDir })
    const defaultName = String(created.data.name)

    // 页面先开（store 刷新拉到当前列表，侧栏行 = 序号缺省名），后播种消息：
    // 命名观察器改名 + terminals.changed 广播 → 统一 store 对账 → 侧栏行名字
    // 即时翻转，全程无整页刷新（提案「前端侧栏即时跟随」的断言口径）
    const view = await openAgentDocked(page)
    // 行锚定走 .ats-item-title 精确等值（:text-is）——hasText 子串会把
    // 「终端 15」误配进「终端 5」检索，并发 spec 的同类序号名互不污染
    const rowByTitle = (name: string) =>
      view.locator(`.ats-item:has(.ats-item-title:text-is("${name}"))`)
    const defaultRow = rowByTitle(defaultName)
    await expect(defaultRow).toBeVisible({ timeout: 15000 })

    seedTranscript(workDir, 'a4000000-0000-4000-8000-000000000004', UI_FIRST_MESSAGE)
    const renamedRow = rowByTitle(UI_FIRST_MESSAGE)
    await expect(renamedRow).toBeVisible({ timeout: 30000 })
    await expect(defaultRow, '改名后旧缺省名行应消失（是改名不是新增）').toHaveCount(0)
  })

  test('S2 开关关闭零行为：观察器整体旁路，重开后恢复命名（开关是唯一闸）', async ({ request }) => {
    const headers = await unlockHeaders(request)
    const off = await request.put(`${API_BASE}/api/settings`, {
      headers,
      data: { agentAutoNameEnabled: false },
    })
    expect(off.status(), '关闭自动命名开关失败').toBe(200)

    const workDir = newWorkDir()
    const created = await createAgentSessionApi(request, { name: '', runtime: 'claude', dir: workDir })
    const defaultName = String(created.data.name)
    seedTranscript(workDir, 'a5000000-0000-4000-8000-000000000005', UI_FIRST_MESSAGE)

    // 两个观察周期（S1 手动改名用例同款窗）：名字保持缺省形态 = 零行为
    await new Promise(resolve => setTimeout(resolve, 11_000))
    const list = (await (await request.get(`${API_BASE}/api/terminals`, { headers })).json()) as { data?: { id: string; name: string }[] }
    const mine = (list.data || []).find(s => s.id === created.id)
    expect(mine?.name, '开关关闭期间不得自动命名').toBe(defaultName)

    // 重开（写 true = 默认值语义）：下一轮按关闭期间已落盘的首条消息命名
    const on = await request.put(`${API_BASE}/api/settings`, {
      headers: await unlockHeaders(request),
      data: { agentAutoNameEnabled: true },
    })
    expect(on.status()).toBe(200)
    await expect
      .poll(
        async () => {
          const res = await request.get(`${API_BASE}/api/terminals`, { headers: await unlockHeaders(request) })
          const l = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
          return l.find(s => s.id === created.id)?.name ?? ''
        },
        { timeout: 30_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe(UI_FIRST_MESSAGE)
  })
})
