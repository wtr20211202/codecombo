import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 折叠控制命令面板暴露 E2E（P-20261006-20，配方同 quick-open-line：自备临时
 * 仓库，afterAll 清理并复位 uiState）：
 *   - 打开长文件 → 命令面板「全部折叠」→ 可见行数骤减、深层标记行消失
 *   - 「全部展开」→ 可见行数恢复、深层标记行重现
 *   - 「折叠至一级」可执行且可见行数回落（与全部折叠的可见面同族，不比数值
 *     ——区域按嵌套包含，两者隐藏行集合天然同量级，只断言执行生效）
 * 夹具用 .py：Monaco basic-languages 无语法折叠 provider → 缩进折叠（offSide），
 * 区域计算确定同步，免 TS worker 异步时序。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-palette-fold')
const PROJ = 'e2e-palette-fold'
const FILE = 'fold_target.py'
const DEEP_MARKER = 'deep_marker_alpha = 42'

function fileContent(): string {
  return [
    '# fold target for e2e',
    'def alpha():',
    '    total_a = 1',
    '    total_a += 2',
    '',
    '    def alpha_inner():',
    `        ${DEEP_MARKER}`,
    '        return deep_marker_alpha',
    '',
    '    return alpha_inner()',
    '',
    '',
    'def beta():',
    '    total_b = 10',
    '    total_b += 20',
    '',
    '    def beta_inner():',
    '        deep_marker_beta = 99',
    '        return deep_marker_beta',
    '',
    '    return beta_inner()',
    '',
    '',
    'TAIL = "fold-e2e-tail"',
    '',
  ].join('\n')
}

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
  fs.writeFileSync(path.join(REPO_DIR, FILE), fileContent())
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: palette fold 基线'])
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

/** 打开项目 + Quick Open 开夹具文件（预览位；折叠作用于活跃编辑器） */
async function openProjectAndFile(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+p')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(FILE.replace('.py', ''))
  // 文件清单异步拉取（loadPaletteFiles），条目渲染前按 Enter 是 no-op——
  // 先等条目出现再回车（quick-open-line 同款前置，缺它即偶发空按）
  await expect(page.locator('.palette-item', { hasText: FILE })).toBeVisible({ timeout: 10000 })
  await page.keyboard.press('Enter')
  await expect(page.locator('.palette-card')).toHaveCount(0)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE })).toBeVisible()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(DEEP_MARKER, { timeout: 15000 })
}

/** 命令面板执行折叠族命令。焦点须先移出 Monaco（Monaco 会吞 Ctrl+K 弦，
 * editor-snippets/editor-reopen-tab 同款前置），命令执行后面板自关 */
async function runPaletteCommand(page: import('@playwright/test').Page, title: string) {
  await page.locator('.editor-tab.active').click()
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(`>${title}`)
  const item = page.locator('.palette-item').filter({ hasText: title }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
  await expect(page.locator('.palette-card')).toHaveCount(0)
}

/** 当前渲染的可见行数（折叠隐藏行会从 view-lines DOM 移除，数量严格单调下降） */
function visibleLineCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('.monaco-editor .view-lines .view-line').length)
}

test('全部折叠 → 行数骤减深层标记消失 → 全部展开恢复', async ({ page }) => {
  await openProjectAndFile(page)
  const before = await visibleLineCount(page)
  expect(before).toBeGreaterThan(10)

  await runPaletteCommand(page, '全部折叠')
  // 深层标记行被折叠隐藏（缩进折叠 offSide：def 行保留、函数体隐藏）
  await expect(page.locator('.monaco-editor .view-lines')).not.toContainText(DEEP_MARKER, { timeout: 10000 })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('def alpha()', { timeout: 5000 })
  // 函数体内容行（缩进块）同样隐藏；区域外的顶层空行分隔符不属任何折叠区域，
  // 保持可见——行数骤减以「内容行全隐 + 计数严格下降」断言，不定魔法数值
  //（实测折叠后可见 9：4 锚点行 + 区域外空行）
  await expect(page.locator('.monaco-editor .view-lines')).not.toContainText('total_a', { timeout: 5000 })
  await expect(page.locator('.monaco-editor .view-lines')).not.toContainText('total_b', { timeout: 5000 })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('TAIL', { timeout: 5000 })
  await expect.poll(() => visibleLineCount(page), { timeout: 10000 }).toBeLessThan(before)
  const folded = await visibleLineCount(page)
  expect(folded).toBeLessThanOrEqual(Math.floor(before / 2))

  await runPaletteCommand(page, '全部展开')
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(DEEP_MARKER, { timeout: 10000 })
  await expect.poll(() => visibleLineCount(page), { timeout: 10000 }).toBe(before)
})

test('折叠至一级可执行且可见行数回落', async ({ page }) => {
  await openProjectAndFile(page)
  const before = await visibleLineCount(page)

  await runPaletteCommand(page, '折叠至一级')
  await expect.poll(() => visibleLineCount(page), { timeout: 10000 }).toBeLessThan(before)
  // def 行（一级区域锚点）仍可见：折叠的是函数体不是整文件
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('def beta()', { timeout: 5000 })

  // 收尾还原，不留折叠态给同仓库后续用例
  await runPaletteCommand(page, '全部展开')
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(DEEP_MARKER, { timeout: 10000 })
})
