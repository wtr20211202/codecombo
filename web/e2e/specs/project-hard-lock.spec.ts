import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fixedLocale, gotoAndUnlock, waitForAppReady, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 项目硬锁 E2E（P-20261004-3）：locked 归档不可变档。
 *   API 面：锁定 → 文件写/git 提交/开终端（含 agent dir 落锁内）三面 403
 *   （明文含稳定标记 project.locked）→ 读面放行 → 解锁 → 写恢复（真实建文件 +
 *   真实 stage/commit）+ 双向审计入账；
 *   UI 面：首页卡片右键「锁定」→ confirm 影响面清单 → 卡片锁徽标 →
 *   右键「解锁」→ 二次确认 → 徽标消失。
 * 自备临时 git 仓库，用后经 API 清理注册（project-freeze 同款骨架）。
 */

const NAME_PREFIX = 'sc-e2e-hardlock-'
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

test.beforeAll(async () => {
  await cleanupProjects()
  projDir = fs.mkdtempSync(path.join(os.tmpdir(), NAME_PREFIX))
  projName = path.basename(projDir)
  // 真实 git 仓库：解锁恢复方向要做一次成功的 stage/commit（403 方向守卫在
  // handler 前中止，仓库形态无关紧要；恢复方向需要真仓库证明全链路恢复）
  execSync('git init', { cwd: projDir })
  execSync('git config core.autocrlf false', { cwd: projDir })
  execSync('git config user.email sc-e2e@example.com', { cwd: projDir })
  execSync('git config user.name sc-e2e', { cwd: projDir })
  fs.writeFileSync(path.join(projDir, 'README.md'), 'hard lock probe\n')
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
  await cleanupProjects()
  try { fs.rmSync(projDir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('锁定→文件写/git 提交/开终端三面 403→读放行→解锁恢复+双向审计', async () => {
  test.setTimeout(60000)
  await setLocked(true)

  // ── 三面 403：错误明文含稳定标记 project.locked（P-305 未落地的兼容契约）──
  const headers = await unlockHeaders()
  const expectDenied = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    expect(res.status, `${method} ${url}`).toBe(403)
    const text = await res.text()
    expect(text, `${method} ${url} 缺稳定标记`).toContain('project.locked')
  }

  // 面 1：文件写族（create；write/rename/delete 同族同守卫，抽一代表）
  await expectDenied('POST', `${API_BASE}/api/projects/${projectId}/file/create`, { path: 'blocked.txt' })
  // 面 2：git 提交族（stage → 前置于 commit）
  await expectDenied('POST', `${API_BASE}/api/projects/${projectId}/stage`, { files: ['README.md'] })
  await expectDenied('POST', `${API_BASE}/api/projects/${projectId}/commit`, { message: 'should not land' })
  // 面 3：开终端（项目终端 + agent 会话 dir 落锁内）
  await expectDenied('POST', `${API_BASE}/api/terminals`, { projectId, name: 'locked-shell' })
  await expectDenied('POST', `${API_BASE}/api/terminals`, { kind: 'agent', dir: serverPath(projDir) })

  // ── 读面放行 ──
  let res = await fetch(`${API_BASE}/api/projects/${projectId}`, { headers })
  expect(res.status).toBe(200)
  res = await fetch(`${API_BASE}/api/projects/${projectId}/status`, { headers })
  expect(res.status).toBe(200)
  res = await fetch(`${API_BASE}/api/projects/${projectId}/file?path=README.md`, { headers })
  expect(res.status).toBe(200)

  // ── 解锁恢复：写面真实可用（建文件 + stage/commit 全链路）──
  await setLocked(false)
  res = await fetch(`${API_BASE}/api/projects/${projectId}/file/create`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ path: 'restored.txt', content: 'writable again' }),
  })
  expect([200, 201], '解锁后文件写应恢复').toContain(res.status)
  res = await fetch(`${API_BASE}/api/projects/${projectId}/stage`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ files: ['restored.txt'] }),
  })
  expect(res.status, '解锁后 stage 应恢复').toBe(200)
  res = await fetch(`${API_BASE}/api/projects/${projectId}/commit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: 'after unlock' }),
  })
  expect(res.status, '解锁后 commit 应恢复').toBe(200)
  // 终端创建恢复（建真会话后立刻关掉，approval-jump 同款先例）
  res = await fetch(`${API_BASE}/api/terminals`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ projectId, name: 'unlocked-shell' }),
  })
  expect(res.status, '解锁后终端创建应恢复').toBe(200)
  const term = ((await res.json()) as { data?: { id?: string } }).data
  if (term?.id) {
    await fetch(`${API_BASE}/api/terminals/${term.id}`, { method: 'DELETE', headers })
  }

  // ── 双向审计：project.lock 与 project.unlock 均入账 ──
  const auditRes = await fetch(`${API_BASE}/api/audit?limit=50`, { headers })
  const audit = await auditRes.json() as { data?: { action: string }[] }
  const actions = (audit?.data || []).map(e => e.action)
  expect(actions).toContain('project.lock')
  expect(actions).toContain('project.unlock')
})

test('UI：右键锁定→confirm 影响面清单→锁徽标；右键解锁→二次确认→徽标消失', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  const card = page.locator('.project-card').filter({ hasText: projName }).first()
  await expect(card).toBeVisible({ timeout: 5000 })
  await expect(card.locator('.project-locked-badge')).toHaveCount(0)

  // 右键 → 「锁定（归档不可变）」
  await card.click({ button: 'right' })
  const lockItem = page.locator('.n-dropdown-option').filter({ hasText: '锁定' })
  await expect(lockItem).toBeVisible({ timeout: 3000 })
  await lockItem.click()

  // confirm 弹窗（useDialog discrete dialog 渲染 .n-dialog）带影响面清单
  const dialog = page.locator('.n-dialog').filter({ hasText: '锁定项目？' })
  await expect(dialog).toBeVisible({ timeout: 3000 })
  await expect(dialog).toContainText('文件写入')
  await expect(dialog).toContainText('Git 写操作')
  await expect(dialog).toContainText('终端')
  await dialog.getByRole('button', { name: '锁定', exact: true }).click()

  // 卡片锁徽标出现 + API 态已落
  await expect(card.locator('.project-locked-badge')).toBeVisible({ timeout: 5000 })
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const proj = ((list?.data || []) as { id: string; name: string; locked: boolean }[])
    .find(p => p.name === projName)
  expect(proj?.locked).toBe(true)

  // 右键 → 「解锁」→ 第一道确认
  await card.click({ button: 'right' })
  const unlockItem = page.locator('.n-dropdown-option').filter({ hasText: '解锁' })
  await expect(unlockItem).toBeVisible({ timeout: 3000 })
  await unlockItem.click()
  const unlockDialog1 = page.locator('.n-dialog').filter({ hasText: '解锁项目？' })
  await expect(unlockDialog1).toBeVisible({ timeout: 3000 })
  await unlockDialog1.getByRole('button', { name: '确认', exact: true }).click()

  // 第二道最终确认
  const unlockDialog2 = page.locator('.n-dialog').filter({ hasText: '确认解锁？' })
  await expect(unlockDialog2).toBeVisible({ timeout: 3000 })
  await unlockDialog2.getByRole('button', { name: '确认解锁', exact: true }).click()

  // 徽标消失 + API 态恢复
  await expect(card.locator('.project-locked-badge')).toHaveCount(0, { timeout: 5000 })
  const list2 = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const proj2 = ((list2?.data || []) as { id: string; name: string; locked: boolean }[])
    .find(p => p.name === projName)
  expect(proj2?.locked).toBe(false)
})

test('锁定持久化：API 锁定后刷新首页锁徽标仍在，解锁后消失', async ({ page }) => {
  await setLocked(true)

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const card = page.locator('.project-card').filter({ hasText: projName }).first()
  await expect(card.locator('.project-locked-badge')).toBeVisible({ timeout: 5000 })

  // 刷新后仍在（服务端持久化，非前端内存态）
  await page.reload()
  await waitForAppReady(page)
  await expect(page.locator('.project-card').filter({ hasText: projName }).first().locator('.project-locked-badge'))
    .toBeVisible({ timeout: 10000 })

  await setLocked(false)
  await page.reload()
  await waitForAppReady(page)
  await expect(page.locator('.project-card').filter({ hasText: projName }).first().locator('.project-locked-badge'))
    .toHaveCount(0, { timeout: 10000 })
})
