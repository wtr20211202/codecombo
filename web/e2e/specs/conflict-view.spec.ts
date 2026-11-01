import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 冲突解决视图 E2E（补齐路线图登记的测试盲区「冲突视图」）：
 * 自备临时仓库构造真实合并冲突（base → feature/main 双向改同一行 → merge），
 * 注册为项目后走 UI 全流程：
 *   1. Git 面板冲突横幅/ConflictView 挂载，冲突文件清单含 demo.txt
 *   2. 三方对比渲染我方/他方内容
 *   3. 「采用我方」一键解决 → 冲突清零（all-resolved 语义）→ 文件内容为我方版本
 * 环境敏感点：仓库必须放系统临时目录且以服务端形态路径注册（serverPath，
 * 与 core-workflow 的 REPO_DIR 同理）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const REPO_DIR = path.join(process.env.TEMP || osTmp(), 'sc-e2e-conflict-view')
const PROJ_NAME = 'conflict-demo'
const FILE = 'demo.txt'

function osTmp(): string {
  return process.env.TEMP || '/tmp'
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], {
    cwd, encoding: 'utf8',
  })
}

async function unlockHeaders(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''
let mainEditHash = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  // 清理同名旧项目与残留目录
  const list = await (await request.get(`${BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_NAME) await request.delete(`${BASE}/api/projects/${p.id}`, { headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  // base：两分支的共同祖先
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'line1: base\nline2: shared\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'base'])
  // feature：改 line2
  git(REPO_DIR, ['checkout', '-b', 'feature'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'line1: base\nline2: feature changed this\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'feature edit'])
  // main：同一行不同改法 → 合并必冲突
  git(REPO_DIR, ['checkout', 'main'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'line1: base\nline2: main changed this\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'main edit'])
  mainEditHash = git(REPO_DIR, ['rev-parse', 'HEAD']).trim()
  let merged = false
  try {
    git(REPO_DIR, ['merge', 'feature'])
    merged = true
  } catch { /* 冲突即预期：非零退出 */ }
  if (merged) throw new Error('expected merge conflict did not happen')
  // 断言确实处于冲突态
  const status = git(REPO_DIR, ['status', '--porcelain'])
  if (!status.includes('UU')) throw new Error('expected UU conflict entry, got: ' + status)

  const created = await request.post(`${BASE}/api/projects`, {
    headers,
    // 注册路径按服务端形态交接（linux 实例经 /mnt/c 同见 %TEMP% 夹具）
    data: { name: PROJ_NAME, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  if (!projectId) throw new Error('project registration failed')
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await request.delete(`${BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

// 幂等打开 Git 面板并展开冲突面板：rail「Git 管理」是 toggle——侧栏开合态
// 经 uiState 跨用例/跨运行恢复，盲目单击会在「已打开」时反而收起（flaky 根因：
// 横幅可见性取决于恢复态而非确定动作）。以横幅可见为收敛目标重试
async function openConflictPanel(page: Parameters<typeof gotoAndUnlock>[0]) {
  test.setTimeout(60000) // 收敛循环 + 收尾断言需要超出默认 30s 的预算
  const banner = page.locator('.conflict-banner')
  const panelTitle = page.getByText('冲突文件', { exact: true })
  for (let attempt = 0; attempt < 4; attempt++) {
    // 冲突面板已展开：就位
    if (await panelTitle.isVisible().catch(() => false)) return
    if (await banner.isVisible().catch(() => false)) {
      await banner.click() // 横幅展开冲突面板
      await expect(panelTitle).toBeVisible({ timeout: 3000 })
      return
    }
    // 横幅不可见 = 底部 Git 面板未展开（横幅在底部面板 Git 页签内）。
    // rail 是 toggle：读 aria-expanded 只在收起时点击，展开态盲点会误关
    const rail = page.locator('.rail-btn[title="Git 管理"]')
    if ((await rail.getAttribute('aria-expanded').catch(() => null)) !== 'true') {
      await rail.click()
    }
    await page.waitForTimeout(1500)
  }
  await expect(banner).toBeVisible({ timeout: 10000 })
}

// 历史缺陷（已修）：首次进入冲突项目时 conflictCount 拉取早于服务端仓库
// 状态就绪 → 计 0 且 headless 无 focus 自愈，横幅长时间不出现；
// GitPanel 已加「项目进入后一次短延重试」兜底，下方 helper 的 rail 归一化
// 循环保留（uiState 恢复态不定，与面板可见性解耦）
test('冲突视图：横幅挂载 + 冲突文件清单', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await openConflictPanel(page)
  await expect(page.getByText('冲突文件', { exact: true })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('[title="demo.txt"]')).toBeVisible({ timeout: 10000 })
})

test('三方对比：我方/他方内容分别渲染', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await openConflictPanel(page)
  // 三方模式默认开启：我方 = main 版本、他方 = feature 版本
  await expect(page.getByText('main changed this')).toBeVisible({ timeout: 10000 })
  await expect(page.getByText('feature changed this')).toBeVisible({ timeout: 10000 })
})

test('采用我方一键解决：冲突清零 + 文件内容为我方版本', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await openConflictPanel(page)
  await page.getByRole('button', { name: '采用我方' }).first().click()
  // 解决后冲突计数归零（conflictCount=0 时横幅卸载）。空态文案「当前没有
  // 冲突文件」存在窗口极短（计数归零即卸载面板），不可作稳定断言锚点
  await expect(page.locator('.conflict-banner')).toBeHidden({ timeout: 10000 })
  // 磁盘内容应为我方（main）版本
  const content = fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')
  expect(content).toContain('main changed this')
  expect(content).not.toContain('<<<<<<<')
})

test('采用他方一键解决：冲突重建 → 冲突清零 + 文件内容为他方版本', async ({ page }) => {
  // 上一用例已解除合并（checkout --ours + add，合并仍进行中）——重建冲突态：
  // 放弃合并 → 回到 main edit → 重新合并 feature 触发同样的 UU 冲突
  try { git(REPO_DIR, ['merge', '--abort']) } catch { /* 非合并中忽略 */ }
  git(REPO_DIR, ['reset', '--hard', mainEditHash])
  let conflicted = false
  try {
    git(REPO_DIR, ['merge', 'feature'])
    conflicted = true
  } catch { /* 冲突即预期 */ }
  if (conflicted) throw new Error('expected merge conflict did not happen')

  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await openConflictPanel(page)
  await page.getByRole('button', { name: '采用他方' }).first().click()
  await expect(page.locator('.conflict-banner')).toBeHidden({ timeout: 10000 })
  // 磁盘内容应为他方（feature）版本
  const content = fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')
  expect(content).toContain('feature changed this')
  expect(content).not.toContain('<<<<<<<')
})

test('手动解决：编辑合并结果 → 保存结果 → 内容精确落盘', async ({ page }) => {
  // 重建冲突态（同采用他方用例）
  try { git(REPO_DIR, ['merge', '--abort']) } catch { /* 非合并中忽略 */ }
  git(REPO_DIR, ['reset', '--hard', mainEditHash])
  let conflicted = false
  try {
    git(REPO_DIR, ['merge', 'feature'])
    conflicted = true
  } catch { /* 冲突即预期 */ }
  if (conflicted) throw new Error('expected merge conflict did not happen')

  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await openConflictPanel(page)

  // 3way 模式下编辑 Result 窗格（原生 textarea 绑定 resultContent）
  const resultBox = page.locator('.n-modal textarea, .git-panel textarea').first()
  await expect(resultBox).toBeVisible({ timeout: 5000 })
  const manual = 'line1: base\nline2: manual merged line\n'
  await resultBox.fill(manual)
  await page.getByRole('button', { name: '保存结果' }).click()

  // 冲突清零（横幅卸载）+ 磁盘精确等于手工编辑内容
  await expect(page.locator('.conflict-banner')).toBeHidden({ timeout: 10000 })
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).toBe(manual)
})
