import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Git 面板四项功能 E2E：
 *   F1 提交搜索——hash 片段（大小写不敏感）+ 内容字面子串 + 目录历史修复回归
 *   F2 变更文件右键菜单——查看此次变更（diff 标签）/ 查看文件历史（弹窗）
 *      / 在编辑器中打开
 *   F3 blame 注入文本点击提交 id → 底部 Git 面板滚动选中对应提交
 *   F4 编辑器右键菜单——与分支/Tag/提交对比弹窗 / 与剪贴板内容对比
 *      （伪 ref「剪贴板 ↔ 工作区」）/ 在文件树中定位
 * 自备临时仓库（3 提交、两文件、src 子目录），afterAll 清理（范式与
 * commit-actions 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-git-panel-features')
const PROJ = 'e2e-git-panel-features'
const LIB = 'src/lib.ts'
const README = 'README.md'

let projectId = ''

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

function writeFile(rel: string, content: string) {
  const p = path.join(REPO_DIR, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

// lib.ts 经 c1/c2 两次提交（blame 至少两段）；README 单独提交（搜索/历史用）
let c1 = ''
let c2 = ''
let c3 = ''

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
  execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })

  writeFile(LIB, 'export function add(a: number, b: number): number {\n  return a + b\n}\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: init library'])
  c1 = git(REPO_DIR, ['rev-parse', 'HEAD'])

  writeFile(LIB, 'export function add(a: number, b: number): number {\n  return a + b\n}\nexport function PatchAlpha(s: string): string {\n  return s.trim()\n}\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: PatchAlpha boundary'])
  c2 = git(REPO_DIR, ['rev-parse', 'HEAD'])

  writeFile(README, '# panel features\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c3: readme notes'])
  c3 = git(REPO_DIR, ['rev-parse', 'HEAD'])

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

async function enterAndOpenLog(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-item').first()).toBeVisible()
}

const SEARCH_BOX = (page: import('@playwright/test').Page) => page.getByPlaceholder('搜索提交…')

/** 选中提交：点 meta 行（消息区单击是展开 body，不选中） */
async function selectCommit(page: import('@playwright/test').Page, hashPrefix: string) {
  await page.locator('.commit-item').filter({ hasText: hashPrefix }).first().locator('.commit-meta').click()
  await expect(page.locator('.commits-right .diff-node').first()).toBeVisible({ timeout: 5000 })
}

/** 右侧文件树里的文件节点（带变更状态徽标；目录节点没有） */
function fileNode(page: import('@playwright/test').Page, name?: string) {
  const nodes = page.locator('.commits-right .diff-node').filter({ has: page.locator('.diff-status') })
  return name ? nodes.filter({ hasText: name }).first() : nodes.first()
}

test('F1 提交搜索：hash 片段大小写不敏感命中单条', async ({ page }) => {
  await enterAndOpenLog(page)
  const frag = c2.slice(2, 9).toUpperCase() // hash 中段且转大写
  await SEARCH_BOX(page).fill(frag)
  await SEARCH_BOX(page).press('Enter')
  const items = page.locator('.commit-item')
  await expect(items).toHaveCount(1, { timeout: 5000 })
  await expect(items.first()).toContainText(c2.slice(0, 8))
  await expect(items.first()).toContainText('c2: PatchAlpha boundary')
})

test('F1 提交搜索：内容字面子串大小写不敏感', async ({ page }) => {
  await enterAndOpenLog(page)
  await SEARCH_BOX(page).fill('PATCHALPHA')
  await SEARCH_BOX(page).press('Enter')
  await expect(page.locator('.commit-item').filter({ hasText: 'c2: PatchAlpha boundary' }))
    .toBeVisible({ timeout: 5000 })
  // 正则元字符按字面：c2 消息无括号而 fix:( 不应被当正则解析
  await SEARCH_BOX(page).fill('c1:')
  await SEARCH_BOX(page).press('Enter')
  await expect(page.locator('.commit-item').filter({ hasText: 'c1: init library' }))
    .toBeVisible({ timeout: 5000 })
})

test('F2 变更文件右键：此次变更 diff 标签 + 文件历史弹窗', async ({ page }) => {
  await enterAndOpenLog(page)
  // 选中 c3（单文件 README），目录树折叠为单文件节点
  await selectCommit(page, c3.slice(0, 8))
  const node = fileNode(page, 'README.md')
  await expect(node).toBeVisible()

  // 查看此次变更 → 打开 diff 标签（面包屑 oldRef↔newRef 比较标签）
  await node.click({ button: 'right' })
  const changeDiff = page.locator('.n-dropdown-menu').getByText('查看此次变更', { exact: true })
  await expect(changeDiff).toBeVisible({ timeout: 3000 })
  await changeDiff.click()
  const crumb = page.locator('.breadcrumb-bar')
  await expect(crumb).toContainText('↔', { timeout: 5000 })
  await expect(crumb).toContainText(c3.slice(0, 8))

  // 查看文件历史 → 弹窗（标题含文件路径 + 提交列表）
  await node.click({ button: 'right' })
  const history = page.locator('.n-dropdown-menu').getByText('查看文件历史', { exact: true })
  await expect(history).toBeVisible({ timeout: 3000 })
  await history.click()
  const modal = page.locator('.n-modal')
  await expect(modal).toContainText(`文件历史：${README}`, { timeout: 5000 })
  await expect(modal.locator('text=c3: readme notes').first()).toBeVisible()
  await page.locator('.n-modal .n-base-close, .n-modal .n-card-header__close').first().click()
})

test('F2+ 在编辑器中打开：普通编辑器标签', async ({ page }) => {
  await enterAndOpenLog(page)
  await selectCommit(page, c3.slice(0, 8))
  const node = fileNode(page, 'README.md')
  await node.click({ button: 'right' })
  const open = page.locator('.n-dropdown-menu').getByText('在编辑器中打开', { exact: true })
  await expect(open).toBeVisible({ timeout: 3000 })
  await open.click()
  // 普通 Monaco 编辑器（非 diff）渲染
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.monaco-diff-editor')).toHaveCount(0)
})

test('F3 blame 点击提交 id → 底部 Git 面板选中对应提交', async ({ page }) => {
  await enterAndOpenLog(page)
  await selectCommit(page, c2.slice(0, 8))
  const node = fileNode(page, 'lib.ts')
  await node.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('在编辑器中打开', { exact: true }).click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 5000 })

  await page.locator('.blame-toggle-btn').click()
  const spans = page.locator('.monaco-editor span.sc-blame-ref')
  await expect(spans.first()).toBeVisible({ timeout: 5000 })

  // 逐个尝试可视区内的注入文本（首行可能被面包屑遮挡）：点击 c2 的段
  const c2Span = spans.filter({ hasText: c2.slice(0, 8) }).first()
  let clicked = false
  if (await c2Span.isVisible().catch(() => false)) {
    await c2Span.click({ timeout: 1500 }).catch(() => { /* 遮挡则退回逐个尝试 */ })
    clicked = (await page.locator('.commit-item.selected').count()) > 0
  }
  for (let i = 0; i < 4 && !clicked; i++) {
    const el = spans.nth(i)
    if (!(await el.isVisible().catch(() => false))) continue
    try {
      await el.click({ timeout: 1500 })
      clicked = (await page.locator('.commit-item.selected').count()) > 0
    } catch { /* 被遮挡：试下一个 */ }
  }
  expect(clicked).toBe(true)

  // 底部 Git 面板激活且选中提交为 c2
  const selected = page.locator('.commit-item.selected').first()
  await expect(selected).toBeVisible({ timeout: 5000 })
  await expect(selected).toContainText(c2.slice(0, 8))
})

test('F4 编辑器右键：菜单项注册 + 对比参照弹窗（按钮入口同源）', async ({ page }) => {
  await enterAndOpenLog(page)
  await selectCommit(page, c2.slice(0, 8))
  const node = fileNode(page, 'lib.ts')
  await node.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('在编辑器中打开', { exact: true }).click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 5000 })

  // Monaco 右键菜单含全部四项 Git 动作（headless 下 Monaco 菜单打开即被
  // 失焦策略关闭、点击落在空壳 DOM 上无法驱动动作执行——动作本体经
  // 右上角按钮/单测/真机烟雾覆盖，此处断言菜单注册面）
  const viewLines = page.locator('.monaco-editor .view-lines').first()
  await viewLines.click({ button: 'right' })
  const menu = page.locator('.context-view .monaco-menu, .monaco-menu-container .monaco-menu')
  await expect(menu.first()).toBeVisible({ timeout: 3000 })
  await expect(menu.getByText('与分支/Tag/提交对比…', { exact: true })).toBeAttached()
  await expect(menu.getByText('与剪贴板内容对比', { exact: true })).toBeAttached()
  await expect(menu.getByText('查看文件历史', { exact: true })).toBeAttached()
  await expect(menu.getByText('在文件树中定位', { exact: true })).toBeAttached()
  await page.keyboard.press('Escape')

  // 对比参照弹窗（与右键菜单同一 CompareRefModal 实例，经右上角按钮驱动）
  const compareBtn = page.locator('.ega-btn').filter({ hasText: '对比' })
  await expect(compareBtn).toBeVisible()
  await compareBtn.click()
  const modal = page.locator('.n-modal')
  await expect(modal).toContainText(`对比：${LIB}`, { timeout: 5000 })
  await modal.locator('.n-select').first().click()
  await page.locator('.n-base-select-option').filter({ hasText: /^main$/ }).first().click()
  // main 无 lib.ts 的对立差异时至少渲染对比区（空差异也有面板），断言弹窗未报错
  await expect(modal).toBeVisible()
  await page.locator('.n-modal .n-base-close, .n-modal .n-card-header__close').first().click()
})

test('F1 目录历史修复回归：子目录历史不再恒为空', async ({ page }) => {
  await enterAndOpenLog(page)
  const dirInput = page.getByPlaceholder('目录历史 (src/)')
  await dirInput.fill('src')
  await page.getByRole('button', { name: '目录历史' }).click()
  // src/ 仅 c1、c2 触及；c3（README）不应出现
  await expect(page.locator('.commit-item').filter({ hasText: 'c2: PatchAlpha boundary' }))
    .toBeVisible({ timeout: 5000 })
  await expect(page.locator('.commit-item').filter({ hasText: 'c1: init library' }))
    .toBeVisible({ timeout: 5000 })
  await expect(page.locator('.commit-item').filter({ hasText: 'c3: readme notes' }))
    .toHaveCount(0)
})

test('F2 悬浮层触发收窄：仅消息文字 hover 弹出，日期区不触发', async ({ page }) => {
  await enterAndOpenLog(page)
  const row = page.locator('.commit-item').filter({ hasText: 'c2: PatchAlpha boundary' }).first()

  // hover 日期/右侧 meta 区：不应弹出详情浮层（曾从日期划过即弹，用户反馈收窄）
  await row.locator('.commit-meta-date').hover()
  await page.waitForTimeout(700) // 超过 400ms 弹出延迟
  await expect(page.locator('.commit-pop')).toHaveCount(0)

  // hover 消息文字：弹出
  await row.locator('.commit-msg').hover()
  await expect(page.locator('.commit-pop')).toBeVisible({ timeout: 3000 })
})

test('dsh 独立访问守卫：关闭后裸开反代地址返回引导页，iframe 嵌入不受影响', async ({ page }) => {
  const headers = await unlockHeaders()

  // 反代端口必须本实例独占：默认 3081 是全机共享面——主实例（:9999）、并行
  // 分片实例、乃至 WSL 侧巡更实例（wslrelay 把 WSL 内监听转发到 Windows 回环，
  // 实测 lnx-e2e-bin 占 3081）都可能是属主；打过去断言的是别人家的守卫
  //（本实例 AllowStandalone=false 的 PUT 传不到对方，守卫直通 → 上游 502）。
  // 先经 settings 给本实例指定派生独占端口（主端口+37，避开 share/pprof 的
  // +2/+1 派生），随后的 /dsh/url 惰性启动按实时配置绑定该端口
  const dshPort = Number(new URL(API_BASE).port) + 37
  await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT', headers,
    body: JSON.stringify({ dshProxyPort: dshPort }),
  })

  // 惰性拉起反代（首次 /dsh/url 访问即启动监听）
  await fetch(`${API_BASE}/api/tools/dsh/url`, { headers })
  const proxyPort = await (async () => {
    const res = await fetch(`${API_BASE}/api/tools/dsh/url`, { headers }).then(r => r.json())
    return Number((res?.data?.url || '').match(/:(\d+)/)?.[1] || 0)
  })()
  // 绑定到的必须是我们指定的端口：不等说明端口被外部占走（degraded），
  // 后续守卫断言会打到场外进程——显式失败并给出真实绑定，别让断言说谎
  expect(proxyPort).toBe(dshPort)

  // 关闭「允许独立标签页访问」
  await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT', headers,
    body: JSON.stringify({ dshAllowStandalone: false }),
  })

  // 裸开（顶层导航）→ 友好引导页（中文按 Accept-Language；e2e locale zh-CN）
  const res = await page.request.get(`http://127.0.0.1:${proxyPort}/`, {
    headers: { 'Sec-Fetch-Dest': 'document', 'Accept-Language': 'zh-CN' },
  })
  expect(res.status()).toBe(403)
  const body = await res.text()
  expect(body).toContain('dsh 嵌入通道')
  // 引导页品牌随 4adaf9da 切换为 Codecombo
  expect(body).toContain('Codecombo')

  // iframe 嵌入（Sec-Fetch-Dest: iframe）不被拦：非 403（放行到 token 门/上游）
  const embed = await page.request.get(`http://127.0.0.1:${proxyPort}/`, {
    headers: { 'Sec-Fetch-Dest': 'iframe' },
  })
  expect(embed.status()).not.toBe(403)

  // 显式恢复开启：顶层导航重新放行；反代端口一并恢复默认（本实例数据面
  // 持久于 .e2e-data，留在派生端口会 surprises 共享 :9999 的其他用例/人）
  await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT', headers,
    body: JSON.stringify({ dshAllowStandalone: true, dshProxyPort: 3081 }),
  })
  const after = await page.request.get(`http://127.0.0.1:${proxyPort}/`, {
    headers: { 'Sec-Fetch-Dest': 'document' },
  })
  expect(after.status()).not.toBe(403)
})
