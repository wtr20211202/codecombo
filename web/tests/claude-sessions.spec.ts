import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * Claude 会话区 E2E（P5）：管理页 Claude 页签 + 项目底部终端浮层 + 恢复链路。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions）。
 *
 * 测试数据：按用户要求构造大量会话（55 + 3 条 fixture，标题带 [e2e-fix] 标记，
 * 用 utimes 控制时间桶），写入真实 ~/.claude/projects 下的两个目录——
 *   - D--e2e-claude-fixtures（假项目，全局范围可见）
 *   - 注册 simple-coding 项目的 EncodePath 编码目录（动态解析，项目范围可见）
 * afterAll 精确删除这些 fixture 文件 + 关闭测试创建的 agent 会话。
 *
 * 时间桶设计注意：服务端把 mtime 在 5 分钟内（activeWindow）的会话判为
 * 「进行中」——该状态的行点击恢复是空操作、title 属性变为进行中提示。
 * 所有 fixture 的 age 必须保持在 5 分钟以上（buildFixtures 各桶已留余量），
 * 需要点行交互的用例须过滤出带「恢复」角标的行。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const FIXTURE_COUNT_GLOBAL = 55
const FIXTURE_COUNT_PROJECT = 3
const MARK = '[e2e-fix]'
const FAKE_DIR_NAME = 'D--e2e-claude-fixtures'
const FIXTURE_CWD = 'D:\\e2e-claude-fixtures'
const createdFiles: string[] = []
const createdSessionIds: string[] = []

// 项目级 fixture 的编码目录从注册项目路径动态推导（运行实例注册的仓库根随
// 检出位置而异——主仓/worktree/贡献者 clone 各不相同，写死任何绝对路径都会
// 在别的检出上错配项目范围查询；beforeAll 先经 /api/projects 解析再建 fixture，
// 解析不到即显式失败而非落到错误目录）
const encodeClaudeDir = (p: string) => p.replace(/[\\/:]/g, '-')
let REAL_PROJECT_ENCODED = ''

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getProjectId(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = list.find(x => x.name === 'simple-coding')
  if (!p) throw new Error('simple-coding project not found')
  return p.id
}

/** 构造一个最小可解析的 claude jsonl（cwd 转义与真实存储一致） */
function fixtureJSONL(title: string, iso: string): string {
  return [
    '{"type":"last-prompt","sessionId":"x"}',
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${title} 见 mieA9"},"timestamp":"${iso}","cwd":"D:\\\\e2e-claude-fixtures"}`,
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]},"timestamp":"' + iso + '"}',
  ].join('\n') + '\n'
}

function writeFixture(encodedDir: string, id: string, title: string, ageMs: number) {
  const dir = path.join(os.homedir(), '.claude', 'projects', encodedDir)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.jsonl`)
  const iso = new Date(Date.now() - ageMs).toISOString()
  fs.writeFileSync(file, fixtureJSONL(title, iso), 'utf-8')
  const at = new Date(Date.now() - ageMs)
  fs.utimesSync(file, at, at)
  createdFiles.push(file)
}

async function buildFixtures() {
  // fixture cwd 对应的真实目录必须存在（服务端建会话校验 dir），测完删除
  fs.mkdirSync(FIXTURE_CWD, { recursive: true })
  // 全局：55 条（50 今天 + 3 最近7天 + 2 更早），时间倒序分散在三个时间桶。
  // 「今天」桶从 10 分钟前起步：服务端把 mtime 在 5 分钟内（activeWindow）的
  // 会话判为「进行中」（onResume 对其空操作、title 显示进行中提示），fixture
  // 必须整体落在窗口外，否则恢复/标题断言随机踩中 active 行
  for (let i = 0; i < FIXTURE_COUNT_GLOBAL; i++) {
    const ageMs = i < 50 ? (i + 10) * 60_000 : i < 53 ? 3 * 86400_000 + i * 60_000 : 40 * 86400_000 + i * 60_000
    writeFixture(FAKE_DIR_NAME, `e2e-fix-g${String(i).padStart(2, '0')}-a7c3f`, `${MARK} 全局会话 ${i}`, ageMs)
  }
  // 项目级：3 条写入真实项目编码目录（[e2e-fix] 标记保证与用户真实会话可区分）
  for (let i = 0; i < FIXTURE_COUNT_PROJECT; i++) {
    writeFixture(REAL_PROJECT_ENCODED, `e2e-fix-p${i}-91bd2`, `${MARK} 项目会话 ${i}`, (i + 1) * 3_600_000)
  }
}

const page_wait = (ms: number) => new Promise(r => setTimeout(r, ms))

async function cleanupFixtures(request: APIRequestContext) {
  // 顺序很重要：先关会话（shell cwd 占住 fixture 目录会导致目录删不掉），再删文件
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string; name?: string }[] }).data || []
  for (const s of list) {
    if (s.kind === 'agent') {
      await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  }
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  // 清理空目录（仅我们创建的假项目目录 + fixture cwd 目录）。
  // 会话关闭后服务端异步杀进程，Windows 下 cwd 句柄稍后才释放：等待 + 重试
  for (let attempt = 0; attempt < 8; attempt++) {
    await page_wait(1000)
    try { fs.rmSync(FIXTURE_CWD, { recursive: true, force: true }) } catch { /* gone */ }
    try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
    if (!fs.existsSync('D:/e2e-claude-fixtures')) break
  }
}

async function enterProject(page: Page) {
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

test.describe('Claude 会话区（P5）', () => {
  let projectId = ''

  test.beforeAll(async ({ request }) => {
    projectId = await getProjectId(request)
    // 项目级 fixture 编码目录随注册路径解析（worktree 槽位 ≠ 主仓路径）
    const headers = await unlockHeaders(request)
    const list = ((await (await request.get(`${BASE}/api/projects`, { headers })).json()) as { data?: { id: string; name: string; path: string }[] }).data || []
    const proj = list.find(x => x.id === projectId)
    if (!proj?.path) throw new Error('simple-coding project has no resolvable path')
    REAL_PROJECT_ENCODED = encodeClaudeDir(proj.path)
    buildFixtures()
  })

  test.afterAll(async ({ request }) => {
    if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
    await cleanupFixtures(request)
  })

  test('管理页 Claude 页签：列表/时间分段/搜索/加载更多', async ({ page }) => {
    page.on('console', m => { if (m.type() === 'error') console.log('[BROWSER-ERR]', m.text()) })
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    page.on('response', r => { if (r.url().includes('/claude/sessions')) console.log('[CSP-API]', r.status(), r.url()) })
    await enterProject(page)
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })

    // 切到 Claude 页签
    await view.locator('.ats-tab', { hasText: 'Claude' }).click()
    const picker = view.locator('.csp-root')
    try {
      await expect(picker).toBeVisible({ timeout: 8000 })
    } catch (e) {
      const dump = await page.evaluate(() => ({
        cspCount: document.querySelectorAll('.csp-root').length,
        sidebarHTML: document.querySelector('.ats-root')?.innerHTML?.slice(0, 600),
        sidebarRect: document.querySelector('.ats-root')?.getBoundingClientRect(),
      }))
      console.log('[CSP-DIAG]', JSON.stringify(dump))
      throw e
    }

    // 搜索 [e2e-fix] → 服务端只返回匹配 fixture（58 条中前 50 条）
    const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
    await picker.locator('input').fill(MARK)
    await searchResp
    await expect(picker.locator('.csp-row')).toHaveCount(50, { timeout: 15000 })
    // 时间分段头出现（首页 50 条全是「今天」的 fixture，「更早」在加载更多之后）
    await expect(picker.locator('.csp-bucket', { hasText: '今天' })).toBeVisible()

    // 加载更多 → 追加剩余 8 条（全局范围含项目级 fixture：55 全局 + 3 项目 = 58）
    const moreResp = page.waitForResponse(r => r.url().includes('offset=50'))
    await picker.locator('.csp-more button').click()
    await moreResp
    await expect(picker.locator('.csp-row')).toHaveCount(58, { timeout: 15000 })
    // 时间分段完整：追加后「更早」桶出现
    await expect(picker.locator('.csp-bucket', { hasText: '更早' })).toBeVisible()
    // 加载完后「加载更多」消失
    await expect(picker.locator('.csp-more')).toHaveCount(0)

    // 搜索唯一 id 片段
    const uniqResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
    await picker.locator('input').fill('e2e-fix-g00')
    await uniqResp
    await expect(picker.locator('.csp-row')).toHaveCount(1, { timeout: 15000 })
  })

  test('恢复链路：点击会话行 → 新建 agent 终端注入 claude --resume 并打开管理页', async ({ page, request }) => {
    await enterProject(page)
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    await view.locator('.ats-tab', { hasText: 'Claude' }).click()
    const picker = view.locator('.csp-root')
    try {
      await expect(picker).toBeVisible({ timeout: 8000 })
    } catch (e) {
      const dump = await page.evaluate(() => ({
        cspCount: document.querySelectorAll('.csp-root').length,
        sidebarHTML: document.querySelector('.ats-root')?.innerHTML?.slice(0, 600),
        sidebarRect: document.querySelector('.ats-root')?.getBoundingClientRect(),
      }))
      console.log('[CSP-DIAG]', JSON.stringify(dump))
      throw e
    }

    // 点击第一个可恢复的 fixture 行（带「恢复」角标 = 非 active）：「进行中」
    // 的行点击是空操作（防 fork 双进程写同一历史），最新 fixture 也可能因
    // activeWindow 被判进行中，不能盲点 .first()
    // 点击行首 BrandIcon 区（position 锚定，无 @click.stop 子元素，事件自然
    // 冒泡到行的 onResume）：此前点 .csp-row-main 行主体区，但行右侧 hover
    // 显现钮群（星标/备注/回放/接力/恢复，历次能力累积，回放/接力为带字
    // 宽钮）在默认 260px 侧栏下已把主体区 flex 压成 0 宽——行渲染成无标题
    // 纯按钮条（P-20261003-114 接力钮引入后越界，截图实证，产品侧待入案），
    // 主体区不再是可靠点击目标
    await picker.locator('.csp-row')
      .filter({ hasText: MARK })
      .filter({ has: page.locator('.csp-row-resume') })
      .first()
      .click({ position: { x: 12, y: 20 } })

    // 管理页切回/保持在 docked，系统会话区出现「Claude · …」新会话
    const newItem = view.locator('.ats-item', { hasText: 'Claude ·' }).first()
    await expect(newItem).toBeVisible({ timeout: 15000 })
    // 多会话 keep-alive：新会话 xterm 追加在 DOM 尾部，first() 会选中
    // 旧会话的隐藏实例（同 terminal-restart 串扰根因）
    await expect(view.locator('.xterm').last()).toBeVisible({ timeout: 15000 })

    // 服务端校验：新会话 dir = fixture cwd，launchArgs 生效（name 前缀 + kind=agent）
    const headers = await unlockHeaders(request)
    const list = ((await (await request.get(`${BASE}/api/terminals`, { headers })).json()) as { data?: { id: string; name: string; kind: string; path: string }[] }).data || []
    const resumed = list.find(s => s.name.startsWith('Claude ·'))
    expect(resumed).toBeTruthy()
    expect(resumed!.kind).toBe('agent')
    expect(resumed!.path).toBe('D:\\e2e-claude-fixtures')
    if (resumed) createdSessionIds.push(resumed.id)
  })

  test('项目底部终端浮层：项目范围锁定，只列本项目的 fixture', async ({ page }) => {
    await enterProject(page)
    // 打开底部终端面板（浮层按钮在终端工具栏内）
    for (let i = 0; i < 3; i++) {
      if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
      await page.locator('.ide-rail .rail-btn[title="终端"]').click()
      await page.waitForTimeout(600)
    }
    await page.locator('.term-tool-btn[aria-label="Claude 会话"]').click()
    const panel = page.locator('.term-claude-panel')
    await expect(panel).toBeVisible({ timeout: 10000 })

    // 项目范围（未搜索也应只含本项目的 fixture；用标记搜索断言精确性）
    await panel.locator('input').fill(MARK)
    await expect(panel.locator('.csp-row')).toHaveCount(FIXTURE_COUNT_PROJECT, { timeout: 15000 })
    // 无「加载更多」（3 条 < 50）
    await expect(panel.locator('.csp-more')).toHaveCount(0)
    // 关闭浮层
    await panel.locator('.csp-head-close').click()
    await expect(panel).toHaveCount(0)
  })

  test('键盘导航：↑↓ 选择、Enter 恢复唯一匹配行', async ({ page }) => {
    await enterProject(page)
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    await view.locator('.ats-tab', { hasText: 'Claude' }).click()
    const picker = view.locator('.csp-root')
    await expect(picker).toBeVisible({ timeout: 8000 })

    // 多行列表：↑↓ 移动键盘活动行（搜索框聚焦时按键冒泡到根）
    const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
    await picker.locator('input').fill(MARK)
    await searchResp
    await expect(picker.locator('.csp-row')).toHaveCount(50, { timeout: 15000 })
    // 全量刷新后键盘定位首行
    await expect(picker.locator('.csp-row').first()).toHaveClass(/is-kbd-active/)
    await page.keyboard.press('ArrowDown')
    await expect(picker.locator('.csp-row').nth(1)).toHaveClass(/is-kbd-active/)
    await expect(picker.locator('.csp-row').first()).not.toHaveClass(/is-kbd-active/)
    // ↑×2 钳制在首行
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(picker.locator('.csp-row').first()).toHaveClass(/is-kbd-active/)

    // Enter 恢复：唯一匹配 p2（3 小时前的 fixture，未被其他用例的恢复触碰过，
    // 不会因 mtime 落入 activeWindow 被判「进行中」而空操作）
    const uniqResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
    await picker.locator('input').fill('e2e-fix-p2')
    await uniqResp
    await expect(picker.locator('.csp-row')).toHaveCount(1, { timeout: 15000 })
    await expect(picker.locator('.csp-row').first()).toHaveClass(/is-kbd-active/)
    await page.keyboard.press('Enter')
    // 恢复链路 UI 侧：按会话名唯一子串定位新条目（resumeName = 'Claude · {title}'，
    // p2 的标题只出现在本会话），不依赖侧栏列表的渲染时点与计数基线
    const newItem = view.locator('.ats-item').filter({ hasText: '项目会话 2' })
    await expect(newItem).toHaveCount(1, { timeout: 15000 })
    // 新会话 pane 追加在 DOM 末尾：断言 last 而非 first（first 可能是未激活的旧 pane，hidden）
    await expect(view.locator('.xterm').last()).toBeVisible({ timeout: 15000 })
  })

  test('长标题两行截断 + tooltip 全文（打磨轮5）', async ({ page }) => {
    // 无空格长 ASCII token：断行只能靠 overflow-wrap:anywhere。
    // 总长留出余量：MARK(9)+空格+60x=70 rune < titleMaxRunes(80)，避免
    // 服务端截断追加 … 造成预期值漂移。
    // age 取 10 分钟：必须落在服务端 activeWindow（5 分钟）外，否则行被判
    // 「进行中」，title 属性变为进行中提示而非 标题+cwd
    const longTitle = `${MARK} ${'x'.repeat(60)}`
    writeFixture(FAKE_DIR_NAME, 'e2e-fix-longtitle-b0a1e', longTitle, 10 * 60_000)

    await enterProject(page)
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    await view.locator('.ats-tab', { hasText: 'Claude' }).click()
    const picker = view.locator('.csp-root')
    await expect(picker).toBeVisible({ timeout: 8000 })

    // 定位长标题行本身（70 连续 x 是独有内容）。不断言「排最前」——
    // fixture 文件会被同文件其他用例的 resume 追加触碰 mtime，排序断言天然脆弱
    const row = picker.locator('.csp-row').filter({ hasText: 'x'.repeat(60) }).first()
    // 服务端标题 = content 原文（fixtureJSONL 会在 title 后拼 ' 见 mieA9' 作标记尾巴）。
    // P-20261003-165 起行 title 追加第三行多选操作提示——断言前两行（标题+cwd）
    const title = await row.getAttribute('title')
    expect(title?.split('\n').slice(0, 2).join('\n')).toBe(`${longTitle} 见 mieA9\nD:\\e2e-claude-fixtures`)
    // 两行截断样式生效（无空格 token 也断行，不再单行省略）
    const clamp = await row.locator('.csp-row-title').evaluate((el) => getComputedStyle(el).webkitLineClamp)
    expect(clamp).toBe('2')
  })
})
