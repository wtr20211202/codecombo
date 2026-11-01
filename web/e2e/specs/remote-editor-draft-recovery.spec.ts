import { test, expect, type APIRequestContext, type Locator } from '@playwright/test'
import net from 'node:net'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD, fetchWslHost } from '../../tests/helpers'

/**
 * 远程编辑草稿保护 E2E（P-20261004-116，P-15 自认边界兑现）：改远程文件不保存 →
 * 防抖落 IndexedDB（remote: 伪路径键，固定命名空间）→ 刷新（模拟崩溃/断连）→
 * 恢复提示条出现 → 恢复内容回填 → Ctrl+S 回写远端成功。对比预览（P-20261004-71
 * 同款第三键）：恢复条悬挂期间远端被外部再改 → 草稿 vs 远端现内容并排可见 →
 * 知情丢弃，远端真值不动。自动保存仍不做（P-15 显式 Ctrl+S 语义保持）。
 *
 * 环境门控（与 remote-editor-open.spec 同惯例）：需 WSL sshd 可达（端口以播种的
 * 主机记录为准；缺失时先跑 scripts/e2e-seed-wsl.sh），HTTP 走 Playwright request
 * 上下文。IndexedDB 草稿键 = `remote-editor\u0000remote:<hostId>:<path>`（persist
 * 域 REMOTE_DRAFT_PROJECT 固定命名空间，项目 id 是 uuid 恒不碰撞）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const WSL_HOST_NAME = 'WSL'
const DRAFT_FILE = '/tmp/sc-e2e-remote-draft.txt'
const SEED = 'remote-draft-seed\n'
const MARKER = 'REMOTE-DRAFT-UNSAVED'
const REWRITE_MARKER = 'remote-changed-while-hanging'
// persist 域 REMOTE_DRAFT_PROJECT：远程草稿的固定命名空间（与生产同源的字面量）
const REMOTE_DRAFT_NS = 'remote-editor'

function tcpReachable(port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

let api: APIRequestContext
let wslUp = false
let hostId = ''

async function authHeaders(): Promise<Record<string, string>> {
  const res = await api.post(BASE + '/api/lock/unlock', {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'X-Lock-Token': token }
}

/** 经上传端点播种远端文件（sshd 高频建连节流面：失败重试一次兜底） */
async function seedRemoteFile(path: string, dir: string, name: string, content: string) {
  const headers = await authHeaders()
  const doUpload = () => api.post(`${BASE}/api/remotehosts/${hostId}/files/upload`, {
    headers,
    multipart: {
      path: dir,
      files: { name, mimeType: 'application/octet-stream', buffer: Buffer.from(content, 'utf-8') },
    },
    failOnStatusCode: false,
    timeout: 20000,
  })
  let res = await doUpload()
  if (!res.ok()) {
    await new Promise(r => setTimeout(r, 2000))
    res = await doUpload()
  }
  expect(res.ok(), `upload ${path} failed: ${res.status()} ${await res.text()}`).toBeTruthy()
}

/** 读远端文件当前内容（e2e 断言远端真值用） */
async function readRemote(path: string): Promise<string> {
  const headers = await authHeaders()
  const res = await api.get(`${BASE}/api/remotehosts/${hostId}/files/content`, {
    headers, params: { path }, failOnStatusCode: false, timeout: 20000,
  })
  if (!res.ok()) return `<read-failed ${res.status()}>`
  const body = (await res.json()) as { data?: string }
  return body.data ?? ''
}

async function removeRemote(paths: string[]) {
  try {
    const headers = await authHeaders()
    await api.post(`${BASE}/api/remotehosts/${hostId}/files/delete`, {
      headers, data: { paths }, timeout: 20000,
    })
  } catch { /* 清理失败不影响断言 */ }
}

/** 读取远程命名空间的全部草稿记录（主键 `remote-editor\u0000` 前缀范围，与
 *  draftDb/persist 路由同构）。DB 未创建时不得预先 open（无版本 open 会凭空
 *  建出无 store 的 v1 库，应用侧建连语义被破坏——editor-draft-recovery 同款纪律） */
async function readRemoteDrafts(page: Parameters<typeof gotoAndUnlock>[0]): Promise<{ content?: string }[]> {
  return await page.evaluate(async (ns) => {
    const known = await indexedDB.databases?.() ?? null
    if (known && !known.some(d => d.name === 'sc-editor-drafts')) return []
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('sc-editor-drafts')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    if (!db.objectStoreNames.contains('drafts')) return []
    return await new Promise<unknown[]>((resolve, reject) => {
      const range = IDBKeyRange.bound(`${ns}\u0000`, `${ns}\u0000\uffff`)
      const req = db.transaction('drafts', 'readonly').objectStore('drafts').getAll(range)
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    }) as Promise<unknown[]>
  }, REMOTE_DRAFT_NS) as { content?: string }[]
}

/** 打开远程管理视图 + WSL 主机的文件管理器（remote-editor-open 同款入口） */
async function openFileManager(page: Parameters<typeof gotoAndUnlock>[0], hostName = WSL_HOST_NAME): Promise<Locator> {
  await gotoAndUnlock(page, BASE + '/project')
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  const card = page.locator('.host-card').filter({ hasText: hostName }).first()
  await expect(card).toBeVisible({ timeout: 10000 })
  await card.hover()
  await card.locator('.host-card-files').click()
  const modal = page.locator('.n-modal').filter({ hasText: '文件管理' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  await expect(modal.locator('tr').first()).toBeVisible({ timeout: 20000 })
  return modal
}

/** 文件管理器内直达目录 + 右键「在编辑器打开」→ 等编辑器 tab 挂出 */
async function openInEditor(
  page: Parameters<typeof gotoAndUnlock>[0],
  modal: Locator,
  dir: string,
  fileName: string,
) {
  await modal.locator('button[title="编辑路径直达"]').click()
  await modal.locator('.rf-path-input input').fill(dir)
  await modal.locator('.rf-path-input input').press('Enter')
  await expect(modal.locator('tr').first()).toBeVisible({ timeout: 15000 })
  await modal.locator('.rf-filter input').fill(fileName)
  const row = modal.locator('tr').filter({ hasText: fileName }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.locator('td').first().click({ button: 'right' })
  await page.locator('.rfc-item').filter({ hasText: '在编辑器打开' }).click()
  await expect(modal).toBeHidden({ timeout: 10000 })
  const tab = page.locator('.editor-tab').filter({ hasText: fileName }).first()
  await expect(tab).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.monaco-container').first()).toBeVisible({ timeout: 15000 })
}

/** 刷新后等待 uiState 恢复远程签 + 远端内容装载完成（打开链含草稿探测） */
async function ensureRemoteTabOpen(page: Parameters<typeof gotoAndUnlock>[0], fileName: string, seedText: string) {
  const tab = page.locator('.editor-tab', { hasText: fileName })
  try {
    await tab.waitFor({ state: 'visible', timeout: 15000 })
  } catch {
    await gotoAndUnlock(page, BASE + '/project')
    await tab.waitFor({ state: 'visible', timeout: 15000 })
  }
  await expect(page.locator('.view-lines').first()).toContainText(seedText, { timeout: 15000 })
}

/** 在当前激活编辑器全选改写（确定性内容，不保存）。insertText 整段插入不走
 *  逐键 type——Monaco 对 Playwright 逐键输入存在尾字符重复的竞态面（实测
 *  'UNSAVED' 键入落成 'UNSAVEDED'），单次 input 事件天然免疫 */
async function rewriteActiveEditor(page: Parameters<typeof gotoAndUnlock>[0], text: string) {
  await page.locator('.monaco-container .view-lines').first().click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(text)
  await expect(page.locator('.monaco-container .view-lines').first()).toContainText(text)
}

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext()
  const wslHost = await fetchWslHost(BASE)
  hostId = wslHost?.id || ''
  if (!hostId) return
  wslUp = await tcpReachable(wslHost?.port || 23)
  if (!wslUp) return
  const headers = await authHeaders()
  const probe = await api.get(`${BASE}/api/remotehosts/${hostId}/files/list`, {
    headers, params: { path: '/tmp' }, failOnStatusCode: false, timeout: 20000,
  })
  if (!probe.ok()) {
    console.log(`WSL SFTP auth probe failed (${probe.status()}), skip WSL-gated tests`)
    wslUp = false
    return
  }
  await removeRemote([DRAFT_FILE])
  await seedRemoteFile(DRAFT_FILE, '/tmp', 'sc-e2e-remote-draft.txt', SEED)
})

test.afterAll(async () => {
  if (hostId) await removeRemote([DRAFT_FILE])
  // 清编辑器 uiState 残留：远程伪路径签持久进服务端 uiState（项目维度），
  // 不清会干扰后续 spec 的 boot 恢复（remote-editor-open 同款清理纪律）
  try {
    const headers = await authHeaders()
    const res = await (await api.get(BASE + '/api/ui-state', { headers })).json()
    const map = res?.data as Record<string, Record<string, unknown>> | undefined
    if (map) {
      let changed = false
      for (const k of Object.keys(map)) {
        if (map[k]?.editor !== undefined) {
          delete map[k].editor
          changed = true
        }
      }
      if (changed) await api.put(BASE + '/api/ui-state', { headers, data: map })
    }
  } catch { /* 实例不可达时跳过清理 */ }
  await api?.dispose()
})

test('远程编辑防丢全链：改不保存 → 刷新 → 恢复条 → 恢复回填 → Ctrl+S 回写远端', async ({ page }) => {
  test.skip(!wslUp || !hostId, 'WSL sshd 不可达或 WSL 主机未预置，跳过实流用例')
  test.setTimeout(150000)
  await fixedLocale(page)
  const modal = await openFileManager(page)
  await openInEditor(page, modal, '/tmp', 'sc-e2e-remote-draft.txt')
  await expect(page.locator('.view-lines').first()).toContainText('remote-draft-seed', { timeout: 15000 })

  // 改写不保存：等防抖 2s 落 IndexedDB（远程固定命名空间，轮询确定性等待）。
  // 内容断言用精确相等：草稿即恢复面的唯一事实源，落库时已被污染后面全链失真
  await rewriteActiveEditor(page, MARKER)
  await expect.poll(() => readRemoteDrafts(page), { timeout: 12000 })
    .toEqual([expect.objectContaining({ content: MARKER })])

  // 刷新模拟崩溃/断连：远端真值未变，草稿比远端新
  await page.reload()
  await ensureRemoteTabOpen(page, 'sc-e2e-remote-draft.txt', 'remote-draft-seed')

  // 恢复提示条出现（本地同款三键）
  const bar = page.locator('[data-testid="draft-recovery-bar"]')
  await expect(bar).toBeVisible({ timeout: 15000 })
  await expect(bar).toContainText('检测到未保存的草稿')
  await expect(bar).toContainText('恢复草稿')

  // 恢复：草稿写回编辑器（保持未保存脏态，远端未动）
  await page.locator('[data-testid="draft-recovery-restore"]').click()
  await expect(bar).toBeHidden()
  await expect(page.locator('.view-lines').first()).toContainText(MARKER, { timeout: 10000 })
  expect(await readRemote(DRAFT_FILE)).toBe(SEED)

  // Ctrl+S 显式保存回写：远端真值 = 恢复内容；保存成功清草稿（防丢底闭环）。
  // 先点回编辑器（恢复条按钮点击后焦点在条上，Monaco 键位不接 Ctrl+S）
  await page.locator('.monaco-container .view-lines').first().click()
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.n-message').filter({ hasText: '文件已保存' })).toBeVisible({ timeout: 20000 })
  await expect.poll(() => readRemote(DRAFT_FILE), { timeout: 20000 }).toBe(MARKER)
  await expect.poll(() => readRemoteDrafts(page), { timeout: 10000 }).toEqual([])
})

test('对比预览与知情丢弃：悬挂期远端被再改 → 并排可见 → 丢弃不覆盖远端', async ({ page }) => {
  test.skip(!wslUp || !hostId, 'WSL sshd 不可达或 WSL 主机未预置，跳过实流用例')
  test.setTimeout(150000)
  await fixedLocale(page)
  const modal = await openFileManager(page)
  await openInEditor(page, modal, '/tmp', 'sc-e2e-remote-draft.txt')
  // 上轮用例保存过，先回播种基线（重试换 worker 时 afterAll 可能重播）
  await seedRemoteFile(DRAFT_FILE, '/tmp', 'sc-e2e-remote-draft.txt', SEED)
  await page.reload()
  await ensureRemoteTabOpen(page, 'sc-e2e-remote-draft.txt', 'remote-draft-seed')

  await rewriteActiveEditor(page, MARKER)
  await expect.poll(() => readRemoteDrafts(page), { timeout: 12000 })
    .toEqual([expect.objectContaining({ content: MARKER })])

  await page.reload()
  await ensureRemoteTabOpen(page, 'sc-e2e-remote-draft.txt', 'remote-draft-seed')
  const bar = page.locator('[data-testid="draft-recovery-bar"]')
  await expect(bar).toBeVisible({ timeout: 15000 })

  // 恢复条悬挂期间远端被 agent/他人再改（恢复条是静态快照不随远端刷新）
  await seedRemoteFile(DRAFT_FILE, '/tmp', 'sc-e2e-remote-draft.txt', REWRITE_MARKER + '\n')

  // 第三键对比预览：diff 标签，左=草稿（MARKER）、右=远端现内容（REWRITE_MARKER）
  await page.locator('[data-testid="draft-recovery-preview"]').click()
  await expect(page.locator('.editor-tab[aria-label*="(Diff)"]').first()).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.monaco-diff-editor .editor.original .view-lines')).toContainText(MARKER, { timeout: 15000 })
  await expect(page.locator('.monaco-diff-editor .editor.modified .view-lines')).toContainText(REWRITE_MARKER, { timeout: 15000 })

  // 预览只读：恢复条保留，知情决策照常
  await expect(bar).toBeVisible()

  // 知情丢弃：草稿清账、恢复条摘除、远端真值不动。
  // 断言编辑器内容前先切回文件签（预览后活跃签是 diff 标签，.view-lines first
  // 是 diff 左侧=草稿侧，必含 MARKER）
  await page.locator('[data-testid="draft-recovery-discard"]').click()
  await expect(bar).toBeHidden()
  await expect.poll(() => readRemoteDrafts(page), { timeout: 10000 }).toEqual([])
  // 文件签定位：排除 diff 签（.tab-diff-icon 唯一归属）而非匹配确切 aria-label——
  // P-20261004-138 起远程签 aria-label 携主机别名（'<名> (WSL)'），hasText 子串
  // 又会连 diff 签（'<名> (Diff)'）一起命中
  await page.locator('.pane-primary .editor-tab')
    .filter({ hasText: 'sc-e2e-remote-draft.txt' })
    .filter({ hasNot: page.locator('.tab-diff-icon') })
    .click()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).not.toContainText(MARKER, { timeout: 10000 })
  await expect.poll(() => readRemote(DRAFT_FILE), { timeout: 20000 }).toBe(REWRITE_MARKER + '\n')
})
