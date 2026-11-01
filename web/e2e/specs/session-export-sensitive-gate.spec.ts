import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话导出敏感扫描警示——出域闸第三面 E2E（P-20261004-113）：
 *   1. API md：含 token 形态的 transcript 导出 → 200 JSON warnings（类型计数，
 *      无附件头、无原文）→ confirm=1 → 全文完整无遮蔽；
 *   2. API jsonl：同一 fixture → 警示 → confirm=1 → 相对化改写后的全文（扫描
 *      挂点在改写链下游，出域字节与无闸路径同源）；
 *   3. API 终端 txt：会话输出回显 token → 警示 → confirm=1 → 附件含原文；
 *   4. UI：回放页导出 → 「敏感内容出域确认」弹层展示命中类型 → 取消零下载 →
 *      重开确认后下载全文。
 * 无敏感零打扰由既有四支导出 spec（session-export-md/jsonl、terminal-export-
 * output、terminal-sensitive-egress）回归覆盖。
 *
 * 测试数据：播种 fixture transcript 到真实 ~/.claude/projects（同域既有约定），
 * afterAll 精确删除。拓扑：服务实例与测试同机（session-export-md.spec 同款）。
 */

const MARK = '[e2e-sens-exp]'
const FAKE_DIR_NAME = 'D--e2e-sens-exp-fixtures'
const SESSION_ID = 'e2e-sens-exp-a1b2c3d4-e5f6'
const SECRET = 'ghp_e2eSensitiveGate0123456789abcdefghij'
const USER_TEXT_1 = `${MARK} 调试凭据 ${SECRET}`
const PROJECT_NAME = 'simple-coding'
const createdFiles: string[] = []

/** 播种含凭据形态的 fixture transcript（token 同时出现在标题与正文） */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
  const lines = [
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: USER_TEXT_1 },
      timestamp: at(6), cwd: 'D:\\e2e-sens-exp-fixtures',
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '收到，排查中' }] },
      timestamp: at(5),
    }),
  ]
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  const at10 = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, at10, at10)
  createdFiles.push(file)
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  if (!res.ok()) throw new Error(`unlock failed: ${res.status()}`)
  const token = ((await res.json()) as { token: string }).token
  return { 'X-Lock-Token': token }
}

async function openReplayModal(page: Page) {
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
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
  await expect(modal.locator('.cstl-step').first()).toBeVisible({ timeout: 15000 })
  return modal
}

test.describe('会话导出敏感扫描警示（P-20261004-113）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('API md：首跳 JSON 警示（类型计数无原文）→ confirm=1 全文完整', async ({ request }) => {
    const headers = await unlockHeaders(request)
    const url = `${API_BASE}/api/claude/sessions/${SESSION_ID}/export`

    const gated = await request.get(url, { headers })
    expect(gated.status()).toBe(200)
    expect(gated.headers()['content-type'] || '').toContain('application/json')
    expect(gated.headers()['content-disposition']).toBeUndefined()
    const body = (await gated.json()) as {
      warnings?: string[]
      sensitiveHits?: { type: string; count: number }[]
    }
    expect(body.warnings).toEqual(['sensitive-content'])
    expect(body.sensitiveHits?.some(h => h.type === 'known-token' && h.count >= 1)).toBe(true)
    // 警示只回类型计数：响应体里绝不能出现凭据原文
    expect(JSON.stringify(body)).not.toContain(SECRET)

    const ok = await request.get(`${url}?confirm=1`, { headers })
    expect(ok.status()).toBe(200)
    expect(ok.headers()['content-disposition'] || '').toContain('attachment')
    const md = await ok.text()
    expect(md).toContain(USER_TEXT_1)
    // 默认原样保真：确认后原文完整无遮蔽
    expect(md).toContain(SECRET)
  })

  test('API jsonl：警示 → confirm=1 出相对化改写后的全文', async ({ request }) => {
    const headers = await unlockHeaders(request)
    const url = `${API_BASE}/api/claude/sessions/${SESSION_ID}/export?format=jsonl`

    const gated = await request.get(url, { headers })
    expect(gated.status()).toBe(200)
    expect(gated.headers()['content-type'] || '').toContain('application/json')
    expect(gated.headers()['content-disposition']).toBeUndefined()
    const body = (await gated.json()) as { warnings?: string[]; sensitiveHits?: { type: string; count: number }[] }
    expect(body.warnings).toEqual(['sensitive-content'])
    expect(body.sensitiveHits?.some(h => h.type === 'known-token')).toBe(true)
    expect(JSON.stringify(body)).not.toContain(SECRET)

    const ok = await request.get(`${url}&confirm=1`, { headers })
    expect(ok.status()).toBe(200)
    expect(ok.headers()['content-type'] || '').toContain('application/x-ndjson')
    expect(ok.headers()['content-disposition'] || '').toContain('attachment')
    const raw = await ok.text()
    expect(raw).toContain(SECRET)
    // 扫描在相对化改写链下游：确认出域的仍是改写后内容（cwd 主机路径已剥）
    expect(raw).toContain('"cwd":"."')
    expect(raw).not.toContain('e2e-sens-exp-fixtures')
  })

  test('API 终端 txt：输出命中凭据 → 警示 → confirm=1 附件含原文', async ({ request }) => {
    test.setTimeout(60_000)
    const headers = { ...(await unlockHeaders(request)), 'Content-Type': 'application/json' }
    const projects = await request.get(`${API_BASE}/api/projects`, { headers })
    const list = ((await projects.json()) as { data?: { id: string; name: string }[] }).data || []
    const projectId = list.find(p => p.name === PROJECT_NAME)?.id
    if (!projectId) throw new Error(`project ${PROJECT_NAME} not found`)
    const created = await request.post(`${API_BASE}/api/terminals`, { headers, data: { projectId, name: 'e2e-sens-exp' } })
    expect(created.ok()).toBeTruthy()
    const sessionId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
    expect(sessionId).not.toBe('')
    try {
      const wr = await request.post(`${API_BASE}/api/terminals/broadcast-write`, {
        headers, data: { ids: [sessionId], data: `echo ${SECRET}\r` },
      })
      expect(wr.ok()).toBeTruthy()

      type GateBody = { warnings?: string[]; sensitiveHits?: { type: string; count: number }[] }
      let gateBody: GateBody | null = null
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 500))
        const res = await request.get(`${API_BASE}/api/terminals/${sessionId}/export`, { headers })
        expect(res.status()).toBe(200)
        if ((res.headers()['content-type'] || '').includes('application/json')) {
          gateBody = (await res.json()) as GateBody
          break
        }
      }
      expect(gateBody).toBeTruthy()
      expect(gateBody!.warnings).toContain('sensitive-content')
      expect(gateBody!.sensitiveHits?.some(h => h.type === 'known-token')).toBe(true)
      expect(JSON.stringify(gateBody)).not.toContain(SECRET)

      const allowed = await request.get(`${API_BASE}/api/terminals/${sessionId}/export?confirm=1`, { headers })
      expect(allowed.status()).toBe(200)
      expect(allowed.headers()['content-disposition'] || '').toContain('attachment')
      expect(await allowed.text()).toContain(SECRET)
    } finally {
      await request.delete(`${API_BASE}/api/terminals/${sessionId}`, { headers })
    }
  })

  test('UI：导出弹「敏感内容出域确认」→ 取消零下载 → 确认后下载全文', async ({ page }) => {
    test.setTimeout(90_000)
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplayModal(page)

    // 第一次：警示弹层（类型 + 计数），取消 = 零下载
    await modal.locator('[data-test="timeline-export"]').click()
    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()
    await menu.locator('.n-dropdown-option').filter({ hasText: 'Markdown（人读文档）' }).first().click()
    const dlg = page.locator('.n-dialog').filter({ hasText: '敏感内容出域确认' })
    await expect(dlg).toBeVisible({ timeout: 8000 })
    await expect(dlg).toContainText('API 令牌')
    await expect(dlg).not.toContainText(SECRET) // 警示层只展示类型计数，不含原文
    let downloaded = false
    const earlyDownload = page.waitForEvent('download', { timeout: 1500 }).then(() => { downloaded = true }).catch(() => {})
    await dlg.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
    await earlyDownload
    expect(downloaded).toBe(false)

    // 第二次：确认出域 → 下载全文（默认原样保真）
    await modal.locator('[data-test="timeline-export"]').click()
    await expect(menu).toBeVisible()
    const dlPromise = page.waitForEvent('download', { timeout: 15000 })
    await menu.locator('.n-dropdown-option').filter({ hasText: 'Markdown（人读文档）' }).first().click()
    const dlg2 = page.locator('.n-dialog').filter({ hasText: '敏感内容出域确认' })
    await expect(dlg2).toBeVisible({ timeout: 8000 })
    await dlg2.locator('.n-dialog__action button').filter({ hasText: '确认出域' }).click()
    const dl = await dlPromise
    expect(dl.suggestedFilename()).toMatch(/^claude-.*\d{8}\.md$/)
    const md = fs.readFileSync(await dl.path(), 'utf-8')
    expect(md).toContain(USER_TEXT_1)
    expect(md).toContain(SECRET)

    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })
})
