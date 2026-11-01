import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 未提交变更导出补丁 E2E（P-20261003-72，GET /api/projects/:id/patch?scope=…）：
 *   - 三态内容（worktree 未暂存 / staged 暂存 / head 全集）互不串味；
 *   - --binary：二进制变更以 GIT binary patch 入补丁；
 *   - P-20261004-56：worktree/head 追补 untracked 新文件段（纯 untracked 现场
 *     可导出、按钮可点，克隆 apply 后新文件落地内容一致）；
 *   - 导出 → 于克隆副本 git apply 还原全部变更（字节级比对，含二进制）；
 *   - UI：变更面板工具条「导出补丁」三态下拉下载（suggestedFilename 含分支+日期），
 *     全干净（tracked/untracked 均无）时按钮禁用、服务端空 diff 400。
 * 自备临时仓库（core.autocrlf false，三平台行尾语义对齐），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-export-patch')
const PROJ = 'e2e-export-patch'
const BASE = 'base.txt'
const STAGED = 'staged.txt'
const BIN = 'blob.bin'
const UNTRACKED = 'untracked-new.txt'

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

/** 干净克隆（--no-checkout + autocrlf=false 后再检出：杜绝全局 smudge 把基线检成 CRLF，补丁上下文失配）。
 * 克隆源/补丁路径用本地形态——git 在测试进程侧跑，serverPath 只用于服务端注册 */
function freshClone(to: string) {
  execFileSync('git', ['clone', '--no-checkout', REPO_DIR, to])
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: to })
  execFileSync('git', ['checkout', 'HEAD'], { cwd: to })
}

let projectId = ''

/** 重建「混合未提交变更」夹具态（幂等）：test 1-3 各自入口调用——
 * Playwright 失败重试跑在同文件全部用例之后（届时 test 4 已把变更提交掉），
 * 不自愈会把首次失败放大成永久 400 级联 */
function ensureMixedChanges() {
  execFileSync('git', ['reset', '--hard'], { cwd: REPO_DIR })
  execFileSync('git', ['clean', '-fd'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, BASE), 'base v2\n')
  fs.writeFileSync(path.join(REPO_DIR, STAGED), 'staged new\n')
  fs.writeFileSync(path.join(REPO_DIR, BIN), Buffer.from([0xff, 0xfe, 0x00, 0x9c]))
  fs.writeFileSync(path.join(REPO_DIR, UNTRACKED), 'untracked new\n') // P-56：agent 新产物形态
  git(REPO_DIR, ['add', STAGED, BIN])
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(4)
}

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
  execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, BASE), 'base v1\n')
  fs.writeFileSync(path.join(REPO_DIR, BIN), Buffer.from([0x00, 0x01, 0x02, 0x03]))
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 导出补丁基线'])
  ensureMixedChanges()

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // 克隆副本与导出的补丁文件一并收走（在测试内 rm 是为重跑幂等，这里收尾）
  for (const p of [
    path.join(os.tmpdir(), 'sc-e2e-export-patch-clone-api'),
    path.join(os.tmpdir(), 'sc-e2e-export-patch-clone-ui'),
    path.join(os.tmpdir(), 'sc-e2e-export-patch-head.patch'),
  ]) { try { fs.rmSync(p, { recursive: true, force: true }) } catch { /* 占用忽略 */ } }
  // uiState 归零收尾（防布局恢复污染后续 spec）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test('API 三态：内容互不串味 + 二进制入补丁 + 下载头含分支与日期 + 非法 scope 400', async ({ request }) => {
  ensureMixedChanges()
  const headers = await unlockHeaders()
  const url = `${API_BASE}/api/projects/${projectId}/patch`
  const today = new Date()
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

  // worktree：未暂存 tracked + untracked 新文件段（P-56）
  const wt = await request.get(`${url}?scope=worktree`, { headers })
  expect(wt.ok()).toBeTruthy()
  expect(wt.headers()['content-type']).toContain('text/x-patch')
  expect(wt.headers()['content-disposition']).toContain('attachment')
  expect(wt.headers()['content-disposition']).toContain(`main-${ymd}.patch`)
  const wtBody = await wt.text()
  expect(wtBody).toContain('diff --git a/base.txt')
  expect(wtBody).toContain('+base v2')
  expect(wtBody).toContain('diff --git a/untracked-new.txt b/untracked-new.txt')
  expect(wtBody).toContain('new file mode')
  expect(wtBody).toContain('+++ b/untracked-new.txt')
  expect(wtBody).toContain('+untracked new')
  expect(wtBody).not.toContain('staged.txt')
  expect(wtBody).not.toContain('blob.bin')

  // staged：只含暂存（新文件 + 二进制以 GIT binary patch 形态嵌入）；
  // untracked 不入 staged（暂存区无 untracked 概念，语义不变）
  const sg = await request.get(`${url}?scope=staged`, { headers })
  expect(sg.ok()).toBeTruthy()
  const sgBody = await sg.text()
  expect(sgBody).toContain('staged.txt')
  expect(sgBody).toContain('GIT binary patch')
  expect(sgBody).not.toContain('+base v2')
  expect(sgBody).not.toContain('untracked-new.txt')

  // head：全集（暂存+未暂存+untracked）；缺省 scope 同 head
  for (const q of ['scope=head', '']) {
    const hd = await request.get(q ? `${url}?${q}` : url, { headers })
    expect(hd.ok()).toBeTruthy()
    const hdBody = await hd.text()
    expect(hdBody).toContain('+base v2')
    expect(hdBody).toContain('staged.txt')
    expect(hdBody).toContain('GIT binary patch')
    expect(hdBody).toContain('+++ b/untracked-new.txt')
  }

  // 非法 scope → 400 明确报错
  const bad = await request.get(`${url}?scope=nonsense`, { headers })
  expect(bad.status()).toBe(400)
  expect((await bad.json() as { error?: string }).error).toContain('invalid scope')
})

test('导出 head 补丁 → 克隆副本 git apply 还原全部变更（文本+二进制字节级一致）', async ({ request }) => {
  ensureMixedChanges()
  const headers = await unlockHeaders()
  const res = await request.get(`${API_BASE}/api/projects/${projectId}/patch?scope=head`, { headers })
  expect(res.ok()).toBeTruthy()
  const patchPath = path.join(os.tmpdir(), 'sc-e2e-export-patch-head.patch')
  fs.writeFileSync(patchPath, await res.body())

  const cloneDir = path.join(os.tmpdir(), 'sc-e2e-export-patch-clone-api')
  try { fs.rmSync(cloneDir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  freshClone(cloneDir)

  execFileSync('git', ['apply', patchPath], { cwd: cloneDir })

  // 还原后与源仓库工作区字节级一致（含二进制与 untracked 新文件）
  expect(fs.readFileSync(path.join(cloneDir, BASE), 'utf8')).toBe('base v2\n')
  expect(fs.readFileSync(path.join(cloneDir, STAGED), 'utf8')).toBe('staged new\n')
  expect(fs.readFileSync(path.join(cloneDir, UNTRACKED), 'utf8')).toBe('untracked new\n')
  expect(Buffer.compare(
    fs.readFileSync(path.join(cloneDir, BIN)),
    fs.readFileSync(path.join(REPO_DIR, BIN)),
  )).toBe(0)
})

test('UI：工具条三态下拉导出下载 → 下载文件于克隆副本 git apply 还原', async ({ page }) => {
  ensureMixedChanges()
  // status 接口走服务端 3s TTL 缓存——重试场景下缓存里可能是 test 4 提交后的
  // 干净态；CLI 改仓不触发失效，静置一个 TTL 再进页面，首拉必见混合态
  await page.waitForTimeout(3300)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  // rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  const panel = page.locator('.commit-panel')
  await expect(panel.locator('.cp-node').filter({ hasText: BASE })).toBeVisible({ timeout: 10000 })

  // 混合变更下按钮可用，下拉三态齐备
  const exportBtn = panel.locator('[data-testid="export-patch"]')
  await expect(exportBtn).toBeEnabled()
  await exportBtn.click()
  const headOption = page.locator('.n-dropdown-option').filter({ hasText: '全部（相对 HEAD）' })
  await expect(page.locator('.n-dropdown-option').filter({ hasText: '工作区（未暂存）' })).toBeVisible()
  await expect(page.locator('.n-dropdown-option').filter({ hasText: '暂存区' })).toBeVisible()
  const dlPromise = page.waitForEvent('download')
  await headOption.click()
  const dl = await dlPromise
  expect(dl.suggestedFilename()).toMatch(/^main-\d{8}\.patch$/)

  // 下载产物于干净克隆 git apply → 未提交变更全部还原（含 untracked 新文件）
  const cloneDir = path.join(os.tmpdir(), 'sc-e2e-export-patch-clone-ui')
  try { fs.rmSync(cloneDir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  freshClone(cloneDir)
  execFileSync('git', ['apply', await dl.path()], { cwd: cloneDir })
  expect(fs.readFileSync(path.join(cloneDir, BASE), 'utf8')).toBe('base v2\n')
  expect(fs.readFileSync(path.join(cloneDir, UNTRACKED), 'utf8')).toBe('untracked new\n')
  expect(Buffer.compare(
    fs.readFileSync(path.join(cloneDir, BIN)),
    fs.readFileSync(path.join(REPO_DIR, BIN)),
  )).toBe(0)
})

test('纯 untracked 现场可导出（P-56）：按钮可点 + worktree/head 含新文件段 + staged 仍 400；全干净恢复禁用', async ({ page, request }) => {
  // CLI 提交掉全部已跟踪变更，只留 untracked 新文件（P-72 时代此形态按钮
  // 禁用、导出 400）；--allow-empty：重试时变更可能已被首次尝试提交。
  // UNTRACKED 幂等重写：末段清理会删它，失败重试的二次进入须自愈
  fs.writeFileSync(path.join(REPO_DIR, UNTRACKED), 'untracked new\n')
  fs.writeFileSync(path.join(REPO_DIR, 'untracked-only.txt'), 'untracked\n')
  git(REPO_DIR, ['add', BASE, STAGED, BIN])
  git(REPO_DIR, ['commit', '--allow-empty', '-m', 'chore: 清空已跟踪未提交变更'])

  // API 契约：worktree/head 追补 untracked 段 200；staged 语义不变 400
  const headers = await unlockHeaders()
  const url = `${API_BASE}/api/projects/${projectId}/patch`
  for (const scope of ['worktree', 'head']) {
    const res = await request.get(`${url}?scope=${scope}`, { headers })
    expect(res.ok()).toBeTruthy()
    const body = await res.text()
    expect(body).toContain('new file mode')
    expect(body).toContain('+++ b/untracked-new.txt')
    expect(body).toContain('+++ b/untracked-only.txt')
  }
  const sg = await request.get(`${url}?scope=staged`, { headers })
  expect(sg.status()).toBe(400)
  expect((await sg.json() as { error?: string }).error).toContain('no changes to export')

  // status 接口 3s TTL：进页面前静置一个 TTL，首拉必见「仅 untracked」态
  await page.waitForTimeout(3300)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  const panel = page.locator('.commit-panel')
  // CLI 改仓不触发前端刷新 → 点面板刷新按钮归到最新态
  await panel.locator('.cp-tab-refresh').click()
  await expect(panel.locator('.cp-node').filter({ hasText: 'untracked-new.txt' })).toBeVisible({ timeout: 10000 })
  // P-56 核心：纯 untracked 现场按钮可点，staged 项单独禁用（无 untracked 概念；
  // naive-ui 置灰落内层 body，外层壳类不变——session-locate-tree 同款断言）
  const exportBtn = panel.locator('[data-testid="export-patch"]')
  await expect(exportBtn).toBeEnabled()
  await exportBtn.click()
  const stagedOption = page.locator('.n-dropdown-option-body').filter({ hasText: '暂存区' })
  await expect(stagedOption).toBeVisible()
  await expect(stagedOption).toHaveClass(/n-dropdown-option-body--disabled/)
  await page.keyboard.press('Escape')

  // 全干净（untracked 也清掉）：按钮回到禁用，三态全 400（空导出兜底契约不变）
  fs.rmSync(path.join(REPO_DIR, UNTRACKED))
  fs.rmSync(path.join(REPO_DIR, 'untracked-only.txt'))
  // status 3s TTL：CLI 删除不失效缓存，静置后再刷新
  await page.waitForTimeout(3300)
  await panel.locator('.cp-tab-refresh').click()
  await expect(panel.locator('[data-testid="export-patch"]')).toBeDisabled()
  for (const scope of ['worktree', 'staged', 'head']) {
    const res = await request.get(`${url}?scope=${scope}`, { headers })
    expect(res.status()).toBe(400)
    expect((await res.json() as { error?: string }).error).toContain('no changes to export')
  }
})
