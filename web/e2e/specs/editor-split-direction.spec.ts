import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器分屏方向（正交拆分，P-20261005-230）E2E：
 *   ① tab 右键「在下方分屏打开」→ 上下堆叠（.editor-split-vertical），同文件开进分屏组
 *   ② Ctrl+Alt+\（splitDown 键位）三态：纵向开着 → 关闭；未分屏 → 开纵向；
 *      Ctrl+\（toggleSplit）恒开横向（方向切回）
 *   ③ 纵向分屏随 uiState 持久化：刷新后方向与分屏组清单一并恢复
 *   ④ 旧布局兼容（升级纪律「旧数据面 + 新二进制」）：预置无 splitDirection 字段的
 *      editor 命名空间 → 横向恢复，行为与历史完全一致
 * 自备临时仓库，afterAll 清理并复位 uiState。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-split-direction')
const PROJ = 'e2e-split-direction'
const FILES = [
  { name: 'dir-a.txt', content: 'direction alpha content' },
  { name: 'dir-b.txt', content: 'direction beta content' },
]

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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  for (const f of FILES) fs.writeFileSync(path.join(REPO_DIR, f.name), f.content + '\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 分屏方向基线'])
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
  // editor 命名空间整键清除（null = 服务端清命名空间语义）：方向/清单残留不污染他 spec
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: { editor: null } }),
  })
})

/** 打开项目并经文件树打开夹具文件（editor-split.spec 同款就绪重试口径） */
async function openProjectAndFiles(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILES[0]!.name }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  for (const f of FILES) {
    await page.locator('.file-tree .item-name', { hasText: f.name }).first().click()
  }
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[1]!.name })).toBeVisible()
}

/** 若上次会话恢复出分屏（空态占位或带文件），先一键关闭归到单组 */
async function ensureSplitClosed(page: import('@playwright/test').Page) {
  if (!(await page.locator('.pane-split').isVisible().catch(() => false))) return
  const emptyClose = page.locator('.split-empty-close')
  if (await emptyClose.isVisible().catch(() => false)) {
    await emptyClose.click()
  } else {
    await page.locator('.pane-split .editor-tab').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: '关闭分屏' }).click()
  }
  await expect(page.locator('.pane-split')).toHaveCount(0)
}

test('在下方分屏打开（纵向渲染）→ splitDown 键位三态 → Ctrl+\\ 切回横向 → 纵向刷新恢复', async ({ page }) => {
  await openProjectAndFiles(page)
  await ensureSplitClosed(page)

  // 右键 b → 在下方分屏打开：分屏组出现且容器为纵向堆叠（排列轴翻转）
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[1]!.name }).click({ button: 'right' })
  await page.getByTestId('tab-split-down').click()
  await expect(page.locator('.pane-split')).toBeVisible()
  await expect(page.locator('.editor-split.editor-split-vertical')).toBeVisible()
  await expect(page.locator('.split-divider.split-divider-v')).toBeVisible()
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[1]!.name })).toHaveClass(/active/)
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 8000 })
  // 主组标签原样保留（同一共享对象）
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[1]!.name })).toBeVisible()

  // Ctrl+Alt+\（splitDown）：纵向开着 → 同向再按取消拆分（终端 splitTab toggle 语义对称）
  await page.keyboard.press('Control+Alt+\\')
  await expect(page.locator('.pane-split')).toHaveCount(0)

  // 再按 Ctrl+Alt+\：未分屏 → 以活跃文件开纵向分屏
  await page.keyboard.press('Control+Alt+\\')
  await expect(page.locator('.pane-split')).toBeVisible()
  await expect(page.locator('.editor-split.editor-split-vertical')).toBeVisible()
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[1]!.name })).toBeVisible()

  // Ctrl+\（toggleSplit）：关屏再开恒回横向（键位文案承诺「右侧」，方向切回）
  await page.keyboard.press('Control+\\')
  await expect(page.locator('.pane-split')).toHaveCount(0)
  await page.keyboard.press('Control+\\')
  await expect(page.locator('.pane-split')).toBeVisible()
  await expect(page.locator('.editor-split.editor-split-vertical')).toHaveCount(0)
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[1]!.name })).toBeVisible()

  // 回到纵向 → 等防抖持久化落盘 → 刷新：方向与分屏组清单一并恢复（P-20261005-230）
  await page.keyboard.press('Control+\\')
  await expect(page.locator('.pane-split')).toHaveCount(0)
  await page.keyboard.press('Control+Alt+\\')
  await expect(page.locator('.editor-split.editor-split-vertical')).toBeVisible()
  await page.waitForTimeout(1800) // uiState 自动保存防抖 500ms + PUT 往返

  await page.reload()
  await expect(page.locator('.pane-primary .editor-tab').first()).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.pane-split')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.editor-split.editor-split-vertical')).toBeVisible()
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[1]!.name })).toBeVisible()
})

test('旧布局兼容：uiState 无 splitDirection 字段时按横向恢复（零值=既有行为不变）', async ({ page }) => {
  await openProjectAndFiles(page)
  await ensureSplitClosed(page)

  // 先等自动保存把「分屏关闭」现场冲刷落盘并对齐脏键基底——此后页面零变更，
  // 离开页面时 forceSave 按零 diff 零写，外部预置的旧形态记录不被覆盖
  await page.waitForTimeout(1800)

  // 离开页面 → 预置「旧版本」editor 命名空间：splitOpen/splitFiles/splitActiveFile
  // 齐全但无 splitDirection 字段（升级纪律「旧数据面 + 新二进制」形态，editor
  // 整键替换不带新字段）
  await page.goto('about:blank')
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ local: {
      projectId,
      editor: {
        openFiles: [FILES[0]!.name],
        activeIndex: 0,
        scrollPositions: {},
        splitOpen: true,
        splitFiles: [FILES[1]!.name],
        splitActiveFile: FILES[1]!.name,
      },
    } }),
  })
  expect([200, 204]).toContain(res.status)

  // 重进项目（直达 /project——显式点项目卡进项目会跳过 uiState 项目维度恢复，
  // bootstrap appliedPending 短路是既有设计）：分屏按横向恢复（无纵向容器类），
  // 分屏组清单照常回位
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/project`)
  await expect(page.locator('.pane-primary .editor-tab').first()).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.pane-split')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.editor-split.editor-split-vertical')).toHaveCount(0)
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[1]!.name })).toBeVisible()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name })).toBeVisible()
})
