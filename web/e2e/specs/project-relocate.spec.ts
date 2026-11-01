import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixedLocale, gotoAndUnlock, waitForAppReady, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 项目重新定位 E2E（P-20261001-12）：
 *   注册项目 → 磁盘目录搬家 → 首页卡片转「路径无效」→ 卡片「重新定位」按钮 →
 *   填新路径确认 → 卡片恢复有效，且项目 ID 不变、uiState 探针保留
 *   （uiState/终端历史等按项目 ID 关联，ID 连续 = 状态全保留）。
 * 自备临时目录，用后经 API 清理注册。
 */

const NAME_PREFIX = 'sc-e2e-relocate-'
let projDir = ''
let movedDir = ''
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

test.beforeAll(async () => {
  await cleanupProjects()
  projDir = fs.mkdtempSync(path.join(os.tmpdir(), NAME_PREFIX))
  projName = path.basename(projDir)
  fs.writeFileSync(path.join(projDir, 'README.md'), 'relocate probe\n')
  // 经 API 注册（UI 注册是 add-project-enter 的职责）
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
  // uiState 探针命名空间清空（null = 清空该命名空间，见 PUT /ui-state 合并语义）
  try {
    const headers = await unlockHeaders()
    await fetch(`${API_BASE}/api/ui-state`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ 'e2e-relocate-probe': null }),
    })
  } catch { /* 清理失败不阻塞 */ }
  for (const dir of [projDir, movedDir]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
})

test('目录搬家后重新定位：卡片恢复有效且项目 ID/uiState 保留', async ({ page }) => {
  // 写 uiState 探针（重定位不得清理按项目 ID 关联的 UI 状态；删除项目才会级联清理）
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ 'e2e-relocate-probe': { relocateMarker: { projectId } } }),
  })

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  // 有效卡：无失效徽标
  const card = page.locator('.project-card').filter({ hasText: projName }).first()
  await expect(card).toBeVisible({ timeout: 5000 })
  await expect(card.locator('.project-invalid-badge')).toHaveCount(0)

  // 磁盘搬家：目录移入新父目录
  movedDir = path.join(os.tmpdir(), `moved-${projName}`)
  fs.rmSync(movedDir, { recursive: true, force: true })
  fs.renameSync(projDir, movedDir)

  // 服务端 valid 判定走 5s TTL 仓库信息缓存（git.GetRepoInfoCached）——
  // 搬家后立即刷新会命中旧缓存仍判有效，等过一个缓存窗口再重载
  await page.waitForTimeout(6000)

  // 重载首页：卡片转无效（徽标 + 常驻重新定位按钮）
  await page.reload()
  await waitForAppReady(page)
  await expect(card.locator('.project-invalid-badge')).toBeVisible({ timeout: 10000 })

  // 点卡片上的「重新定位」，填新路径确认
  await card.locator('.invalid-relocate-btn').click()
  const modal = page.locator('.n-modal').filter({ hasText: '重新定位项目' })
  await expect(modal).toBeVisible({ timeout: 3000 })
  const pathInput = modal.locator('input').first()
  await pathInput.fill(serverPath(movedDir))
  await modal.getByRole('button', { name: '确认' }).click()

  // 弹窗关闭、卡片恢复有效（失效徽标消失）
  await expect(modal).toBeHidden({ timeout: 10000 })
  await expect(card.locator('.project-invalid-badge')).toHaveCount(0, { timeout: 10000 })

  // 身份连续：同名项目的 ID 与注册时一致（uiState/终端历史按 ID 关联的依据）
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const proj = ((list?.data || []) as { id: string; name: string; valid: boolean }[])
    .find(p => p.name === projName)
  expect(proj?.id).toBe(projectId)
  expect(proj?.valid).not.toBe(false)

  // uiState 探针保留
  const ui = await (await fetch(`${API_BASE}/api/ui-state`, { headers })).json()
  const marker = (ui?.data?.['e2e-relocate-probe'] ?? {}) as { relocateMarker?: { projectId?: string } }
  expect(marker.relocateMarker?.projectId).toBe(projectId)
})

test('项目卡右键菜单提供重新定位入口（预填当前路径）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  const card = page.locator('.project-card').filter({ hasText: projName }).first()
  await expect(card).toBeVisible({ timeout: 5000 })
  await card.click({ button: 'right' })

  const item = page.locator('.n-dropdown-option').filter({ hasText: '重新定位' })
  await expect(item).toBeVisible({ timeout: 3000 })
  await item.click()

  const modal = page.locator('.n-modal').filter({ hasText: '重新定位项目' })
  await expect(modal).toBeVisible({ timeout: 3000 })
  // 预填当前注册路径，取消收场（不做变更）
  const prefilled = await modal.locator('input').first().inputValue()
  expect(prefilled.length).toBeGreaterThan(0)
  await modal.getByRole('button', { name: '取消' }).click()
  await expect(modal).toBeHidden({ timeout: 3000 })
})
