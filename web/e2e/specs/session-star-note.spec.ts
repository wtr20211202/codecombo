import { test, expect, type Locator, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 会话星标与备注 E2E（P-20261003-67 历史策展层）：
 * 1. 星标置顶——UI 点星 → 「★ 星标」分组出现且行入组 → 服务端分页前置顶
 *    （q 窄化响应里更旧的星标会话排在更新的未星标会话之前）→ 取消/恢复往返；
 * 2. 备注写入——行内弹层编辑 → 行内预览 → 全文搜索命中 note-only 会话且带
 *    「备注」来源标识（transcript 无该词，命中只能来自备注 = 溯源正确）。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions/curation）。
 *
 * 测试数据：播种两条 fixture transcript 到真实 ~/.claude/projects（与
 * session-search.spec.ts 同款约定——标题带 [e2e-sn] 标记 + 随机 token 保证
 * 唯一，utimes 控制在 activeWindow(5 分钟) 之外），afterAll 精确删除 fixture
 * 文件；策展数据经 API 清理（部分更新语义：starred=false + note='' 即删条目）。
 *
 * 语料拥挤防御：列表 q 用 fixture 唯一标记窄化（列表只剩 fixture 行，不依赖
 * 真实语料的规模与时序）；服务端置顶在分页前，星标行必进第一屏。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与既有 claude 会话族 spec 一致）。
 */

const MARK = '[e2e-sn]'
const FAKE_DIR_NAME = 'D--e2e-sn-fixtures'
// 随机 token：真实语料不会含有的子串，note-only 命中的确定性依赖它
const NOTE_KEYWORD = 'sn-note-only-e2e-k8x2'
const SESSION_STAR = 'e2e-sn-a1b2c3d4-0001' // 较旧（50 分钟前）：星标置顶载体
const SESSION_NOTE = 'e2e-sn-a1b2c3d4-0002' // 较新（10 分钟前）：备注载体
const STAR_TITLE = `${MARK} C 会话：星标置顶载体`
const NOTE_TITLE = `${MARK} A 会话：备注载体`
const createdFiles: string[] = []

function at(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString()
}

/** 播种两条 fixture：A 较新（备注载体），C 较旧（星标载体）。内容均不含
 * NOTE_KEYWORD——搜索命中它时只能是备注来源（溯源断言的前提） */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const files: Record<string, { title: string; ageMin: number }> = {
    [`${SESSION_NOTE}.jsonl`]: { title: NOTE_TITLE, ageMin: 10 },
    [`${SESSION_STAR}.jsonl`]: { title: STAR_TITLE, ageMin: 50 },
  }
  for (const [name, fx] of Object.entries(files)) {
    const file = path.join(dir, name)
    const lines = [
      `{"type":"last-prompt","sessionId":"${name.replace('.jsonl', '')}"}`,
      `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${fx.title}"},"timestamp":"${at(fx.ageMin + 1)}","cwd":"D:\\\\e2e-sn-fixtures"}`,
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"收到"}]},"timestamp":"${at(fx.ageMin)}"}`,
    ]
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
    const m = new Date(Date.now() - fx.ageMin * 60_000)
    fs.utimesSync(file, m, m)
    createdFiles.push(file)
  }
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

/** 清理策展条目（部分更新语义：双清 = 服务端删条目），防上次运行残留 */
async function clearCuration(page: Page, ids: string[]) {
  for (const id of ids) {
    await page.request.post('/api/claude/sessions/curation', {
      data: { sessionId: id, starred: false, note: '' },
    })
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

/** 列表 q 窄化（防抖 300ms 后 fetchPage）：fixture 标记唯一 → 列表只剩 fixture 行 */
async function narrowListByMark(page: Page, picker: Locator, term: string) {
  const listResp = page.waitForResponse(r => r.url().includes('/claude/sessions?') && !r.url().includes('/search'))
  await picker.locator('.csp-toolbar input').fill(term)
  await listResp
  // 全文命中区同词触发（P-19 既有链路），等待其返回避免与后续断言竞态
  await page.waitForResponse(r => r.url().includes('/claude/sessions/search')).catch(() => { /* 命中区失败不阻塞 */ })
}

test.describe('会话星标与备注（P-20261003-67）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('星标置顶：UI 点星入置顶分组→服务端分页前置顶→取消/恢复往返', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await clearCuration(page, [SESSION_STAR, SESSION_NOTE])
    const picker = await openClaudeTab(page)
    await narrowListByMark(page, picker, MARK)

    const starRow = picker.locator('.csp-row').filter({ hasText: STAR_TITLE })
    const noteRow = picker.locator('.csp-row').filter({ hasText: NOTE_TITLE })
    await expect(starRow).toBeVisible({ timeout: 10000 })
    await expect(noteRow).toBeVisible()
    // 干净基线：无置顶分组、C 未星标
    await expect(picker.locator('[data-test="session-star-bucket"]')).toHaveCount(0)
    await expect(starRow.locator('[data-test="session-star"]')).not.toHaveClass(/is-on/)

    // UI 点星：置顶分组出现，紧跟分组标签的首行就是星标行（相邻兄弟语义，
    // ~ 通配会误匹配后续时间分组的行）；未星标的 A 不抢位
    // （点击前先布好 refreshList 响应等待：toggleStar 成功后服务端置顶重取，
    // 列表重排窗口内的后续行内点击会随 DOM 行替换落空——P-114 检索态误触
    // 同族先例，fulle2e run7 取消星标点击实测丢失效）
    // P-20261031-1 后六钮静息态 display:none（hover/键盘活动行才显形）：
    // C 基线在更新的 A 之后非首行（fetchPage 全量刷新把键盘活动位固定在
    // 首行，ClaudeSessionPicker fetchPage activeIdx=0），星钮未显形不可点
    // （Playwright 可见性门禁先于鼠标移动，不 hover 直接点必超时）——
    // 先 hover 行走真实用户「移入行→星钮显现→点星」路径（session-relay
    // relayAndCapture 同款惯例），产品 hover 显现语义无回归
    await starRow.hover()
    const starRefresh = page.waitForResponse(r => r.url().includes('/claude/sessions?') && !r.url().includes('/search'))
    await starRow.locator('[data-test="session-star"]').click()
    await expect(picker.locator('[data-test="session-star-bucket"]')).toBeVisible({ timeout: 10000 })
    await expect(picker.locator('[data-test="session-star-bucket"] + .csp-row').filter({ hasText: STAR_TITLE })).toHaveCount(1)
    await expect(starRow.locator('[data-test="session-star"]')).toHaveClass(/is-on/)
    await starRefresh

    // 服务端分页前置顶：q 窄化响应里更旧的 C（星标）排在更新的 A（未星标）之前
    const listResp = await page.request.get(`/api/claude/sessions?limit=20&q=${encodeURIComponent(MARK)}`)
    const sessions = (await listResp.json()).data.sessions as { id: string; starred?: boolean }[]
    expect(sessions.map(s => s.id)).toEqual([SESSION_STAR, SESSION_NOTE])
    expect(sessions[0]!.starred).toBe(true)

    // 取消星标：is-on 消失、置顶分组收起、服务端字段归零。（is-on 消失与分组
    // 收起都是乐观本地态，不能证明服务端写已落——服务端 GET 前先等 curation
    // 写响应与其触发的列表重取，防读旧快照误判，fulle2e 实测形态）
    const unstarCuration = page.waitForResponse(r => r.url().includes('/claude/sessions/curation'))
    const unstarRefresh = page.waitForResponse(r => r.url().includes('/claude/sessions?') && !r.url().includes('/search'))
    await starRow.locator('[data-test="session-star"]').click()
    await expect(starRow.locator('[data-test="session-star"]')).not.toHaveClass(/is-on/)
    await expect(picker.locator('[data-test="session-star-bucket"]')).toHaveCount(0, { timeout: 10000 })
    await unstarCuration
    await unstarRefresh
    const after = await (await page.request.get(`/api/claude/sessions?limit=20&q=${encodeURIComponent(MARK)}`)).json()
    const afterList = after.data.sessions as { id: string; starred?: boolean }[]
    expect(afterList.find(s => s.id === SESSION_STAR)?.starred ?? false).toBe(false)

    // 恢复星标（UI 正向切换回归）：置顶分组与实心星回归
    // 取消星标重取后 C 落回 A 之后非首行，星钮回静息 display:none——同上先 hover
    await starRow.hover()
    await starRow.locator('[data-test="session-star"]').click()
    await expect(starRow.locator('[data-test="session-star"]')).toHaveClass(/is-on/)
    await expect(picker.locator('[data-test="session-star-bucket"]')).toBeVisible({ timeout: 10000 })
  })

  test('备注：行内弹层写入→行内预览→全文搜索 note-only 命中带「备注」标识', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await clearCuration(page, [SESSION_NOTE, SESSION_STAR])
    const picker = await openClaudeTab(page)
    await narrowListByMark(page, picker, MARK)

    const noteRow = picker.locator('.csp-row').filter({ hasText: NOTE_TITLE })
    await expect(noteRow).toBeVisible({ timeout: 10000 })

    // 行内弹层编辑备注（≤200 由 maxlength 保证）
    await noteRow.locator('[data-test="session-note-btn"]').click()
    const editor = page.locator('[data-test="note-editor"]')
    await expect(editor).toBeVisible({ timeout: 5000 })
    await editor.locator('textarea').fill(`${NOTE_KEYWORD} WebSocket 重连的结论记在这里`)
    // 保存以服务端 POST 落地为准（弹层关闭/本地 mutation 时机有竞态，不作断言依据）
    const saveResp = page.waitForResponse(r => r.url().includes('/claude/sessions/curation') && r.request().method() === 'POST')
    await editor.locator('button').filter({ hasText: '保存' }).click()
    const saveBody = await (await saveResp).json()
    expect(saveBody.data.note).toContain(NOTE_KEYWORD)

    // 重取列表（重输同词触发 fetchPage，行对象来自服务端权威状态）后行内预览呈现
    await narrowListByMark(page, picker, MARK)
    await expect(noteRow.locator('[data-test="session-note-text"]')).toContainText(NOTE_KEYWORD, { timeout: 10000 })

    // 全文搜索备注词：transcript 无该词 → note-only 命中（无上下文行），
    // 行上带「备注」来源标识与备注原文
    const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions/search'))
    await picker.locator('.csp-toolbar input').fill(NOTE_KEYWORD)
    await searchResp
    const hit = picker.locator('[data-test="session-search-hit"]').filter({ hasText: NOTE_TITLE })
    await expect(hit).toHaveCount(1, { timeout: 15000 })
    await expect(hit.locator('[data-test="search-hit-note"]')).toContainText('备注')
    await expect(hit.locator('[data-test="search-hit-note"]')).toContainText(NOTE_KEYWORD)
    await expect(hit.locator('.csp-hit-line')).toHaveCount(0)

    // 收尾清理备注（留给星标域干净数据面）
    await clearCuration(page, [SESSION_NOTE])
  })
})
