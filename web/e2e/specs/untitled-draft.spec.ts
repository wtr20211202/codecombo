import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 未命名草稿闭环 E2E（P-20261002-24）：Ctrl+Alt+N 新建草稿 tab → 编辑 →
 * Ctrl+S 拦截转「另存为」→ CreateFile 落盘 + tab 原地转正 + 文件树定位；
 * 以及草稿不持久化（刷新不恢复）与关闭有内容草稿的确认丢弃。
 * 草稿不适入口屏蔽（P-20261003-96）：tab 右键无「就此文件询问智能体」、
 * blame/Git 快捷操作按钮隐藏、备忘单含 Ctrl+Alt+N 行；真实文件入口不受影响。
 * 自备临时仓库，afterAll 清理（含 git checkout 还原）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-untitled-draft')
const PROJ = 'e2e-untitled-draft'
const SEED_FILE = 'seed.txt'
const SAVE_AS_PATH = 'draft-saved.md'
const DRAFT_TEXT = 'scratch before deciding where it lives'

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
  fs.writeFileSync(path.join(REPO_DIR, SEED_FILE), 'seed line\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 未命名草稿基线'])
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

async function openProjectPage(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
}

/** Ctrl+Alt+N 新建草稿（重试兜底：项目页 bootstrap 期间全局 keydown 监听可能未挂载；
 *  每次按键后先等 tab 出现再决定是否重试，避免按键生效后重复新建） */
async function pressNewDraft(page: import('@playwright/test').Page) {
  const draftTab = page.locator('.editor-tab').filter({ hasText: '草稿' }).first()
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Control+Alt+n')
    try {
      await expect(draftTab).toBeVisible({ timeout: 2000 })
      return
    } catch { /* 监听未挂载，重试 */ }
  }
  await expect(draftTab).toBeVisible({ timeout: 5000 })
}

test('草稿闭环：Ctrl+Alt+N 新建 → 编辑 → Ctrl+S 另存为 → 落盘 + tab 转正 + 文件树定位', async ({ page }) => {
  await openProjectPage(page)

  // Ctrl+Alt+N 新建草稿 tab（焦点在 body，非输入框）
  await pressNewDraft(page)
  const draftTab = page.locator('.editor-tab').filter({ hasText: '草稿' }).first()
  await expect(draftTab).toBeVisible({ timeout: 5000 })
  await expect(draftTab).toHaveClass(/active/)

  // 编辑草稿内容（Monaco 聚焦后键入）
  await page.locator('.monaco-editor').click()
  await page.keyboard.type(DRAFT_TEXT)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(DRAFT_TEXT)
  // 脏标记出现
  await expect(draftTab.locator('.tab-dot')).toBeVisible()

  // Ctrl+S 拦截 → 另存为弹窗（promptDialog）
  await page.keyboard.press('Control+s')
  const dialogInput = page.locator('.n-dialog input')
  await expect(dialogInput).toBeVisible({ timeout: 5000 })
  await dialogInput.fill(SAVE_AS_PATH)
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()

  // tab 原地转正：路径/名更新、同一 tab（数量不变）、脏标记消失
  await expect(page.locator('.n-message').filter({ hasText: '已保存' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.editor-tab')).toHaveCount(1)
  await expect(page.locator('.editor-tab').filter({ hasText: SAVE_AS_PATH })).toBeVisible()
  await expect(page.locator('.editor-tab').filter({ hasText: '草稿' })).toHaveCount(0)
  await expect(page.locator('.editor-tab .tab-dot')).toHaveCount(0)
  // 内容跟随 tab 原地转正（未丢字）
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(DRAFT_TEXT)

  // 磁盘生效（CreateFile 随建随写）
  await expect.poll(async () => {
    try { return fs.readFileSync(path.join(REPO_DIR, SAVE_AS_PATH), 'utf8') } catch { return '' }
  }, { timeout: 5000 }).toContain(DRAFT_TEXT)
  expect(git(REPO_DIR, ['status', '--porcelain'])).toContain(SAVE_AS_PATH)

  // 另存为成功 → 文件树刷新并定位新文件（钩子先 refreshRoot 再 reveal）
  await expect(page.locator('.file-tree .item-name', { hasText: SAVE_AS_PATH }).first()).toBeVisible({ timeout: 8000 })

  // 草稿 tab 不持久化：刷新后转正文件恢复、草稿不复活
  await page.reload()
  await expect(page.locator('.editor-tab').filter({ hasText: SAVE_AS_PATH })).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.editor-tab').filter({ hasText: '草稿' })).toHaveCount(0)
})

test('关闭有内容草稿：确认后丢弃；取消则保留', async ({ page }) => {
  await openProjectPage(page)

  await pressNewDraft(page)
  const draftTab = page.locator('.editor-tab').filter({ hasText: '草稿' }).first()
  await expect(draftTab).toBeVisible({ timeout: 5000 })

  // 写入内容后点 × 关闭 → 未保存确认弹窗
  await page.locator('.monaco-editor').click()
  await page.keyboard.type('throwaway content')
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('throwaway content')
  await draftTab.locator('.tab-close').click()
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 5000 })

  // 取消：草稿保留、内容原样
  await dialog.locator('button').filter({ hasText: '取消' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(draftTab).toBeVisible()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('throwaway content')

  // 再关 → 确认：草稿丢弃（不落盘）
  await draftTab.locator('.tab-close').click()
  await expect(page.locator('.n-dialog')).toBeVisible({ timeout: 5000 })
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.editor-tab').filter({ hasText: '草稿' })).toHaveCount(0, { timeout: 5000 })

  // 磁盘无任何草稿残留
  expect(fs.readdirSync(REPO_DIR)).not.toContain('untitled')
})

test('草稿不适入口屏蔽：右键无询问智能体项、blame/历史按钮隐藏；备忘单含 Ctrl+Alt+N；真实文件不受影响（P-20261003-96）', async ({ page }) => {
  await openProjectPage(page)

  // ① 草稿 tab 右键菜单不含「就此文件询问智能体」（untitled://N 内部键对 agent 无意义）
  await pressNewDraft(page)
  const draftTab = page.locator('.editor-tab').filter({ hasText: '草稿' }).first()
  await expect(draftTab).toBeVisible({ timeout: 5000 })
  await draftTab.click({ button: 'right' })
  const menu = page.locator('[role="menu"]').first()
  await expect(menu).toBeVisible()
  await expect(page.getByRole('menuitem').filter({ hasText: '就此文件询问智能体' })).toHaveCount(0)
  // 点菜单顶部 4px padding 区收起（容器点击即关，不触达任何菜单项）
  await menu.click({ position: { x: 80, y: 2 } })
  await expect(menu).toBeHidden()

  // ② blame 按钮 / Git 快捷操作锚（历史/对比/询问智能体按钮族）对草稿隐藏
  await expect(page.locator('.blame-toggle-btn')).toHaveCount(0)
  await expect(page.locator('.ega-anchor')).toHaveCount(0)

  // ③ 备忘单含「新建未命名草稿」行（Ctrl+Alt+N 键位可发现性，P-28 起在列）
  await page.keyboard.press('Shift+Slash')
  const help = page.locator('.sc-help').filter({ hasText: '快捷键' }).first()
  await expect(help).toBeVisible({ timeout: 3000 })
  const draftRow = help.locator('.sc-help-row').filter({ hasText: '新建未命名草稿' })
  await expect(draftRow).toBeVisible()
  await expect(draftRow.locator('kbd')).toHaveText(['Ctrl', 'Alt', 'N'])
  await page.keyboard.press('Escape')
  await expect(help).toBeHidden({ timeout: 3000 })

  // 真实文件入口不受影响：seed.txt 的询问智能体项与 blame/历史按钮照常
  await page.locator('.file-tree .item-name', { hasText: SEED_FILE }).first().click()
  await expect(page.locator('.blame-toggle-btn')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.ega-anchor')).toBeVisible()
  const seedTab = page.locator('.editor-tab').filter({ hasText: SEED_FILE })
  await seedTab.click({ button: 'right' })
  await expect(page.getByRole('menuitem').filter({ hasText: '就此文件询问智能体' })).toBeVisible()
})

// 编辑器内右键项目域动作的草稿守卫（P-20261005-180，P-96 自认「留待后续提案」
// 的兑现）：untitled://N 草稿无磁盘基线，文件历史/与引用对比/剪贴板对比/定位
// 文件树/本地历史/选区询问智能体/复制引用整族菜单项经 scFileIsDraft 上下文键
// 摘除（草稿右键菜单无此族项）；纯 buffer/选区动作（存片段/分享/发送终端）
// 不受影响；真实文件正向对照全量在场。菜单在 Monaco shadow DOM，Playwright
// locator 自动穿透（ask-selection.spec 同口径）。
const PROJECT_DOMAIN_ITEMS = [
  '与分支/Tag/提交对比…',
  '与剪贴板内容对比',
  '查看文件历史',
  '在文件树中定位',
  '本地历史',
  '复制引用（路径:行）',
] as const
const ASK_SELECTION_ITEM = '询问智能体选中代码'

test('草稿编辑器内右键：项目域动作族不出现；真实文件正向对照（P-20261005-180）', async ({ page }) => {
  await openProjectPage(page)
  const menu = page.locator('.context-view .monaco-menu, .monaco-menu-container .monaco-menu')

  // ① 草稿：写入内容并全选（editorHasSelection 真——若无草稿守卫，「询问智能体
  // 选中代码」本应出现，一并断言其缺席才是有效守卫证据而非 editorHasSelection 假)
  await pressNewDraft(page)
  await page.locator('.monaco-editor').click()
  await page.keyboard.type(DRAFT_TEXT)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(DRAFT_TEXT)
  await page.keyboard.press('Control+a')
  // 选区内右键不塌缩选区（ask-selection.spec 同口径）：x=10 落在行首字符上
  await page.locator('.monaco-editor .view-line').first().click({ button: 'right', position: { x: 10, y: 8 } })
  await expect(menu.first()).toBeVisible({ timeout: 3000 })
  for (const label of [...PROJECT_DOMAIN_ITEMS, ASK_SELECTION_ITEM]) {
    await expect(menu.first().locator('.action-item').filter({ hasText: label }),
      `草稿菜单不应出现「${label}」`).toHaveCount(0)
  }
  // 对照组：纯 buffer/选区动作在场（菜单确实开了，守卫只摘项目域族）
  await expect(menu.first().locator('.action-item').filter({ hasText: '分享选中文本' })).toBeAttached()
  await expect(menu.first().locator('.action-item').filter({ hasText: '发送选中到终端' })).toBeAttached()
  await page.keyboard.press('Escape')
  await expect(menu.first()).toBeHidden({ timeout: 3000 })

  // ② 真实文件正向对照：同一菜单族逐项在场（选区在 → 含选区询问智能体）
  await page.locator('.file-tree .item-name', { hasText: SEED_FILE }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('seed line', { timeout: 8000 })
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+a')
  await page.locator('.monaco-editor .view-line').first().click({ button: 'right', position: { x: 10, y: 8 } })
  await expect(menu.first()).toBeVisible({ timeout: 3000 })
  for (const label of [...PROJECT_DOMAIN_ITEMS, ASK_SELECTION_ITEM]) {
    await expect(menu.first().locator('.action-item').filter({ hasText: label }),
      `真实文件菜单应有「${label}」`).toBeAttached()
  }
  await page.keyboard.press('Escape')
})
