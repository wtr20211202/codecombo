import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * md 预览链接导航 E2E（P-20261003-108；页内锚点跳转 P-20261007-7）：
 *   ① 相对 .md 链接（./docs/guide.md）点击 → 编辑器打开该文件（OPS_OPEN_FILE_AT
 *      既有链，预览位）；再点 ../README.md 反向链接回到主页（../ 折叠闭环）
 *   ② http(s) 外链点击 → window.open('_blank', 'noopener,noreferrer')（noopener
 *      红线；window.open 页内 stub 断言——真实 popup 会请求外网，不可控）
 *   ③ 页内目录锚点（#第一节）点击 → 预览滚动到对应标题 + 呼吸高亮，preventDefault
 *      生效：SPA 不整页跳走（URL 不挂 #）、不开新窗、当前文件不变
 *   ④ #top 特例：先跳到第二节（滚动离顶）再点返回顶部 → 滚回容器顶
 *   ⑤ 坏锚点（#no-such-anchor）→ 不炸不跳，title 提示锚点未命中（诚实边界）
 * 自备临时仓库，afterAll 清理并复位 uiState（editorPrefs 是服务端跨用例全局
 * 状态——beforeAll 先清保证「无记录默认 split」基线确定性）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-md-links')
const PROJ = 'e2e-md-links'
const README_FILE = 'README.md'
const GUIDE_FILE = 'guide.md'
// 中段填充把「第二节」顶出首屏（滚动量有意义的下限）；标题文本即 slug（中文保留）
const FILLER_BEFORE_SEC2 = Array.from({ length: 20 }, (_, i) => `填充段落 ${i + 1}，撑出滚动空间。`)
const FILLER_TAIL = Array.from({ length: 20 }, (_, i) => `尾部段落 ${i + 1}，保证第二节后有内容。`)
const README_CONTENT = [
  '# 主页',
  '',
  '- [使用指南](./docs/guide.md)',
  '- [外链](https://example.com/external)',
  '- [跳到第一节](#第一节)',
  '- [跳到第二节](#第二节)',
  '- [返回顶部](#top)',
  '- [坏锚点](#no-such-anchor)',
  '',
  '## 第一节',
  '',
  '第一节正文。',
  ...FILLER_BEFORE_SEC2,
  '## 第二节',
  '',
  '第二节正文。',
  ...FILLER_TAIL,
].join('\n')
const GUIDE_CONTENT = [
  '# 指南标题',
  '',
  '[返回主页](../README.md)',
  '',
  '指南正文。',
  '',
].join('\n')

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
  // uiState 复位（含 editorPrefs）：残留的 md 模式偏好会破坏「默认 split」基线
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ local: null }),
  })
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(path.join(REPO_DIR, 'docs'), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, README_FILE), README_CONTENT)
  fs.writeFileSync(path.join(REPO_DIR, 'docs', GUIDE_FILE), GUIDE_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: md 预览链接导航基线'])
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

/** 从首页进项目并经文件树打开指定文件（幂等：已开的只会被激活） */
async function openProjectAndFile(page: import('@playwright/test').Page, file: string) {
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
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.pane-primary .md-preview')).toBeVisible({ timeout: 10000 })
}

/** 预览面板里的链接（按文本定位） */
const previewLink = (page: import('@playwright/test').Page, text: string) =>
  page.locator('.pane-primary .md-preview-content a', { hasText: text }).first()

/** 预览滚动容器（.md-preview 是滚动面，.md-preview-content 是 v-html 内容） */
const previewScroller = (page: import('@playwright/test').Page) =>
  page.locator('.pane-primary .md-preview')

/** 平滑滚动是异步的：轮询到命中高亮标题落进容器顶邻域（呼吸空隙 8px + 余量） */
async function expectAnchorLandedAtTop(page: import('@playwright/test').Page) {
  await expect
    .poll(
      async () =>
        previewScroller(page).evaluate((el) => {
          const hit = el.querySelector('.md-anchor-hit') as HTMLElement | null
          if (!hit) return false
          const d = hit.getBoundingClientRect().top - el.getBoundingClientRect().top
          return d >= -2 && d <= 48
        }),
      { timeout: 5000 },
    )
    .toBe(true)
}

/** 活跃编辑器标签名 */
const activeTabName = (page: import('@playwright/test').Page) =>
  page.locator('.pane-primary .editor-tab.active .tab-name')

/** 页内 window.open stub（remote-view-link 同款：真实 popup 会请求外网不可控） */
async function stubWindowOpen(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __lastOpen?: { url: string; target: string; features: string } }
    w.__lastOpen = undefined
    window.open = ((url: string, target: string, features: string) => {
      w.__lastOpen = { url, target, features }
      return null
    }) as typeof window.open
  })
}

test('相对 .md 链接点击打开目标文件，../ 反向链接回到主页', async ({ page }) => {
  await openProjectAndFile(page, README_FILE)
  await expect(page.locator('.pane-primary .md-preview-content')).toContainText('主页', { timeout: 8000 })
  await expect(activeTabName(page)).toHaveText(README_FILE)

  // ./docs/guide.md → 编辑器打开 docs/guide.md（预览位），预览切到指南内容
  await previewLink(page, '使用指南').click()
  await expect(activeTabName(page)).toHaveText(GUIDE_FILE, { timeout: 10000 })
  await expect(page.locator('.pane-primary .md-preview-content')).toContainText('指南标题', { timeout: 8000 })

  // ../README.md 反向链接：../ 折叠回项目根，主页回显（仓内文档导航闭环）
  await previewLink(page, '返回主页').click()
  await expect(activeTabName(page)).toHaveText(README_FILE, { timeout: 10000 })
  await expect(page.locator('.pane-primary .md-preview-content')).toContainText('第一节', { timeout: 8000 })
})

test('外链点击 window.open 新标签且带 noopener', async ({ page }) => {
  await openProjectAndFile(page, README_FILE)
  await stubWindowOpen(page)

  await previewLink(page, '外链').click()
  const opened = await page.evaluate(() => (window as unknown as { __lastOpen?: { url: string; target: string; features: string } }).__lastOpen)
  expect(opened).toEqual({ url: 'https://example.com/external', target: '_blank', features: 'noopener,noreferrer' })

  // 外链不改当前文件（编辑器无跳变）
  await expect(activeTabName(page)).toHaveText(README_FILE)
})

test('页内目录锚点点击滚动到目标标题并呼吸高亮，不整页跳走', async ({ page }) => {
  await openProjectAndFile(page, README_FILE)
  await stubWindowOpen(page)

  // 中文锚点全链路：#第一节（marked encodeURI 产物）→ 解码 → slug id「第一节」精确命中
  await previewLink(page, '跳到第一节').click()
  await expect(page.locator('.pane-primary .md-preview-content .md-anchor-hit')).toHaveText('第一节', { timeout: 5000 })
  await expectAnchorLandedAtTop(page)

  // preventDefault 生效：URL 未被塞进 # 锚（SPA 整页跳走/散列跳转都不发生）
  expect(page.url()).not.toContain('#')
  const opened = await page.evaluate(() => (window as unknown as { __lastOpen?: { url: string; target: string; features: string } }).__lastOpen)
  expect(opened).toBeUndefined()
  await expect(activeTabName(page)).toHaveText(README_FILE)
  await expect(page.locator('.pane-primary .md-preview-content')).toContainText('主页', { timeout: 8000 })
})

test('#top 无同名元素时回滚预览容器顶', async ({ page }) => {
  await openProjectAndFile(page, README_FILE)

  // 先跳到第二节让滚动离顶（smooth 滚动异步，先轮询到非零再点 #top）
  await previewLink(page, '跳到第二节').click()
  await expect
    .poll(async () => previewScroller(page).evaluate((el) => el.scrollTop), { timeout: 5000 })
    .toBeGreaterThan(0)

  await previewLink(page, '返回顶部').click()
  await expect
    .poll(async () => previewScroller(page).evaluate((el) => el.scrollTop), { timeout: 5000 })
    .toBe(0)
  expect(page.url()).not.toContain('#')
})

test('坏锚点不炸不跳：title 提示锚点未命中（诚实边界）', async ({ page }) => {
  await openProjectAndFile(page, README_FILE)

  const bad = previewLink(page, '坏锚点')
  await bad.click()
  // title 悬浮提示携带锚点原文（双语消息均含 {anchor}，断言锚点名即可与语言解耦）
  await expect(bad).toHaveAttribute('title', /no-such-anchor/, { timeout: 5000 })

  expect(page.url()).not.toContain('#')
  await expect(activeTabName(page)).toHaveText(README_FILE)
  await expect(page.locator('.pane-primary .md-preview-content')).toContainText('主页', { timeout: 8000 })
})
