import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话回放导出原始 JSONL E2E（P-20261003-60 + P-20261003-113 出域相对化）：
 * 回放页工具条「导出」下拉 →「原始 JSONL」→ 下载内容 = 源 transcript 按会话
 * cwd 相对化改写后的字节（cwd 字段等主机绝对路径收敛为相对形态，行结构/换行/
 * 其余字节逐字节保留）+ 下载名 .jsonl + 数据出域审计入账（claude.export）。
 * md/jsonl 双选项的存在性由 session-export-md.spec.ts 断言。
 *
 * 前置：simple-coding 已运行（含 GET /api/claude/sessions/:id/export?format=jsonl）。
 *
 * 测试数据：播种 fixture transcript 到真实 ~/.claude/projects（与
 * session-export-md.spec.ts 同款约定，独立 id/目录互不干扰），afterAll 精确
 * 删除。拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（同域既有用例一致）。
 */

const MARK = '[e2e-exp-raw]'
const FAKE_DIR_NAME = 'D--e2e-exp-raw-fixtures'
const SESSION_ID = 'e2e-exp-raw-a1b2c3d4-e5f6'
const USER_TEXT_1 = `${MARK} 原始导出验证：帮我排查心跳`
const createdFiles: string[] = []
let fixturePath = ''

/** 播种 fixture transcript（含元信息行/思考/工具行——原样直传应全部保留） */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  fixturePath = file
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
  const lines = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: USER_TEXT_1 },
      timestamp: at(5), cwd: 'D:\\e2e-exp-raw-fixtures',
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [
        { type: 'thinking', thinking: '先确认服务端口' },
        { type: 'tool_use', id: 'toolu_r1', name: 'Bash', input: { command: 'grep -rn heartbeat server/' } },
      ] },
      timestamp: at(4),
    }),
  ]
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  // mtime 落在服务端 activeWindow(5 分钟) 外：行可交互、列表可见
  const at10 = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, at10, at10)
  createdFiles.push(file)
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

// 用 API 解锁拿 token（audit-log.spec 同款；锁定关闭时 unlock 端点同样发 token）
async function unlockToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  if (!res.ok()) throw new Error(`unlock failed: ${res.status()}`)
  return ((await res.json()) as { token: string }).token
}

async function openReplayModal(page: Page) {
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.ats-tab', { hasText: 'Claude' }).click()
  const picker = view.locator('.csp-root')
  await expect(picker).toBeVisible({ timeout: 8000 })
  // 搜索标记 → 唯一 fixture 行 → 行内「回放」角标 → 弹层时间线
  const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
  await picker.locator('input').fill(MARK)
  await searchResp
  const row = picker.locator('.csp-row').filter({ hasText: MARK }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.hover()
  await row.locator('.csp-row-replay').click()
  const modal = page.locator('.n-modal .cstl-root')
  await expect(modal).toBeVisible({ timeout: 10000 })
  await expect(modal.locator('.cstl-step').first()).toBeVisible({ timeout: 15000 })
  return modal
}

test.describe('会话回放导出原始 JSONL（P-20261003-60）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('下拉选原始 JSONL → 下载内容按 cwd 相对化 + .jsonl 下载名 + 审计入账', async ({ page, request }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplayModal(page)

    // 工具条「导出」下拉 → 「原始 JSONL」选项 → blob 下载
    await modal.locator('[data-test="timeline-export"]').click()
    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()
    const dlPromise = page.waitForEvent('download')
    await menu.locator('.n-dropdown-option').filter({ hasText: 'JSONL' }).first().click()
    const dl = await dlPromise
    const suggested = dl.suggestedFilename()
    expect(suggested).toMatch(/^claude-.*\d{8}\.jsonl$/)
    expect(suggested).toContain('e2e-exp-raw')

    // 出域相对化（P-20261003-113）：cwd 字段值收敛 "."（主机布局不出域），
    // 其余字节逐字节保留（行结构/换行/思考/工具行原样）
    const downloaded = fs.readFileSync(await dl.path()).toString('utf-8')
    const source = fs.readFileSync(fixturePath, 'utf-8')
    expect(downloaded).toBe(source.replaceAll('D:\\\\e2e-exp-raw-fixtures', '.'))
    expect(downloaded).toContain('"cwd":"."')
    expect(downloaded).not.toContain('e2e-exp-raw-fixtures')
    expect(downloaded).toContain(USER_TEXT_1)

    // 数据出域审计入账：claude.export 成功事件，detail = 会话 id（内容不入账）
    const token = await unlockToken(request)
    const auditResp = await request.get(`${API_BASE}/api/audit?limit=50`, {
      headers: { 'X-Lock-Token': token },
    })
    expect(auditResp.ok()).toBe(true)
    const audit = (await auditResp.json()) as { data: Array<{ action: string; result: string; detail: string }> }
    const hit = audit.data.find(e => e.action === 'claude.export' && e.detail === SESSION_ID)
    expect(hit).toBeTruthy()
    expect(hit!.result).toBe('success')

    // 关闭弹层
    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })
})
