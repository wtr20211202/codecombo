import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * index.lock 遗留锁检测与一键清理（P-20261002-150）E2E：
 *   闭环：造 mtime 10 分钟前的旧锁 → 变更面板暂存（git add 写命令）失败 →
 *        错误提示为本地化「遗留锁」文案（服务端稳定标记 → KNOWN_ERROR 映射）+
 *        面板顶部出现修复条 → 点一键清理 → 锁文件消失 + 再次暂存成功（写恢复）
 *   保护：mtime=now 的新锁（正在写入的锁形态）走清理端点 → 409 拒绝且锁仍在
 *        （mtime 双重校验防误删活锁）；无锁时清理幂等成功（removed=false）
 * 自备临时仓库（root 基线提交），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-indexlock')
const LOCK_PROJ = 'e2e-indexlock'
const FILE = '.e2e-indexlock.tmp'

let projectId = ''

// 固定参数列表调用 git（无 shell 拼接），身份用 -c 内联避免依赖本机 git 配置
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

// 造一把 index.lock：ageMs 为拨过去的 mtime 龄（旧锁=遗留形态，新锁=写入中形态）
function makeLock(ageMs: number): string {
  const lockPath = path.join(REPO_DIR, '.git', 'index.lock')
  fs.writeFileSync(lockPath, '')
  const t = new Date(Date.now() - ageMs)
  fs.utimesSync(lockPath, t, t)
  return lockPath
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === LOCK_PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'indexlock e2e v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 初始提交'])

  projectId = await registerProject(headers, LOCK_PROJ, REPO_DIR)
  expect(projectId).toBeTruthy()

  // 造一个未暂存改动：变更面板有可暂存行（写命令=暂存的 git add）
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'indexlock e2e v2\n')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === LOCK_PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // 本 spec 运行期间 auto-save 的 uiState 会污染后续 spec 的布局恢复——与
  // commit-amend 的收尾对称，归零清空整个命名空间
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** rail「提交」是 toggle（uiState 服务端全局、跨用例恢复态不定）→ 循环归一化到面板可见 */
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
  await page.locator('.project-card').filter({ hasText: LOCK_PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
}

/** 点目标文件的暂存开关（变更列表唯一 .tmp 文件行）；面板服务端 status 有 3s
 * TTL 缓存，进入项目后先等行渲染出来 */
async function stageTargetFile(page: import('@playwright/test').Page) {
  const row = page.locator('.cp-node').filter({ hasText: FILE })
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.locator('.cp-stage-toggle').click()
}

test('闭环：旧锁 → 暂存失败出修复条 → 一键清理 → 写恢复', async ({ page }) => {
  await enterProject(page)

  // 无错误时无修复条
  await expect(page.getByTestId('index-lock-bar')).toHaveCount(0)

  // 造遗留锁（mtime 10 分钟前 >> 5 分钟阈值）→ 暂存（git add 写命令）失败
  const lockPath = makeLock(10 * 60 * 1000)
  await stageTargetFile(page)

  // 错误提示为本地化文案（不直出英文底层报错）：P-20261005-194 起该错误随响应
  // 携 hint kind=lock，toast 由 KNOWN_ERROR 旧文案升级为行动化指引（git.hint.lock，
  // 含锁路径插值）——断言稳定前缀；服务端稳定标记点亮修复条的链路不变
  await expect(page.locator('.n-message').filter({ hasText: 'git 操作被遗留的锁文件阻止' })).toBeVisible({ timeout: 10000 })
  // 修复条出现在变更面板顶部
  const bar = page.getByTestId('index-lock-bar')
  await expect(bar).toBeVisible()
  await expect(bar).toContainText('检测到遗留的 Git 锁文件')

  // 一键清理 → 成功提示 + 修复条消失 + 锁文件真被删除
  await page.getByTestId('index-lock-cleanup').click()
  await expect(page.locator('.n-message').filter({ hasText: '遗留锁已清理' })).toBeVisible({ timeout: 10000 })
  await expect(bar).toHaveCount(0, { timeout: 10000 })
  expect(fs.existsSync(lockPath), '锁文件应已删除').toBe(false)

  // 写恢复：再次暂存成功（写命令不再被锁阻塞）。服务端 status 有 3s TTL 缓存
  //（P-138 同款前提：面板快速连点会短暂显示陈旧未暂存态），故先轮询 /status
  // 直至真值收敛（TTL 过期后新扫描=staged），再点面板刷新重拉同一收敛态，
  // 最后断言 UI 落到 staged ✓ 与仓库真值
  await stageTargetFile(page)
  const headers = await unlockHeaders()
  await expect.poll(async () => {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/status`, { headers })
    const body = (await res.json()) as { data?: Array<{ path: string; staged: boolean }> }
    const f = (body.data || []).find(x => x.path === FILE)
    return f ? String(f.staged) : 'missing'
  }, { timeout: 15000, interval: 500 }).toBe('true')
  expect(git(REPO_DIR, ['diff', '--cached', '--name-only']), '仓库真值：文件已入暂存区').toContain(FILE)
  // P-20261005-194 起 hint 错误 toast 时长 10s 且悬于视口顶部中央——
  // 恰压在刷新钮上会拦点击（本用例前段很快，点击必然落在 toast 存活期内），
  // 等它按既定生命周期自然退场再操作，不放宽不跳过
  await expect(page.locator('.n-message').filter({ hasText: 'git 操作被遗留的锁文件阻止' })).toHaveCount(0, { timeout: 15000 })
  await page.locator('.cp-tab-refresh').click()
  const row = page.locator('.cp-node').filter({ hasText: FILE })
  await expect(row.locator('.cp-stage-toggle.staged')).toBeVisible({ timeout: 10000 })
})

test('保护：新锁清理 409 拒绝且锁仍在；无锁清理幂等成功', async () => {
  // mtime=now 的「正在写入的锁」形态：清理必须拒绝（mtime 双重校验防误删活锁）
  const lockPath = makeLock(0)
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/index-lock/cleanup`, {
    method: 'POST', headers,
  })
  expect(res.status).toBe(409)
  expect(fs.existsSync(lockPath), '新锁必须保留（可能正在写入）').toBe(true)

  // 锁消失后（此处手动移走）再清理：幂等成功 removed=false
  fs.rmSync(lockPath)
  const res2 = await fetch(`${API_BASE}/api/projects/${projectId}/index-lock/cleanup`, {
    method: 'POST', headers,
  })
  expect(res2.status).toBe(200)
  const body = (await res2.json()) as { removed?: boolean }
  expect(body.removed).toBe(false)
})
