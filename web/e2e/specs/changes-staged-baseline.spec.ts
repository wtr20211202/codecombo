import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更 diff 的暂存态基线（P-20261004-42 盲提交收口）E2E：变更树双击/回车开
 * 编辑器 Diff 标签按行暂存态分流——已暂存行 = HEAD vs 暂存区（键
 * diff:HEAD:index:<path>，blob 取数 ref=:0 stage-0 语法），未暂存行 = 暂存区
 * vs 工作区（键 diff:index:wt:<path>）。守护链：
 *   部分暂存（MM）行的 diff 只含已暂存增量、不含工作区追加改动（「将提交什么」
 *   可见——合并 diff 误导的回归锚）；
 *   未暂存行 diff 基线是暂存区（不含已暂存侧增量当差异噪声）；
 *   面包屑对比标签双语呈现（HEAD ↔ 暂存区 / 暂存区 ↔ 工作区）；
 *   键盘 Enter 与双击同链（onFileListKeydown → handleFileDblClick）。
 * 全程以 git CLI 校验仓库真实状态；自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-staged-baseline')
const PROJ = 'e2e-staged-baseline'
// 互不为子串的根级文件名（树行按末段名定位）
const F_MM = 'staged-partial.txt'
const F_DIRTY = 'unstaged-only.txt'
const F_NEW = 'untracked-fresh.txt'

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

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'staged baseline e2e\n')
  // MM 夹具：HEAD < 暂存区（staged-two）< 工作区（work-three 再改）——三态内容
  // 互异才能证明「已暂存视图不含工作区追加改动」
  fs.writeFileSync(path.join(REPO_DIR, F_MM), 'head-one\nhead-two\nhead-three\n')
  fs.writeFileSync(path.join(REPO_DIR, F_DIRTY), 'base-one\nbase-two\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 暂存基线分流基线'])
  // F_MM：先暂存增量（staged-two），再追加工作区改动（work-three）
  fs.writeFileSync(path.join(REPO_DIR, F_MM), 'head-one\nstaged-two\nhead-three\n')
  git(REPO_DIR, ['add', F_MM])
  fs.writeFileSync(path.join(REPO_DIR, F_MM), 'head-one\nstaged-two\nwork-three\n')
  // F_DIRTY：只动工作区
  fs.writeFileSync(path.join(REPO_DIR, F_DIRTY), 'base-one\ndirty-two\n')
  // F_NEW：未跟踪新文件
  fs.writeFileSync(path.join(REPO_DIR, F_NEW), 'fresh content\n')
  // 仓库实况哨兵：MM 行 staged=true（服务端 parseXY X 位优先）、F_DIRTY 未暂存
  //（porcelain XY 前导空格已被 git() helper trim，按「无 M 在 X 位」判读）
  expect(git(REPO_DIR, ['status', '--porcelain', F_MM])).toBe('MM ' + F_MM)
  expect(git(REPO_DIR, ['status', '--porcelain', F_DIRTY])).toBe('M ' + F_DIRTY)
  expect(git(REPO_DIR, ['diff', '--cached', '--', F_MM])).toContain('staged-two')

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // uiState 归零收尾（防布局恢复污染后续 spec）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: F_MM })).toBeVisible({ timeout: 10000 })
}

function row(page: import('@playwright/test').Page, name: string) {
  return page.locator('.cp-node').filter({ hasText: name }).first()
}

/** Monaco diff 编辑器两侧文本（小文件全量渲染，view-lines 拼接无换行符） */
function diffSide(page: import('@playwright/test').Page, side: 'original' | 'modified') {
  return page.locator(`.monaco-diff-editor .editor.${side} .view-lines`)
}

test('已暂存行双击 = HEAD↔暂存区：只含暂存增量、blob ref=:0，工作区追加改动不可见', async ({ page }) => {
  await enterProject(page)
  // 数据链直证：blob 快照取数以 stage-0 语法寻址暂存区（index 伪 ref 的映射）
  const blobRefs: string[] = []
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (u.pathname.endsWith('/blob')) {
      const ref = u.searchParams.get('ref')
      if (ref !== null && u.searchParams.get('path') === F_MM) blobRefs.push(ref)
    }
  })

  await row(page, F_MM).dblclick()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })
  // 键形态：diff:HEAD:index:<path>；面包屑对比标签「HEAD ↔ 暂存区」
  await expect(page.locator('.crumb.compare')).toContainText('HEAD')
  await expect(page.locator('.crumb.compare')).toContainText('暂存区')
  // 暂存增量在右侧（暂存区内容），HEAD 侧没有
  await expect(diffSide(page, 'modified')).toContainText('staged-two')
  await expect(diffSide(page, 'original')).toContainText('head-two')
  await expect(diffSide(page, 'original')).not.toContainText('staged-two')
  // 盲提交收口锚：HEAD↔暂存区视图两侧都看不到工作区追加改动（work-three）
  await expect(diffSide(page, 'modified')).not.toContainText('work-three')
  await expect(diffSide(page, 'original')).not.toContainText('work-three')
  // index 侧取数走 :0（stage-0）；HEAD 侧走 HEAD
  await expect.poll(() => blobRefs, { timeout: 5000 }).toContain(':0')
  expect(blobRefs).toContain('HEAD')
})

test('未暂存行双击 = 暂存区↔工作区：基线是暂存区而非 HEAD', async ({ page }) => {
  await enterProject(page)
  await row(page, F_DIRTY).dblclick()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })
  // 键形态 diff:index:wt:<path>：面包屑「暂存区 ↔ 工作区」
  await expect(page.locator('.crumb.compare')).toContainText('暂存区')
  await expect(page.locator('.crumb.compare')).toContainText('工作区')
  // 工作区增量在右侧；暂存区基线（左侧）没有
  await expect(diffSide(page, 'modified')).toContainText('dirty-two')
  await expect(diffSide(page, 'original')).toContainText('base-one')
  await expect(diffSide(page, 'original')).not.toContainText('dirty-two')
})

test('键盘 Enter 与双击同链分流 + 未跟踪新文件呈全新文件形态（左空）', async ({ page }) => {
  await enterProject(page)
  // Enter 走 onFileListKeydown → handleFileDblClick 同一分流：先点选行落键盘
  // 光标（handleFileClick），再聚焦列表容器按 Enter
  await row(page, F_DIRTY).click()
  const list = page.locator('.cp-file-list')
  await list.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.crumb.compare')).toContainText('暂存区')

  // 未跟踪新文件：index 无条目 → 左侧空 =「全新文件」形态（oldRef=index 取数
  // 失败静默兜底，与旧 HEAD 基线显示等价、语义更准）
  await row(page, F_NEW).dblclick()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })
  await expect(diffSide(page, 'modified')).toContainText('fresh content')
  await expect(diffSide(page, 'original')).not.toContainText('fresh content')
})
