import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 分享创建前敏感文件扫描（P-20261001-26）E2E：
 * 服务端创建分享时做文件名级敏感扫描，命中即拦截（响应仅 warnings 不创建），
 * 前端弹警示框列出命中文件，「仍然分享」后才带 override 二次请求真正创建：
 *   1. API：目录分享命中 → 拦截 + warnings 清单；override 后创建成功；
 *      干净目标直接创建（warnings 空）
 *   2. UI：文件树右键分享 → 警示框出现 → 取消不创建 → 仍要分享出结果卡
 * 夹具：spec 自建临时项目（含 .env / config/id_rsa / config/cert.pem），
 * 落在系统临时目录（仓库外——worktree 内的 .sc-tmp 被 gitignore，会让文件
 * 树默认隐藏 ignored 条目）；本地路径交服务端时经 serverPath() 包裹
 * （跨拓扑口径）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-share-sensitive-scan'
let FIXTURE_DIR = ''

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

async function getProjectId(): Promise<string> {
  const { json } = await api('GET', '/api/projects')
  const p = ((json?.data || []) as { id: string; name: string }[]).find(x => x.name === PROJ_NAME)
  if (!p) throw new Error(`project ${PROJ_NAME} not found`)
  return p.id
}

/** 清空全部分享（服务端全局状态，保证确定性） */
async function cleanupShares(): Promise<void> {
  const { json } = await api('GET', '/api/share')
  const list = ((json?.data || []) as { token: string }[])
  for (const s of list) await api('DELETE', `/api/share/${s.token}`)
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await unlockRes.json()) as { token?: string }).token || ''

  // 上轮残留清理（同名项目先删，幂等）
  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) await api('DELETE', `/api/projects/${oldProj.id}`)
  FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-share-sensitive-scan-'))
  const writeFile = (rel: string, content: string) => {
    const p = path.join(FIXTURE_DIR, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  writeFile('.env', 'API_KEY=secret-1111')
  writeFile('config/id_rsa', 'fake-private-key')
  writeFile('config/cert.pem', 'fake-cert')
  writeFile('notes/readme.md', '# clean dir')
  // 注册项目：路径交给服务端一律 serverPath 折算（跨拓扑口径）
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(FIXTURE_DIR) })
  expect([200, 201]).toContain(proj.status)
  await cleanupShares()
})

test.afterAll(async () => {
  await cleanupShares()
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

test('API：命中敏感文件拦截创建（warnings 清单）→ override 创建成功；干净目录直接创建', async () => {
  const projectId = await getProjectId()

  // 项目根分享：命中 .env / config/id_rsa / config/cert.pem → 拦截（响应无 data）
  const blocked = await api('POST', '/api/share', { projectId, path: '' })
  expect(blocked.status).toBe(200)
  expect(blocked.json?.data).toBeUndefined()
  expect(blocked.json?.warnings).toEqual(['.env', 'config/cert.pem', 'config/id_rsa'])
  expect(blocked.json?.scanTruncated).toBe(false)

  // 列表确认为空：拦截路径没有落库
  const emptyList = await api('GET', '/api/share')
  expect(((emptyList.json?.data || []) as unknown[]).length).toBe(0)

  // override 二次请求：真正创建，响应仍附 warnings 供展示
  const created = await api('POST', '/api/share', { projectId, path: '', override: true })
  expect(created.status).toBe(200)
  expect(created.json?.data?.token).toBeTruthy()
  expect(created.json?.warnings).toEqual(['.env', 'config/cert.pem', 'config/id_rsa'])

  // 幂等语义不受影响：同目标再分享（override）恒同一 token
  const again = await api('POST', '/api/share', { projectId, path: '', override: true })
  expect(again.json?.data?.token).toBe(created.json?.data?.token)

  // 干净目录：无警告直接创建（warnings 为空数组）
  const clean = await api('POST', '/api/share', { projectId, path: 'notes' })
  expect(clean.status).toBe(200)
  expect(clean.json?.data?.token).toBeTruthy()
  expect(clean.json?.warnings).toEqual([])

  // 单文件分享 .env 本身：命中报文件名，拦截；override 后成功
  const envBlocked = await api('POST', '/api/share', { projectId, path: '.env' })
  expect(envBlocked.json?.data).toBeUndefined()
  expect(envBlocked.json?.warnings).toEqual(['.env'])
  const envCreated = await api('POST', '/api/share', { projectId, path: '.env', override: true })
  expect(envCreated.json?.data?.token).toBeTruthy()
})

/**
 * 等待文件树出现目标行：进项目后 uiState 异步恢复可能把侧栏覆写成
 * 「Git 管理」等其他面板（与文件面板点击存在竞态）——轮询期间必要时
 * 重新点开文件面板（aria-expanded=false 才点，防把已打开的面板点关）
 */
async function waitForTreeRow(page: Page, name: string) {
  const row = page.locator('.tree-item').filter({ hasText: name }).first()
  const railFiles = page.locator('[data-testid="rail-files"]')
  const deadline = Date.now() + 15000
  for (;;) {
    if (await row.isVisible().catch(() => false)) return
    if (Date.now() > deadline) break
    const expanded = await railFiles.getAttribute('aria-expanded').catch(() => null)
    if (expanded !== 'true') await railFiles.click().catch(() => { /* 未挂载重试 */ })
    await page.waitForTimeout(400)
  }
  await expect(row).toBeVisible()
}

test('UI：文件树右键分享 → 警示框列出命中 → 取消不创建 → 仍要分享出结果卡', async ({ page }) => {
  // 清空分享（前一条 API 用例会留下 3 条）：「取消不创建」断言需要确定前置
  await cleanupShares()
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const projectCard = page.locator('.project-card').filter({ hasText: PROJ_NAME }).first()
  await projectCard.click()
  await page.waitForURL('**/project')
  await waitForTreeRow(page, 'config')

  // 右键 config 目录（默认隐藏点文件，.env 不在树上；config 内含 id_rsa/cert.pem）
  // P-20261003-320 起先弹创建弹层选模式，live 默认直接确认
  const configRow = page.locator('.tree-item').filter({ hasText: 'config' }).first()
  await expect(configRow).toBeVisible()
  await configRow.click({ button: 'right' })
  await expect(page.locator('.n-dropdown-menu')).toBeVisible()
  await page.locator('.n-dropdown-menu').getByText('生成分享链接', { exact: true }).click()
  const createModal = page.locator('.share-create-modal')
  await expect(createModal).toBeVisible()
  await createModal.locator('[data-testid="share-create-confirm"]').click()

  // 警示框：命中文件按分享根内相对路径列出（相对 config，无 .env 本身）
  const dialog = page.locator('.n-dialog').filter({ hasText: '发现疑似敏感文件' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('cert.pem')
  await expect(dialog).toContainText('id_rsa')
  await expect(dialog).toContainText('仍然分享')

  // 取消：不创建——无结果卡、分享列表仍为空
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('.share-result-modal')).toHaveCount(0)
  const listAfterCancel = await api('GET', '/api/share')
  expect(((listAfterCancel.json?.data || []) as unknown[]).length).toBe(0)

  // 再分享并确认「仍然分享」：override 二次请求 → 结果卡短链
  await configRow.click({ button: 'right' })
  await expect(page.locator('.n-dropdown-menu')).toBeVisible()
  await page.locator('.n-dropdown-menu').getByText('生成分享链接', { exact: true }).click()
  const createModal2 = page.locator('.share-create-modal')
  await expect(createModal2).toBeVisible()
  await createModal2.locator('[data-testid="share-create-confirm"]').click()
  const dialog2 = page.locator('.n-dialog').filter({ hasText: '发现疑似敏感文件' })
  await expect(dialog2).toBeVisible()
  await dialog2.getByRole('button', { name: '仍然分享' }).click()

  const modal = page.locator('.share-result-modal')
  await expect(modal).toBeVisible()
  const link = await modal.locator('input').inputValue()
  expect(link).toMatch(/\/s\/[0-9a-z]{16}$/)
})
