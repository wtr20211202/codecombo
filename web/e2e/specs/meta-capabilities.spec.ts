import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 能力探测端点 /api/meta（P-20261004-4）E2E：
 *   1. meta 公开只读（免 token 先例同 /api/help）：返回版本与已注册能力项
 *      （去重有序、含全部已投用能力家族）
 *   2. 前端探测分流不破坏 Quick Open 快路径：进入项目 Ctrl+P 时先发
 *      GET /api/meta 探测，声明 flat-file-list 后文件清单照常命中——
 *      loadPaletteFiles 的 hasCap 分流与 /file-list 快路径端到端贯通
 *
 * 「capability 未注册时 helper false」属 store 纯逻辑，由 vitest 单测覆盖
 * （web/src/__tests__/stores/meta.test.ts）：e2e 无法触达页面内 Pinia 实例。
 */

const PROJ_NAME = 'e2e-meta-capabilities'
const MARKER_FILE = 'meta-capability-marker.md'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-meta-capabilities')
// 已投用能力项（与 server/app/modules.go 的 manifest 声明一一对应）。笔记族
// P-20261108-3 单库化后只剩 notes-global（项目族 notes/notes-multi 随端点退役下线）
const REGISTERED_CAPS = ['ahead-behind-all', 'fetch-all', 'file-history', 'flat-file-list', 'notes-global']
const RETIRED_CAPS = ['notes', 'notes-multi']

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) await api('DELETE', `/api/projects/${oldProj.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, MARKER_FILE), `# ${PROJ_NAME}\n`)
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
})

test.afterAll(async () => {
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

test('meta 公开只读：免 token 返回版本与已注册能力清单', async () => {
  // 不带 X-Lock-Token：公开端点不依赖锁状态（ops-manual / api/help 免 token 先例）
  const res = await fetch(API_BASE + '/api/meta')
  expect(res.status).toBe(200)
  const body = await res.json()

  // 版本载荷：构建信息 + 内核契约版本均非空
  expect(typeof body.version?.version).toBe('string')
  expect(body.version.version.length).toBeGreaterThan(0)
  expect(typeof body.version?.apiVersion).toBe('string')
  expect(body.version.apiVersion.length).toBeGreaterThan(0)

  // 能力清单：数组、去重有序、含全部已投用能力家族
  const caps: string[] = body.capabilities
  expect(Array.isArray(caps)).toBe(true)
  expect(new Set(caps).size).toBe(caps.length)
  expect([...caps].sort()).toEqual(caps)
  for (const cap of REGISTERED_CAPS) {
    expect(caps).toContain(cap)
  }
  // 已退役能力项不再声明（对端探测不到即按缺席降级——单库化 mixed-version 约定）
  for (const cap of RETIRED_CAPS) {
    expect(caps).not.toContain(cap)
  }
})

test('前端探测分流：进入项目即发 /api/meta 探测，Ctrl+P 快路径文件清单照常命中', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  // 监听先于导航注册：项目页挂载期 ahead/behind 徽章链与 Ctrl+P 链都会消费
  // ensureCaps，探测请求只发一次（store 缓存），任一先到即证明探测链贯通
  const metaRequest = page.waitForRequest(req => req.url().includes('/api/meta'), { timeout: 30000 })
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await page.locator('.header-project-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: PROJ_NAME }).first().click()

  // 探测请求已发出（store 按实例缓存，后续消费不再重发）
  const meta = await (await metaRequest).response()
  expect(meta?.status()).toBe(200)

  // hasCap(flat-file-list)=true → file-list 单请求快路径，文件清单照常命中
  await page.keyboard.press('Control+p')
  const paletteInput = page.locator('.palette-input input')
  await expect(paletteInput).toBeVisible({ timeout: 5000 })
  await paletteInput.fill(MARKER_FILE)
  const item = page.locator('.palette-item').filter({ hasText: MARKER_FILE }).first()
  await expect(item).toBeVisible({ timeout: 10000 })
})
