import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 回放时间线书签 E2E（P-20261003-122 轮级策展回跳）：
 * 1. assistant 轮书签 toggle——star 图标仅 assistant 轮可标（user/tool/result
 *    无入口），标后回放顶部书签清单出现（时刻 + 结论首行摘要，时间正序），
 *    取消后清单条目消失、清空后整条收起；
 * 2. 点击书签直达——呼吸高亮定位该轮，且与「仅命中」正交（目标不在命中集时
 *    自动退出紧凑视图，定位意图优先）；
 * 3. 刷新后书签仍在——持久经服务端 claudecur 策展域（timeline 响应携书签集）。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions/curation 的
 * bookmarkAdd/bookmarkRemove 扩展）。
 *
 * 测试数据：播种一条 10 步 fixture transcript 到真实 ~/.claude/projects
 *（与 timeline-search.spec.ts 同款约定——标题带 [e2e-bm] 标记，utimes 控制
 * 在 activeWindow(5 分钟) 之外），afterAll 精确删除 fixture 文件；书签经
 * API 清理（timeline 响应回读书签集逐个 bookmarkRemove + 双清删条目，
 * 防上次运行残留的老时刻书签污染 chip 计数）。回放链路只读，不创建终端会话。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与既有 claude 会话族 spec 一致）。
 */

const MARK = '[e2e-bm]'
const FAKE_DIR_NAME = 'D--e2e-bm-fixtures'
const SESSION_ID = 'e2e-bm-b2c3d4e5-f6a7'
// 10 步 < 首屏 limit(50)：全部条目一屏加载完（虚拟窗口内全量渲染，与
// timeline-search 同前提），书签清单/星标断言不依赖滚动换窗
const createdFiles: string[] = []
/** assistant 轮时刻（buildFixtures 填充）：书签 API 清理用（bookmarkRemove 键） */
const assistantAt: Record<number, string> = {}

/** 播种 fixture transcript：10 步，assistant 文本轮在 1/3/7（3 与混合行
 *  同刻——同一条 assistant 消息拆出的 tool_use+text 共 timestamp，验证
 *  assistant 优先定位），时间正序。时刻每下标只求值一次（写入行与
 *  assistantAt 共用同一串——toISOString 毫秒级，两次求值会差 1ms 且
 *  书签持久对账是全等断言） */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  const stamps: string[] = []
  for (let i = 0; i < 8; i++) stamps.push(new Date(Date.now() - (20 - i) * 60_000).toISOString())
  const at = (i: number) => stamps[i]!
  const lines: string[] = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
    // 步骤 0：user 指令
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} 把主题换成 coral"},"timestamp":"${at(0)}","cwd":"D:\\\\e2e-bm-fixtures"}`,
    // 步骤 1：assistant 结论（书签载体 A，正文含 zebra-unicorn 供仅命中用例）
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"结论一 BM-ALPHA：zebra-unicorn 主题切换完成"}]},"timestamp":"${at(1)}"}`,
    // 步骤 2 tool + 步骤 3 assistant 文本（同一条消息拆出，同刻；书签载体 B）
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"themes/coral.json"}},{"type":"text","text":"结论二 BM-BETA：预算充足可以继续"}]},"timestamp":"${at(2)}"}`,
    // 步骤 4：tool_result
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]},"timestamp":"${at(3)}"}`,
    // 步骤 5：user
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} token 预算还剩多少"},"timestamp":"${at(4)}","cwd":"D:\\\\e2e-bm-fixtures"}`,
    // 步骤 6 tool + 步骤 7 assistant 结论（书签载体 C）
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"echo budget"}},{"type":"text","text":"结论三 BM-GAMMA：预算核对完毕可以发布"}]},"timestamp":"${at(5)}"}`,
    // 步骤 8：tool_result
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"budget ok"}]},"timestamp":"${at(6)}"}`,
    // 步骤 9：user
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} 回滚 (revert) 上一次发布"},"timestamp":"${at(7)}","cwd":"D:\\\\e2e-bm-fixtures"}`,
  ]
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  assistantAt[1] = at(1)
  assistantAt[3] = at(2) // 步骤 3 与步骤 2 同刻（混合行）
  assistantAt[7] = at(5) // 步骤 7 与步骤 6 同刻（混合行）
  // mtime/收尾部留 10 分钟余量：落在服务端 activeWindow(5 分钟) 外，行可交互
  const old = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, old, old)
  createdFiles.push(file)
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

/** 清理本会话全部书签 + 删策展条目（timeline 响应回读书签集逐个移除——
 *  上次运行残留的老时刻书签无法枚举，从响应回读是唯一可靠口径） */
async function clearAllBookmarks(page: Page) {
  const resp = await page.request.get(`/api/claude/sessions/${SESSION_ID}/timeline?limit=1`)
  const body = await resp.json()
  const bms: string[] = body?.data?.bookmarks ?? []
  for (const at of bms) {
    await page.request.post('/api/claude/sessions/curation', {
      data: { sessionId: SESSION_ID, bookmarkRemove: at },
    })
  }
  await page.request.post('/api/claude/sessions/curation', {
    data: { sessionId: SESSION_ID, starred: false, note: '' },
  })
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

/** 打开 fixture 会话的回放弹层，断言 10 步全部就位后返回弹层 */
async function openReplay(page: Page) {
  const picker = await openClaudeTab(page)
  const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
  await picker.locator('input').fill(MARK)
  await searchResp
  const row = picker.locator('.csp-row').filter({ hasText: MARK }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.hover()
  await row.locator('.csp-row-replay').click()
  const modal = page.locator('.n-modal .cstl-root')
  await expect(modal).toBeVisible({ timeout: 10000 })
  await expect(modal.locator('.cstl-step')).toHaveCount(10, { timeout: 15000 })
  return modal
}

/** star / unstar 某一步（hover 显现钮后点击——同族 hover 显现惯例） */
async function clickBookmark(modal: ReturnType<Page['locator']>, step: number) {
  const stepEl = modal.locator(`.cstl-step[data-step="${step}"]`)
  await stepEl.hover()
  await stepEl.locator('[data-test="timeline-bookmark"]').click()
}

/** 刷新后重开回放（持久用例专用）：本页此前停靠过终端管理页，localStorage
 *  启动恢复链（AgentTerminal onMounted consumePendingOpenState）在 home 全屏
 *  overlay 原样复现该面板——真实用户「刷新→管理页回来→重开回放」动线，直接
 *  在恢复的 overlay 内重开 Claude 页签与回放（overlay 会拦截 home 项目卡点击，
 *  走 home→项目卡→rail 的常规路径必然超时） */
async function openReplayAfterReload(page: Page) {
  const view = page.locator('.agt-home-overlay .atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.ats-tab', { hasText: 'Claude' }).click()
  const picker = view.locator('.csp-root')
  await expect(picker).toBeVisible({ timeout: 8000 })
  const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
  await picker.locator('input').fill(MARK)
  await searchResp
  const row = picker.locator('.csp-row').filter({ hasText: MARK }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.hover()
  await row.locator('.csp-row-replay').click()
  const modal = page.locator('.n-modal .cstl-root')
  await expect(modal).toBeVisible({ timeout: 10000 })
  await expect(modal.locator('.cstl-step')).toHaveCount(10, { timeout: 15000 })
  return modal
}

test.describe('回放时间线书签（P-20261003-122）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('书签 toggle：仅 assistant 轮可标，标后清单出现（摘要+时刻正序），取消消失', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await clearAllBookmarks(page)
    const modal = await openReplay(page)
    const strip = modal.locator('[data-test="timeline-bookmark-list"]')

    // 干净基线：无书签清单
    await expect(strip).toHaveCount(0)

    // 仅 assistant 轮有书签入口：user（步骤 0/5）与 tool（步骤 2/6）无钮，
    // assistant 文本轮（步骤 1/3/7）有钮
    await expect(modal.locator('.cstl-step[data-step="0"] [data-test="timeline-bookmark"]')).toHaveCount(0)
    await expect(modal.locator('.cstl-step[data-step="2"] [data-test="timeline-bookmark"]')).toHaveCount(0)
    await expect(modal.locator('.cstl-step[data-step="1"] [data-test="timeline-bookmark"]')).toHaveCount(1)

    // star 步骤 1：实心星点亮（is-on），顶部清单出现且 chip 带结论首行摘要
    await clickBookmark(modal, 1)
    await expect(modal.locator('.cstl-step[data-step="1"] [data-test="timeline-bookmark"]')).toHaveClass(/is-on/)
    await expect(strip).toBeVisible()
    await expect(strip.locator('[data-test="timeline-bookmark-chip"]')).toHaveCount(1)
    await expect(strip.locator('[data-test="timeline-bookmark-chip"]').first()).toContainText('结论一 BM-ALPHA')

    // star 步骤 3（与 tool 同刻的混合行文本）：清单两条，时间正序（结论一在前）
    await clickBookmark(modal, 3)
    await expect(strip.locator('[data-test="timeline-bookmark-chip"]')).toHaveCount(2)
    await expect(strip.locator('[data-test="timeline-bookmark-chip"]').nth(0)).toContainText('BM-ALPHA')
    await expect(strip.locator('[data-test="timeline-bookmark-chip"]').nth(1)).toContainText('BM-BETA')

    // 取消步骤 1：星灭、chip 消失，剩一条
    await clickBookmark(modal, 1)
    await expect(modal.locator('.cstl-step[data-step="1"] [data-test="timeline-bookmark"]')).not.toHaveClass(/is-on/)
    await expect(strip.locator('[data-test="timeline-bookmark-chip"]')).toHaveCount(1)
    await expect(strip.locator('[data-test="timeline-bookmark-chip"]').first()).toContainText('BM-BETA')

    // 取消步骤 3：清单清空整条收起（等最后一个 curation POST 落服务端——
    // 星/清单断言是乐观本地态，下一用例的服务端对账不能与在途写竞态）
    const unstar2 = page.waitForResponse(r => r.url().includes('/claude/sessions/curation') && r.request().method() === 'POST')
    await clickBookmark(modal, 3)
    await expect(strip).toHaveCount(0)
    await unstar2
  })

  test('点击书签直达：呼吸高亮定位 + 与「仅命中」正交（目标不在命中自动退出）', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await clearAllBookmarks(page)
    const modal = await openReplay(page)
    const input = modal.locator('[data-test="timeline-search-input"] input')
    const onlyBtn = modal.locator('[data-test="timeline-search-hits-only"]')

    // star 步骤 1 与步骤 3（后者与 tool 同刻——书签定位应落 assistant 文本）；
    // 等第二个 curation POST 落服务端（下一用例的清理对账不能与在途写竞态）
    await clickBookmark(modal, 1)
    const star3 = page.waitForResponse(r => r.url().includes('/claude/sessions/curation') && r.request().method() === 'POST')
    await clickBookmark(modal, 3)
    await star3
    const strip = modal.locator('[data-test="timeline-bookmark-list"]')
    await expect(strip.locator('[data-test="timeline-bookmark-chip"]')).toHaveCount(2)

    // 点击结论一 chip：该轮呼吸高亮（is-focus，P-132 jumpToIndex 同款视觉）
    await strip.locator('[data-test="timeline-bookmark-chip"]').filter({ hasText: 'BM-ALPHA' }).click()
    await expect(modal.locator('.cstl-step[data-step="1"]')).toHaveClass(/is-focus/)

    // 正交性：搜索仅命中步骤 1（紧凑视图只剩 1 条），点击结论二 chip（不在
    // 命中集）→ 自动退出紧凑视图 + 定位到步骤 3（assistant 优先于同刻 tool）
    await input.fill('zebra-unicorn')
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveText('1 处命中')
    await onlyBtn.click()
    await expect(modal.locator('.cstl-step')).toHaveCount(1)
    await strip.locator('[data-test="timeline-bookmark-chip"]').filter({ hasText: 'BM-BETA' }).click()
    await expect(onlyBtn).not.toHaveClass(/is-on/)
    await expect(modal.locator('.cstl-step[data-step="3"]')).toHaveClass(/is-focus/)
    await expect(modal.locator('.cstl-step')).toHaveCount(10)
  })

  test('刷新后书签仍在：持久经服务端策展域，重开回放即恢复', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await clearAllBookmarks(page)
    const modal = await openReplay(page)
    await clickBookmark(modal, 1)
    await clickBookmark(modal, 7)
    const strip = modal.locator('[data-test="timeline-bookmark-list"]')
    await expect(strip.locator('[data-test="timeline-bookmark-chip"]')).toHaveCount(2)

    // 服务端权威对账：timeline 响应应已携带两条书签（升序）
    const resp = await page.request.get(`/api/claude/sessions/${SESSION_ID}/timeline?limit=1`)
    const body = await resp.json()
    const bms: string[] = body?.data?.bookmarks ?? []
    expect(bms).toEqual([assistantAt[1], assistantAt[7]])

    // 整页刷新（落到 home 再启动）后重开回放：星标态与清单从服务端完整恢复
    await page.goto('/')
    const modal2 = await openReplayAfterReload(page)
    await expect(modal2.locator('.cstl-step[data-step="1"] [data-test="timeline-bookmark"]')).toHaveClass(/is-on/)
    await expect(modal2.locator('.cstl-step[data-step="7"] [data-test="timeline-bookmark"]')).toHaveClass(/is-on/)
    await expect(modal2.locator('[data-test="timeline-bookmark-list"] [data-test="timeline-bookmark-chip"]')).toHaveCount(2)
    await expect(modal2.locator('[data-test="timeline-bookmark-chip"]').first()).toContainText('BM-ALPHA')
    await expect(modal2.locator('[data-test="timeline-bookmark-chip"]').nth(1)).toContainText('BM-GAMMA')

    // 收尾清理：留给书签域干净数据面（删 fixture 前）
    await clearAllBookmarks(page)
  })
})
