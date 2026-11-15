import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  clearNotesViewUiState, closeNotesOverlayIfOpen, DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName,
} from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 笔记标签行 E2E（P-20261112-7 S2）：编辑区上方（np-tabs 与编辑器之间）的当前篇
 * 标签编辑面——chips 增删 + 尾部「+」内联输入（自动补全候选 = 全库既有标签去重
 * 集合），标签编辑并入防抖保存链（与内容变更同窗合并一次 PUT 携 tags 整体替换；
 * 纯内容保存不带 tags 不清他窗标签），409 冲突裁决链随件（评审修订点）：
 *   1. 标签增删：chips + x 删除 + PUT 载荷携 tags；零标签轻量占位（+ 恒在）
 *   2. 自动补全：全库候选 contains 匹配点选、本篇已有标签排除；达 8 上限 + 禁用
 *   3. 冲突裁决：409 挂起期间的本地标签编辑——「用我的覆盖」携 content+tags 一并
 *      写回；「载入服务端版本」本地标签编辑一并放弃（编辑面回落 409 快照
 *      currentTags）——标签编辑不使裁决路径静默丢弃
 * 自备临时仓库与项目，afterAll 清理（范式与 notes-global.spec 对称）。
 */

const REPO = path.join(os.tmpdir(), 'sc-e2e-notes-tags')
const PROJ = 'e2e-notes-tags'

let projId = ''
let headers: Record<string, string> = { 'Content-Type': 'application/json' }

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

function makeRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# notes-tags e2e\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: 笔记标签行基线'])
}

interface NoteMeta { id: string; title: string; tags?: string[] }

async function globalList(trash = false): Promise<NoteMeta[]> {
  const res = await fetch(`${API_BASE}/api/notes${trash ? '?trash=1' : ''}`, { headers })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data?: NoteMeta[] }).data ?? []
}

async function purgeAllGlobal(): Promise<void> {
  for (const view of [await globalList(), await globalList(true)]) {
    for (const n of view) {
      await fetch(`${API_BASE}/api/notes/${n.id}?purge=1`, { method: 'DELETE', headers })
    }
  }
}

async function apiCreate(title: string, content: string, tags?: string[]): Promise<string> {
  const res = await fetch(`${API_BASE}/api/notes`, {
    method: 'POST', headers, body: JSON.stringify({ title, content, tags }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { data?: { id?: string } }).data?.id || ''
}

async function apiGet(id: string): Promise<{ content?: string; tags?: string[] }> {
  const res = await fetch(`${API_BASE}/api/notes/${id}`, { headers })
  expect(res.status).toBe(200)
  const d = ((await res.json()) as { data?: { content?: string; tags?: string[] } }).data ?? {}
  return { content: d.content, tags: d.tags } // 窄投影（整篇响应含 id/title/时间戳）
}

/** 服务端 default 篇内容（占位篇首写落真身的收敛等待） */
async function defaultNoteContent(): Promise<string> {
  try {
    const res = await fetch(`${API_BASE}/api/notes/default`, { headers })
    if (res.status !== 200) return ''
    return ((await res.json()) as { data?: { content?: string } }).data?.content ?? ''
  } catch {
    return ''
  }
}

async function openNotesPanel(page: Page) {
  const panel = page.locator('[data-testid="notes-panel"]')
  if (!(await panel.isVisible().catch(() => false))) {
    await page.locator('[data-testid="rail-notes"]').click()
  }
  try {
    await panel.waitFor({ state: 'visible', timeout: 2500 })
  } catch {
    await page.locator('[data-testid="rail-notes"]').click()
    await panel.waitFor({ state: 'visible', timeout: 5000 })
  }
  return panel
}

/** 内联输入加一个标签：点 + → 输入 → 回车确认。返回本次标签编辑触发的
 *  防抖 PUT 请求（同窗合并的那一次——调用方据此断言载荷；请求事件由本函数
 *  消费，调用方不得对同一次 PUT 再挂 waitForRequest） */
async function addTag(page: Page, tag: string): Promise<import('@playwright/test').Request> {
  await page.locator('[data-testid="notes-tag-add"]').click()
  const input = page.locator('[data-testid="notes-tag-input"] input')
  await expect(input).toBeVisible({ timeout: 4000 })
  const putPromise = page.waitForRequest(r => r.method() === 'PUT' && r.url().includes('/api/notes/'))
  await input.fill(tag)
  await input.press('Enter')
  return putPromise
}

test.beforeAll(async () => {
  headers = await unlockHeaders()
  const stale = (await (await fetch(`${API_BASE}/api/projects`, { headers })).json()) as { data?: { id: string; name: string }[] }
  for (const p of stale.data ?? []) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  makeRepo(REPO)
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO) }),
  })
  expect([200, 201]).toContain(res.status)
  projId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projId).not.toBe('')
})

test.afterAll(async () => {
  headers = await unlockHeaders()
  await purgeAllGlobal()
  if (projId) await fetch(`${API_BASE}/api/projects/${projId}`, { method: 'DELETE', headers })
  // uiState notesView 开态键兜底归位（P-20261112-6-S1）：用例结束时面板保持打开，
  // 开态残留跨 spec/跨 run 复活会遮住后续 spec 的首页入口（closeNotesOverlayIfOpen
  // 同语义的服务端清场口）
  await clearNotesViewUiState(API_BASE)
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('标签增删与防抖合并：chips + x 删除 + PUT 携 tags 整体替换；纯内容保存不带 tags；零标签轻量占位', async ({ page }) => {
  await purgeAllGlobal()

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 前序用例残留的笔记 overlay 开态先关（见 tests/helpers closeNotesOverlayIfOpen 注释）
  await closeNotesOverlayIfOpen(page)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
  const panel = await openNotesPanel(page)
  const editor = panel.locator('[data-testid="notes-editor"]')
  await expect(editor).toBeVisible({ timeout: 8000 }) // 空库占位 default 篇

  // 零标签轻量占位：无 chips，仅「+」
  const row = panel.locator('[data-testid="notes-tags"]')
  await expect(row.locator('[data-testid="notes-tag"]')).toHaveCount(0)
  await expect(row.locator('[data-testid="notes-tag-add"]')).toBeVisible()

  // 占位篇输入 → 防抖保存落真身（default-upsert）；纯内容保存不带 tags
  // （nil 保全语义的前端面——请求在 fill 前挂，捕获这一次防抖 PUT）
  const purePromise = page.waitForRequest(r => r.method() === 'PUT' && r.url().includes('/api/notes/default'))
  await editor.fill('标签行基线内容')
  const purePut = await purePromise
  expect(purePut.postDataJSON()).not.toHaveProperty('tags')
  await expect.poll(defaultNoteContent, { timeout: 8000 }).toBe('标签行基线内容')

  // 加标签：与内容编辑同窗——先改内容再回车确认，一次 PUT 携 content+tags
  await editor.fill('标签行基线内容二')
  const mergedPut = await addTag(page, '交接')
  const mergedBody = mergedPut.postDataJSON() as { content?: string; tags?: string[] }
  expect(mergedBody.tags).toEqual(['交接'])
  expect(mergedBody.content).toBe('标签行基线内容二')
  await expect(row.locator('[data-testid="notes-tag"]').filter({ hasText: '交接' })).toBeVisible()
  await expect.poll(() => apiGet('default'), { timeout: 8000 }).toEqual(expect.objectContaining({ tags: ['交接'] }))
  // chip title 提示全名
  await expect(row.locator('[data-testid="notes-tag"]').filter({ hasText: '交接' })).toHaveAttribute('title', '交接')

  // 第二个标签（仅标签变更：PUT 携 tags，content 是编辑面现值）
  const tagPut = await addTag(page, 'proj-b')
  expect((tagPut.postDataJSON() as { tags?: string[] }).tags).toEqual(['交接', 'proj-b'])
  await expect.poll(() => apiGet('default'), { timeout: 8000 }).toEqual(expect.objectContaining({ tags: ['交接', 'proj-b'] }))

  // 点 x 删除 → PUT tags:[]（显式清空）→ 服务端真值
  await row.locator('[data-testid="notes-tag"]').filter({ hasText: '交接' }).locator('.np-tag-x').click()
  const rmPut = await page.waitForRequest(r => r.method() === 'PUT' && r.url().includes('/api/notes/default'))
  expect((rmPut.postDataJSON() as { tags?: string[] }).tags).toEqual(['proj-b'])
  await expect(row.locator('[data-testid="notes-tag"]').filter({ hasText: '交接' })).toHaveCount(0, { timeout: 4000 })
  await row.locator('[data-testid="notes-tag"]').filter({ hasText: 'proj-b' }).locator('.np-tag-x').click()
  await expect(row.locator('[data-testid="notes-tag"]')).toHaveCount(0, { timeout: 4000 })
  // 服务端清空语义：normalize 归 nil + omitempty → GET 响应省 tags 字段（undefined）
  await expect.poll(() => apiGet('default'), { timeout: 8000 }).toEqual({ content: '标签行基线内容二' })
  // 清空后回到轻量占位（+ 恒在，chips 无）
  await expect(row.locator('[data-testid="notes-tag-add"]')).toBeVisible()
})

test('自动补全：全库标签候选点选、本篇已有排除；达 8 上限「+」禁用', async ({ page }) => {
  await purgeAllGlobal()
  await apiCreate('带标签篇', 'content a', ['alpha', 'beta'])
  await apiCreate('另一篇', 'content b', ['gamma'])

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 前序用例残留的笔记 overlay 开态先关（见 tests/helpers closeNotesOverlayIfOpen 注释）
  await closeNotesOverlayIfOpen(page)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
  const panel = await openNotesPanel(page)

  // 切到「另一篇」：补全候选来自全库（alpha/beta/gamma），本篇无标签
  await panel.locator('.np-tab').filter({ hasText: '另一篇' }).click()
  await page.locator('[data-testid="notes-tag-add"]').click()
  const input = page.locator('[data-testid="notes-tag-input"] input')
  await expect(input).toBeVisible({ timeout: 4000 })
  await input.fill('alp')
  // contains 匹配候选（naive 下拉菜单），点选即确认
  const option = page.locator('.n-auto-complete-menu .n-base-select-option').filter({ hasText: 'alpha' })
  await expect(option).toBeVisible({ timeout: 4000 })
  await option.click()
  await expect(panel.locator('[data-testid="notes-tag"]').filter({ hasText: 'alpha' })).toBeVisible({ timeout: 4000 })
  await expect.poll(() => globalList().then(l => l.find(n => n.title === '另一篇')?.tags), { timeout: 8000 })
    .toEqual(['gamma', 'alpha']) // 建篇既有 gamma + 点选补全 alpha（整体替换保序）

  // 本篇已有标签从候选排除：输入 'alph'（本篇已带 alpha）不再出候选
  await page.locator('[data-testid="notes-tag-add"]').click()
  await input.fill('alph')
  await expect(page.locator('.n-auto-complete-menu .n-base-select-option').filter({ hasText: 'alpha' })).toHaveCount(0, { timeout: 4000 })
  await input.press('Escape') // 取消收起（Esc：退出输入不产生编辑）

  // 达 8 上限：+ 禁用并提示
  const fullId = await apiCreate('满标签篇', 'c', ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'])
  await panel.locator(`[data-testid="notes-tab-${fullId}"]`).click()
  const addBtn = page.locator('[data-testid="notes-tag-add"]')
  await expect(addBtn).toBeDisabled({ timeout: 4000 })
  await expect(addBtn).toHaveAttribute('title', '每篇最多 8 个标签')
})

test('409 冲突裁决链（评审修订点）：挂起期间的本地标签编辑——「用我的覆盖」携 content+tags 写回；「载入服务端版本」一并放弃回落服务端', async ({ page }) => {
  await purgeAllGlobal()
  const id = await apiCreate('冲突篇', 'v1', ['srv-tag'])

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 前序用例残留的笔记 overlay 开态先关（见 tests/helpers closeNotesOverlayIfOpen 注释）
  await closeNotesOverlayIfOpen(page)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
  const panel = await openNotesPanel(page)
  const editor = panel.locator('[data-testid="notes-editor"]')

  // 切到冲突篇（GET 真值带入 tags=['srv-tag'] 编辑面）
  await panel.locator(`[data-testid="notes-tab-${id}"]`).click()
  await expect(editor).toHaveValue('v1', { timeout: 8000 })
  await expect(panel.locator('[data-testid="notes-tag"]').filter({ hasText: 'srv-tag' })).toBeVisible({ timeout: 4000 })

  // 本地编辑（dirty 防抖窗内）+ 外部写推进 → 防抖落盘撞 409 冲突条
  await editor.fill('my local edit')
  await fetch(`${API_BASE}/api/notes/${id}`, {
    method: 'PUT', headers, body: JSON.stringify({ content: 'server v2', tags: ['srv-tag'] }),
  })
  await expect(panel.locator('[data-testid="notes-conflict"]')).toBeVisible({ timeout: 8000 })

  // 409 挂起期间的本地标签编辑（未落盘）——裁决不得静默丢弃
  const retryPut = await addTag(page, 'my-tag')
  await expect(panel.locator('[data-testid="notes-tag"]').filter({ hasText: 'my-tag' })).toBeVisible({ timeout: 4000 })

  // ── 动作①用我的覆盖：content+tags 一并写回 ──
  expect(retryPut.postDataJSON()).toEqual(expect.objectContaining({ tags: ['srv-tag', 'my-tag'] })) // 挂起编辑触发的重试 PUT
  await panel.locator('[data-testid="notes-conflict-overwrite"]').click()
  await expect(panel.locator('[data-testid="notes-conflict"]')).toBeHidden({ timeout: 4000 })
  await expect.poll(() => apiGet(id), { timeout: 8000 }).toEqual({
    content: 'my local edit',
    tags: ['srv-tag', 'my-tag'],
  })
  await expect(panel.locator('[data-testid="notes-tag"]').filter({ hasText: 'my-tag' })).toBeVisible()

  // ── 动作②载入服务端版本：本地标签编辑一并放弃，编辑面回落服务端 ──
  await editor.fill('another local edit')
  await fetch(`${API_BASE}/api/notes/${id}`, {
    method: 'PUT', headers, body: JSON.stringify({ content: 'server v3', tags: ['srv-tag'] }),
  })
  await expect(panel.locator('[data-testid="notes-conflict"]')).toBeVisible({ timeout: 8000 })
  await addTag(page, 'dropped-tag')
  await expect(panel.locator('[data-testid="notes-tag"]').filter({ hasText: 'dropped-tag' })).toBeVisible({ timeout: 4000 })
  await panel.locator('[data-testid="notes-conflict-load"]').click()
  await expect(panel.locator('[data-testid="notes-conflict"]')).toBeHidden({ timeout: 4000 })
  await expect(editor).toHaveValue('server v3', { timeout: 8000 })
  // 本地标签编辑一并放弃（冲突条文案明示），编辑面回落 409 快照 currentTags
  await expect(panel.locator('[data-testid="notes-tag"]').filter({ hasText: 'dropped-tag' })).toHaveCount(0, { timeout: 4000 })
  await expect(panel.locator('[data-testid="notes-tag"]').filter({ hasText: 'srv-tag' })).toBeVisible()
  // 服务端未被载入路径再写（服务端真值不动）
  await expect.poll(() => apiGet(id), { timeout: 8000 }).toEqual({ content: 'server v3', tags: ['srv-tag'] })
})
