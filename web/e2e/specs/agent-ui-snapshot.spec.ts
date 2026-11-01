import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 用户 UI 现场上报与 agent 感知 E2E（P-20261004-52）：ui.snapshot 全链路
 *   1. UI 上报链：浏览器进项目页并经文件深链打开文件定位 200 行 → 上报器
 *      显著变化去抖 2s 落盘 → agent 令牌（sca_）GET 断言 path/line/project
 *      与 visiblePanels 形态
 *   2. 隐私开关关：PUT settings {uiSnapshotEnabled:false} → agent GET 立即
 *      404（code=ui.snapshot_unavailable，存量快照也不可读）→ 翻回开恢复可读
 *   3. 鉴权形态：无令牌 GET 401（组中间件面）；agent 令牌可读亦可 POST
 *   TTL 过期（10 分钟无心跳查无）不做 e2e 等待——store 单测注入时钟覆盖
 *   （server/store/uisnap_test.go）；e2e 数据面为旧格式兼容形态（.e2e-data
 *   复用），新 kind uisnap 首次写入即建档，无迁移面。
 */

const DIR = path.join(os.tmpdir(), 'sc-e2e-ui-snapshot')
const PROJ_NAME = 'ui-snapshot-demo'
const REL = 'deep/target.txt'
const LINE_ANCHOR = 200

function linedFileContent(): string {
  const lines: string[] = ['ui-snapshot target first line']
  for (let i = 2; i <= 260; i++) lines.push(`// pad line ${i}`)
  return lines.join('\n') + '\n'
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''
let agentToken = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const list = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_NAME) await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
  }
  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(path.dirname(path.join(DIR, REL)), { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: DIR })
  fs.writeFileSync(path.join(DIR, REL), linedFileContent())
  git(DIR, ['add', '.'])
  git(DIR, ['commit', '-m', 'root: ui-snapshot 基线'])

  const created = await request.post(`${API_BASE}/api/projects`, {
    headers,
    data: { name: PROJ_NAME, path: serverPath(DIR).replace(/\\/g, '/') },
  })
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  if (!projectId) throw new Error('project registration failed')

  // agent 令牌明文（管理面 reveal，单例播种语义，conflict-agent-resolve 同款）
  const revealed = await request.post(`${API_BASE}/api/agent-token/reveal`, { headers })
  agentToken = ((await revealed.json()) as { data?: { token?: string } }).data?.token || ''
  expect(agentToken.startsWith('sca_'), 'agent token should be sca_ prefixed').toBeTruthy()

  // 开关归一到开（前序运行残留关闭态会让用例 1 全挂；幂等）
  await request.put(`${API_BASE}/api/settings`, { headers, data: { uiSnapshotEnabled: true } })
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  // 开关复位默认档（开），不把关闭态泄漏给后续 spec
  await request.put(`${API_BASE}/api/settings`, { headers, data: { uiSnapshotEnabled: true } }).catch(() => {})
  if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

const agentHeaders = () => ({ 'Content-Type': 'application/json', 'X-Lock-Token': agentToken })

interface SnapView {
  activeProjectId?: string
  activeFile?: { path: string; line: number; column?: number } | null
  visiblePanels?: { side: string; sideOpen: boolean; bottom: string; bottomOpen: boolean }
  activeTerminalSessionId?: string
  updatedAt?: string
  ageSeconds?: number
}

test('UI 上报链：打开文件定位 200 行 → agent 令牌 GET 断言现场', async ({ page, request }) => {
  await fixedLocale(page)
  // 文件深链（?project= 显式带归属项目先切上下文，file-deeplink 同链）打开
  // 200 行：Monaco 光标落位 → 导航信标 → 上报器 2s 去抖落盘
  await gotoAndUnlock(page, `${API_BASE}/project?project=${projectId}&file=${encodeURIComponent(REL)}&line=${LINE_ANCHOR}`)

  // 轮询 agent 读取面（2s 去抖 + Monaco 装载都在窗口内）；陈旧/初始快照
  // （无 activeFile）不误判，直到定位行落进现场
  const deadline = Date.now() + 20_000
  let snap: SnapView | null = null
  for (;;) {
    const res = await request.get(`${API_BASE}/api/ui/snapshot`, { headers: agentHeaders() })
    if (res.status() === 200) {
      const body = (await res.json()) as { data?: SnapView }
      const f = body.data?.activeFile
      if (f?.path === REL && f.line === LINE_ANCHOR) {
        snap = body.data ?? null
        break
      }
    }
    if (Date.now() > deadline) throw new Error('ui snapshot never carried the anchored file location')
    await page.waitForTimeout(500)
  }
  expect(snap?.activeProjectId).toBe(projectId)
  // 面板投影形态断言（值随 uiState 全局态漂移不断言具体开合）
  expect(snap?.visiblePanels && snap.visiblePanels.side.length > 0).toBeTruthy()
  expect(typeof snap?.visiblePanels?.sideOpen).toBe('boolean')
  expect(snap?.visiblePanels && snap.visiblePanels.bottom.length > 0).toBeTruthy()
  expect(typeof snap?.visiblePanels?.bottomOpen).toBe('boolean')
  expect(Number(snap?.ageSeconds)).toBeGreaterThanOrEqual(0)
  expect(snap?.updatedAt).toBeTruthy()
})

test('agent 令牌可读可写（组中间件双令牌面）；写读回环', async ({ request }) => {
  // 注：无令牌 401 由 LockMiddleware 组中间件面承担（lock.spec /
  // router_lock_e2e_test 覆盖）——种子实例锁定关闭时实例本就全开放，
  // 匿名可读是实例级既有态势而非本端点的泄露面，不在此重复断言
  // agent 令牌写路径：POST 覆写最近快照（sca_ 与解锁令牌同组可达）
  const post = await request.post(`${API_BASE}/api/ui/snapshot`, {
    headers: agentHeaders(),
    data: {
      activeProjectId: projectId,
      activeFile: { path: 'agent-wrote.txt', line: 3 },
      visiblePanels: { side: 'files', sideOpen: true, bottom: 'git', bottomOpen: true },
    },
  })
  expect(post.status()).toBe(200)
  const got = await (await request.get(`${API_BASE}/api/ui/snapshot`, { headers: agentHeaders() })).json() as { data?: SnapView }
  expect(got.data?.activeFile?.path).toBe('agent-wrote.txt')
})

test('隐私开关关 → agent GET 立即查无（404 ui.snapshot_unavailable）；翻回开恢复', async ({ page, request }) => {
  // 先确保有一条在报现场（上一用例的 agent 写入即满足；此处浏览器再落一拍
  // 真实 UI 现场，让「存量快照也不可读」断言更有说服力）
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/project?project=${projectId}&file=${encodeURIComponent(REL)}&line=10`)
  const deadline = Date.now() + 20_000
  for (;;) {
    const res = await request.get(`${API_BASE}/api/ui/snapshot`, { headers: agentHeaders() })
    const body = res.status() === 200 ? ((await res.json()) as { data?: SnapView }) : null
    if (body?.data?.activeFile?.path === REL) break
    if (Date.now() > deadline) throw new Error('ui snapshot never carried the reopened file')
    await page.waitForTimeout(500)
  }

  const headers = await unlockHeaders(request)
  await request.put(`${API_BASE}/api/settings`, { headers, data: { uiSnapshotEnabled: false } })

  const off = await request.get(`${API_BASE}/api/ui/snapshot`, { headers: agentHeaders() })
  expect(off.status()).toBe(404)
  const offBody = (await off.json()) as { code?: string }
  expect(offBody.code).toBe('ui.snapshot_unavailable')

  // 翻回开：存量快照仍在 TTL 内，读取即刻恢复（无需等下一次上报）
  await request.put(`${API_BASE}/api/settings`, { headers, data: { uiSnapshotEnabled: true } })
  const on = await request.get(`${API_BASE}/api/ui/snapshot`, { headers: agentHeaders() })
  expect(on.status()).toBe(200)
  const onBody = (await on.json()) as { data?: SnapView }
  expect(onBody.data?.activeFile?.path).toBe(REL)
})
