import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName, fetchWslHost } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器「放弃未保存修改」E2E（P-20261005-156，VS Code Revert File 对位）：
 * 脏 buffer 一键回磁盘/远端当前内容——409 冲突对话框「加载磁盘/远端版本」
 * （loadDiskVersion/loadRemoteVersion 全链）的常态入口。
 *   ① tab 右键：干净 tab 无此项；脏 tab 项可见 → 确认 → 内容回磁盘态 + 脏点
 *      消失 + 磁盘不被触碰；取消则原地不动。
 *   ② 编辑器右键（scFileCanRevert 上下文键）：干净文件菜单无此项；脏文件可见
 *      且同一确认链可达。
 *   ③ 远程伪路径 tab（环境门控：WSL sshd 可达，remote-editor-draft-recovery
 *      同惯例）：buffer 改脏 + 远端被外部再改 → 放弃 → 回「远端当前内容」
 *      （非打开时快照），远端真值不动。
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-revert-file')
const PROJ = 'e2e-editor-revert-file'
const FILE = 'revert-local.txt'
const ORIGINAL = 'revert e2e baseline line1\n'
const APPEND = 'my-unsaved-edit'
const REVERT_TOAST = '已加载磁盘版本，你的未保存修改已放弃'
const MENU_LABEL = '放弃未保存修改'

// 远程用例（P-20261004-116 同族环境门控）
const REMOTE_FILE = '/tmp/sc-e2e-remote-revert.txt'
const REMOTE_SEED = 'remote revert seed\n'
const REMOTE_MARKER = 'REMOTE-UNSAVED-EDIT'
const REMOTE_REWRITE = 'remote-rewritten-while-dirty\n'

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

let projectId = ''

// ── 远程环境（WSL sshd 可达才跑，见 beforeAll 门控）──
const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const WSL_HOST_NAME = 'WSL'
let api: APIRequestContext
let wslUp = false
let remoteHostId = ''

function tcpReachable(port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

async function remoteAuthHeaders(): Promise<Record<string, string>> {
  const res = await api.post(BASE + '/api/lock/unlock', { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'X-Lock-Token': token }
}

/** 经上传端点播种/外部改写远端文件（sshd 高频建连节流面：失败重试一次兜底） */
async function uploadRemote(name: string, content: string) {
  const headers = await remoteAuthHeaders()
  const doUpload = () => api.post(`${BASE}/api/remotehosts/${remoteHostId}/files/upload`, {
    headers,
    multipart: {
      path: '/tmp',
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
  expect(res.ok(), `upload ${name} failed: ${res.status()}`).toBeTruthy()
}

/** 读远端文件当前内容（断言远端真值不被 UI 放弃动作触碰） */
async function readRemote(): Promise<string> {
  const headers = await remoteAuthHeaders()
  const res = await api.get(`${BASE}/api/remotehosts/${remoteHostId}/files/content`, {
    headers, params: { path: REMOTE_FILE }, failOnStatusCode: false, timeout: 20000,
  })
  if (!res.ok()) return `<read-failed ${res.status()}>`
  const body = (await res.json()) as { data?: string }
  return body.data ?? ''
}

async function removeRemote() {
  try {
    const headers = await remoteAuthHeaders()
    await api.post(`${BASE}/api/remotehosts/${remoteHostId}/files/delete`, {
      headers, data: { paths: [REMOTE_FILE] }, timeout: 20000,
    })
  } catch { /* 清理失败不影响断言 */ }
}

test.beforeAll(async ({ playwright }) => {
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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'])
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), ORIGINAL)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 放弃未保存修改基线'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)

  // 远程门控：WSL 主机记录存在且 sshd 可达才启用远程用例（seed 顺带预热）
  api = await playwright.request.newContext()
  const wslHost = await fetchWslHost(BASE)
  remoteHostId = wslHost?.id || ''
  if (!remoteHostId) return
  wslUp = await tcpReachable(wslHost?.port || 23)
  if (!wslUp) return
  const probe = await api.get(`${BASE}/api/remotehosts/${remoteHostId}/files/list`, {
    headers: await remoteAuthHeaders(), params: { path: '/tmp' }, failOnStatusCode: false, timeout: 20000,
  })
  if (!probe.ok()) {
    console.log(`WSL SFTP auth probe failed (${probe.status()}), skip WSL-gated tests`)
    wslUp = false
    return
  }
  await removeRemote()
  await uploadRemote(path.basename(REMOTE_FILE), REMOTE_SEED)
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
  if (remoteHostId && wslUp) await removeRemote()
})

/** 进项目并打开目标文件（文件树可见性重试，uiState 面板开合跑序不定） */
async function enterAndOpenFile(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('revert e2e baseline', { timeout: 8000 })
}

/** 键入追加一行使文件变脏（Monaco 行尾定位 → 回车 → 输入；autoSave 默认 off，
 *  脏态稳定保留到断言点） */
async function makeDirty(page: Page) {
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(APPEND)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(APPEND)
  await expect(page.locator('.editor-tab .tab-dot')).toBeVisible()
}

/** 「放弃未保存修改」确认弹窗（标题与确认按钮同文案） */
function revertDialog(page: Page) {
  return page.locator('.n-dialog').filter({ hasText: MENU_LABEL })
}

/** tab 右键打开自绘菜单（自绘 HTML 菜单无 Monaco 的监听延迟挂载问题） */
async function openTabContextMenu(page: Page) {
  await page.locator('.editor-tab', { hasText: FILE }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '复制路径' })).toBeVisible()
}

/** Monaco 右键打开内建菜单：菜单 item 的 mouseup 激活监听是渲染后 100ms
 *  RunOnceScheduler 延迟挂的（menu.js），右键后立刻点会落进无监听窗口成为
 *  no-op（editor-copy-reference 实测惯例），固定等 300ms */
async function openEditorContextMenu(page: Page) {
  await page.locator('.monaco-editor .view-line').first().click({ button: 'right', timeout: 15000 })
  await page.waitForTimeout(300)
}

/** 远程管理 → WSL 文件管理器 → 右键「在编辑器打开」（remote-editor-draft-recovery
 *  同款入口链，fixedLocale 后文案为中文） */
async function openRemoteFileInEditor(page: Page): Promise<Locator> {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/project')
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  const card = page.locator('.host-card').filter({ hasText: WSL_HOST_NAME }).first()
  await expect(card).toBeVisible({ timeout: 10000 })
  await card.hover()
  await card.locator('.host-card-files').click()
  const modal = page.locator('.n-modal').filter({ hasText: '文件管理' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  await modal.locator('button[title="编辑路径直达"]').click()
  await modal.locator('.rf-path-input input').fill('/tmp')
  await modal.locator('.rf-path-input input').press('Enter')
  // 路径直达后 /tmp 清单经 sshd 节流面落位可能明显滞后（seed helper 同注记），
  // 不能以「首行可见」判定到位——那会命中上一次目录的陈旧行。filteredEntries
  // 对 entries 响应式：先填过滤、目标行给足 30s 窗口，清单落位即命中
  await modal.locator('.rf-filter input').fill(path.basename(REMOTE_FILE))
  const row = modal.locator('tr').filter({ hasText: path.basename(REMOTE_FILE) }).first()
  await expect(row).toBeVisible({ timeout: 30000 })
  await row.locator('td').first().click({ button: 'right' })
  await page.locator('.rfc-item').filter({ hasText: '在编辑器打开' }).click()
  await expect(modal).toBeHidden({ timeout: 10000 })
  const tab = page.locator('.editor-tab').filter({ hasText: path.basename(REMOTE_FILE) }).first()
  await expect(tab).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.monaco-container .view-lines').first()).toContainText('remote revert seed', { timeout: 30000 })
  return tab
}

/** 在当前激活编辑器全选改写（insertText 单次 input 免 Monaco 逐键尾字符重复
 *  竞态，remote-editor-draft-recovery 同款） */
async function rewriteActiveEditor(page: Page, text: string) {
  await page.locator('.monaco-container .view-lines').first().click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(text)
  await expect(page.locator('.monaco-container .view-lines').first()).toContainText(text.trim())
}

test('干净 tab 右键无「放弃未保存修改」；编辑器右键同样不出现', async ({ page }) => {
  await enterAndOpenFile(page)
  await expect(page.locator('.editor-tab .tab-dot')).toHaveCount(0)

  await openTabContextMenu(page)
  await expect(page.getByRole('menuitem', { name: MENU_LABEL })).toHaveCount(0)
  // 菜单是常驻 fixed 定位层，不关会盖住 tab 挡住下一次右键——点「复制文件名」
  // 无害项关菜单（容器 @click 收起，动作只有剪贴板副作用）
  await page.getByRole('menuitem', { name: '复制文件名' }).click()
  await expect(page.getByRole('menuitem', { name: '复制路径' })).toHaveCount(0)

  await makeDirty(page)
  await openTabContextMenu(page)
  await expect(page.getByRole('menuitem', { name: MENU_LABEL })).toHaveCount(1)
  await page.getByRole('menuitem', { name: '复制文件名' }).click()
  await expect(page.getByRole('menuitem', { name: '复制路径' })).toHaveCount(0)

  // 编辑器右键（Monaco 内建菜单）：脏文件才出「放弃未保存修改」（scFileCanRevert）
  await openEditorContextMenu(page)
  await expect(page.getByRole('menuitem', { name: MENU_LABEL })).toHaveCount(1)
  await page.keyboard.press('Escape')
})

test('tab 右键放弃→确认→内容回磁盘态+脏点消失，磁盘不被触碰', async ({ page }) => {
  await enterAndOpenFile(page)
  await makeDirty(page)

  await openTabContextMenu(page)
  await page.getByRole('menuitem', { name: MENU_LABEL }).click()
  const dialog = revertDialog(page)
  await expect(dialog).toBeVisible()
  // 确认文案明确丢失警示（回到磁盘当前内容）
  await expect(dialog).toContainText('回到磁盘当前内容')

  await dialog.locator('.n-dialog__action button').filter({ hasText: MENU_LABEL }).click()

  // 编辑器内容回到磁盘态（追加行消失）+ 脏点消失 + 成功提示
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('revert e2e baseline')
  await expect(page.locator('.monaco-editor .view-lines')).not.toContainText(APPEND, { timeout: 5000 })
  await expect(page.locator('.editor-tab .tab-dot')).toHaveCount(0)
  await expect(page.locator('.n-message').filter({ hasText: REVERT_TOAST })).toBeVisible({ timeout: 5000 })
  // 磁盘从未被写入（放弃是纯 buffer 态动作）
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).toBe(ORIGINAL)

  // 回净态后编辑器右键菜单项随之隐藏（上下文键翻 false）
  await openEditorContextMenu(page)
  await expect(page.getByRole('menuitem', { name: MENU_LABEL })).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('tab 右键放弃→取消→原地不动仍为脏态', async ({ page }) => {
  await enterAndOpenFile(page)
  await makeDirty(page)

  await openTabContextMenu(page)
  await page.getByRole('menuitem', { name: MENU_LABEL }).click()
  await expect(revertDialog(page)).toBeVisible()
  await revertDialog(page).locator('.n-dialog__action button').filter({ hasText: '取消' }).click()

  await expect(page.locator('.editor-tab .tab-dot')).toBeVisible()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(APPEND)
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).toBe(ORIGINAL)
})

test('编辑器右键放弃→确认→内容回磁盘态', async ({ page }) => {
  await enterAndOpenFile(page)
  await makeDirty(page)

  await openEditorContextMenu(page)
  await page.getByRole('menuitem', { name: MENU_LABEL }).click()
  const dialog = revertDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.locator('.n-dialog__action button').filter({ hasText: MENU_LABEL }).click()

  await expect(page.locator('.monaco-editor .view-lines')).not.toContainText(APPEND, { timeout: 5000 })
  await expect(page.locator('.editor-tab .tab-dot')).toHaveCount(0)
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).toBe(ORIGINAL)
})

test('远程 tab 放弃→确认→回远端当前内容（远端真值不被触碰）', async ({ page }) => {
  test.skip(!wslUp, 'WSL sshd 不可达（scripts/e2e-seed-wsl.sh 可播种），跳过远程用例')
  const tab = await openRemoteFileInEditor(page)

  // buffer 全选改写变脏 → 外部改写远端（放弃应回「远端当前内容」= 改写后内容）
  await rewriteActiveEditor(page, REMOTE_MARKER + '\n')
  await expect(page.locator('.editor-tab .tab-dot').first()).toBeVisible()
  await uploadRemote(path.basename(REMOTE_FILE), REMOTE_REWRITE)

  await page.locator('.editor-tab').filter({ hasText: path.basename(REMOTE_FILE) }).first()
    .click({ button: 'right' })
  await page.getByRole('menuitem', { name: MENU_LABEL }).click()
  const dialog = revertDialog(page)
  await expect(dialog).toBeVisible()
  // 远程签确认文案指向远端当前内容
  await expect(dialog).toContainText('回到远端当前内容')
  await dialog.locator('.n-dialog__action button').filter({ hasText: MENU_LABEL }).click()

  // 编辑器内容 = 远端当前内容（非打开时快照），脏点消失，远端真值不动
  await expect(page.locator('.monaco-container .view-lines').first())
    .toContainText('remote-rewritten-while-dirty', { timeout: 15000 })
  await expect(tab.locator('.tab-dot')).toHaveCount(0)
  await expect(page.locator('.n-message').filter({ hasText: '已加载远端版本' })).toBeVisible({ timeout: 5000 })
  expect(await readRemote()).toBe(REMOTE_REWRITE)
})
