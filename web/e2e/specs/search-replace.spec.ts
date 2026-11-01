import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 全工程搜索替换 E2E（补齐「替换」UI 的真实动作）：
 * Ctrl+Shift+F 打开 → 搜索 foo → 展开替换 → 填 bar → 全部替换 → 确认 →
 * 两个文件磁盘内容均已替换、toast 汇报 2 文件 3 处。
 * 自备临时仓库，afterAll 清理（范式与 stash-flow 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-search-replace')
const PROJ = 'e2e-search-replace'

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
  fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), 'foo bar foo\n')
  fs.writeFileSync(path.join(REPO_DIR, 'b.txt'), 'foo baz\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 搜索替换基线'])
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

test('全工程替换：搜索 foo → 全部替换为 bar → 磁盘生效 → 打开中的编辑器同步', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 先在编辑器打开 a.txt（验证替换后已打开文件自动重读磁盘）
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: 'a.txt' }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: 'a.txt' }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('foo bar foo', { timeout: 8000 })

  // Ctrl+Shift+F 打开全工程搜索
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })

  // 搜索 foo（防抖 300ms + git grep）
  await card.locator('input').first().fill('foo')
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })

  // 展开替换行，填替换值，执行全部替换
  await card.locator('button[title="替换"]').click()
  await expect(card.locator('.ps-replace-row input')).toBeVisible({ timeout: 3000 })
  await card.locator('.ps-replace-row input').fill('bar')
  await card.getByRole('button', { name: '全部替换' }).click()

  // 预览弹层（P-20261003-71）：before→after 行级对照，after 与执行同函数生成
  const preview = page.locator('.n-modal').filter({ hasText: '替换预览' })
  await expect(preview).toBeVisible({ timeout: 3000 })
  const groupA = preview.locator('.rp-file-group').filter({ hasText: 'a.txt' })
  await expect(groupA.locator('.rp-line.is-before')).toContainText('foo bar foo')
  await expect(groupA.locator('.rp-line.is-after')).toContainText('bar bar bar')
  await expect(preview.locator('.rp-file-group').filter({ hasText: 'b.txt' }).locator('.rp-line.is-after')).toContainText('bar baz')
  await preview.locator('[data-testid="replace-preview-confirm"]').click()

  // 处数不写死：Windows 服务端走 rg（--vimgrep 每处一条），Linux 无 rg 走
  // git grep（每行一条）——同仓库计数天然不同（3 vs 2），语义以磁盘断言为准。
  // 20s：替换是逐文件异步读改写，跨拓扑（/mnt/c IO + WS 往返）可超 8s
  await expect(page.locator('.n-message').filter({ hasText: /已在 2 个文件中完成 \d+ 处替换/ })).toBeVisible({ timeout: 20000 })

  // 磁盘真实状态
  expect(fs.readFileSync(path.join(REPO_DIR, 'a.txt'), 'utf8')).toBe('bar bar bar\n')
  expect(fs.readFileSync(path.join(REPO_DIR, 'b.txt'), 'utf8')).toBe('bar baz\n')

  // 打开中的编辑器同步新内容（否则用户下次保存会把替换覆盖回去）
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('bar bar bar', { timeout: 8000 })
})

test('正则模式替换：b.r → beer，选项语义与替换一致', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 前置状态（上一用例后）：a.txt = bar bar bar、b.txt = bar baz

  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })

  // 开启正则选项后搜索 b.r
  await card.locator('input').first().fill('b.r')
  // fill 聚焦输入框，搜索执行后 needle 随即入查询历史（P-20261003-48 全局域
  // 环形表）→ 历史下拉弹出。历史上其 absolute 悬浮盖住选项 chips、regex 勾选
  // 点击被 ps-history-item 拦截（search-replace-preview 同款根因，负载下偶发），
  // P-20261006-32 已改锚头部件下缘不再遮挡；显式 blur 收下拉照旧保留作双保险：
  // @blur 即 historyFocused=false，与产品 Esc 分层「先收下拉」同语义
  await card.locator('input').first().blur()
  await card.locator('.opt-chip').filter({ hasText: '.*' }).locator('.n-checkbox').click()
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })

  // 展开替换行 → 填 beer → 全部替换
  await card.locator('button[title="替换"]').click()
  await card.locator('.ps-replace-row input').fill('beer')
  await card.getByRole('button', { name: '全部替换' }).click()
  // 预览弹层：正则替换的 after 行与执行同函数生成（b.r → beer）
  const preview = page.locator('.n-modal').filter({ hasText: '替换预览' })
  await expect(preview).toBeVisible({ timeout: 3000 })
  await expect(preview.locator('.rp-file-group').filter({ hasText: 'a.txt' }).locator('.rp-line.is-after')).toContainText('beer beer beer')
  await preview.locator('[data-testid="replace-preview-confirm"]').click()
  // 替换是逐文件异步读改写，完成才弹成功 toast：必须等完成信号再断言磁盘，
  // 否则与写入竞态（曾因 bundle 重建后时序变化稳定误报为丢写入）
  await expect(page.locator('.n-message').filter({ hasText: '已在 2 个文件中完成' })).toBeVisible({ timeout: 8000 })

  // 磁盘真实状态：a.txt 3 处 + b.txt 1 处
  expect(fs.readFileSync(path.join(REPO_DIR, 'a.txt'), 'utf8')).toBe('beer beer beer\n')
  expect(fs.readFileSync(path.join(REPO_DIR, 'b.txt'), 'utf8')).toBe('beer baz\n')
})

test('外部改写跳过脏文件：打开中且有未保存修改的文件不写入 + 通知中心点名', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 自包含重置：前序用例可能改写文件（bar/beer），显式还原基线内容
  // （checkout 还原 git 内文件；显式重写确保无未跟踪差异）
  git(REPO_DIR, ['checkout', '--', '.'])
  fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), 'foo bar foo\n')
  fs.writeFileSync(path.join(REPO_DIR, 'b.txt'), 'foo baz\n')

  // 打开 a.txt 并制造未保存修改（追加 X → foo bar fooX）
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: 'a.txt' }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: 'a.txt' }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('foo bar foo', { timeout: 8000 })
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('X')
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('foo bar fooX')

  // 替换 foo → beer：a.txt 脏 → 跳过；b.txt 干净 → 替换
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await card.locator('input').first().fill('foo')
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })
  await card.locator('button[title="替换"]').click()
  await card.locator('.ps-replace-row input').fill('beer')
  await card.getByRole('button', { name: '全部替换' }).click()
  const preview = page.locator('.n-modal').filter({ hasText: '替换预览' })
  await expect(preview).toBeVisible({ timeout: 3000 })
  await preview.locator('[data-testid="replace-preview-confirm"]').click()

  // 处数不写死（rg/git grep 后端计数不同）+ 20s 容忍跨拓扑逐文件读改写
  await expect(page.locator('.n-message').filter({ hasText: /已在 2 个文件中完成 \d+ 处替换/ })).toBeVisible({ timeout: 20000 })

  // a.txt 磁盘已被替换（beer bar beer）；用户的未保存修改只保留在内存，
  // 已有通知中心点名提示人工核对
  expect(fs.readFileSync(path.join(REPO_DIR, 'a.txt'), 'utf8')).toBe('beer bar beer\n')
  expect(fs.readFileSync(path.join(REPO_DIR, 'b.txt'), 'utf8')).toBe('beer baz\n')

  // 通知中心点名跳过的脏文件
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/notifications`, { headers })
  const body = (await res.json()) as { data?: Array<{ title?: string; body?: string }> }
  const warn = (body.data || []).find(n => (n.title || '').includes('未同步外部修改'))
  expect(warn, '应有跳过脏文件的通知').toBeTruthy()
  expect(warn?.body || '').toContain('a.txt')
})


test('搜索文件模式：glob 限定 *.md 时 .txt 匹配被排除', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 自包含重置：前序用例可能已把 foo 全部替换掉，显式还原基线
  git(REPO_DIR, ['checkout', '--', '.'])
  fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), 'foo bar foo\n')
  fs.writeFileSync(path.join(REPO_DIR, 'b.txt'), 'foo baz\n')

  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })

  // glob 限定 *.md：foo 只在 .txt 中 → 无匹配结果
  await card.locator('input').first().fill('foo')
  await card.locator('.ps-glob input').fill('*.md')
  await expect(card.getByText('无匹配结果')).toBeVisible({ timeout: 30000 })

  // 放宽为 *.txt：两个文件的匹配全部出现
  await card.locator('.ps-glob input').fill('*.txt')
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 30000 })
  await expect(card.getByText('无匹配结果')).toHaveCount(0)
})

test('结果键盘导航：↓ 高亮首个匹配，Enter 打开文件', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await card.locator('input').first().fill('foo')
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })

  // ↓ 选中首个匹配（is-active），Enter 打开文件
  await card.locator('input').first().press('ArrowDown')
  await expect(card.locator('.ps-line.is-active').first()).toBeVisible({ timeout: 3000 })
  await card.locator('input').first().press('Enter')

  // 打开动作：面板关闭 + 编辑器打开对应文件
  await expect(card).toBeHidden({ timeout: 5000 })
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 8000 })
})
