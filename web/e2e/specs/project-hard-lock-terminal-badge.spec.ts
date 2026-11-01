import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 项目硬锁 × 存量终端锁徽标 E2E（P-20261004-143）：锁定语义不杀既有会话——
 * shell 命令不经 API 守卫照常可执行，徽标是诚实边界提示（不阻断）。
 *   WS 广播路径：项目内开终端 → API 锁定（不经 UI）→ projects.changed 广播 →
 *   project store 直补锁态 → 终端 tab 小锁徽标即现（无刷新）；
 *   shell 面：锁定期间向存量会话 PTY 直写命令（broadcast-write）→ 文件落盘
 *   （不阻断只提示）；
 *   双向：API 解锁 → 徽标即摘。
 * 自备临时 git 仓库，用后经 API 清理注册（project-hard-lock 同款骨架；
 * 底部面板播种/归一化取 regression-probe 同款先例）。
 */

const NAME_PREFIX = 'sc-e2e-lock-badge-'
let projDir = ''
let projName = ''
let projectId = ''

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理历史运行残留：按名称前缀删注册（磁盘目录保留） */
async function cleanupProjects(): Promise<void> {
  try {
    const headers = await unlockHeaders()
    const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
    for (const p of ((list?.data || []) as { id: string; name: string }[])) {
      if (p.name.startsWith(NAME_PREFIX)) {
        await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
      }
    }
  } catch { /* 清理失败不阻塞用例 */ }
}

async function setLocked(locked: boolean): Promise<void> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/locked`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ locked }),
  })
  expect(res.status).toBe(200)
}

/** 清空本实例全部终端会话（CLAUDE.md 测试节「用例开头先 API 清空」惯例）：
 *  跨用例共享的服务端终端域，前序 spec 遗留会话会让 tab 计数面向不定初始态 */
async function closeAllTerminalSessions(): Promise<void> {
  try {
    const headers = await unlockHeaders()
    const list = ((await (await fetch(`${API_BASE}/api/terminals`, { headers })).json()) as { data?: Array<{ id?: string }> }).data || []
    for (const t of list) {
      if (t.id) await fetch(`${API_BASE}/api/terminals/${t.id}`, { method: 'DELETE', headers }).catch(() => { /* 幂等尽力 */ })
    }
  } catch { /* 清理失败不阻塞用例 */ }
}

/** 播种底部面板布局（uiState 服务端持久；regression-probe 同款）：页面加载前
 *  把 showBottomPanel/bottomTab 写成期望值，boot 恢复直接落到终端分区 */
async function seedBottomPanelLayout(request: import('@playwright/test').APIRequestContext): Promise<void> {
  const unlock = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await unlock.json()) as { token?: string }).token || ''
  const headers = { 'X-Lock-Token': token }
  const stateRes = await request.get(`${API_BASE}/api/ui-state`, { headers })
  const body = (await stateRes.json().catch(() => null)) as { data?: Record<string, { layout?: Record<string, unknown> }> } | null
  const layout = {
    ...(body?.data?.local?.layout || {}),
    showBottomPanel: true,
    bottomTab: 'terminal',
  }
  await request.patch(`${API_BASE}/api/ui-state`, { headers, data: { local: { layout } } }).catch(() => { /* 尽力播种 */ })
}

/** 点击 rail 直到面板进入期望可见态（toggle 语义；regression-probe 同款轮询） */
async function railToggleUntil(page: import('@playwright/test').Page, title: string, target: () => Promise<boolean>) {
  for (let i = 0; i < 3; i++) {
    if (await target()) return
    await page.locator(`.rail-btn[title="${title}"]`).click()
    for (let w = 0; w < 6; w++) {
      await page.waitForTimeout(500)
      if (await target()) return
    }
  }
  expect(await target()).toBe(true)
}

test.beforeAll(async () => {
  await cleanupProjects()
  projDir = fs.mkdtempSync(path.join(os.tmpdir(), NAME_PREFIX))
  projName = path.basename(projDir)
  execSync('git init', { cwd: projDir })
  execSync('git config core.autocrlf false', { cwd: projDir })
  execSync('git config user.email sc-e2e@example.com', { cwd: projDir })
  execSync('git config user.name sc-e2e', { cwd: projDir })
  fs.writeFileSync(path.join(projDir, 'README.md'), 'lock badge probe\n')
  execSync('git add README.md', { cwd: projDir })
  execSync('git commit -m init', { cwd: projDir })
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: projName, path: serverPath(projDir) }),
  })
  const body = await res.json() as { data?: { id?: string } }
  if (!body.data?.id) throw new Error(`register project failed: ${res.status} ${JSON.stringify(body)}`)
  projectId = body.data.id
})

test.afterAll(async () => {
  // 防御性解锁（用例中途失败时残留锁会挡住注册删除）
  try { await setLocked(false) } catch { /* 未注册等场景忽略 */ }
  await cleanupProjects()
  try { fs.rmSync(projDir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('存量终端锁徽标：开终端→API 锁定（WS 广播）→tab 徽标即现→shell 仍可写→解锁→徽标消失', async ({ page, request }) => {
  test.setTimeout(90000)
  await closeAllTerminalSessions()
  await seedBottomPanelLayout(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  // 进入项目
  const card = page.locator('.project-card').filter({ hasText: projName }).first()
  await expect(card).toBeVisible({ timeout: 5000 })
  await card.click()
  await page.waitForURL('**/project')

  // 底部终端面板可见后新建终端 tab（存量会话=锁前开出）
  await railToggleUntil(page, '终端', async () =>
    (await page.locator('.term-toolbar').isVisible().catch(() => false)))
  const before = await page.locator('.term-tab').count()
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(800)
  expect(await page.locator('.term-tab').count()).toBeGreaterThan(before)
  await expect(page.locator('.term-tab-lock')).toHaveCount(0)

  // API 锁定（不经 UI）→ projects.changed WS 广播 → store 直补 → 徽标即现（无刷新，
  // 页面 URL 未变即未重载——徽标出现本身就是广播路径的证明）
  await setLocked(true)
  const tabLock = page.locator('.term-tab-lock').first()
  await expect(tabLock).toBeVisible({ timeout: 8000 })
  await expect(tabLock).toHaveAttribute('title', /项目已锁定归档/)

  // shell 仍可执行（不阻断只提示）：锁定期间向存量会话 PTY 直写命令。走
  // broadcast-write（与前端广播条同链路的 REST 直写口；数据尾部 \r = PTY
  // Enter，与 writeSessionInput 同惯例）。不走 /queue：纯 shell 无 task.progress
  // 上报史，引擎 busy 判定缺失降级「只存不发」，命令永远进不了 PTY
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/terminals`, { headers })).json()
  const session = ((list?.data || []) as { id?: string; projectId?: string }[]).find(s => s.projectId === projectId)
  expect(session?.id, '存量会话应仍在服务端清单（锁不杀会话）').toBeTruthy()
  const wRes = await fetch(`${API_BASE}/api/terminals/broadcast-write`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ids: [session!.id], data: 'echo locked-shell-probe > shell-probe.txt\r' }),
  })
  expect(wRes.status, 'broadcast-write 应 200').toBe(200)
  const wBody = (await wRes.json()) as { data?: { written?: number; missing?: string[]; failed?: string[] } }
  expect(wBody.data?.written, '存量会话 PTY 直写应落账（missing/failed 为空）').toBe(1)
  let probeOk = false
  for (let i = 0; i < 20 && !probeOk; i++) {
    await page.waitForTimeout(500)
    const f = await fetch(`${API_BASE}/api/projects/${projectId}/file?path=shell-probe.txt`, { headers })
    if (f.status === 200) probeOk = true
  }
  expect(probeOk, '锁定项目的存量终端 shell 仍可写（徽标只提示不阻断）').toBe(true)

  // 解锁 → 徽标即摘（双向）
  await setLocked(false)
  await expect(page.locator('.term-tab-lock')).toHaveCount(0, { timeout: 8000 })
})
