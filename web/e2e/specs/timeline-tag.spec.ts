import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 回放轮级语义标签 E2E（P-20261003-256）：
 * 1. 标签编辑——条目 meta 行标签钮打开内联编辑行，输入 #标签 回车提交（#前缀
 *    归一），条目 chip 与顶部标签过滤条（#标签×轮数）即时出现；编辑器内快捷
 *    复用 chips 点击切换（已挂再点=移除）；
 * 2. chips 过滤与搜索/书签正交组合——过滤条点击只留打标条目（多选 OR），与
 *    搜索「仅命中」∩ 叠加；书签跳转目标不在过滤内时自动退出过滤（定位意图
 *    优先，P-132 语义推广）；
 * 3. 刷新后标签仍在——持久经服务端 claudecur 策展域（timeline 响应携标签集）。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions/curation 的
 * tagAdd/tagRemove 扩展与 timeline 响应 tags 字段）。
 *
 * 测试数据：播种一条 10 步 fixture transcript 到真实 ~/.claude/projects
 *（与 timeline-bookmark.spec.ts 同款约定——标题带 [e2e-tag] 标记，utimes 控制
 * 在 activeWindow(5 分钟) 之外），afterAll 精确删除 fixture 文件；标签/书签经
 * API 清理（timeline 响应回读权威集逐个移除 + 双清删策展条目，防上次运行
 * 残留污染计数）。回放链路只读，不创建终端会话。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与既有 claude 会话族 spec 一致）。
 */

const MARK = '[e2e-tag]'
const FAKE_DIR_NAME = 'D--e2e-tag-fixtures'
const SESSION_ID = 'e2e-tag-c4d5e6f7-a8b9'
// 10 步 < 首屏 limit(50)：全部条目一屏加载完（虚拟窗口内全量渲染），chips/
// 过滤条断言不依赖滚动换窗
const createdFiles: string[] = []
/** assistant 轮时刻（buildFixtures 填充）：API 清理键（tagRemove/bookmarkRemove） */
const assistantAt: Record<number, string> = {}

/** 播种 fixture transcript：与 timeline-bookmark 同款 10 步形态，assistant
 *  文本轮在 1/3/7，时间正序；时刻每下标只求值一次（写入行与 assistantAt
 *  共用同一串，标签持久对账是全等断言） */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  const stamps: string[] = []
  for (let i = 0; i < 8; i++) stamps.push(new Date(Date.now() - (30 - i) * 60_000).toISOString())
  const at = (i: number) => stamps[i]!
  const lines: string[] = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
    // 步骤 0：user 指令
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} 把主题换成 coral"},"timestamp":"${at(0)}","cwd":"D:\\\\e2e-tag-fixtures"}`,
    // 步骤 1：assistant 结论（标签载体 A，正文含 BM-ALPHA 供搜索用例）
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"结论一 TAG-ALPHA：zebra-unicorn 主题切换完成"}]},"timestamp":"${at(1)}"}`,
    // 步骤 2 tool + 步骤 3 assistant 文本（同一条消息拆出，同刻）
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"themes/coral.json"}},{"type":"text","text":"结论二 TAG-BETA：预算充足可以继续"}]},"timestamp":"${at(2)}"}`,
    // 步骤 4：tool_result
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]},"timestamp":"${at(3)}"}`,
    // 步骤 5：user
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} token 预算还剩多少"},"timestamp":"${at(4)}","cwd":"D:\\\\e2e-tag-fixtures"}`,
    // 步骤 6 tool + 步骤 7 assistant 结论（标签载体 B）
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"echo budget"}},{"type":"text","text":"结论三 TAG-GAMMA：预算核对完毕可以发布"}]},"timestamp":"${at(5)}"}`,
    // 步骤 8：tool_result
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"budget ok"}]},"timestamp":"${at(6)}"}`,
    // 步骤 9：user
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} 回滚 (revert) 上一次发布"},"timestamp":"${at(7)}","cwd":"D:\\\\e2e-tag-fixtures"}`,
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

/** 清理本会话全部标签/书签 + 删策展条目（timeline 响应回读权威集逐个移除——
 *  上次运行残留无法枚举，从响应回读是唯一可靠口径；双清删条目防孤儿） */
async function clearAllCuration(page: Page) {
  const resp = await page.request.get(`/api/claude/sessions/${SESSION_ID}/timeline?limit=1`)
  const body = await resp.json()
  for (const p of (body?.data?.tags ?? []) as Array<{ at: string; tag: string }>) {
    await page.request.post('/api/claude/sessions/curation', {
      data: { sessionId: SESSION_ID, tagRemove: { at: p.at, tag: p.tag } },
    })
  }
  for (const at of (body?.data?.bookmarks ?? []) as string[]) {
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

/** 刷新后重开回放（持久用例专用）：本页此前停靠过终端管理页，localStorage
 *  启动恢复链在 home 全屏 overlay 原样复现该面板——直接在恢复的 overlay 内
 *  重开 Claude 页签与回放（overlay 会拦截 home 项目卡点击） */
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

/** 打开某步的标签编辑行（hover 显现钮后点击——同族 hover 显现惯例） */
async function openTagEditor(modal: ReturnType<Page['locator']>, step: number) {
  const stepEl = modal.locator(`.cstl-step[data-step="${step}"]`)
  await stepEl.hover()
  await stepEl.locator('[data-test="timeline-tag"]').click()
  return stepEl.locator('[data-test="timeline-tag-editor"]')
}

/** 输入标签并回车提交（等待 curation POST 落服务端——后续用例的清理对账
 *  不能与在途写竞态） */
async function typeTag(page: Page, modal: ReturnType<Page['locator']>, step: number, tag: string) {
  const editor = await openTagEditor(modal, step)
  const post = page.waitForResponse(r => r.url().includes('/claude/sessions/curation') && r.request().method() === 'POST')
  await editor.locator('[data-test="timeline-tag-input"] input').fill(tag)
  await editor.locator('[data-test="timeline-tag-input"] input').press('Enter')
  await post
}

/** star / unstar 某一步书签（hover 显现钮后点击） */
async function clickBookmark(modal: ReturnType<Page['locator']>, step: number) {
  const stepEl = modal.locator(`.cstl-step[data-step="${step}"]`)
  await stepEl.hover()
  await stepEl.locator('[data-test="timeline-bookmark"]').click()
}

test.describe('回放轮级语义标签（P-20261003-256）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('标签编辑：内联行输入提交（#前缀归一），条目 chip 与过滤条即时出现，快捷复用可移除', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await clearAllCuration(page)
    const modal = await openReplay(page)
    const strip = modal.locator('[data-test="timeline-tag-list"]')

    // 干净基线：无标签过滤条、条目无 chips
    await expect(strip).toHaveCount(0)

    // 步骤 1 输入「#架构」：#前缀归一为 架构 —— 条目 chip 与过滤条即时出现
    await typeTag(page, modal, 1, '#架构')
    await expect(modal.locator('.cstl-step[data-step="1"] [data-test="timeline-tag-chip"]')).toHaveText('#架构')
    await expect(strip).toBeVisible()
    const chips = strip.locator('[data-test="timeline-tag-filter"]')
    await expect(chips).toHaveCount(1)
    await expect(chips.first()).toContainText('#架构')
    await expect(chips.first()).toContainText('1')

    // 步骤 7 输入「修复」：过滤条两条，各计 1
    await typeTag(page, modal, 7, '修复')
    await expect(chips).toHaveCount(2)
    await expect(modal.locator('.cstl-step[data-step="7"] [data-test="timeline-tag-chip"]').first()).toContainText('#修复')

    // 编辑器内快捷复用：步骤 7 重开编辑器，「架构」呈未挂态，点击即挂（过滤条
    // 架构计数变 2）；「修复」呈已挂态，点击即摘（条目 chip 退回一枚）
    const editor7 = await openTagEditor(modal, 7)
    const archSuggest = editor7.locator('[data-test="timeline-tag-suggest"][data-tag="架构"]')
    const fixSuggest = editor7.locator('[data-test="timeline-tag-suggest"][data-tag="修复"]')
    await expect(archSuggest).not.toHaveClass(/is-on/)
    await expect(fixSuggest).toHaveClass(/is-on/)
    const post1 = page.waitForResponse(r => r.url().includes('/claude/sessions/curation') && r.request().method() === 'POST')
    await archSuggest.click()
    await post1
    await expect(modal.locator('.cstl-step[data-step="7"] [data-test="timeline-tag-chip"]')).toHaveCount(2)
    const archChip = chips.filter({ hasText: '#架构' })
    await expect(archChip).toContainText('2')
    const post2 = page.waitForResponse(r => r.url().includes('/claude/sessions/curation') && r.request().method() === 'POST')
    await fixSuggest.click()
    await post2
    await expect(modal.locator('.cstl-step[data-step="7"] [data-test="timeline-tag-chip"]')).toHaveCount(1)

    // 收尾：清空本会话策展（留给下一用例干净数据面）
    await clearAllCuration(page)
  })

  test('chips 过滤与搜索/书签正交组合：过滤只留打标条目，与「仅命中」∩ 叠加，书签跳转自动退出', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await clearAllCuration(page)
    const modal = await openReplay(page)
    const input = modal.locator('[data-test="timeline-search-input"] input')
    const onlyBtn = modal.locator('[data-test="timeline-search-hits-only"]')

    // 播数据：步骤 1 架构、步骤 7 修复；步骤 1 另加书签（组合用例的跳转目标）
    await typeTag(page, modal, 1, '架构')
    await clickBookmark(modal, 1)
    const post7 = page.waitForResponse(r => r.url().includes('/claude/sessions/curation') && r.request().method() === 'POST')
    await typeTag(page, modal, 7, '修复')
    await post7

    // 点击「架构」chip：只剩步骤 1，chip 高亮
    const archChip = modal.locator('[data-test="timeline-tag-filter"][data-tag="架构"]')
    await archChip.click()
    await expect(archChip).toHaveClass(/is-on/)
    await expect(modal.locator('.cstl-step')).toHaveCount(1)
    await expect(modal.locator('.cstl-step[data-step="1"]')).toBeVisible()

    // 与搜索正交 ∩：搜索「预算」命中步骤 3/5/7（均未挂架构）→ 交集为空，空态
    // 按标签口径提示（非「没有命中的步骤」）
    await input.fill('预算')
    await onlyBtn.click()
    await expect(modal.locator('.cstl-step')).toHaveCount(0)
    await expect(modal.locator('.cstl-state')).toContainText('没有打了所选标签的条目')

    // 取消标签过滤 → 恢复为仅命中的 3 步（3/5/7）——两过滤态互不读写
    await archChip.click()
    await expect(modal.locator('.cstl-step')).toHaveCount(3)

    // 书签跳转 × 标签过滤：切回「修复」（步骤 7 唯一可见），点击书签 chip
    //（目标=步骤 1 不在过滤内）→ 过滤自动退出 + 呼吸高亮定位步骤 1
    await modal.locator('[data-test="timeline-tag-filter"][data-tag="修复"]').click()
    await expect(modal.locator('.cstl-step')).toHaveCount(1)
    await modal.locator('[data-test="timeline-bookmark-chip"]').click()
    await expect(onlyBtn).not.toHaveClass(/is-on/)
    await expect(modal.locator('.cstl-step')).toHaveCount(10)
    await expect(modal.locator('.cstl-step[data-step="1"]')).toHaveClass(/is-focus/)
    await expect(archChip).not.toHaveClass(/is-on/)

    // 收尾清理
    await clearAllCuration(page)
  })

  test('刷新后标签仍在：持久经服务端策展域，重开回放即恢复且可继续过滤', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await clearAllCuration(page)
    const modal = await openReplay(page)
    await typeTag(page, modal, 1, '架构')
    const post7 = page.waitForResponse(r => r.url().includes('/claude/sessions/curation') && r.request().method() === 'POST')
    await typeTag(page, modal, 7, '修复')
    await post7

    // 服务端权威对账：timeline 响应应已携带两对 (at, tag)
    const resp = await page.request.get(`/api/claude/sessions/${SESSION_ID}/timeline?limit=1`)
    const body = await resp.json()
    const tags = (body?.data?.tags ?? []) as Array<{ at: string; tag: string }>
    expect(tags).toEqual([
      { at: assistantAt[1], tag: '架构' },
      { at: assistantAt[7], tag: '修复' },
    ])

    // 整页刷新（落到 home 再启动）后重开回放：chips 与过滤条从服务端完整恢复
    await page.goto('/')
    const modal2 = await openReplayAfterReload(page)
    await expect(modal2.locator('.cstl-step[data-step="1"] [data-test="timeline-tag-chip"]')).toHaveText('#架构')
    await expect(modal2.locator('.cstl-step[data-step="7"] [data-test="timeline-tag-chip"]').first()).toContainText('#修复')
    await expect(modal2.locator('[data-test="timeline-tag-filter"]')).toHaveCount(2)

    // 恢复后的过滤条可继续用：「架构」→ 只剩步骤 1
    await modal2.locator('[data-test="timeline-tag-filter"][data-tag="架构"]').click()
    await expect(modal2.locator('.cstl-step')).toHaveCount(1)
    await expect(modal2.locator('.cstl-step[data-step="1"]')).toBeVisible()

    // 收尾清理：留给标签域干净数据面（删 fixture 前）
    await clearAllCuration(page)
  })
})
