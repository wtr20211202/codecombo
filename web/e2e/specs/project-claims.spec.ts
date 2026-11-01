import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 跨实例同目录双开检测 E2E（P-20261003-3）：
 * claim 文件锚定在项目 .git/codecombo/project-claims/（P-20261025-1 标识切换后
 * 新命名空间，server/claims claims.go claimRelDir；两个实例对同一目录唯一必然
 * 共享的锚点，各实例数据目录互不可见），spec 直接在自备 fixture 仓库内造他实例
 * claim——与服务端扫描读的是同一份物理文件，跨数据目录/跨挂载路径语义天然成立：
 *   1. 预置他实例存活 claim → 添加项目 → 服务端即时 claim（本实例文件落位）
 *      + 冲突入账通知中心（titleKey=system.dualOpen.conflict.title + msgParams）
 *   2. 移除项目 → 本实例 claim 即时清理，他实例文件不动
 *   3. 崩溃残留（updatedAt 超 staleness）扫描跳过，不误报
 * 通知经共享实例 API 断言与清理，fixture 仓库在用例内自生自灭
 */

const TITLE_KEY = 'system.dualOpen.conflict.title'
const CONFLICT_TITLE = '检测到项目被其他实例同时打开'
const PEER_ID = 'e2e-peer-instance'
const PEER_PORT = 59998
// P-20261025-1：claim 写入锚点已是 codecombo/ 新命名空间（服务端写恒落新目录，
// 扫描对新旧取并集）——fixture 读写都跟新目录对齐
const CLAIM_DIR_REL = path.join('.git', 'codecombo', 'project-claims')

const createdProjects: { name: string; repo: string }[] = []

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

interface NotificationItem {
  titleKey?: string
  body?: string
  msgParams?: { project?: string; port?: number }
}

async function notificationsByProject(
  headers: Record<string, string>,
  projectName: string,
): Promise<NotificationItem[]> {
  const res = await fetch(`${API_BASE}/api/notifications`, { headers })
  const list = ((await res.json()) as { data?: NotificationItem[] }).data || []
  return list.filter(n => n.titleKey === TITLE_KEY && n.msgParams?.project === projectName)
}

async function waitConflictCount(
  headers: Record<string, string>,
  projectName: string,
  timeoutMs = 8000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const n = await notificationsByProject(headers, projectName)
    if (n.length > 0 || Date.now() > deadline) return n.length
    await new Promise(resolve => setTimeout(resolve, 400))
  }
}

// makeRepo 自备 fixture 仓库（同 editor-save 先例）+ 预置他实例 claim；
// age 给残留场景造过期 updatedAt
function makeRepo(name: string, ageMs = 0): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `sc-claims-${name}-`))
  execSync('git init -q', { cwd: repo })
  const claimDir = path.join(repo, CLAIM_DIR_REL)
  fs.mkdirSync(claimDir, { recursive: true })
  const ts = new Date(Date.now() - ageMs).toISOString()
  fs.writeFileSync(
    path.join(claimDir, `${PEER_ID}.json`),
    JSON.stringify({ instanceId: PEER_ID, port: PEER_PORT, startedAt: ts, updatedAt: ts }),
  )
  return repo
}

async function addProject(headers: Record<string, string>, name: string, repo: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST',
    headers,
    // 注册路径按服务端形态交接（跨拓扑经 /mnt/c 同见同一物理目录，claim
    // 文件锚定语义才成立）；测试侧 fs 断言继续用 repo 原形态
    body: JSON.stringify({ name, path: serverPath(repo) }),
  })
  expect(res.ok).toBeTruthy()
  const project = ((await res.json()) as { data?: { id?: string } }).data
  createdProjects.push({ name, repo })
  return project?.id || ''
}

async function removeProject(headers: Record<string, string>, id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/projects/${id}`, { method: 'DELETE', headers })
  expect(res.ok).toBeTruthy()
}

function myClaimFile(repo: string): string[] {
  const dir = path.join(repo, CLAIM_DIR_REL)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== `${PEER_ID}.json`)
}

async function waitMyClaim(repo: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (myClaimFile(repo).length > 0) return true
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  // 项目与 fixture 仓库清理（ID 用后即删；残留按名兜底）
  const res = await fetch(`${API_BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: Array<{ id?: string; name?: string }> }).data || []
  for (const p of list) {
    if (p.name?.startsWith('E2E双开')) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  for (const { repo } of createdProjects) {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('他实例存活 claim → 添加项目即检测：本实例 claim 落位 + 通知中心入账', async ({ page }) => {
  test.setTimeout(60000)
  const headers = await unlockHeaders()
  const repo = makeRepo('conflict')
  const id = await addProject(headers, 'E2E双开项目', repo)

  // 服务端即时 claim：本实例文件与对端文件共存同一锚点目录
  expect(await waitMyClaim(repo)).toBe(true)
  const peerSurvived = fs.existsSync(path.join(repo, CLAIM_DIR_REL, `${PEER_ID}.json`))
  expect(peerSurvived).toBe(true)

  // 冲突入账：titleKey + msgParams（对端端口）+ 语言中立明细原文
  expect(await waitConflictCount(headers, 'E2E双开项目')).toBe(1)
  const list = await notificationsByProject(headers, 'E2E双开项目')
  expect(list[0]?.msgParams?.port).toBe(PEER_PORT)
  expect(list[0]?.body).toContain(String(PEER_PORT))

  // 通知中心 UI 行（titleKey 模板按 zh 渲染）
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: 'E2E双开项目' }).first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await expect(
    page.locator('.nc-item:not(.nc-sub)').filter({ hasText: CONFLICT_TITLE }),
  ).toHaveCount(1)

  await removeProject(headers, id)
})

test('移除项目 → 本实例 claim 清理，他实例文件不动', async () => {
  const headers = await unlockHeaders()
  const repo = makeRepo('cleanup')
  const id = await addProject(headers, 'E2E双开清理项目', repo)
  expect(await waitMyClaim(repo)).toBe(true)

  await removeProject(headers, id)
  const deadline = Date.now() + 5000
  while (myClaimFile(repo).length > 0 && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  expect(myClaimFile(repo)).toEqual([])
  expect(fs.existsSync(path.join(repo, CLAIM_DIR_REL, `${PEER_ID}.json`))).toBe(true)
})

test('崩溃残留（过期 updatedAt）不误报', async ({ page }) => {
  test.setTimeout(30000)
  const headers = await unlockHeaders()
  // 10 分钟未续期 = 超 3 分钟 staleness 窗口的崩溃残留
  const repo = makeRepo('stale', 10 * 60_000)
  const id = await addProject(headers, 'E2E双开残留项目', repo)

  // 扫描对残留沉默（给即时补扫与一个扫描周期留出窗口）
  await page.waitForTimeout(2000)
  expect(await notificationsByProject(headers, 'E2E双开残留项目')).toEqual([])

  await removeProject(headers, id)
})
