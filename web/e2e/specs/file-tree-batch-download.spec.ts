import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { inflateRawSync } from 'node:zlib'
import { readFileSync } from 'node:fs'

// 多选「下载选中」批量归档（P-20261003-250）：文件树多选 ≥2 右键打包 zip。
// 断言聚焦最小面——批量菜单项 → 触发下载文件名 → 解包条目（跨 2 目录 3 文件
// 全部在内 + 内容对得上）；zip 结构/子树递归/护栏/敏感扫描的完整校验在 Go
// 单测 archive_batch_test.go，API 实流用例补 dir 选择项的子树相对路径。
// 探针建在 simple-coding 仓库 docs/e2e-bd/ 下（同 file-tree-dir-zip 播种惯例：
// 只建在 docs/ 前缀内、目录保持 3 行小体积让多选三项同屏可见），
// beforeAll/afterAll 统一播种清理。
const PROBE_ROOT = 'e2e-bd'
const PROBE_FILES = ['one.txt', 'two.txt']
const PROBE_SUB_FILE = 'sub/three.txt'

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
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
  // fetch 对 4xx/5xx 不抛异常——播种请求必须核 res.ok（file-tree-dir-zip 同款
  // 首跑教训：create 静默失败会把问题拖成用例中段的诡异 404）
  const res = await fetch(`${API_BASE}/api/projects/${pid}/file/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path, content: action === 'create' ? 'x' : undefined }),
  }).catch(() => null)
  if (!res || !res.ok) {
    if (action === 'delete' && res && res.status === 404) return
    throw new Error(`seed ${action} ${path} failed: HTTP ${res ? res.status : 'network'} ${res ? await res.text().catch(() => '') : ''}`)
  }
}

async function seedProbes(pid: string) {
  const all = [`docs/${PROBE_ROOT}/${PROBE_FILES[0]}`, `docs/${PROBE_ROOT}/${PROBE_FILES[1]}`, `docs/${PROBE_ROOT}/${PROBE_SUB_FILE}`]
  for (const p of all) await apiJson(pid, 'delete', p).catch(() => {})
  for (const d of [`docs/${PROBE_ROOT}/sub`, `docs/${PROBE_ROOT}`, PROBE_ROOT]) {
    await apiJson(pid, 'delete', d).catch(() => {})
  }
  for (const p of all) await apiJson(pid, 'create', p)
  // create 写固定内容 'x'，内容断言按播种值改写一个可辨识样本
  const token = await lockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path: `docs/${PROBE_ROOT}/${PROBE_FILES[0]}`, content: 'hello-batchdl' }),
  })
  if (!res.ok) throw new Error(`seed write one.txt failed: HTTP ${res.status}`)
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

// 反复收起/展开直到目标目录可见（展开态在 uiState 恢复 + 虚拟列表下有竞态，
// file-tree-dir-zip 同款循环）
async function expandDir(page: Page, name: string) {
  const dir = itemByName(page, name)
  await expect(dir).toBeVisible({ timeout: 5000 })
  for (let i = 0; i < 5; i++) {
    const arrow = (await dir.locator('.dir-arrow').textContent().catch(() => '')) || ''
    if (arrow === '▼') return
    await dir.click()
    await page.waitForTimeout(600)
  }
}

// ============== 极简 zip 解包（零依赖，file-tree-dir-zip 同款） ==============

/** 扫 EOCD 取中央目录全部条目名 */
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

/** 按条目名取未压缩内容（压缩尺寸/偏移取自中央目录，流式 zip 可靠口径） */
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

test.beforeAll(async () => {
  const pid = await projectId()
  await seedProbes(pid)
})

test.afterAll(async () => {
  try {
    const pid = await projectId()
    for (const p of [
      `docs/${PROBE_ROOT}/${PROBE_FILES[0]}`, `docs/${PROBE_ROOT}/${PROBE_FILES[1]}`, `docs/${PROBE_ROOT}/${PROBE_SUB_FILE}`,
      `docs/${PROBE_ROOT}/sub`, `docs/${PROBE_ROOT}`,
      // 历史运行若在仓库根误播同名目录，清理顺带扫掉（dir-zip 先例）
      PROBE_ROOT,
    ]) {
      await apiJson(pid, 'delete', p).catch(() => {})
    }
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('多选下载选中批量归档（P-20261003-250）', () => {
  test('多选 3 文件跨 2 目录 → 右键下载选中 → zip 含全部且内容正确', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await expandDir(page, 'docs')
    await expandDir(page, PROBE_ROOT)
    await expandDir(page, 'sub')

    // 三个选择项同屏可见（e2e-bd 目录只有 3 行 + 展开 sub 一行）
    const one = itemByName(page, PROBE_FILES[0])
    const two = itemByName(page, PROBE_FILES[1])
    const three = itemByName(page, PROBE_SUB_FILE.split('/')[1])
    await expect(one).toBeVisible({ timeout: 5000 })
    await expect(two).toBeVisible()
    await expect(three).toBeVisible()

    // Ctrl+Click 逐个增选成 3 项多选（selectedPaths 只由 Ctrl/Shift 点击填充，
    // 普通点击只打开文件不入集——file-tree-multi-select 同款驱动）
    await one.click({ modifiers: ['Control'] })
    await two.click({ modifiers: ['Control'] })
    await three.click({ modifiers: ['Control'] })
    await expect(page.locator('.tree-item.selected')).toHaveCount(3)

    // 右键落在多选集合内 → 菜单切批量形态 → 「下载选中（3 项）」
    await two.click({ button: 'right' })
    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()
    // 等待注册先于菜单点击（P-20261030-2 直链化：取包下载事件近乎即时，
    // blob 时代「整包进内存才事件」的秒级缓冲不再存在，后注册必漏事件）
    const dlPromise = page.waitForEvent('download', { timeout: 15000 })
    await menu.getByText('下载选中（3 项）', { exact: true }).click()

    const dl = await dlPromise
    // 直链化后保存名权威 = 服务端 Content-Disposition（archive_batch.go
    // selectionZipName：多项 = archive-<yyyymmdd>-<HHmmss>.zip，时间戳防撞名；
    // blob 时代 a.download 客户端名遮蔽了它，直链形态按服务端权威断言）
    expect(dl.suggestedFilename()).toMatch(/^archive-\d{8}-\d{6}\.zip$/)
    const tmpPath = await dl.path()
    const buf = readFileSync(tmpPath!)
    // 跨 2 目录的 3 文件全部入包，条目以各自 basename 为根
    expect(zipCentralEntries(buf).sort()).toEqual(['one.txt', 'three.txt', 'two.txt'])
    expect(zipEntryContent(buf, 'one.txt')).toBe('hello-batchdl')
  })

  test('API 实流：probe 聚合预估 + 跨目录条目 + 目录选择项子树相对路径', async () => {
    const token = await lockToken()
    const pid = await projectId()
    const headers = { 'X-Lock-Token': token }
    const paths = [`docs/${PROBE_ROOT}/${PROBE_FILES[0]}`, `docs/${PROBE_ROOT}/${PROBE_FILES[1]}`, `docs/${PROBE_ROOT}/${PROBE_SUB_FILE}`]
    const base = `${API_BASE}/api/projects/${pid}/files-archive`

    // probe=1：聚合规模预估（3 条目）+ 空 warnings
    const probeRes = await fetch(`${base}?${paths.map(p => `paths=${encodeURIComponent(p)}`).join('&')}&probe=1`, { headers })
    const probeText = await probeRes.text()
    expect(probeRes.status, `probe body=${probeText}`).toBe(200)
    expect(probeRes.headers.get('content-type')).toContain('application/json')
    const probe = JSON.parse(probeText) as { data?: { entries: number; truncated: boolean }, warnings?: string[] }
    expect(probe.data?.entries).toBe(3)
    expect(probe.data?.truncated).toBe(false)
    expect(probe.warnings).toEqual([])

    // 实包：3 文件跨 2 目录全部入包 + 内容核对
    const zipRes = await fetch(`${base}?${paths.map(p => `paths=${encodeURIComponent(p)}`).join('&')}`, { headers })
    const buf = Buffer.from(await zipRes.arrayBuffer())
    expect(zipRes.status, `zip head=${buf.subarray(0, 120).toString('utf8')}`).toBe(200)
    expect(zipRes.headers.get('content-type')).toBe('application/zip')
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
    expect(zipCentralEntries(buf).sort()).toEqual(['one.txt', 'three.txt', 'two.txt'])
    expect(zipEntryContent(buf, 'one.txt')).toBe('hello-batchdl')

    // 目录选择项：子树递归含子目录，条目根名 = 目录 basename（与单目录包
    // 「以所选目录为根」同源的「以选择项为根」，remotehost 归档同约定）
    const dirRes = await fetch(`${base}?paths=${encodeURIComponent(`docs/${PROBE_ROOT}`)}`, { headers })
    const dirBuf = Buffer.from(await dirRes.arrayBuffer())
    expect(dirRes.status).toBe(200)
    expect(zipCentralEntries(dirBuf).sort()).toEqual([`${PROBE_ROOT}/one.txt`, `${PROBE_ROOT}/sub/`, `${PROBE_ROOT}/sub/three.txt`, `${PROBE_ROOT}/two.txt`])
    expect(zipEntryContent(dirBuf, `${PROBE_ROOT}/sub/three.txt`)).toBe('x')
  })
})
