import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverIsRemote, serverPath } from '../../tests/dualpath'

/**
 * 笔记单库化存量迁移 E2E（P-20261108-3）：「旧数据面 + 新二进制」——旧版本留下的项目
 * 作用域笔记（notes-multi 时代 <projectID>-<noteID> 文档）在新版本上并入项目无关的
 * 笔记库，标题带「[项目名] 」前缀、内容逐字不丢：
 *   - 「注入旧数据」：服务端无写项目作用域笔记的 API（端点已退役），经数据面直写
 *     <dataDir>/data/notesmulti/<projectId>-<uuid>.json（filestore Get/List 每次读盘
 *     无缓存，运行中写入即时可见——audit-archive / approval-timeout 同机制）
 *   - 只读计数 GET /api/notes/migration 如实回报滞留；笔记视图顶部续迁横幅出现，
 *     点「继续迁移」= POST 续迁（与启动期同一实现）→ 横幅消失、清单出现「[项目名] 原
 *     标题」、内容逐字一致、源文档清除
 * 数据面目录探测（audit-archive 同款反转）：先经 API 建一篇笔记，再在候选目录
 * （SC_E2E_DATA_DIR → .e2e-data/full-<port> → .e2e-data）里找这份刚落盘的文档——
 * 命中者即活动数据面，防陈旧候选目录误选。启动期自动迁移与满额中止/幂等/降级窗口
 * 矩阵由 Go 单测覆盖（store/notesmigrate_test.go、api/project/notesmigrate_test.go）
 */

// 数据面直写依赖测试侧可见的服务端数据面：跨拓扑（WSL 服务端）结构性不可达——环境门控
test.skip(serverIsRemote, '笔记文档直写依赖测试侧可见的服务端数据面，跨拓扑不可达——仅同机拓扑')

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const REPO = path.join(os.tmpdir(), 'sc-e2e-notes-migration')
const PROJ = 'e2e-notes-migration'
const LEGACY_TITLE = '旧项目交接'
const LEGACY_CONTENT = '# 旧版本项目笔记\n\n- 待办：迁移后仍可见\n- 决策：内容逐字不丢\n'

let headers: Record<string, string> = { 'Content-Type': 'application/json' }
let projId = ''

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

interface NoteMeta { id: string; title: string }

async function globalList(trash = false): Promise<NoteMeta[]> {
  const res = await fetch(`${API_BASE}/api/notes${trash ? '?trash=1' : ''}`, { headers })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data?: NoteMeta[] }).data ?? []
}

async function purgeAllGlobal(): Promise<void> {
  for (const view of [await globalList(), await globalList(true)]) {
    for (const n of view) {
      await fetch(`${API_BASE}/api/notes/${n.id}?purge=1`, { method: 'DELETE', headers })
    }
  }
}

/** 数据面根候选（按序列举；SC_E2E_DATA_DIR 由 e2e-restart 注入时最优先） */
function dataDirCandidates(): string[] {
  const port = new URL(API_BASE).port || '80'
  const dirs: string[] = []
  if (process.env.SC_E2E_DATA_DIR) dirs.push(path.resolve(repoRoot, process.env.SC_E2E_DATA_DIR))
  dirs.push(path.join(repoRoot, '.e2e-data', `full-${port}`))
  dirs.push(path.join(repoRoot, '.e2e-data'))
  return dirs
}

/** 经 API 建一篇探针笔记，按其落盘文档（data/notesmulti/_global-<id>.json）定位活动数据面 */
async function probeLiveDataDir(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/notes`, {
    method: 'POST', headers, body: JSON.stringify({ title: 'probe', content: 'probe' }),
  })
  expect(res.status).toBe(201)
  const id = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  try {
    for (const dir of dataDirCandidates()) {
      if (fs.existsSync(path.join(dir, 'data', 'notesmulti', `_global-${id}.json`))) return dir
    }
  } finally {
    await fetch(`${API_BASE}/api/notes/${id}?purge=1`, { method: 'DELETE', headers })
  }
  throw new Error(`live data dir not found, tried: ${dataDirCandidates().join(', ')}`)
}

test.beforeAll(async () => {
  headers = await unlockHeaders()
  const stale = (await (await fetch(`${API_BASE}/api/projects`, { headers })).json()) as { data?: { id: string; name: string }[] }
  for (const p of stale.data ?? []) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO })
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO) }),
  })
  expect([200, 201]).toContain(res.status)
  projId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projId).not.toBe('')
})

test.afterAll(async () => {
  headers = await unlockHeaders()
  await purgeAllGlobal()
  if (projId) await fetch(`${API_BASE}/api/projects/${projId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('旧项目笔记（旧数据面）→ 续迁横幅 → 并入笔记库带「[项目名]」前缀且内容不丢', async ({ page }) => {
  await purgeAllGlobal()
  const dataDir = await probeLiveDataDir()

  // 旧数据面：项目作用域篇（P-20261107-2 notes-multi 时代的文档形态，字段与
  // server/store/notesmulti.go MultiNote 同形）
  const noteId = randomUUID()
  const sourceFile = path.join(dataDir, 'data', 'notesmulti', `${projId}-${noteId}.json`)
  const at = new Date(Date.now() - 3600_000).toISOString()
  fs.writeFileSync(sourceFile, JSON.stringify({
    id: noteId, title: LEGACY_TITLE, content: LEGACY_CONTENT, createdAt: at, updatedAt: at,
  }))

  // 只读计数如实回报（GET 零写盘：源文档仍在）
  const st = await (await fetch(`${API_BASE}/api/notes/migration`, { headers })).json() as { data?: { pending?: number; full?: boolean } }
  expect(st.data?.pending ?? 0).toBeGreaterThanOrEqual(1)
  expect(st.data?.full).toBe(false)
  expect(fs.existsSync(sourceFile)).toBe(true)

  // 首页笔记 overlay：续迁横幅出现 → 继续迁移
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('[data-testid="home-notes"]').click()
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toBeVisible({ timeout: 8000 })
  const panel = overlay.locator('[data-testid="notes-panel"]')
  const banner = panel.locator('[data-testid="notes-migration-banner"]')
  await expect(banner).toBeVisible({ timeout: 8000 })
  await banner.locator('[data-testid="notes-migration-resume"]').click()
  await expect(banner).toBeHidden({ timeout: 8000 })

  // 清单出现「[项目名] 原标题」篇，点开内容逐字一致
  const migratedTitle = `[${PROJ}] ${LEGACY_TITLE}`
  const item = panel.locator('[data-testid="notes-list-item"]').filter({ hasText: migratedTitle })
  await expect(item).toHaveCount(1, { timeout: 8000 })
  await item.click()
  await expect(panel.locator('[data-testid="notes-editor"]')).toHaveValue(LEGACY_CONTENT, { timeout: 8000 })

  // API 侧：迁入篇在册、内容逐字一致；源文档清除、滞留计数归零
  const hit = (await globalList()).find(n => n.title === migratedTitle)
  expect(hit).toBeTruthy()
  const full = await (await fetch(`${API_BASE}/api/notes/${hit!.id}`, { headers })).json() as { data?: { content?: string } }
  expect(full.data?.content).toBe(LEGACY_CONTENT)
  expect(fs.existsSync(sourceFile)).toBe(false)
  const after = await (await fetch(`${API_BASE}/api/notes/migration`, { headers })).json() as { data?: { pending?: number } }
  expect(after.data?.pending).toBe(0)
})
