import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器未保存草稿恢复 E2E（P-20261002-6）：编辑不保存 → 防抖落 IndexedDB →
 * 刷新（模拟崩溃/误关）→ 恢复提示条出现 → 点恢复内容还原；丢弃则草稿删除、
 * 刷新不再提示。自备临时仓库，afterAll 清理。
 * 陈旧对账（P-20261003-152）：文件被删除后的草稿，刷新后启动对账清理——
 * 已删文件的草稿不再滞留（汇总提示 + IndexedDB 清账），存活文件草稿照常恢复。
 * 对比预览（P-20261004-71）：恢复条悬挂期间磁盘被外部再改 → 第三键并排预览
 * 草稿 vs 磁盘现内容（两侧差异可见）→ 恢复条保留，恢复/丢弃知情决策照常。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-draft')
const PROJ = 'e2e-editor-draft'
const FILE = 'draft-target.txt'
const DELETED = 'stale-target.txt'
const ORIGINAL = 'draft recovery baseline line\n'
const STALE_ORIGINAL = 'stale target baseline line\n'
const APPEND = 'unsaved-draft-marker'
const STALE_APPEND = 'orphan-draft-marker'
// 对比预览（P-20261004-71）用：恢复条悬挂期间磁盘被 agent/他人再改的标记
const DISK_MARKER = 'agent-rewrote-disk-line'

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

/** 读取当前项目作用域的全部草稿记录（主键 \u0000 前缀范围，与 draftDb 同构） */
async function readProjectDrafts(page: Page, projectId: string): Promise<{ content?: string }[]> {
  return await page.evaluate(async (pid) => {
    // DB 尚未由应用创建时不得预先 open：无版本 open 会凭空建出无 store 的
    // v1 库，应用按 v1 打开不再触发 onupgradeneeded，store 永远缺失
    const known = await indexedDB.databases?.() ?? null
    if (known && !known.some(d => d.name === 'sc-editor-drafts')) return []
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('sc-editor-drafts')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    if (!db.objectStoreNames.contains('drafts')) return []
    return await new Promise<unknown[]>((resolve, reject) => {
      const range = IDBKeyRange.bound(`${pid}\u0000`, `${pid}\u0000\uffff`)
      const req = db.transaction('drafts', 'readonly').objectStore('drafts').getAll(range)
      req.onsuccess = () => resolve(req.result || [])
      req.onerror = () => reject(req.error)
    }) as Promise<unknown[]>
  }, projectId) as { content?: string }[]
}

/** 刷新后等待 uiState 恢复目标标签；uiState 未恢复时回退手动打开（打开动作同样触发草稿探测） */
async function ensureTargetTabOpen(page: Page) {
  const tab = page.locator('.pane-primary .editor-tab', { hasText: FILE })
  try {
    await tab.waitFor({ state: 'visible', timeout: 15000 })
  } catch {
    for (let i = 0; i < 3; i++) {
      if (await page.locator('.file-tree .item-name', { hasText: FILE }).first().isVisible().catch(() => false)) break
      await page.locator('[data-testid="rail-files"]').click()
      await page.waitForTimeout(600)
    }
    await page.locator('.file-tree .item-name', { hasText: FILE }).first().click()
  }
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('draft recovery baseline', { timeout: 10000 })
}

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE), ORIGINAL)
  fs.writeFileSync(path.join(REPO_DIR, DELETED), STALE_ORIGINAL)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 草稿恢复基线'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test('编辑不保存 → 刷新 → 恢复提示出现 → 点恢复内容还原', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 打开目标文件
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('draft recovery baseline', { timeout: 8000 })

  // 键入未保存内容，等待防抖 2s 落 IndexedDB（轮询项目作用域草稿，确定性等待）
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(APPEND)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(APPEND)
  await expect.poll(() => readProjectDrafts(page, projectId), { timeout: 10000 })
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining(APPEND) }),
    ]))

  // 刷新模拟崩溃/误关（beforeunload 弹窗 Playwright 自动解除）；磁盘文件未变
  await page.reload()
  await ensureTargetTabOpen(page)

  // 恢复提示条出现：检测到未保存的草稿 + 两键
  const bar = page.locator('[data-testid="draft-recovery-bar"]')
  await expect(bar).toBeVisible({ timeout: 10000 })
  await expect(bar).toContainText('检测到未保存的草稿')
  await expect(bar).toContainText('恢复草稿')
  await expect(bar).toContainText('丢弃')

  // 点恢复：草稿内容写回编辑器（文件保持未保存脏态，磁盘未动）
  await page.locator('[data-testid="draft-recovery-restore"]').click()
  await expect(bar).toBeHidden()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(APPEND, { timeout: 8000 })
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).not.toContain(APPEND)
})

test('丢弃草稿 → 草稿删除，刷新不再提示', async ({ page }) => {
  // 独立闭环（Playwright 每用例全新浏览器上下文，IndexedDB 不跨用例）：
  // 编辑不保存 → 刷新出提示 → 丢弃 → 草稿删除 → 再刷新不再提示
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('draft recovery baseline', { timeout: 8000 })

  // 键入未保存内容，等待防抖落库
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(APPEND)
  await expect.poll(() => readProjectDrafts(page, projectId), { timeout: 10000 })
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining(APPEND) }),
    ]))

  // 刷新：提示条出现（磁盘未变，草稿比磁盘新）
  await page.reload()
  await ensureTargetTabOpen(page)
  const bar = page.locator('[data-testid="draft-recovery-bar"]')
  await expect(bar).toBeVisible({ timeout: 10000 })

  // 丢弃：草稿删除、提示条摘除、编辑器维持磁盘内容
  await page.locator('[data-testid="draft-recovery-discard"]').click()
  await expect(bar).toBeHidden()
  await expect(page.locator('.monaco-editor .view-lines')).not.toContainText(APPEND)
  await expect.poll(() => readProjectDrafts(page, projectId), { timeout: 8000 }).toEqual([])

  // 再刷新：草稿已删，不再提示
  await page.reload()
  await ensureTargetTabOpen(page)
  await expect(page.locator('[data-testid="draft-recovery-bar"]')).toHaveCount(0, { timeout: 10000 })
})

/** 从文件树打开指定文件（侧栏可能未开，rail-files 兜底重试 3 次） */
async function openTreeFile(page: Page, name: string) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: name }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: name }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: name })).toBeVisible({ timeout: 10000 })
}

/** 在当前激活编辑器尾部键入未保存内容（Ctrl+End 定位文末 + 换行追加） */
async function dirtyActiveEditor(page: Page, marker: string) {
  await page.locator('.monaco-editor').last().click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(marker)
  await expect(page.locator('.monaco-editor').last()).toContainText(marker)
}

test('陈旧对账：文件已删除的草稿刷新后被清理，存活文件草稿照常恢复', async ({ page }) => {
  test.setTimeout(120_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 两个文件各脏一份草稿（不同标记），等防抖落 IndexedDB
  await openTreeFile(page, FILE)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('draft recovery baseline', { timeout: 8000 })
  await dirtyActiveEditor(page, APPEND)
  await openTreeFile(page, DELETED)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('stale target baseline', { timeout: 8000 })
  await dirtyActiveEditor(page, STALE_APPEND)
  await expect.poll(() => readProjectDrafts(page, projectId), { timeout: 10000 })
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining(APPEND) }),
      expect.objectContaining({ content: expect.stringContaining(STALE_APPEND) }),
    ]))

  // 外部删除（agent/git rm 口径）：服务端 API 直删，前端脏 tab 与草稿均保留
  const headers = await unlockHeaders()
  const del = await fetch(`${API_BASE}/api/projects/${projectId}/file/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ path: DELETED }),
  })
  expect(del.status).toBe(200)

  // 刷新 = 启动对账：已删文件的草稿被清理并汇总提示，存活文件草稿照常入队恢复
  await page.reload()

  // 对账清理提示（一条汇总，先于其他断言防 3s toast 生命周期错过）
  await expect(page.locator('.n-message').filter({ hasText: '已清理 1 份陈旧草稿' })).toBeVisible({ timeout: 15000 })

  // 存活文件恢复链路零回归：tab 恢复 + 草稿提示条出现；已删文件不再有 tab
  await ensureTargetTabOpen(page)
  const bar = page.locator('[data-testid="draft-recovery-bar"]')
  await expect(bar).toBeVisible({ timeout: 10000 })
  await expect(bar).toContainText('检测到未保存的草稿')
  await expect(page.locator('.editor-tab', { hasText: DELETED })).toHaveCount(0)

  // IndexedDB 对账终态：陈旧草稿清账、存活草稿保留（等恢复/保存时再清）
  await expect.poll(async () => {
    const rows = await readProjectDrafts(page, projectId)
    return {
      staleGone: !rows.some(r => (r.content || '').includes(STALE_APPEND)),
      survivorKept: rows.some(r => (r.content || '').includes(APPEND)),
    }
  }, { timeout: 15000 }).toEqual({ staleGone: true, survivorKept: true })
})

/** 对比预览共用前置：草稿落库 → 刷新出恢复条 → 悬挂期间磁盘被外部再改。
 *  恢复条是静态快照不随磁盘刷新——正是「盲恢复=陈旧覆盖」的风险形态 */
async function offerWithDiskRewritten(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openTreeFile(page, FILE)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('draft recovery baseline', { timeout: 8000 })
  await dirtyActiveEditor(page, APPEND)
  await expect.poll(() => readProjectDrafts(page, projectId), { timeout: 10000 })
    .toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining(APPEND) }),
    ]))

  await page.reload()
  await ensureTargetTabOpen(page)
  const bar = page.locator('[data-testid="draft-recovery-bar"]')
  await expect(bar).toBeVisible({ timeout: 10000 })

  // 提示条悬挂期间磁盘被 agent/他人再改（外部直写，前端不重载已开签）
  fs.writeFileSync(path.join(REPO_DIR, FILE), ORIGINAL + DISK_MARKER + '\n')
  return bar
}

test('对比预览：草稿 vs 被再改的磁盘并排可见，恢复条保留、恢复仍照常', async ({ page }) => {
  test.setTimeout(120_000)
  const bar = await offerWithDiskRewritten(page)

  // 第三键对比预览：diff 标签打开，左=草稿（APPEND）、右=磁盘现内容（DISK_MARKER）
  await page.locator('[data-testid="draft-recovery-preview"]').click()
  await expect(page.locator('.pane-primary .editor-tab[aria-label*="(Diff)"]')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.monaco-diff-editor .editor.original .view-lines')).toContainText(APPEND, { timeout: 15000 })
  await expect(page.locator('.monaco-diff-editor .editor.modified .view-lines')).toContainText(DISK_MARKER, { timeout: 15000 })

  // 预览是只读动作：恢复条不消失，看完差异可继续决策
  await expect(bar).toBeVisible()

  // 回文件签 → 恢复：草稿写回编辑器脏态，磁盘保持 agent 版本未被覆盖
  await page.locator('.pane-primary .editor-tab', { hasText: FILE }).first().click()
  await page.locator('[data-testid="draft-recovery-restore"]').click()
  await expect(bar).toBeHidden()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(APPEND, { timeout: 8000 })
  const disk = fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')
  expect(disk).toContain(DISK_MARKER)
  expect(disk).not.toContain(APPEND)
})

test('对比预览：看过差异后知情丢弃，草稿清账、磁盘 agent 版本不动', async ({ page }) => {
  test.setTimeout(120_000)
  const bar = await offerWithDiskRewritten(page)

  await page.locator('[data-testid="draft-recovery-preview"]').click()
  await expect(page.locator('.monaco-diff-editor .editor.modified .view-lines')).toContainText(DISK_MARKER, { timeout: 15000 })

  // 知情丢弃：差异里已确认磁盘更新，丢草稿不丢磁盘工作
  await page.locator('[data-testid="draft-recovery-discard"]').click()
  await expect(bar).toBeHidden()
  await expect.poll(() => readProjectDrafts(page, projectId), { timeout: 8000 }).toEqual([])
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).toContain(DISK_MARKER)
})
