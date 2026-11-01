import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 重命名后引用更新 E2E（P-20261005-157）：
 * ① 代码类文件 rename 成功 → toast 带「更新引用？」动作 → 点击 →
 *    预览弹层含两处高置信命中（'../a/b/c' 无扩展 + '../a/b/c.ts' 带扩展）→
 *    执行 → 磁盘引用更新为 New 路径（扩展名各自保留）；
 * ② 低置信 './c' 命中（同目录简式，指涉歧义）挂徽标且默认未勾，不执行保持原样；
 * ③ 零引用代码文件 rename → 点动作 → 预览不弹（零命中静默）；
 * ④ 非代码扩展名 rename → 无「更新引用？」动作 toast（扩展名门槛）。
 * 自备临时仓库（git grep 只搜 tracked 文件，须先提交基线），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-rename-ref')
const PROJ = 'e2e-rename-ref'

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

/** 基线：目标文件 a/b/c.ts + 两处高置信引用（带/不带扩展名）+ 两处低置信 './c' 简式 */
function writeBaseline() {
  fs.mkdirSync(path.join(REPO_DIR, 'a', 'b'), { recursive: true })
  fs.mkdirSync(path.join(REPO_DIR, 'src'), { recursive: true })
  fs.mkdirSync(path.join(REPO_DIR, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(REPO_DIR, 'other'), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, 'a', 'b', 'c.ts'), "export const c = 'target'\n")
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'one.ts'), "import { c } from '../a/b/c'\n")
  fs.writeFileSync(path.join(REPO_DIR, 'docs', 'two.md'), 'see [c](../a/b/c.ts)\n')
  fs.writeFileSync(path.join(REPO_DIR, 'a', 'b', 'sibling.ts'), "import { c } from './c'\n")
  fs.writeFileSync(path.join(REPO_DIR, 'other', 'holder.ts'), "import { c } from './c'\n")
}

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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  writeBaseline()
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 引用更新基线'])
  await registerProject(headers, PROJ, REPO_DIR)
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

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

/** 进入项目 + 开文件树；自备仓库条目少，逐层点开 a → b 到目标文件可见 */
async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——奇数次点击保证最终打开
  for (let i = 0; i < 3; i++) {
    if (await itemByName(page, 'src').isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
}

/** 逐层展开 a → b 直到目标文件可见（展开态持久化下幂等重试） */
async function revealTarget(page: Page, name: string) {
  for (let i = 0; i < 5; i++) {
    const target = itemByName(page, name)
    if (await target.isVisible().catch(() => false)) return target
    for (const seg of ['a', 'b']) {
      const dir = itemByName(page, seg)
      if (await dir.isVisible().catch(() => false)) {
        if (((await dir.locator('.dir-arrow').textContent().catch(() => '')) || '') !== '▼') {
          await dir.click()
          await page.waitForTimeout(500)
        }
      }
    }
    await page.waitForTimeout(500)
  }
  return itemByName(page, name)
}

/** 树内右键 rename：内联输入预填旧名 → 填新名回车 */
async function renameViaTree(page: Page, target: Locator, newName: string) {
  await target.click({ button: 'right' })
  await expect(page.locator('.n-dropdown-menu')).toBeVisible()
  await page.locator('.n-dropdown-menu').getByText('重命名', { exact: true }).click()
  const inlineInput = page.locator('.inline-input-row input')
  await expect(inlineInput).toBeVisible()
  await inlineInput.fill(newName)
  await inlineInput.press('Enter')
}

test('rename → 更新引用？→ 预览含两高置信命中 → 执行落盘 → 低置信 ./c 默认未勾不动', async ({ page }) => {
  // 重跑自愈：checkout 恢复基线引用，清掉上轮改名残留的 d.ts（否则 rename 409）
  git(REPO_DIR, ['checkout', '--', '.'])
  try { fs.rmSync(path.join(REPO_DIR, 'a', 'b', 'd.ts'), { force: true }) } catch { /* 占用忽略 */ }
  await enterProject(page)

  // 右键 c.ts → 重命名 d.ts → toast 动作「更新引用？」
  const target = await revealTarget(page, 'c.ts')
  await renameViaTree(page, target, 'd.ts')
  const action = page.locator('[data-testid="rename-ref-update"]')
  await expect(action).toBeVisible({ timeout: 5000 })

  // 点动作 → 预览弹层：两处高置信命中（src/one.ts 无扩展 + docs/two.md 带扩展）默认勾，
  // 两处低置信 './c'（a/b/sibling.ts + other/holder.ts）挂徽标默认未勾
  await action.click()
  const preview = page.locator('.n-modal').filter({ hasText: '替换预览' })
  await expect(preview).toBeVisible({ timeout: 8000 })
  const groupOne = preview.locator('.rp-file-group').filter({ hasText: 'one.ts' })
  const groupTwo = preview.locator('.rp-file-group').filter({ hasText: 'two.md' })
  const groupSibling = preview.locator('.rp-file-group').filter({ hasText: 'sibling.ts' })
  const groupHolder = preview.locator('.rp-file-group').filter({ hasText: 'holder.ts' })

  // 高置信组 after 行正确（各自扩展名保留）且默认勾选
  await expect(groupOne.locator('.rp-line.is-after')).toHaveText(["import { c } from '../a/b/d'"])
  await expect(groupTwo.locator('.rp-line.is-after')).toHaveText(['see [c](../a/b/d.ts)'])
  await expect(groupOne.locator('.n-checkbox')).toBeChecked()
  await expect(groupTwo.locator('.n-checkbox')).toBeChecked()

  // 低置信组：徽标在场、默认未勾（is-excluded 降透明态）
  await expect(groupSibling.locator('.rp-lowconf')).toHaveText('低置信')
  await expect(groupHolder.locator('.rp-lowconf')).toHaveText('低置信')
  await expect(groupSibling.locator('.n-checkbox')).not.toBeChecked()
  await expect(groupHolder.locator('.n-checkbox')).not.toBeChecked()
  await expect(groupSibling).toHaveClass(/is-excluded/)
  await expect(groupHolder).toHaveClass(/is-excluded/)

  // 统计只计勾选：2 文件 2 处
  await expect(preview.locator('.rp-stats-text')).toContainText('将替换 2 个文件中的 2 处')

  // 执行：仅高置信勾选文件落盘，引用更新为 New 路径；低置信文件原样不动
  await preview.locator('[data-testid="replace-preview-confirm"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已在 2 个文件中完成 2 处替换' })).toBeVisible({ timeout: 20000 })
  await expect(preview).toBeHidden({ timeout: 5000 })
  expect(fs.readFileSync(path.join(REPO_DIR, 'src', 'one.ts'), 'utf8')).toBe("import { c } from '../a/b/d'\n")
  expect(fs.readFileSync(path.join(REPO_DIR, 'docs', 'two.md'), 'utf8')).toBe('see [c](../a/b/d.ts)\n')
  expect(fs.readFileSync(path.join(REPO_DIR, 'a', 'b', 'sibling.ts'), 'utf8')).toBe("import { c } from './c'\n")
  expect(fs.readFileSync(path.join(REPO_DIR, 'other', 'holder.ts'), 'utf8')).toBe("import { c } from './c'\n")
  // rename 本体生效
  expect(fs.existsSync(path.join(REPO_DIR, 'a', 'b', 'd.ts'))).toBe(true)
})

test('零引用代码文件：动作在 → 点击 → 预览不弹（零命中静默）', async ({ page }) => {
  // 无引用目标（唯一词防他文件误命中）
  fs.writeFileSync(path.join(REPO_DIR, 'a', 'zz-solo-qnw.ts'), 'export const solo = 1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'solo probe'])
  await enterProject(page)

  const solo = await revealTarget(page, 'zz-solo-qnw.ts')
  await renameViaTree(page, solo, 'zz-solo-renamed.ts')
  const action = page.locator('[data-testid="rename-ref-update"]')
  await expect(action).toBeVisible({ timeout: 5000 })

  await action.click()
  // 零命中：预览弹层不出现（git grep 无命中，静默不弹）
  await expect(page.locator('.n-modal').filter({ hasText: '替换预览' })).toHaveCount(0, { timeout: 4000 })
})

test('非代码扩展名：rename 成功无「更新引用？」动作（扩展名门槛）', async ({ page }) => {
  fs.writeFileSync(path.join(REPO_DIR, 'a', 'probe-img-pkw.png'), 'binary-ish\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'png probe'])
  await enterProject(page)

  const png = await revealTarget(page, 'probe-img-pkw.png')
  await renameViaTree(page, png, 'probe-img-renamed.png')

  // rename 成功 toast 在场，但无「更新引用？」动作钮
  await expect(page.locator('.n-message').filter({ hasText: '已重命名为' }).first()).toBeVisible({ timeout: 5000 })
  await expect(page.locator('[data-testid="rename-ref-update"]')).toHaveCount(0)
})
