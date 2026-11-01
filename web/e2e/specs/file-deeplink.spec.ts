import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, setLockEnabled } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件深链 E2E（P-20261002-49）：/project?file=<相对路径>[&project=<id>] 直达编辑器
 *   ① ?file= 直达：bootstrap 完成（uiState 项目恢复落定）后打开并激活 tab，
 *      消费后 URL 清 query——刷新不再重复消费
 *   ② ?project= 切项目链：当前在 A，链接指向 B（含子目录路径的 URL 编码）
 *      → 先切 B 再开文件
 *   ③ tab 右键「复制文件链接」→ 剪贴板 URL 粘贴再进 → 直达（回环）
 *   ④ 带行深链（P-20261003-302）：?line=N 定位到行 / 非法行号忽略按无行打开 /
 *      agent navigate 事件（sc-ops:navigate，SPA 内 router.push）携带 file?line=
 *      即时消费并定位——顺带覆盖 SPA 再入消费路径
 * 自备两个临时仓库（文件内容互异，内容断言即证明读自正确项目），afterAll 清理。
 * 时序注：进入项目后 uiState 自动持久化防抖 2s，深链用例依赖「上次会话项目」
 * 恢复，故进入后轮询 GET /api/ui-state 等待 projectId 落定再 goto 深链。
 */

const DIR_A = path.join(os.tmpdir(), 'sc-e2e-deeplink-a')
const DIR_B = path.join(os.tmpdir(), 'sc-e2e-deeplink-b')
const PROJ_A = 'e2e-deeplink-a'
const PROJ_B = 'e2e-deeplink-b'
const FILE_A = 'deeplink-target.md'
const CONTENT_A = '# deeplink target alpha'
// 子目录路径：消费端经 route.query 拿到的是 %2F 解码后的形态，覆盖 URL 编码回环
const FILE_B = 'sub/deeplink-beta.txt'
const CONTENT_B = 'deeplink beta in project b'
// 带行深链（P-20261003-302）：120 行文件、锚点在 80 行——虚拟化渲染下首屏
// 见不到锚点行，revealLineInCenter 后才可见（可见即证明定位生效）
const FILE_LINE = 'deeplink-lined.md'
const LINE_ANCHOR_AT = 80
const LINE_ANCHOR = `sc-deeplink-anchor-${LINE_ANCHOR_AT}`

function linedFileContent(): string {
  const lines: string[] = ['deeplink lined first line']
  for (let i = 2; i <= 120; i++) {
    lines.push(i === LINE_ANCHOR_AT ? `// ${LINE_ANCHOR}` : `// pad line ${i}`)
  }
  return lines.join('\n') + '\n'
}

let projIdA = ''
let projIdB = ''

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

function makeRepo(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: 文件深链基线'])
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_A || p.name === PROJ_B) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [DIR_A, DIR_B]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  makeRepo(DIR_A, { [FILE_A]: CONTENT_A, [FILE_LINE]: linedFileContent() })
  makeRepo(DIR_B, { [FILE_B]: CONTENT_B })
  projIdA = await registerProject(headers, PROJ_A, DIR_A)
  projIdB = await registerProject(headers, PROJ_B, DIR_B)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  for (const id of [projIdA, projIdB]) {
    if (id) await fetch(`${API_BASE}/api/projects/${id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } }).catch(() => {})
  }
  for (const dir of [DIR_A, DIR_B]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  }).catch(() => {})
})

/** 重置持久化布局（uiState 服务端全局，前序 spec 面板开关经布局恢复污染入口）
 *  并经首页点击进入项目 A、经文件树打开 FILE_A 制造一次状态变化（自动持久化
 *  watcher 无 immediate，纯切项目在挂载后无变化不触发保存），随后轮询等
 *  uiState 记下 projectId=A——后续深链 goto 的 bootstrap 恢复才确定落在本项目
 *  （否则 fetchProjects 自动选中首个可用项目，深链 ?file= 落点不确定）。
 *  顺带经 API 关掉锁定开关：深链 goto 不走 gotoAndUnlock，遮罩若在会挡住
 *  消费后的断言（锁定 API 需先解锁，localStorage token 在解锁后已就位） */
async function enterProjectA(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await setLockEnabled(page, false)
  await page.evaluate(async () => {
    // 页内同源 fetch 自动携带 HttpOnly 锁 cookie（P-20261019-2 起无头可带）
    await fetch('/api/ui-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local: null }),
    })
  })
  await page.reload()
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_A }).first().click()
  await page.waitForURL('**/project')
  // 打开文件树面板并点开 FILE_A（rail 按钮是 toggle，先保证面板可见）
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE_A }).first().click()
  await expect(page.locator('.editor-tab', { hasText: FILE_A })).toBeVisible({ timeout: 30000 })
  const pollHeaders = await unlockHeaders()
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/api/ui-state`, { headers: pollHeaders })
      const body = (await res.json()) as { data?: { local?: { projectId?: string } } }
      if (body.data?.local?.projectId === projIdA) return
    } catch { /* 轮询重试 */ }
    await page.waitForTimeout(500)
  }
  throw new Error('uiState 未在超时内记录项目 A（自动持久化未落地）')
}

/** 深链直达断言公共段：目标 tab 存在且激活，Monaco 渲染出本项目特有内容 */
async function expectDeepLinkedTab(page: Page, tabName: string, content: string) {
  const tab = page.locator('.editor-tab', { hasText: tabName })
  await expect(tab).toBeVisible({ timeout: 30000 })
  await expect(tab).toHaveClass(/active/)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(content, { timeout: 10000 })
}

test('?file= 直达：文件打开且激活，URL 清 query，刷新不重复消费', async ({ page }) => {
  await enterProjectA(page)
  await page.goto(`${API_BASE}/project?file=${encodeURIComponent(FILE_A)}`)
  await expectDeepLinkedTab(page, FILE_A, CONTENT_A)
  // 消费后清 query（防刷新重复打开）
  await expect(page).toHaveURL(/\/project$/)

  // 刷新：URL 保持无 query（不重复消费）；标签经 uiState 项目维度恢复仍在且唯一
  await page.waitForTimeout(2500) // 自动持久化防抖 2s，等 openFiles 落盘
  await page.reload()
  await expect(page).toHaveURL(/\/project$/)
  await expect(page.locator('.editor-tab', { hasText: FILE_A })).toHaveCount(1, { timeout: 30000 })
})

test('?project= 切项目链：当前在 A，链接指向 B 先切项目再开文件', async ({ page }) => {
  await enterProjectA(page)
  await page.goto(`${API_BASE}/project?project=${projIdB}&file=${encodeURIComponent(FILE_B)}`)
  // 内容断言即证明读自项目 B（readFile 按项目隔离，A 中无此路径）；
  // tab 名为路径末段（子目录前缀不在 tab 上）
  await expectDeepLinkedTab(page, 'deeplink-beta.txt', CONTENT_B)
  // TopBar 项目选择器已切到 B
  await expect(page.locator('.header-project-select')).toContainText(PROJ_B)
  await expect(page).toHaveURL(/\/project$/)
})

test('复制链接回环：tab 右键复制 → 剪贴板 URL 粘贴再进 → 直达', async ({ page }) => {
  await enterProjectA(page) // 已含：文件树打开 + FILE_A 已开且激活

  // 右键 tab → 复制文件链接（剪贴板读回断言精确 URL）
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('.editor-tab', { hasText: FILE_A }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '复制文件链接' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '文件链接已复制' })).toBeVisible({ timeout: 5000 })
  const link = await page.evaluate(() => navigator.clipboard.readText())
  // 断言参数集而非整串（P-20261022-3 起拼装收口 presentAtoms.buildFileDeepLinkQuery，
  // 键序随实现——消费端 parseFileDeepLinkQuery 对键序不敏感，回环语义不变）
  const linkUrl = new URL(link)
  expect(linkUrl.origin + linkUrl.pathname).toBe(`${API_BASE}/project`)
  expect(linkUrl.searchParams.get('file')).toBe(FILE_A)
  expect(linkUrl.searchParams.get('project')).toBe(projIdA)
  expect([...linkUrl.searchParams.keys()].sort()).toEqual(['file', 'project'])

  // 粘贴再进（= 用户把链接发给别人/别的设备后打开）：直达同一文件
  await page.goto(link)
  await expectDeepLinkedTab(page, FILE_A, CONTENT_A)
  await expect(page).toHaveURL(/\/project$/)
})

test('?line= 带行深链：打开并定位到锚点行，消费后 URL 清 query', async ({ page }) => {
  await enterProjectA(page)
  await page.goto(`${API_BASE}/project?file=${encodeURIComponent(FILE_LINE)}&line=${LINE_ANCHOR_AT}`)
  const tab = page.locator('.editor-tab', { hasText: FILE_LINE })
  await expect(tab).toBeVisible({ timeout: 30000 })
  await expect(tab).toHaveClass(/active/)
  // 虚拟化渲染下锚点行（80 行）可见即证明行定位生效——普通打开停在首屏见不到
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(LINE_ANCHOR, { timeout: 15000 })
  await expect(page).toHaveURL(/\/project$/)
})

test('非法/越界行号忽略：按无行打开不炸（停在顶部兜底）', async ({ page }) => {
  await enterProjectA(page)
  // line=abc 非数值：忽略定位参数，文件正常打开
  await page.goto(`${API_BASE}/project?file=${encodeURIComponent(FILE_A)}&line=abc`)
  await expectDeepLinkedTab(page, FILE_A, CONTENT_A)
  await expect(page).toHaveURL(/\/project$/)
  // line=99999 越界（文件仅 1 行）：复用既有「轮询超时停在顶部」，不报错且 URL 清
  await page.goto(`${API_BASE}/project?file=${encodeURIComponent(FILE_A)}&line=99999`)
  await expectDeepLinkedTab(page, FILE_A, CONTENT_A)
  await expect(page).toHaveURL(/\/project$/)
})

test('agent navigate 事件（SPA 再入）：file?line= 深链即时消费并定位', async ({ page }) => {
  await enterProjectA(page)
  // 已在 /project（query 已清）的 SPA 内，模拟 agent 经 ops 通道 navigate 推送
  // 深链（sc-ops:navigate → router.push）：query.file 变化触发即时消费
  await page.evaluate(([fp, line]) => {
    window.dispatchEvent(new CustomEvent('sc-ops:navigate', {
      detail: { path: `/project?file=${encodeURIComponent(fp)}&line=${line}` },
    }))
  }, [FILE_LINE, LINE_ANCHOR_AT])
  const tab = page.locator('.editor-tab', { hasText: FILE_LINE })
  await expect(tab).toBeVisible({ timeout: 30000 })
  await expect(tab).toHaveClass(/active/)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(LINE_ANCHOR, { timeout: 15000 })
  await expect(page).toHaveURL(/\/project$/)
})
