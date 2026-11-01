import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * .editorconfig 项目级缩进约定（P-20261003-95）：带配置仓打开对应文件缩进
 * 遵循（[*.go] → Tab 键入制表符 / [*] → 两空格），无配置仓走全局设置
 * （默认 4 空格）零回归。服务端契约（file-policy 随行下发 editorconfig）
 * 一并在用例内经 API 断言。
 * 自备临时仓库，afterAll 清理。
 */

const EC_DIR = path.join(os.tmpdir(), 'sc-e2e-editorconfig')
const PLAIN_DIR = path.join(os.tmpdir(), 'sc-e2e-editorconfig-plain')
const PROJ_EC = 'e2e-editorconfig'
const PROJ_PLAIN = 'e2e-editorconfig-plain'

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

function seedRepo(dir: string, withEditorconfig: boolean) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir }) // 双路径：Windows 服务端 git 也不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  if (withEditorconfig) {
    // [*] 两空格打底，[*.go] 后置节覆盖为 tab/8（后者胜叠加语义的用例形态）
    fs.writeFileSync(path.join(dir, '.editorconfig'),
      'root = true\n[*]\nindent_style = space\nindent_size = 2\n[*.go]\nindent_style = tab\ntab_width = 8\n')
  }
  fs.writeFileSync(path.join(dir, 'pkg', 'main.go'), 'package main\n')
  fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 1\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: editorconfig 基线'])
}

let ecId = ''
let plainId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_EC || p.name === PROJ_PLAIN) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  seedRepo(EC_DIR, true)
  seedRepo(PLAIN_DIR, false)
  ecId = await registerProject(headers, PROJ_EC, EC_DIR)
  plainId = await registerProject(headers, PROJ_PLAIN, PLAIN_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_EC || p.name === PROJ_PLAIN) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(EC_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  try { fs.rmSync(PLAIN_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 打开项目并点开文件树中指定文件（树内名唯一），光标落到行 1 尾后回车另起空行。
 *  expandDir = 文件所在父目录（树默认折叠，先点目录行展开） */
async function openFileAndNewLine(page: import('@playwright/test').Page, projName: string, fileName: string, expandDir?: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, projName).click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 5; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: fileName }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
    if (expandDir && await page.locator('.file-tree .item-name', { hasText: expandDir }).first().isVisible().catch(() => false)) {
      await page.locator('.file-tree .item-name', { hasText: expandDir }).first().click()
      await page.waitForTimeout(400)
    }
  }
  await page.locator('.file-tree .item-name', { hasText: fileName }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toBeVisible({ timeout: 8000 })
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
}

/** 键入 Tab + 文本并保存，断言磁盘第二行精确等于 expected（区分 tab / 2 空格 / 4 空格） */
async function tabTypeSaveAndAssertLine(page: import('@playwright/test').Page, dir: string, fileRel: string, text: string, expectedLine: string) {
  await page.keyboard.press('Tab')
  await page.keyboard.type(text)
  await page.keyboard.press('Control+s')
  await expect(page.locator('.n-message').filter({ hasText: '文件已保存' })).toBeVisible({ timeout: 5000 })
  const fullPath = path.join(dir, ...fileRel.split('/'))
  await expect.poll(async () => {
    try {
      return fs.readFileSync(fullPath, 'utf8').split('\n')[1] ?? ''
    } catch { return '' }
  }, { timeout: 5000 }).toBe(expectedLine)
}

test('带 editorconfig 仓：[*.go] 缩进遵循（Tab → 制表符）+ 服务端契约', async ({ page }) => {
  // 服务端契约：file-policy 响应随行 editorconfig（[*.go] 后置节覆盖 [*]）
  const headers = await unlockHeaders()
  const pol = await (await fetch(`${API_BASE}/api/projects/${ecId}/file-policy?path=pkg%2Fmain.go`, { headers })).json() as { editorconfig?: { indentStyle?: string; tabWidth?: number } }
  expect(pol.editorconfig?.indentStyle).toBe('tab')
  expect(pol.editorconfig?.tabWidth).toBe(8)

  await openFileAndNewLine(page, PROJ_EC, 'main.go', 'pkg')
  await tabTypeSaveAndAssertLine(page, EC_DIR, 'pkg/main.go', 'tabbed', '\ttabbed')
})

test('带 editorconfig 仓：[*] 两空格遵循', async ({ page }) => {
  await openFileAndNewLine(page, PROJ_EC, 'app.js')
  await tabTypeSaveAndAssertLine(page, EC_DIR, 'app.js', 'spaced', '  spaced')
})

test('无配置仓走全局设置：默认 4 空格零回归', async ({ page }) => {
  // 服务端契约：无 .editorconfig 时 file-policy 响应无 editorconfig 键
  const headers = await unlockHeaders()
  const pol = await (await fetch(`${API_BASE}/api/projects/${plainId}/file-policy?path=pkg%2Fmain.go`, { headers })).json() as { editorconfig?: unknown }
  expect('editorconfig' in pol).toBe(false)

  await openFileAndNewLine(page, PROJ_PLAIN, 'main.go', 'pkg')
  await tabTypeSaveAndAssertLine(page, PLAIN_DIR, 'pkg/main.go', 'plain', '    plain')
})
