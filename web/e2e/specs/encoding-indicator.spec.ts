import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器编码指示与转码 E2E（P-20261002-146）：GBK fixture → Breadcrumb 徽标可见 →
 * 重新以指定编码载入中文正确显示；转码保存后磁盘字节按目标编码落盘。
 * 服务端 P-7 链路（ReadFile 探测解码 / WriteFile encoding 回传）已被后端单测覆盖，
 * 本 spec 验证前端徽标/菜单/动作流与磁盘字节闭环。自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-encoding-indicator')
const PROJ = 'e2e-encoding-indicator'
// GBK fixture：中文内容行的 GB18030 字节（ASCII 段两编码同形，中文段必须非 UTF-8）
const GBK_FILE = 'gbk-legacy.txt'
const GBK_TEXT = '中文内容行\nGBK 第二行\n'
const GBK_BYTES = Buffer.from(
  'd6d0cec4c4dac8ddd0d00a47424b20b5dab6fed0d00a'.replace(/\s/g, ''), 'hex',
)
// UTF-8 fixture：含中文（转存 GBK 后字节改变，纯 ASCII 无法证明转码）
const UTF8_FILE = 'utf8-baseline.txt'
const UTF8_TEXT = 'utf8 基线 中文\n'
const UTF8_TEXT_GBK_BYTES = Buffer.from('7574663820bbf9cfdf20d6d0cec40a', 'hex')

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

/** 每用例自归一：磁盘 fixture 重写为初始编码（转码用例会改写磁盘，--repeat 重跑不串） */
function seedFixtures() {
  fs.writeFileSync(path.join(REPO_DIR, GBK_FILE), GBK_BYTES)
  fs.writeFileSync(path.join(REPO_DIR, UTF8_FILE), UTF8_TEXT, 'utf8')
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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：服务端 git 不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  seedFixtures()
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 编码指示基线'])
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

/** 进项目并从文件树打开指定文件（编辑器就绪：monaco 渲染出内容） */
async function openFileInEditor(page: import('@playwright/test').Page, file: string, sample: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: file }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: file }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(sample, { timeout: 8000 })
}

test('GBK 文件：徽标可见 → 编码菜单 → 重新以 GBK 载入中文正确显示', async ({ page }) => {
  seedFixtures()
  await openFileInEditor(page, GBK_FILE, 'GBK')

  // 徽标展示服务端探测编码（GBK 徽标是本提案的核心可见面）
  const badge = page.locator('[data-testid="encoding-badge"]')
  await expect(badge).toHaveText('GBK')

  // 点击徽标弹小编码菜单：两个分区（重载 / 转码保存）各列出支持编码
  await badge.click()
  const menu = page.locator('[data-testid="encoding-menu"]')
  await expect(menu).toBeVisible()
  await expect(menu).toContainText('重新以指定编码载入')
  await expect(menu).toContainText('转为指定编码保存')
  await expect(menu.locator('[data-testid="encoding-reload-gbk"]')).toBeVisible()
  await expect(menu.locator('[data-testid="encoding-save-utf8"]')).toBeVisible()

  // 重新以 GBK 载入：中文正确显示（服务端探测解码 + 标签固化）
  await menu.locator('[data-testid="encoding-reload-gbk"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已以 GBK 重新载入' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('中文内容行', { timeout: 8000 })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('GBK 第二行', { timeout: 8000 })
  // 菜单动作后收起，徽标保持 GBK
  await expect(menu).toHaveCount(0)
  await expect(badge).toHaveText('GBK')
  // 磁盘未被重载动作改动
  expect(fs.readFileSync(path.join(REPO_DIR, GBK_FILE)).equals(GBK_BYTES)).toBe(true)
})

test('GBK → UTF-8 转码保存：磁盘字节变 UTF-8，徽标随存随变', async ({ page }) => {
  seedFixtures()
  await openFileInEditor(page, GBK_FILE, 'GBK')
  const badge = page.locator('[data-testid="encoding-badge"]')
  await expect(badge).toHaveText('GBK')

  await badge.click()
  await page.locator('[data-testid="encoding-menu"] [data-testid="encoding-save-utf8"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已转为 UTF-8 保存' })).toBeVisible({ timeout: 5000 })

  // 磁盘字节已转 UTF-8：中文按 UTF-8 解码正确，且不再等于原 GBK 字节
  await expect.poll(() => fs.readFileSync(path.join(REPO_DIR, GBK_FILE), 'utf8'), { timeout: 5000 })
    .toContain('中文内容行')
  expect(fs.readFileSync(path.join(REPO_DIR, GBK_FILE)).equals(GBK_BYTES)).toBe(false)
  // 保存成功后该文件即 UTF-8，徽标实时翻转
  await expect(badge).toHaveText('UTF-8')
})

test('UTF-8 → GBK 转码保存：跨平台协作方向，磁盘字节变 GBK', async ({ page }) => {
  seedFixtures()
  await openFileInEditor(page, UTF8_FILE, '基线')
  const badge = page.locator('[data-testid="encoding-badge"]')
  // 默认编码（无服务端 encoding 标签）以 UTF-8 徽标呈现
  await expect(badge).toHaveText('UTF-8')

  await badge.click()
  await page.locator('[data-testid="encoding-menu"] [data-testid="encoding-save-gbk"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已转为 GBK 保存' })).toBeVisible({ timeout: 5000 })

  // 磁盘字节已转 GBK（中文段 bb f9 cf df…），且徽标翻转为 GBK
  await expect.poll(() => fs.readFileSync(path.join(REPO_DIR, UTF8_FILE)).equals(UTF8_TEXT_GBK_BYTES), { timeout: 5000 })
    .toBe(true)
  await expect(badge).toHaveText('GBK')
})
