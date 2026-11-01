import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 敏感文件工作台外写入观测 E2E（P-20261005-15）：
 *   - 自环过滤：工作台 API 写入敏感文件（创建/编辑器保存语义）不产生
 *     project.file.external——file.selfwrite 标记先行，watcher 只记真外部
 *   - 外部进程改写 .env（spec 进程直接写盘，即 server 进程之外的真外部）→
 *     通知中心出现 action=file 条目 + 审计入账 project.file.external
 *   - 节流：60s 窗口内同路径外部改动只记一条
 *   - 审计 Detail 只含项目名 + 相对路径，绝不含文件内容
 *   - 通知条目点击直达编辑器打开该文件
 * .env 全程不经 API 种子首写（由外部进程创建），与自环标记窗口无交互；
 * 自备临时仓库，afterAll 清理（path-traversal 范式）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-extwrite')
const PROJ = 'e2e-extwrite'
const EVIL_MARK = 'EXTWRITE_E2E_MARK'

let projectId = ''

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

// 审计台账里的 project.file.external 事件
async function externalEvents(headers: Record<string, string>) {
  const res = await fetch(`${API_BASE}/api/audit?limit=500&offset=0`, { headers })
  expect(res.ok).toBeTruthy()
  const body = (await res.json()) as { data?: { action: string; detail?: string }[] }
  return (body.data || []).filter(e => e.action === 'project.file.external')
}

// 通知中心清单里的 file 动作条目（P-20261005-15 观测形态）；按本项目 id 收窄
//（台账持久化跨运行，重跑残留的旧项目同名条目不作数）
async function fileNotifications(headers: Record<string, string>, pid: string) {
  const res = await fetch(`${API_BASE}/api/notifications`, { headers })
  expect(res.ok).toBeTruthy()
  const body = (await res.json()) as { data?: { id?: string; action?: string; actionPayload?: string; type?: string; projectId?: string }[] }
  return (body.data || []).filter(n => n.action === 'file' && n.actionPayload === '.env' && n.projectId === pid)
}

async function waitFor<T>(fn: () => Promise<T[]>, timeoutMs: number): Promise<T[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const out = await fn()
    if (out.length > 0) return out
    if (Date.now() > deadline) return out
    await new Promise(r => setTimeout(r, 500))
  }
}

// .env 的外部写入审计条目计数（delta 断言的基线口径：台账持久化跨 spec 运行，
// 重跑/复用 .e2e-data 会残留旧条目，断言一律用增量不用绝对值）
async function envExternalCount(headers: Record<string, string>): Promise<number> {
  return (await externalEvents(headers)).filter(e => (e.detail || '').includes('.env')).length
}

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders()
  const stale = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'external write observation e2e\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: extwrite 基线'])

  const created = await request.post(`${API_BASE}/api/projects`, {
    headers, data: { name: PROJ, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  expect(created.status()).toBeLessThan(300)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')

  // 清场上轮运行残留的 file 动作通知（台账持久化跨运行）：同形条目（title/
  // body/projectName 全同——项目同名重建）会被通知中心并组（×N 组行点击是
  // 展开不是激活，实测让测 2 行点击落空），悬挂 projectId 的旧条目点击还会
  // 因 switchProject 失败弃动作。只留本轮项目的新鲜条目，行点击才确定性命中
  const staleNotes = await (await request.get(`${API_BASE}/api/notifications`, { headers })).json()
  for (const n of ((staleNotes?.data || []) as { id?: string; action?: string; projectId?: string }[])) {
    if (n.action === 'file' && n.projectId !== projectId) {
      await request.post(`${API_BASE}/api/notifications/dismiss/${n.id}`, { headers })
    }
  }

  // watcher 递归挂监听以秒计（WatchAll 注记），留出建立窗口再驱动事件
  await new Promise(r => setTimeout(r, 2000))

  // 自环面：工作台 API 写敏感文件（创建 + 编辑器保存两语义都过一遍）——
  // file.selfwrite 标记先行，随后的 fsnotify 事件不得入账
  const create = await request.post(`${API_BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path: '.env', content: 'SELF=1\n' },
  })
  expect(create.status()).toBeLessThan(300)
  const save = await request.put(`${API_BASE}/api/projects/${projectId}/file`, {
    headers, data: { path: '.env', content: 'SELF=2\n' },
  })
  expect(save.status()).toBeLessThan(300)
  // 等待须越过自环标记 TTL（selfWriteTTL=5s，external.go）：紧随其后的外部写
  // 若落在标记窗口内会被自环过滤吞记（e2e 首轮实测 0 条的根因之一），6s+窗口
  // 余量让真外部写必然绕开自环判定
  await new Promise(r => setTimeout(r, 6500))
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders()
  if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('API：自环零记账 + 外部写入入账通知与审计 + Detail 不含内容 + 窗口节流', async ({ request }) => {
  const headers = await unlockHeaders()
  const before = await envExternalCount(headers)

  // 外部进程改写（spec 进程直接写盘 = server 进程之外的真实边界语义）
  fs.writeFileSync(path.join(REPO_DIR, '.env'), `${EVIL_MARK}=1\n`)

  // 通知中心条目：action=file，payload=.env，warning 级，携项目归属
  const notes = await waitFor(() => fileNotifications(headers, projectId), 20000)
  expect(notes.length, '外部写入应产生一条 file 动作通知').toBeGreaterThanOrEqual(1)
  expect(notes[0].type).toBe('warning')
  expect(notes[0].projectId).toBe(projectId)

  // 审计入账：恰 +1（两条 API 自环写零贡献，只有外部写入记账；delta 口径
  // 兼容台账残留——重跑/复用 .e2e-data 不误报）
  await waitFor(async () => {
    const c = await envExternalCount(headers)
    return c > before ? [c] : []
  }, 10000)
  expect(await envExternalCount(headers) - before, 'API 自环写零贡献，外部写恰 +1').toBe(1)
  const mine = (await externalEvents(headers)).filter(e => (e.detail || '').includes('.env'))
  expect(mine[mine.length - 1].detail || '', 'Detail 含项目相对路径').toContain('.env')
  expect(mine[mine.length - 1].detail || '', 'Detail 绝不含文件内容').not.toContain(EVIL_MARK)

  // 节流：60s 窗口内同路径再次外部改动不重复入账
  fs.writeFileSync(path.join(REPO_DIR, '.env'), `${EVIL_MARK}=2\n`)
  await new Promise(r => setTimeout(r, 3000))
  expect(await envExternalCount(headers) - before, '窗口内同路径应去重').toBe(1)
})

test('通知条目点击直达编辑器打开该文件', async ({ page, request }) => {
  test.setTimeout(90000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 解锁后延迟出现的默认密码提醒先收起（遮罩拦点击，notify-copy 同款兜底）
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 通知中心 → 本项目最新 extwrite 条目按行 testid 直点（API 取 id；不经
  // hasText+.first()——同形多条会并组，组行点击语义是展开折叠而非激活，
  // 实测重复运行下必翻；测 1 恰产生一条，beforeAll 又已清场残留）
  const headers = await unlockHeaders()
  const notes = await fileNotifications(headers, projectId)
  expect(notes.length, '本项目应恰有一条 file 动作通知可点').toBeGreaterThanOrEqual(1)
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 5000 })
  const row = page.locator(`[data-testid="notif-row-${notes[0].id}"]`)
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.click()
  await expect(page.locator('.monaco-editor')).toBeVisible({ timeout: 15000 })
})
