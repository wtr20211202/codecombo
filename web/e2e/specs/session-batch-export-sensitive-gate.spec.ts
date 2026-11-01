import { test, expect } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { inflateRawSync } from 'node:zlib'
import { fixedLocale, gotoAndUnlock, projectCardByName, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话批量导出内容敏感闸 E2E（P-20261003-225）：批量此前完全绕过单会话导出
 * 的出域闸（P-20261004-113）——同一批内容两条出域路径警示不对称，本 spec 锁定
 * 同族接入后的闭环：
 *   1. API md：含 token 会话 + 净会话批量 → 200 JSON warnings（跨会话聚合的
 *      类型计数，无附件头、无原文）→ confirm=1（查询串，单导同参数位）→ zip
 *      完整无遮蔽 + 审计 sensitive 后缀；
 *   2. API jsonl：预扫挂点在相对化改写链下游 → 警示 → confirm=1 → 改写后全文；
 *   3. API 零命中直出：净会话批量不弹闸（既有批量 spec 主链路的零回归面）；
 *   4. UI：多选 →「导出选中」→「敏感内容出域确认」弹层展示类型计数 → 取消零
 *      下载 → 确认后下载 zip。
 *
 * 测试数据：播种 2 条 fixture transcript 到真实 ~/.claude/projects（同域既有
 * 约定，标记 [e2e-bgate] 与 session-batch-export 的 [e2e-bexp] 互不命中），
 * afterAll 精确删除。拓扑：服务实例与测试同机（session-batch-export.spec 同款）。
 */

const MARK = '[e2e-bgate]'
const HOT_MARK = '[e2e-bgate-hot]'
const FAKE_DIR_NAME = 'D--e2e-bgate'
const IDS = ['e2e-bgate-a1b2c3d4-0001', 'e2e-bgate-a1b2c3d4-0002']
const SECRET = 'ghp_e2eBatchGate0123456789abcdefg'
const createdFiles: string[] = []

/** 播种 2 条 fixture：0001 净会话（零命中直出对照）、0002 密会话（凭据在正文）。
 *  两行标题都带 MARK 保证检索同屏（hasText 字面子串匹配——[e2e-bgate-hot] 不含
 *  [e2e-bgate]）；hot 标记只进正文，供 zip md 条目内容定位密会话 */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
  const bodies = [
    `${MARK} 批量闸净会话`,
    `${MARK} 批量闸密会话 ${HOT_MARK} 调试凭据 ${SECRET}`,
  ]
  IDS.forEach((id, i) => {
    const file = path.join(dir, `${id}.jsonl`)
    const lines = [
      `{"type":"last-prompt","sessionId":"${id}"}`,
      JSON.stringify({
        parentUuid: null, isSidechain: false, type: 'user',
        message: { role: 'user', content: bodies[i] },
        timestamp: at(6), cwd: 'D:\\e2e-bgate',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
        timestamp: at(5),
      }),
    ]
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
    const at10 = new Date(Date.now() - 10 * 60_000)
    fs.utimesSync(file, at10, at10)
    createdFiles.push(file)
  })
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

async function unlockHeaders(request: import('@playwright/test').APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  if (!res.ok()) throw new Error(`unlock failed: ${res.status()}`)
  const token = ((await res.json()) as { token: string }).token
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

type GateBody = { warnings?: string[]; sensitiveHits?: { type: string; count: number }[] }

// ============== 极简 zip 解包（零依赖，session-batch-export.spec 同款） ==============
function zipCentralEntries(buf: Buffer): string[] {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('EOCD not found (not a zip?)')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory at ' + off)
    const nameLen = buf.readUInt16LE(off + 28)
    names.push(buf.toString('utf8', off + 46, off + 46 + nameLen))
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32) + buf.readUInt16LE(off + 36)
  }
  return names
}

function zipEntryContent(buf: Buffer, name: string): string {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  if (eocd < 0) throw new Error('EOCD not found (not a zip?)')
  let off = buf.readUInt32LE(eocd + 16)
  const count = buf.readUInt16LE(eocd + 10)
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const entryName = buf.toString('utf8', off + 46, off + 46 + nameLen)
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const localOff = buf.readUInt32LE(off + 42)
    if (entryName === name) {
      const lNameLen = buf.readUInt16LE(localOff + 26)
      const lExtraLen = buf.readUInt16LE(localOff + 28)
      const dataStart = localOff + 30 + lNameLen + lExtraLen
      const raw = buf.subarray(dataStart, dataStart + csize)
      return method === 8 ? inflateRawSync(raw).toString('utf8') : raw.toString('utf8')
    }
    off += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`entry ${name} not found`)
}

test.describe('会话批量导出内容敏感闸（P-20261003-225）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('API md：批量首跳 JSON 警示（跨会话聚合类型计数）→ confirm=1 zip 完整', async ({ request }) => {
    const headers = await unlockHeaders(request)
    const url = `${API_BASE}/api/claude/sessions/export-archive`

    const gated = await request.post(url, { headers, data: { ids: IDS } })
    expect(gated.status()).toBe(200)
    expect(gated.headers()['content-type'] || '').toContain('application/json')
    expect(gated.headers()['content-disposition']).toBeUndefined()
    const body = (await gated.json()) as GateBody
    expect(body.warnings).toEqual(['sensitive-content'])
    expect(body.sensitiveHits?.some(h => h.type === 'known-token' && h.count >= 1)).toBe(true)
    // 警示只回类型计数：响应体绝不能出现凭据原文
    expect(JSON.stringify(body)).not.toContain(SECRET)

    const ok = await request.post(`${url}?confirm=1`, { headers, data: { ids: IDS } })
    expect(ok.status()).toBe(200)
    expect(ok.headers()['content-disposition'] || '').toContain('attachment')
    const buf = Buffer.from(await ok.body())
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
    // 确认后原样保真：净 + 密两会话 md 条目齐全，密文逐字在场
    const names = zipCentralEntries(buf)
    expect(names.filter(n => n.endsWith('.md'))).toHaveLength(2)
    expect(names).toContain('MANIFEST.txt')
    const hotMd = names.filter(n => n.endsWith('.md'))
      .map(n => zipEntryContent(buf, n))
      .find(content => content.includes(HOT_MARK))
    expect(hotMd).toBeTruthy()
    expect(hotMd!).toContain(SECRET)
    // 审计放行路径带命中类型计数（P-113 同口径）
    const unlock = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
    const token = ((await unlock.json()) as { token: string }).token
    const audit = (await (await request.get(`${API_BASE}/api/audit?limit=50`, {
      headers: { 'X-Lock-Token': token },
    })).json()) as { data: Array<{ action: string; detail: string }> }
    const evt = audit.data.find(e => e.action === 'claude.export_batch' && e.detail.includes('batch md 2/2'))
    expect(evt).toBeTruthy()
    expect(evt!.detail).toContain('sensitive:known-token')
  })

  test('API jsonl：预扫在相对化改写下游 → 警示 → confirm=1 改写后全文', async ({ request }) => {
    const headers = await unlockHeaders(request)
    const url = `${API_BASE}/api/claude/sessions/export-archive`

    const gated = await request.post(url, { headers, data: { ids: [IDS[1]], format: 'jsonl' } })
    expect(gated.status()).toBe(200)
    expect(gated.headers()['content-type'] || '').toContain('application/json')
    const body = (await gated.json()) as GateBody
    expect(body.warnings).toEqual(['sensitive-content'])
    expect(JSON.stringify(body)).not.toContain(SECRET)

    const ok = await request.post(`${url}?confirm=1`, { headers, data: { ids: [IDS[1]], format: 'jsonl' } })
    expect(ok.status()).toBe(200)
    expect(ok.headers()['content-disposition'] || '').toContain('attachment')
    const buf = Buffer.from(await ok.body())
    const names = zipCentralEntries(buf)
    const jsonlName = names.find(n => n.endsWith('.jsonl'))
    expect(jsonlName).toBeTruthy()
    const jsonl = zipEntryContent(buf, jsonlName!)
    // 确认后原样保真 + 预扫在相对化改写下游（cwd 主机路径已剥，消息正文不动）
    expect(jsonl).toContain(SECRET)
    expect(jsonl).toContain('"cwd":"."')
    expect(jsonl).not.toContain('D:\\\\e2e-bgate')
  })

  test('API 零命中直出：净会话批量不弹闸（零回归面）', async ({ request }) => {
    const headers = await unlockHeaders(request)
    const res = await request.post(`${API_BASE}/api/claude/sessions/export-archive`, {
      headers, data: { ids: [IDS[0]] },
    })
    expect(res.status()).toBe(200)
    expect(res.headers()['content-disposition'] || '').toContain('attachment')
    expect(Buffer.from(await res.body()).subarray(0, 2).toString('latin1')).toBe('PK')
  })

  test('UI：导出选中弹「敏感内容出域确认」→ 取消零下载 → 确认后下载 zip', async ({ page }) => {
    test.setTimeout(90_000)
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    await view.locator('.ats-tab', { hasText: 'Claude' }).click()
    const picker = view.locator('.csp-root')
    await expect(picker).toBeVisible({ timeout: 8000 })
    const searchResp = page.waitForResponse(r =>
      r.url().includes('/claude/sessions?') && r.url().includes('q=') && !r.url().includes('/search?'))
    await picker.locator('input').fill(MARK)
    await searchResp
    await expect(picker.locator('.csp-row').filter({ hasText: MARK })).toHaveCount(2, { timeout: 15000 })

    // Ctrl+点击选中两行（净 + 密）；多选点击落行左缘标题区（P-112 隐形钮群避让）
    const ROW_CLICK = { position: { x: 30, y: 10 } } as const
    const rows = picker.locator('.csp-row').filter({ hasText: MARK })
    for (let i = 0; i < 2; i++) {
      await rows.nth(i).click({ modifiers: ['Control'], ...ROW_CLICK })
    }
    const bar = picker.locator('[data-test="session-batch-bar"]')
    await expect(bar).toBeVisible()
    await expect(bar.locator('[data-test="session-batch-count"]')).toContainText('已选 2')

    // 第一次：警示弹层（类型 + 计数），取消 = 零下载
    await bar.locator('[data-test="session-batch-export"]').click()
    const dlg = page.locator('.n-dialog').filter({ hasText: '敏感内容出域确认' })
    await expect(dlg).toBeVisible({ timeout: 8000 })
    await expect(dlg).toContainText('API 令牌')
    await expect(dlg).not.toContainText(SECRET) // 警示层只展示类型计数，不含原文
    let downloaded = false
    const earlyDownload = page.waitForEvent('download', { timeout: 1500 }).then(() => { downloaded = true }).catch(() => {})
    await dlg.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
    await earlyDownload
    expect(downloaded).toBe(false)
    // 取消后选择集保留（可重试），操作条仍在
    await expect(bar).toBeVisible()

    // 第二次：确认出域 → 下载 zip
    const dlPromise = page.waitForEvent('download', { timeout: 20000 })
    await bar.locator('[data-test="session-batch-export"]').click()
    const dlg2 = page.locator('.n-dialog').filter({ hasText: '敏感内容出域确认' })
    await expect(dlg2).toBeVisible({ timeout: 8000 })
    await dlg2.locator('.n-dialog__action button').filter({ hasText: '确认出域' }).click()
    const dl = await dlPromise
    expect(dl.suggestedFilename()).toMatch(/^claude-sessions-\d{8}\.zip$/)
    const buf = fs.readFileSync(await dl.path())
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
  })
})
