import { test, expect } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { inflateRawSync } from 'node:zlib'
import { fixedLocale, gotoAndUnlock, projectCardByName, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话批量导出 zip E2E（P-20261003-165）：会话中心多选（Ctrl+点击）→ 底部
 * 操作条「导出选中」→ 下载 zip——每会话一个 md 条目 + MANIFEST.txt，md 内容
 * 与单会话导出一致（剥「导出时间」行后逐字节对齐）；护栏（>50 拒绝 / 全落空
 * 404 / 未知 format 400）与 jsonl 变体走 API 直调（zip 结构/单导一致性完整
 * 校验在 Go 单测 claude_sessions_batch_test.go）。
 * 隐藏排除（P-20261003-237）：末位用例置 IDS[0] 策展隐藏后验证——默认视图
 * 多选面天然不含隐藏行（Ctrl+A 只得可见行）、管理视图多选入口整体关闭、
 * 深链单导不拦（知情边界）、批量端点直接 POST 隐藏 id 服务端兜底跳过。
 *
 * 前置：simple-coding 已运行（含 POST /api/claude/sessions/export-archive）。
 * 测试数据：播种 3 条 fixture transcript 到真实 ~/.claude/projects（与
 * session-export-md.spec.ts 同款约定——标题带 [e2e-bexp] 标记，utimes 控制
 * 在 activeWindow(5 分钟) 之外），afterAll 恢复显示 + 精确删除。拓扑同款
 * 边界：仅服务实例与测试同机时可跑。
 */

const MARK = '[e2e-bexp]'
const FAKE_DIR_NAME = 'D--e2e-bexp'
const IDS = ['e2e-bexp-a1b2c3d4-0001', 'e2e-bexp-a1b2c3d4-0002', 'e2e-bexp-a1b2c3d4-0003']
const TITLES = ['批量导出甲会话', '批量导出乙会话', '批量导出丙会话']
const createdFiles: string[] = []

/** 播种 3 条 fixture transcript（标题互异防同题聚合折叠成组头行） */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
  IDS.forEach((id, i) => {
    const title = `${MARK} ${TITLES[i]}`
    const file = path.join(dir, `${id}.jsonl`)
    const lines = [
      `{"type":"last-prompt","sessionId":"${id}"}`,
      JSON.stringify({
        parentUuid: null, isSidechain: false, type: 'user',
        message: { role: 'user', content: title },
        timestamp: at(6), cwd: 'D:\\e2e-bexp',
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `${TITLES[i]}的回复` }] },
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

async function unlockToken(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  if (!res.ok()) throw new Error(`unlock failed: ${res.status()}`)
  return ((await res.json()) as { token: string }).token
}

/** 进会话中心并按标记检索（缺省 3 条 fixture 全命中；P-237 隐藏形态传 2） */
async function openPickerFiltered(page: import('@playwright/test').Page, expectCount = 3) {
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.ats-tab', { hasText: 'Claude' }).click()
  const picker = view.locator('.csp-root')
  await expect(picker).toBeVisible({ timeout: 8000 })
  // 只认列表检索 GET（带 limit/offset）；全文命中区 /search?q= 同样满足
  // 「/claude/sessions + q=」且更快返回——误等它会让断言跑在未过滤列表上
  //（实测 310 会话规模下列表 417ms vs 检索 113ms，Ctrl+A 全选进未过滤首页）
  const searchResp = page.waitForResponse(r =>
    r.url().includes('/claude/sessions?') && r.url().includes('q=') && !r.url().includes('/search?'))
  await picker.locator('input').fill(MARK)
  await searchResp
  await expect(picker.locator('.csp-row').filter({ hasText: MARK })).toHaveCount(expectCount, { timeout: 15000 })
  // 总行数即过滤行数：检索响应已落地、未过滤首页不再在场（Ctrl+A 全选可见行的前提）
  await expect(picker.locator('.csp-row')).toHaveCount(expectCount, { timeout: 15000 })
  return picker
}

// ============== 极简 zip 解包（零依赖，file-tree-dir-zip.spec 同款） ==============
/** 扫 EOCD（PK\x05\x06，从尾部倒扫）取中央目录位置与条目数 */
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

/** 按条目名取未压缩内容（压缩尺寸从中央目录取——流式 zip 以数据描述符收尾） */
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

/** 剥「- 导出时间：…」行：批量与单导两次渲染时刻可能跨秒，该行差异不算内容差异 */
function stripExportTime(md: string): string {
  return md.split('\n').filter(l => !l.startsWith('- 导出时间：')).join('\n')
}

// ============== 行点击定位 ==============
// P-112 注记：行右侧隐形钮群（星标/隐藏/备注/回放/接力）已挤进行幅中央，
// 中心点击会落在隐形回放钮上打开回放弹窗——多选点击显式落在行左缘标题区
//（.csp-row-main，无自有 handler，冒泡到行 onRowClick）
const ROW_CLICK = { position: { x: 30, y: 10 } } as const

test.describe('会话批量导出 zip（P-20261003-165）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(async ({ request }) => {
    // 防残留：P-237 用例会把 IDS[0] 置为策展隐藏，无论用例成败先恢复显示
    //（fixture 文件另行精确删除；服务不在时策展成孤儿条目无展示面——隐藏
    // 消费面是「存活 ∩ 策展」，claude-session-hide.spec 同款收尾）
    try {
      const base = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
      const unlock = await request.post(`${base}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
      const token = ((await unlock.json()) as { token?: string }).token || ''
      await request.post(`${base}/api/claude/sessions/curation`, {
        headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
        data: { sessionId: IDS[0], hidden: false },
      })
    } catch { /* 服务不在：无残留展示面 */ }
    cleanupFixtures()
  })

  test('多选 3 会话 → 导出选中 → zip 含 3 个 md + MANIFEST，内容与单导一致', async ({ page, request }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await fixedLocale(page)
    const picker = await openPickerFiltered(page)

    // Ctrl+点击逐行选中（P-20261002-20 树多选同款）；操作条出现且计数=3
    const rows = picker.locator('.csp-row').filter({ hasText: MARK })
    for (let i = 0; i < 3; i++) {
      await rows.nth(i).click({ modifiers: ['Control'], ...ROW_CLICK })
    }
    const bar = picker.locator('[data-test="session-batch-bar"]')
    await expect(bar).toBeVisible()
    await expect(bar.locator('[data-test="session-batch-count"]')).toContainText('3')
    // 选中行行首对勾指示
    await expect(rows.first().locator('[data-test="session-check"]')).toBeVisible()

    // 导出选中 → zip 下载（下载名客户端合成 claude-sessions-<日期>.zip）
    const dlPromise = page.waitForEvent('download')
    await bar.locator('[data-test="session-batch-export"]').click()
    const dl = await dlPromise
    expect(dl.suggestedFilename()).toMatch(/^claude-sessions-\d{8}\.zip$/)

    const buf = fs.readFileSync(await dl.path())
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
    const names = zipCentralEntries(buf)
    const mdNames = names.filter(n => n.endsWith('.md'))
    expect(names).toContain('MANIFEST.txt')
    expect(mdNames).toHaveLength(3)

    // 内容与单会话导出一致（同渲染链逐字节对账，剥时间行）；按会话 ID 定位
    // 对应条目——zip 条目序是导出序，与单导取哪个会话无关
    const token = await unlockToken(request)
    const singleResp = await request.get(`${API_BASE}/api/claude/sessions/${IDS[0]}/export`, {
      headers: { 'X-Lock-Token': token },
    })
    expect(singleResp.ok()).toBe(true)
    const single = stripExportTime(await singleResp.text())
    const mdForFirst = mdNames.map(n => zipEntryContent(buf, n))
      .find(content => content.includes(`\`${IDS[0]}\``))
    expect(mdForFirst).toBeTruthy()
    const batchMd = stripExportTime(mdForFirst!)
    expect(single.startsWith('# Claude 会话：')).toBe(true)
    expect(batchMd).toBe(single)
    expect(batchMd).toContain(`${MARK} ${TITLES[0]}`)

    // MANIFEST 清单：导出计数与逐文件行
    const mani = zipEntryContent(buf, 'MANIFEST.txt')
    expect(mani).toContain('导出 3 个会话，跳过 0 个')
    for (let i = 0; i < 3; i++) {
      expect(mani).toContain(`\t${IDS[i]}\t${MARK} ${TITLES[i]}`)
    }

    // 批量出域审计入账
    const auditResp = await request.get(`${API_BASE}/api/audit?limit=50`, {
      headers: { 'X-Lock-Token': token },
    })
    expect(auditResp.ok()).toBe(true)
    const audit = (await auditResp.json()) as { data: Array<{ action: string; detail: string }> }
    expect(audit.data.find(e => e.action === 'claude.export_batch' && e.detail.includes('batch md 3/3'))).toBeTruthy()

    // 导出成功后选择集清空，操作条收起
    await expect(bar).toBeHidden()
  })

  test('Shift 范围选中 + 选中态普通点击退出多选（不开会话）', async ({ page }) => {
    await fixedLocale(page)
    const picker = await openPickerFiltered(page)
    const rows = picker.locator('.csp-row').filter({ hasText: MARK })
    const bar = picker.locator('[data-test="session-batch-bar"]')

    // Shift+点击自锚点范围选中：Ctrl 点首行锚定 → Shift 点末行 → 3 行全选中
    await rows.first().click({ modifiers: ['Control'], ...ROW_CLICK })
    await rows.nth(2).click({ modifiers: ['Shift'], ...ROW_CLICK })
    await expect(bar.locator('[data-test="session-batch-count"]')).toContainText('3')

    // 选中态普通点击 = 退出多选（不开会话），操作条收起
    await rows.first().click(ROW_CLICK)
    await expect(bar).toBeHidden()
  })

  test('API 护栏：>50 拒绝（稳定标记）/ 全落空 404 / 未知 format 400 / jsonl 变体', async ({ request }) => {
    const token = await unlockToken(request)
    const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }
    const url = `${API_BASE}/api/claude/sessions/export-archive`

    // 51 个合法形态 id → 400 + 稳定标记
    const many = Array.from({ length: 51 }, (_, i) => `id${String(i).padStart(4, '0')}`)
    const manyRes = await request.post(url, { headers, data: { ids: many } })
    expect(manyRes.status()).toBe(400)
    expect(await manyRes.text()).toContain('too many sessions for batch export (max 50)')

    // 全落空 → 404（不出空包）
    const ghostRes = await request.post(url, { headers, data: { ids: ['ghost-aaaa', 'ghost-bbbb'] } })
    expect(ghostRes.status()).toBe(404)

    // 未知 format → 400
    const fmtRes = await request.post(url, { headers, data: { ids: [IDS[0]], format: 'yaml' } })
    expect(fmtRes.status()).toBe(400)

    // 部分缺失：1 在场 + 2 幽灵 → 200 zip，MANIFEST 跳过清单如实记账
    const partialRes = await request.post(url, { headers, data: { ids: [IDS[0], 'ghost-aaaa', 'ghost-bbbb'] } })
    expect(partialRes.status()).toBe(200)
    const partialBuf = Buffer.from(await partialRes.body())
    const partialNames = zipCentralEntries(partialBuf)
    expect(partialNames.filter(n => n.endsWith('.md'))).toHaveLength(1)
    expect(zipEntryContent(partialBuf, 'MANIFEST.txt')).toContain('导出 1 个会话，跳过 2 个')

    // jsonl 变体：条目为原始 transcript 且 cwd 相对化（主机布局不出域）
    const jsonlRes = await request.post(url, { headers, data: { ids: [IDS[1]], format: 'jsonl' } })
    expect(jsonlRes.status()).toBe(200)
    const jsonlBuf = Buffer.from(await jsonlRes.body())
    const jsonlNames = zipCentralEntries(jsonlBuf)
    const jsonlName = jsonlNames.find(n => n.endsWith('.jsonl'))
    expect(jsonlName).toBeTruthy()
    const jsonl = zipEntryContent(jsonlBuf, jsonlName!)
    expect(jsonl).toContain(`${MARK} ${TITLES[1]}`)
    expect(jsonl).not.toContain('D:\\\\e2e-bexp')
  })

  // P-20261003-237 批量导出排除隐藏会话：本用例把 IDS[0] 置为策展隐藏，必须
  // 排在本文件其他用例之后（workers=1 声明序串行——既有用例依赖 3 条全可见）
  test('隐藏会话不进多选导出面：全选只得可见行、管理视图不可多选、深链单导仍可（P-20261003-237）', async ({ page, request }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await fixedLocale(page)
    const token = await unlockToken(request)
    const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }

    // 预置：IDS[0] 策展隐藏（curation API，claude-session-hide.spec 同通道）
    const hideRes = await request.post(`${API_BASE}/api/claude/sessions/curation`, {
      headers, data: { sessionId: IDS[0], hidden: true },
    })
    expect(hideRes.ok()).toBe(true)

    const picker = await openPickerFiltered(page, 2)
    const bar = picker.locator('[data-test="session-batch-bar"]')

    // 1. 默认视图：隐藏行不在多选导出面——Ctrl+A 全选只得 2 条可见行
    await picker.focus()
    await page.keyboard.press('ControlOrMeta+a')
    await expect(bar).toBeVisible()
    // 精确计数（「已选 2」非子串——'42' 也含 '2'，子串形态会放过未过滤列表全选）
    await expect(bar.locator('[data-test="session-batch-count"]')).toContainText('已选 2')
    const dlPromise = page.waitForEvent('download')
    await bar.locator('[data-test="session-batch-export"]').click()
    const dl = await dlPromise
    const buf = fs.readFileSync(await dl.path())
    expect(zipCentralEntries(buf).filter(n => n.endsWith('.md'))).toHaveLength(2)
    // MANIFEST 只含可见 2 会话（隐藏 id 全程不进归档）
    const mani = zipEntryContent(buf, 'MANIFEST.txt')
    expect(mani).not.toContain(IDS[0])
    expect(mani).toContain(`\t${IDS[1]}\t`)
    expect(mani).toContain(`\t${IDS[2]}\t`)

    // 2. 管理视图（显示已隐藏）：隐藏行可见但多选入口整体关闭——批量条不出现
    await picker.locator('[data-test="session-hidden-toggle"]').click()
    const hiddenRow = picker.locator('.csp-row').filter({ hasText: MARK }).first()
    await expect(hiddenRow).toBeVisible({ timeout: 15000 })
    await expect(bar).toBeHidden() // 切视图即清选择集
    await picker.focus()
    await page.keyboard.press('ControlOrMeta+a')
    await expect(bar).toBeHidden() // 管理视图 Ctrl+A 不选中
    await hiddenRow.click({ modifiers: ['Control'], ...ROW_CLICK })
    await expect(bar).toBeHidden() // 管理视图 Ctrl+点击不选中

    // 3. 深链单导不拦（知情边界）：隐藏会话显式 id 导出仍 200
    const singleResp = await request.get(`${API_BASE}/api/claude/sessions/${IDS[0]}/export`, {
      headers: { 'X-Lock-Token': token },
    })
    expect(singleResp.ok()).toBe(true)
    expect(await singleResp.text()).toContain(`${MARK} ${TITLES[0]}`)

    // 4. 服务端兜底：批量端点直接 POST 携隐藏 id → 跳过进 MANIFEST 已隐藏清单
    const mixRes = await request.post(`${API_BASE}/api/claude/sessions/export-archive`, {
      headers, data: { ids: [IDS[0], IDS[1]] },
    })
    expect(mixRes.status()).toBe(200)
    const mixBuf = Buffer.from(await mixRes.body())
    expect(zipCentralEntries(mixBuf).filter(n => n.endsWith('.md'))).toHaveLength(1)
    const mixMani = zipEntryContent(mixBuf, 'MANIFEST.txt')
    expect(mixMani).toContain('导出 1 个会话，跳过 1 个')
    expect(mixMani).toContain('已隐藏')
    expect(mixMani).toContain(IDS[0])

    // 5. 切回默认视图：隐藏状态跨视图持久（重搜后仍只有 2 行）
    await picker.locator('[data-test="session-hidden-toggle"]').click()
    // 与 openPickerFiltered 同口径：只认列表检索 GET（/search?q= 是全文命中区）
    const searchResp = page.waitForResponse(r =>
      r.url().includes('/claude/sessions?') && r.url().includes('q=') && !r.url().includes('/search?'))
    await picker.locator('input').first().fill(MARK)
    await searchResp
    await expect(picker.locator('.csp-row').filter({ hasText: MARK })).toHaveCount(2, { timeout: 15000 })
    await expect(picker.locator('.csp-row')).toHaveCount(2, { timeout: 15000 })
  })
})
