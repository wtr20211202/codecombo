import { test, expect, type Locator, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 会话历史全文搜索 E2E（P-20261003-19）：选择器顶部搜索框（防抖 300ms）→
 * 跨 transcripts 命中带上下文（≤2 行）→ 点击命中行直达回放弹层并定位到
 * 命中时刻（focusAt，P-82 定位高亮）。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions/search）。
 *
 * 测试数据：播种两条 fixture transcript 到真实 ~/.claude/projects（与
 * claude-timeline.spec.ts 同款约定——标题带 [e2e-ss] 标记，关键词为随机
 * token 保证全语料唯一，utimes 控制在 activeWindow(5 分钟) 之外），
 * afterAll 精确删除 fixture 文件。安全断言：命中上下文里的 password= 赋值
 * 必须以 *** 形态出现（P-108 敏感遮蔽，检索面不放大敏感曝光）。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与既有 claude 会话族 spec 一致）。
 */

const MARK = '[e2e-ss]'
const FAKE_DIR_NAME = 'D--e2e-ss-fixtures'
// 随机 token 关键词：真实语料（本机其他会话）不会含有的子串，保证命中确定
const KEYWORD = 'wx-reconnect-e2e-7q3f'
const SECRET = 'e2esecret-9x4k-neverleak'
const SESSION_A = 'e2e-ss-a1b2c3d4-0001' // 较新：user 消息含关键词 + password= 赋值（遮蔽断言）
const SESSION_B = 'e2e-ss-a1b2c3d4-0002' // 较旧：assistant 消息含关键词
const createdFiles: string[] = []

function at(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString()
}

/** 播种两条 fixture：A 较新（user 行命中+敏感赋值），B 较旧（assistant 行命中）。
 *  mtime 明确错开（A=10 分钟前、B=30 分钟前，均在 activeWindow 5 分钟外）——
 *  命中区按最近活跃倒序，首条命中的确定性依赖此刻意分层 */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const files: Record<string, { lines: string[]; ageMin: number }> = {
    [`${SESSION_A}.jsonl`]: {
      ageMin: 10,
      lines: [
        `{"type":"last-prompt","sessionId":"${SESSION_A}"}`,
        `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} A 会话：修 ${KEYWORD} 时 export password=${SECRET} 不要外泄"},"timestamp":"${at(20)}","cwd":"D:\\\\e2e-ss-fixtures"}`,
        `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"已定位 ${KEYWORD} 的成因"}]},"timestamp":"${at(19)}"}`,
      ],
    },
    [`${SESSION_B}.jsonl`]: {
      ageMin: 30,
      lines: [
        `{"type":"last-prompt","sessionId":"${SESSION_B}"}`,
        `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} B 会话"},"timestamp":"${at(60)}","cwd":"D:\\\\e2e-ss-fixtures"}`,
        `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"assistant 提到 ${KEYWORD} 的重连方案"}]},"timestamp":"${at(59)}"}`,
      ],
    },
  }
  for (const [name, fx] of Object.entries(files)) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, fx.lines.join('\n') + '\n', 'utf-8')
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

/** 输入关键词并等待全文搜索响应返回 */
async function searchFullText(page: Page, picker: Locator, term: string) {
  const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions/search'))
  await picker.locator('input').fill(term)
  await searchResp
}

test.describe('会话历史全文搜索（P-20261003-19）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('搜关键词→命中带上下文（敏感遮蔽）→点击直达回放并定位', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const picker = await openClaudeTab(page)

    await searchFullText(page, picker, KEYWORD)

    // 命中区：2 个会话命中（标题带标记的 fixture 对），区头计数可见。
    // truncated 徽标不作断言：服务端扫的是本机全语料（真实会话可超护栏——
    // 大文件跳过/200 会话封顶属正常态），非本 spec 可控
    const hits = picker.locator('[data-test="session-search-hit"]')
    await expect(hits).toHaveCount(2, { timeout: 15000 })
    await expect(picker.locator('.csp-ft-head')).toContainText('全文命中')
    await expect(picker.locator('.csp-ft-head')).toContainText('2')

    // 最近活跃在前：首条命中 = 较新的 A 会话，标题与目录可见
    const first = hits.first()
    await expect(first.locator('.csp-hit-title')).toContainText(MARK)
    await expect(first.locator('.csp-hit-title')).toContainText('A 会话')

    // 敏感遮蔽（修正项）：命中区（标题+上下文）里 password= 赋值呈 *** 形态，
    // 明文不出现。断言收口在全文命中区——下方会话列表的标题展示是列表端点的
    // 既有行为（P5 既有面，不属本提案检索链）
    await expect(first.locator('.csp-hit-line').first()).toContainText(`${KEYWORD} 时 export password=***`)
    await expect(first.locator('.csp-hit-line').first()).toContainText(KEYWORD)
    const ftText = await picker.locator('.csp-ft').innerText()
    expect(ftText).not.toContain(SECRET)

    // 点击命中行 → 回放弹层打开并定位到命中时刻：时间线内可见命中原文。
    // （回放正文不作文遮蔽断言：transcript 直览是时间线端点的既有行为，
    // P-108 修正项口径是「检索命中上下文」这一新展示面，见服务端 search.go）
    await first.click()
    const modal = page.locator('.n-modal .cstl-root')
    await expect(modal).toBeVisible({ timeout: 10000 })
    await expect(modal.locator('.cstl-step').filter({ hasText: KEYWORD }).first()).toBeVisible({ timeout: 15000 })

    // 关闭弹层
    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })

  test('无命中关键词：全文命中区收口为空态提示', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const picker = await openClaudeTab(page)

    await searchFullText(page, picker, 'e2e-nohit-kq93mz')

    await expect(picker.locator('.csp-ft-none')).toContainText('会话全文无命中', { timeout: 15000 })
    await expect(picker.locator('[data-test="session-search-hit"]')).toHaveCount(0)
  })
})
