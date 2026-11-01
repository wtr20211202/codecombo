import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件树同名族嵌套（P-20261006-21）E2E：
 *   ① 默认关：同名族平铺无角标（历史形态零回归）
 *   ② 设置·外观开嵌套：Card.vue 行 +2 角标，Card.css / Card.test.ts 折叠隐藏
 *   ③ 点角标展开子行（缩进弱化）→ 点击子行打开对应文件（右键/拖拽按行自然继承）
 *   ④ 过滤态自动全展开：折叠族内子文件可被树搜索命中（过滤优先于折叠）
 *   ⑤ 开关刷新持久（file-nesting-settings localStorage，fileNesting store boot 重读）
 * 自备临时仓库（Card.vue + Card.test.ts + Card.css 同名族），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-file-tree-nesting')
const PROJ = 'e2e-file-tree-nesting'
// fileNesting store 的 localStorage 键（stores/file-nesting.ts）：用例 3-5 用
// addInitScript 预置开启（等价于设置页打开），用例 2 走真实设置 UI 开关
const NESTING_KEY = 'file-nesting-settings'

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
  fs.mkdirSync(path.join(REPO_DIR, 'src', 'components'), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'nesting e2e baseline\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'components', 'Card.vue'), '<template />\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'components', 'Card.test.ts'), "it('renders', () => {})\n")
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'components', 'Card.css'), '.card {}\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 嵌套基线'])
  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  try {
    const headers = await unlockHeaders()
    const token = headers['X-Lock-Token']
    if (projectId) {
      await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
    await fetch(`${API_BASE}/api/ui-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
      body: JSON.stringify({ local: null }),
    })
  } catch { /* 服务未起等场景忽略 */ }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 进入项目并保证文件树可见（rail 按钮是 toggle，奇数次点击保证最终打开） */
async function enterProject(page: Page, nesting = false) {
  await fixedLocale(page)
  if (nesting) {
    await page.addInitScript(([key]) => {
      localStorage.setItem(key as string, JSON.stringify({ enabled: true }))
    }, [NESTING_KEY])
  }
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
}

function treeItem(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.file-tree .tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

/** 逐层展开到同名族所在目录 */
async function expandToFamily(page: Page) {
  await treeItem(page, 'src').click()
  await expect(treeItem(page, 'components')).toBeVisible({ timeout: 5000 })
  await treeItem(page, 'components').click()
  await expect(treeItem(page, 'Card.vue')).toBeVisible({ timeout: 5000 })
}

test.describe('文件树同名族嵌套', () => {
  test('默认关：同名族平铺无角标（历史形态零回归）', async ({ page }) => {
    await enterProject(page)
    await expandToFamily(page)
    await expect(treeItem(page, 'Card.vue')).toBeVisible()
    await expect(treeItem(page, 'Card.test.ts')).toBeVisible()
    await expect(treeItem(page, 'Card.css')).toBeVisible()
    await expect(page.locator('.file-tree [data-testid="nest-badge"]')).toHaveCount(0)
  })

  test('设置·外观开启：Card.vue 行 +2 角标，子行折叠隐藏', async ({ page }) => {
    await enterProject(page)
    await expandToFamily(page)

    // 设置 → 外观 → 勾选「文件树同名族嵌套」（直写行，即时生效；点 n-checkbox
    // 而非裸 label——受控 checkbox 的成熟交互写法，editor-tab-git-status 同款）
    await page.locator('[data-testid="rail-settings"]').click()
    await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
    await page.locator('[data-testid="settings-nav-appearance"]').click()
    const row = page.locator('[data-testid="settings-file-nesting"]')
    await expect(row).toBeVisible({ timeout: 3000 })
    await row.locator('.n-checkbox').click()
    await expect(row.locator('.n-checkbox')).toHaveClass(/n-checkbox--checked/)
    // 直写即时落 localStorage（fileNesting store），不依赖设置保存
    await expect.poll(() => page.evaluate(
      ([key]) => JSON.parse(localStorage.getItem(key as string) || '{}')?.enabled === true,
      [NESTING_KEY],
    )).toBe(true)
    // 直写行不参与脏护栏，Escape 干净关窗（git-status-tabs 同款）
    await page.keyboard.press('Escape')
    await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })

    // 族折叠：主行带 +2 角标，子行消失
    const badge = treeItem(page, 'Card.vue').locator('[data-testid="nest-badge"]')
    await expect(badge).toHaveText('+2', { timeout: 5000 })
    await expect(treeItem(page, 'Card.test.ts')).toHaveCount(0)
    await expect(treeItem(page, 'Card.css')).toHaveCount(0)
  })

  test('角标展开子行 → 点击子行打开对应文件', async ({ page }) => {
    await enterProject(page, true)
    await expandToFamily(page)

    // 折叠态起步（预置开启）：点角标展开
    const badge = treeItem(page, 'Card.vue').locator('[data-testid="nest-badge"]')
    await expect(badge).toHaveText('+2', { timeout: 5000 })
    await badge.click()
    await expect(badge).toHaveAttribute('title', '收起同名文件')
    const child = treeItem(page, 'Card.test.ts')
    await expect(child).toBeVisible()
    await expect(child).toHaveClass(/is-nest-child/)
    await expect(treeItem(page, 'Card.css')).toBeVisible()
    await expect(treeItem(page, 'Card.css')).toHaveClass(/is-nest-child/)

    // 点击子行 = 打开对应文件（树行点击语义自然继承；再点角标收起不影响已开 tab）
    await child.click()
    await expect(page.locator('.editor-tab', { hasText: 'Card.test.ts' })).toBeVisible({ timeout: 5000 })
    await badge.click()
    await expect(treeItem(page, 'Card.test.ts')).toHaveCount(0)
    await expect(page.locator('.editor-tab', { hasText: 'Card.test.ts' })).toBeVisible()
  })

  test('过滤态自动全展开：折叠族内子文件可被树搜索命中（过滤优先）', async ({ page }) => {
    await enterProject(page, true)
    await expandToFamily(page)
    await expect(treeItem(page, 'Card.test.ts')).toHaveCount(0) // 折叠生效

    // `/` 直达或工具条按钮开搜索栏，输入过滤词 → 嵌套让位：子行全体可见、角标消失
    await page.locator('.tree-action-btn[title="搜索文件"]').click()
    await page.locator('.tree-search input').fill('Card')
    await expect(treeItem(page, 'Card.test.ts')).toBeVisible({ timeout: 5000 })
    await expect(treeItem(page, 'Card.css')).toBeVisible()
    await expect(page.locator('.file-tree [data-testid="nest-badge"]')).toHaveCount(0)

    // 清过滤回折叠态
    await page.locator('.tree-search input').press('Escape')
    await expect(treeItem(page, 'Card.test.ts')).toHaveCount(0)
    await expect(treeItem(page, 'Card.vue').locator('[data-testid="nest-badge"]')).toHaveText('+2')
  })

  test('刷新持久：开关跨刷新生效（localStorage boot 重读）', async ({ page }) => {
    await enterProject(page, true)
    await expandToFamily(page)
    await expect(treeItem(page, 'Card.vue').locator('[data-testid="nest-badge"]')).toHaveText('+2', { timeout: 5000 })

    await page.reload()
    await gotoAndUnlock(page, `${API_BASE}/`)
    await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
    await page.waitForURL('**/project')
    for (let i = 0; i < 3; i++) {
      if (await page.locator('.file-tree .item-name').first().isVisible().catch(() => false)) break
      await page.locator('[data-testid="rail-files"]').click()
      await page.waitForTimeout(600)
    }
    // 目录展开态（localStorage sc.fileTree.expanded.*）随 restoreExpanded 自动恢复，
    // 不再点击展开（再点会 toggle 收起）；断言恢复后的折叠形态：开关持久 → 角标
    // 仍在、族内子行仍隐藏（嵌套展开态是会话级，reload 后默认收起=设计语义）
    await expect(treeItem(page, 'Card.vue').locator('[data-testid="nest-badge"]')).toHaveText('+2', { timeout: 5000 })
    await expect(treeItem(page, 'Card.test.ts')).toHaveCount(0)
  })
})
