import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixedLocale, gotoAndUnlock, waitForAppReady, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 项目冻结 E2E（P-20261003-9）：
 *   卡片右键「冻结」→ 首页尾部分区「已冻结」出现（默认折叠为一行计数，可展开看弱化卡）→
 *   搜索穿透冻结区（命中照常显示）→ 右键「解冻」恢复原分组；
 *   冻结布尔经 PUT /projects/:id/frozen 持久化，刷新后仍折入尾部分区。
 * 自备临时目录，用后经 API 清理注册。
 */

const NAME_PREFIX = 'sc-e2e-freeze-'
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

test.beforeAll(async () => {
  await cleanupProjects()
  projDir = fs.mkdtempSync(path.join(os.tmpdir(), NAME_PREFIX))
  projName = path.basename(projDir)
  fs.writeFileSync(path.join(projDir, 'README.md'), 'freeze probe\n')
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
  try { fs.rmSync(projDir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('右键冻结→尾部分区计数出现→搜索穿透命中→解冻恢复原分组', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  const card = page.locator('.project-card').filter({ hasText: projName }).first()
  await expect(card).toBeVisible({ timeout: 5000 })

  // 右键菜单出「冻结」（与重新定位同菜单位）
  await card.click({ button: 'right' })
  const freezeItem = page.locator('.n-dropdown-option').filter({ hasText: '冻结' })
  await expect(freezeItem).toBeVisible({ timeout: 3000 })
  await freezeItem.click()

  // 冻结后卡片折入尾部分区：默认折叠为一行计数，主网格不再出现该卡
  await expect(card).toHaveCount(0, { timeout: 5000 })
  const frozenSection = page.locator('.frozen-section')
  await expect(frozenSection).toBeVisible({ timeout: 5000 })
  await expect(frozenSection.locator('.frozen-count')).toHaveText('1')

  // API 侧冻结布尔已落（透传面）
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const proj = ((list?.data || []) as { id: string; name: string; frozen: boolean }[])
    .find(p => p.name === projName)
  expect(proj?.frozen).toBe(true)

  // 展开尾部分区：弱化卡可见
  await frozenSection.locator('.frozen-toggle').click()
  const frozenCard = page.locator('.project-card-frozen').filter({ hasText: projName })
  await expect(frozenCard).toBeVisible({ timeout: 3000 })

  // 搜索穿透冻结区：命中照常显示（收起态下搜索自动展开）
  const searchInput = page.locator('.toolbar-search-input input').first()
  await searchInput.fill(projName)
  await expect(frozenCard).toBeVisible({ timeout: 3000 })
  await searchInput.fill('')

  // 解冻：右键冻结卡 → 「解冻」→ 恢复原分组，尾部分区消失
  await frozenCard.click({ button: 'right' })
  const unfreezeItem = page.locator('.n-dropdown-option').filter({ hasText: '解冻' })
  await expect(unfreezeItem).toBeVisible({ timeout: 3000 })
  await unfreezeItem.click()

  await expect(page.locator('.frozen-section')).toHaveCount(0, { timeout: 5000 })
  await expect(card).toBeVisible({ timeout: 5000 })
  await expect(card.locator('.project-card-frozen')).toHaveCount(0)
})

test('冻结状态持久化：API 冻结后刷新仍折入尾部分区，解冻恢复', async ({ page }) => {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/frozen`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ frozen: true }),
  })
  expect(res.status).toBe(200)

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const frozenSection = page.locator('.frozen-section')
  await expect(frozenSection.locator('.frozen-count')).toHaveText('1', { timeout: 5000 })

  // 刷新后仍在（服务端持久化，非前端内存态）
  await page.reload()
  await waitForAppReady(page)
  await expect(frozenSection.locator('.frozen-count')).toHaveText('1', { timeout: 10000 })

  // API 解冻 → 刷新 → 恢复主网格
  await fetch(`${API_BASE}/api/projects/${projectId}/frozen`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ frozen: false }),
  })
  await page.reload()
  await waitForAppReady(page)
  await expect(page.locator('.frozen-section')).toHaveCount(0, { timeout: 10000 })
  const card = page.locator('.project-card').filter({ hasText: projName }).first()
  await expect(card).toBeVisible({ timeout: 5000 })
})
