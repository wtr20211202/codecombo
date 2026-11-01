import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { inflateRawSync } from 'node:zlib'
import { statSync } from 'node:fs'

// 本地目录「下载为 zip」（P-20261002-115）：文件树目录右键打包下载。
// 断言聚焦最小面——右键菜单项 → 触发下载文件名 → 响应 content-type →
// 解包条目与内容（zip 结构/护栏/符号链接的完整校验在 Go 单测 archive_test.go）。
// 探针建在 simple-coding 仓库 docs/ 下（同 file-tree-context 播种惯例），
// beforeAll/afterAll 统一播种清理。
const PROBE_DIR = 'e2e-dirzip'
const PROBE_SCAN_DIR = 'e2e-dirzip-scan'

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

async function lockToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  return (await res.json()).token || ''
}

async function projectId(): Promise<string> {
  const token = await lockToken()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers: { 'X-Lock-Token': token } })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === 'simple-coding')
  if (!mine) throw new Error('simple-coding 项目不存在')
  return mine.id
}

async function apiJson(pid: string, action: 'create' | 'delete', path: string) {
  const token = await lockToken()
  // fetch 对 4xx/5xx 不抛异常——播种请求必须核 res.ok，静默失败会把问题
  // 拖成用例中段的诡异 404（首跑实测教训：create 静默挂导致后续 404 迷雾）
  const res = await fetch(`${API_BASE}/api/projects/${pid}/file/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path, content: action === 'create' ? 'x' : undefined }),
  }).catch(() => null)
  if (!res || !res.ok) {
    // delete 容忍 404（首跑前无残留属常态）；create 失败必须炸响
    if (action === 'delete' && res && res.status === 404) return
    throw new Error(`seed ${action} ${path} failed: HTTP ${res ? res.status : 'network'} ${res ? await res.text().catch(() => '') : ''}`)
  }
}

/** 播种探针目录：普通包（两级+两文件，无敏感名）与扫描包（含 .env 命中名）。
 *  一律建在 docs/ 下（与 file-tree-context 探针同位）——路径漏前缀会在仓库
 *  根长出同名目录，树里出现两个同名节点、API 断言打到不存在的 docs/ 路径
 *  （首跑实测教训：404 与「根级目录被当探针右键」都源于此） */
async function seedProbes(pid: string) {
  for (const p of [`docs/${PROBE_DIR}/a.txt`, `docs/${PROBE_DIR}/sub/b.txt`, `docs/${PROBE_SCAN_DIR}/.env`]) {
    await apiJson(pid, 'delete', p).catch(() => {})
  }
  for (const d of [`docs/${PROBE_DIR}`, `docs/${PROBE_SCAN_DIR}`, PROBE_DIR, PROBE_SCAN_DIR]) {
    await apiJson(pid, 'delete', d).catch(() => {})
  }
  await apiJson(pid, 'create', `docs/${PROBE_DIR}/a.txt`)
  await apiJson(pid, 'create', `docs/${PROBE_DIR}/sub/b.txt`)
  // create 写固定内容 'x'，内容断言按播种值取（a.txt 改写为可辨识内容）
  {
    const token = await lockToken()
    const res = await fetch(`${API_BASE}/api/projects/${pid}/file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
      body: JSON.stringify({ path: `docs/${PROBE_DIR}/a.txt`, content: 'hello-dirzip' }),
    })
    if (!res.ok) throw new Error(`seed write docs/${PROBE_DIR}/a.txt failed: HTTP ${res.status}`)
  }
  await apiJson(pid, 'create', `docs/${PROBE_SCAN_DIR}/.env`)
}

async function enterProject(page: Page) {
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——奇数次点击保证最终打开
  for (let i = 0; i < 3; i++) {
    if (await page.getByText('README.md').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

// 反复收起/展开 docs 直到探针目录可见（展开态在 uiState 恢复 + 虚拟列表下有竞态）
async function revealProbeDir(page: Page, name: string) {
  const docs = itemByName(page, 'docs')
  await expect(docs).toBeVisible({ timeout: 5000 })
  for (let i = 0; i < 5; i++) {
    const probe = itemByName(page, name)
    if (await probe.isVisible().catch(() => false)) return probe
    const arrow = (await docs.locator('.dir-arrow').textContent().catch(() => '')) || ''
    if (arrow === '▼') {
      await docs.click()
      await page.waitForTimeout(500)
      await docs.click()
    } else {
      await docs.click()
    }
    await page.waitForTimeout(700)
  }
  return itemByName(page, name)
}

// ============== 极简 zip 解包（零依赖） ==============
// 中央目录读条目名 + 本地头定位后 inflateRaw 还原内容。完整 zip 语义校验
// 在 Go 单测（archive/zip.Reader），此处只为 e2e 端到端核对「包里真的是
// 播种的那几个条目、内容对得上」。

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

/** 按条目名取未压缩内容。压缩尺寸与本地头偏移取自中央目录——流式响应的
 *  zip 本地头尺寸为零、以数据描述符收尾（Go zip.Writer 对不可寻宿主写
 *  flag bit 3），从中央目录取数才是可靠口径 */
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
      // 本地头自己的名称/extra 长度可能与中央目录不同，数据起点按本地头算
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

test.beforeAll(async () => {
  const pid = await projectId()
  await seedProbes(pid)
})

test.afterAll(async () => {
  try {
    const pid = await projectId()
    for (const p of [`docs/${PROBE_DIR}/a.txt`, `docs/${PROBE_DIR}/sub/b.txt`, `docs/${PROBE_DIR}`,
      `docs/${PROBE_SCAN_DIR}/.env`, `docs/${PROBE_SCAN_DIR}`,
      // 历史运行曾在仓库根误播同名目录（路径漏前缀），清理顺带扫掉
      PROBE_DIR, PROBE_SCAN_DIR]) {
      await apiJson(pid, 'delete', p).catch(() => {})
    }
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('本地目录下载为 zip（P-20261002-115）', () => {
  test('目录右键 → 下载为 zip → 保存名 dir.zip', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    const probe = await revealProbeDir(page, PROBE_DIR)

    await probe.click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    // 等待注册先于菜单点击（P-20261030-2 直链化：取包下载事件近乎即时，blob
    // 时代「整包进内存才事件」的秒级缓冲不再存在，后注册必漏事件）
    const dlPromise = page.waitForEvent('download', { timeout: 15000 })
    await page.locator('.n-dropdown-menu').getByText('下载为 zip', { exact: true }).click()

    const dl = await dlPromise
    expect(dl.suggestedFilename()).toBe(`${PROBE_DIR}.zip`)
    const tmpPath = await dl.path()
    expect(statSync(tmpPath!).size).toBeGreaterThan(0)
  })

  test('API 实流：content-type application/zip + 解包条目与内容 + probe 预估', async () => {
    const token = await lockToken()
    const pid = await projectId()
    const headers = { 'X-Lock-Token': token }
    const base = `${API_BASE}/api/projects/${pid}/dir-archive`

    // probe=1：纯 JSON，规模预估 + 空 warnings
    const probeRes = await fetch(`${base}?path=docs/${PROBE_DIR}&probe=1`, { headers })
    const probeText = await probeRes.text()
    expect(probeRes.status, `probe body=${probeText}`).toBe(200)
    expect(probeRes.headers.get('content-type')).toContain('application/json')
    const probe = JSON.parse(probeText) as { data?: { entries: number; truncated: boolean }, warnings?: string[] }
    expect(probe.data?.entries).toBe(2) // a.txt + sub/b.txt（目录占位不计）
    expect(probe.data?.truncated).toBe(false)
    expect(probe.warnings).toEqual([])

    // 实包：application/zip + 解包条目与内容逐项核对
    const zipRes = await fetch(`${base}?path=docs/${PROBE_DIR}`, { headers })
    const zipBuf = Buffer.from(await zipRes.arrayBuffer())
    expect(zipRes.status, `zip head=${zipBuf.subarray(0, 120).toString('utf8')}`).toBe(200)
    expect(zipRes.headers.get('content-type')).toBe('application/zip')
    expect(zipRes.headers.get('content-disposition')).toContain(PROBE_DIR)
    const buf = zipBuf
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
    const names = zipCentralEntries(buf)
    expect(names.sort()).toEqual(['a.txt', 'sub/', 'sub/b.txt'])
    expect(zipEntryContent(buf, 'a.txt')).toBe('hello-dirzip')
  })

  test('敏感命中 → 警示确认框 → 仍然打包下载 → 出包', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    const probe = await revealProbeDir(page, PROBE_SCAN_DIR)

    await probe.click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.locator('.n-dropdown-menu').getByText('下载为 zip', { exact: true }).click()

    // P-26 同款警示确认框（.env 命中），取消先验证拦截不出包
    const dialog = page.locator('.n-modal').filter({ hasText: '打包下载前安全扫描' })
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.locator('button').filter({ hasText: '取消' }).click()
    await expect(dialog).toBeHidden()

    // 再来一次：确认「仍然打包下载」→ override 直链取包 → 下载到达
    // （P-20261030-2 直链化：等待注册先于确认点击，下载事件近乎即时）
    await probe.click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.locator('.n-dropdown-menu').getByText('下载为 zip', { exact: true }).click()
    await expect(dialog).toBeVisible({ timeout: 5000 })
    const dlPromise = page.waitForEvent('download', { timeout: 15000 })
    await dialog.locator('button').filter({ hasText: '仍然打包下载' }).click()
    const dl = await dlPromise
    expect(dl.suggestedFilename()).toBe(`${PROBE_SCAN_DIR}.zip`)
  })

  test('文件节点右键无「下载为 zip」项（单文件走既有下载）', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    const readme = itemByName(page, 'README.md')
    await expect(readme).toBeVisible({ timeout: 5000 })
    await readme.click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await expect(page.locator('.n-dropdown-menu').getByText('下载为 zip', { exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
  })
})
