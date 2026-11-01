import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 回放策展导出 E2E（P-20261003-144）：导出下拉策展组「当前过滤结果 / 书签轮」
 * 与回放导航三件（过滤/书签）联动的知识回收闭环——
 * 1. 过滤后导出仅含命中轮：搜索命中集导出为客户端渲染 markdown，文档头带
 *    命中口径注记（查询词+匹配语义），未命中轮不出现在文档里；
 * 2. 书签导出仅含书签轮：star 过的 assistant 结论轮导出，未标记轮不出现；
 * 3. 全量选项不变：既有「Markdown（人读文档）」仍走服务端渲染全量文档
 *    （含全部轮次，无策展导出标记）。
 *
 * 前置：simple-coding 已运行（含 P-122 书签链的 curation 端点扩展）。
 *
 * 测试数据：播种一条 10 步 fixture transcript 到真实 ~/.claude/projects
 *（与 timeline-bookmark.spec.ts 同款约定——标题带 [e2e-cexp] 标记，utimes
 * 控制在 activeWindow(5 分钟) 之外），afterAll 精确删除 fixture 文件；书签经
 * API 清理（timeline 响应回读书签集逐个 bookmarkRemove + 双清删条目）。
 * 回放链路只读，不创建终端会话。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与既有 claude 会话族 spec 一致）。
 */

const MARK = '[e2e-cexp]'
const FAKE_DIR_NAME = 'D--e2e-cexp-fixtures'
const SESSION_ID = 'e2e-cexp-c1d2e3f4-a5b6'
const CONCLUSION_1 = '结论一 CX-ALPHA：zebra-unicorn 主题切换完成'
const CONCLUSION_2 = '结论二 CX-BETA：预算充足可以继续'
const CONCLUSION_3 = '结论三 CX-GAMMA：预算核对完毕可以发布'
const createdFiles: string[] = []
/** assistant 轮时刻（buildFixtures 填充）：书签 API 清理用（bookmarkRemove 键） */
const assistantAt: Record<number, string> = {}

/** 播种 fixture transcript：10 步，assistant 结论轮在 1/3/7（与 tool 混行同刻），
 *  时间正序；「zebra-unicorn」仅命中结论一轮（过滤导出用） */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  const stamps: string[] = []
  for (let i = 0; i < 8; i++) stamps.push(new Date(Date.now() - (20 - i) * 60_000).toISOString())
  const at = (i: number) => stamps[i]!
  const lines: string[] = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} 把主题换成 coral"},"timestamp":"${at(0)}","cwd":"D:\\\\e2e-cexp-fixtures"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"${CONCLUSION_1}"}]},"timestamp":"${at(1)}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"themes/coral.json"}},{"type":"text","text":"${CONCLUSION_2}"}]},"timestamp":"${at(2)}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]},"timestamp":"${at(3)}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} token 预算还剩多少"},"timestamp":"${at(4)}","cwd":"D:\\\\e2e-cexp-fixtures"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"echo budget"}},{"type":"text","text":"${CONCLUSION_3}"}]},"timestamp":"${at(5)}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"budget ok"}]},"timestamp":"${at(6)}"}`,
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} 回滚 (revert) 上一次发布"},"timestamp":"${at(7)}","cwd":"D:\\\\e2e-cexp-fixtures"}`,
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

/** star 某一步（hover 显现钮后点击——同族 hover 显现惯例） */
async function clickBookmark(modal: ReturnType<Page['locator']>, step: number) {
  const stepEl = modal.locator(`.cstl-step[data-step="${step}"]`)
  await stepEl.hover()
  await stepEl.locator('[data-test="timeline-bookmark"]').click()
}

/** 打开导出下拉并点选策展/全量项，等待下载完成返回（naive 禁用项是
 *  --disabled 修饰类而非原生 disabled 属性，须按类断言可选） */
async function exportVia(page: Page, modal: ReturnType<Page['locator']>, optionText: string) {
  await modal.locator('[data-test="timeline-export"]').click()
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  const option = menu.locator('.n-dropdown-option').filter({ hasText: optionText }).first()
  await expect(option.locator('.n-dropdown-option-body')).not.toHaveClass(/--disabled/)
  const dlPromise = page.waitForEvent('download')
  await option.click()
  return await dlPromise
}

test.describe('回放策展导出（P-20261003-144）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('过滤后导出仅含命中轮：文档头带命中口径注记，未命中轮不出现', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await clearAllBookmarks(page)
    const modal = await openReplay(page)

    // 搜索 zebra-unicorn：仅结论一轮命中（命中计数徽标确认过滤集身份）
    const input = modal.locator('[data-test="timeline-search-input"] input')
    await input.fill('zebra-unicorn')
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveText('1 处命中')

    // 导出下拉策展组「当前过滤结果」：计数后缀可预读，点击即下载
    const dl = await exportVia(page, modal, '当前过滤结果')
    expect(dl.suggestedFilename()).toMatch(/^claude-hits-.*\.md$/)
    const md = fs.readFileSync(await dl.path(), 'utf-8')
    // 策展文档头：口径注记引用查询词（命中高亮上下文口径如实注记）
    expect(md).toContain('（策展导出）')
    expect(md).toContain('「zebra-unicorn」的命中轮次')
    // 仅含命中轮：结论一在场，未命中的结论二/三与 user 轮不在文档里
    expect(md).toContain('结论一 CX-ALPHA')
    expect(md).not.toContain('结论二 CX-BETA')
    expect(md).not.toContain('结论三 CX-GAMMA')
    expect(md).not.toContain('回滚 (revert) 上一次发布')

    // 全量选项不变：既有「Markdown（人读文档）」仍导出服务端全量文档
    const dlFull = await exportVia(page, modal, 'Markdown（人读文档）')
    const full = fs.readFileSync(await dlFull.path(), 'utf-8')
    expect(full.startsWith('# Claude 会话：')).toBe(true)
    expect(full).not.toContain('（策展导出）')
    expect(full).toContain('结论一 CX-ALPHA')
    expect(full).toContain('结论二 CX-BETA')
    expect(full).toContain('结论三 CX-GAMMA')
    expect(dlFull.suggestedFilename()).not.toMatch(/^claude-(hits|bookmarks)-/)

    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })

  test('书签导出仅含书签轮：star 结论轮导出，未标记轮不出现', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await clearAllBookmarks(page)
    const modal = await openReplay(page)

    // star 结论一轮与结论二轮（步骤 1/3），等 curation POST 落服务端
    await clickBookmark(modal, 1)
    const star3 = page.waitForResponse(r => r.url().includes('/claude/sessions/curation') && r.request().method() === 'POST')
    await clickBookmark(modal, 3)
    await star3
    await expect(modal.locator('[data-test="timeline-bookmark-chip"]')).toHaveCount(2)

    // 导出下拉策展组「书签轮」：仅两轮结论在文档里
    const dl = await exportVia(page, modal, '书签轮')
    expect(dl.suggestedFilename()).toMatch(/^claude-bookmarks-.*\.md$/)
    const md = fs.readFileSync(await dl.path(), 'utf-8')
    expect(md).toContain('仅包含书签标记的轮次')
    expect(md).toContain('结论一 CX-ALPHA')
    expect(md).toContain('结论二 CX-BETA')
    expect(md).not.toContain('结论三 CX-GAMMA')
    expect(md).not.toContain('回滚 (revert) 上一次发布')

    // 收尾清理：留给书签域干净数据面（删 fixture 前）
    await clearAllBookmarks(page)
    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })
})
