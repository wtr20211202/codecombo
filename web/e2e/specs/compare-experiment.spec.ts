import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 对比实验（P-20261003-46 + P-20261004-72 落盘二阶段）E2E：
 *   1. 服务端契约：POST /compare-experiments 双开（runtime=shell 纯终端，不拉
 *      智能体进程）→ 详情按各侧 startHead 快照面产出并集三分类（分目录夹具
 *      dirA/dirB 造出 仅A/仅B，同目录夹具全部落 双方）
 *   2. 完成链状态迁移：ops-notify task.progress done/failed（terminalId 归属）
 *      → 单侧回执仍 running → 双侧齐备翻 ready；experiment.changed 广播
 *      即时对账（P-20261004-33，面板开着徽标秒翻，与 5s 轮询节拍错开断言）
 *   3. 采用标注持久：adopt b → 记录持有 + 面板徽标（重开面板仍在）
 *   4. 采用落盘二阶段：adopt {side, mode:apply} 一键收尾——B 独有 tracked 回滚
 *      到基线 / untracked 删除（字节备份）、A 侧保留、side 仓 status 干净、
 *      applies/patch 备份可查、快照在案
 *   5. UI：agent 管理页头部入口开面板 → 详情三态徽标 → 点文件开 diff → 采用
 *      → 落盘入口与确认弹窗（取消不执行）
 *
 * 仅A/仅B 的归属分类正确性由 Go 单测（ClassifyCompareFiles/planApplyRows）钉死；
 * 本 spec 在真实服务进程上验证端到端数据面（元数据异步落库 → 详情轮询等待）
 * 与 UI 闭环。落盘测试放最后（会回滚 side 仓夹具），不污染前序断言。
 * afterAll 清理项目/实验/夹具；beforeEach/afterEach 清空会话表防残留计数污染。
 */

const REPO_MAIN = path.join(os.tmpdir(), 'sc-e2e-compare-main')
const REPO_SIDE = path.join(os.tmpdir(), 'sc-e2e-compare-side')
const PROJ = 'e2e-compare-experiment'
const F_A = 'alpha-compare.ts' // 仅 A 侧：主仓 tracked 改动 + untracked
const F_A_NEW = 'alpha-new.ts'
const F_B = 'beta-compare.ts' // 仅 B 侧：side 仓 tracked 改动 + untracked
const F_B_NEW = 'beta-new.ts' // 仅 B 侧 untracked（apply 走删除路径）
const B_BASELINE = 'export const b = 1\n'
const PROMPT = 'e2e compare experiment prompt'

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部终端会话（双开会话是真 PTY，残留会污染后续计数断言） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 清空对比实验记录（用例间隔离） */
async function cleanupExperiments(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/compare-experiments`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const e of list) {
    await request.delete(`${API_BASE}/api/compare-experiments/${e.id}`, { headers })
  }
}

interface ExpSide {
  sessionId: string
  runtime?: string
  result?: string
}
interface ExpFileRow {
  path: string
  inA: boolean
  inB: boolean
}
interface ExpDetail {
  experiment: { id: string; status: string; adopted?: string; a: ExpSide; b: ExpSide }
  files: ExpFileRow[]
}

async function getExperiment(request: APIRequestContext, id: string): Promise<ExpDetail | null> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/compare-experiments/${id}`, { headers })
  if (res.status() !== 200) return null
  const body = (await res.json()) as { data?: ExpDetail }
  return body.data || null
}

/** 模拟某侧完成回执（ops-notify 需解锁 token；观察者同步消费，返回即已落位） */
async function reportDone(request: APIRequestContext, terminalId: string, status = 'done'): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'task.progress', payload: { task: 'e2e', status, terminalId } },
  })
  expect(res.ok()).toBeTruthy()
}

/** 双开发起（runtime=shell：真会话纯终端，不与 TUI 交互） */
async function launchExperiment(
  request: APIRequestContext,
  dirs: { dir?: string; dirA?: string; dirB?: string },
): Promise<ExpDetail['experiment']> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${API_BASE}/api/compare-experiments`, {
    headers,
    data: { prompt: PROMPT, runtimeA: 'shell', runtimeB: 'shell', ...dirs },
  })
  expect(res.status()).toBe(201)
  const body = (await res.json()) as { data?: ExpDetail['experiment'] }
  const exp = body.data
  expect(exp?.id).toBeTruthy()
  return exp!
}

/** 等会话元数据异步落库（startHead 捕获在建会话后 goroutine 补记）→ 三分类就绪 */
async function waitForFiles(request: APIRequestContext, id: string, min: number): Promise<ExpDetail> {
  let last: ExpDetail | null = null
  await expect.poll(async () => {
    last = await getExperiment(request, id)
    return last?.files.length ?? 0
  }, { timeout: 20000, intervals: [500, 1000, 2000] }).toBeGreaterThanOrEqual(min)
  return last!
}

let projectId = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  await cleanupExperiments(request)
  for (const d of [REPO_MAIN, REPO_SIDE]) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  // 主仓：基线提交后 tracked 改动 + untracked 新文件（A 侧产出夹具）
  fs.mkdirSync(REPO_MAIN, { recursive: true })
  git(REPO_MAIN, ['init'])
  git(REPO_MAIN, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(REPO_MAIN, F_A), 'export const a = 1\n')
  git(REPO_MAIN, ['add', '.'])
  git(REPO_MAIN, ['commit', '-m', 'baseline'])
  fs.writeFileSync(path.join(REPO_MAIN, F_A), 'export const a = 2 // side a\n')
  fs.writeFileSync(path.join(REPO_MAIN, F_A_NEW), 'export const an = 1\n')
  // side 仓：独立目录另一份改动（B 侧产出夹具——分目录造「仅 B」）
  fs.mkdirSync(REPO_SIDE, { recursive: true })
  git(REPO_SIDE, ['init'])
  git(REPO_SIDE, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(REPO_SIDE, F_B), B_BASELINE)
  git(REPO_SIDE, ['add', '.'])
  git(REPO_SIDE, ['commit', '-m', 'baseline'])
  fs.writeFileSync(path.join(REPO_SIDE, F_B), 'export const b = 2 // side b\n')
  fs.writeFileSync(path.join(REPO_SIDE, F_B_NEW), 'export const bn = 1\n')

  // 项目夹具（UI 入口要进项目页打开 agent 管理页）
  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_MAIN) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const token = headers['X-Lock-Token']
  await cleanupExperiments(request)
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_MAIN, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  try { fs.rmSync(REPO_SIDE, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupExperiments(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test('服务端契约：双开 → 分目录三分类 → 完成链状态迁移 → 采用持久', async ({ request }) => {
  // 双开：A 侧主仓 / B 侧 side 仓（分目录竞写形态）
  const exp = await launchExperiment(request, { dir: serverPath(REPO_MAIN), dirB: serverPath(REPO_SIDE) })
  expect(exp.status).toBe('running')
  expect(exp.a.sessionId).not.toBe(exp.b.sessionId)

  // 三分类（分目录基线错开）：A 仓两文件仅 A、B 仓一文件仅 B
  const detail = await waitForFiles(request, exp.id, 3)
  const byPath = new Map(detail.files.map(f => [f.path, f]))
  expect(byPath.get(F_A)).toMatchObject({ inA: true, inB: false })
  expect(byPath.get(F_A_NEW)).toMatchObject({ inA: true, inB: false })
  expect(byPath.get(F_B)).toMatchObject({ inA: false, inB: true })

  // 单文件 diff：基线 vs 侧产出（A 侧 untracked 走合成 new-file diff）
  const headers = await unlockHeaders(request)
  const diff = await request.get(
    `${API_BASE}/api/compare-experiments/${exp.id}/filediff?side=b&file=${encodeURIComponent(F_B)}`,
    { headers },
  )
  expect(diff.status()).toBe(200)
  expect(await diff.text()).toContain('-export const b = 1')

  // 完成链：单侧回执仍 running；双侧齐备翻 ready
  await reportDone(request, exp.a.sessionId)
  const afterA = await getExperiment(request, exp.id)
  expect(afterA?.experiment.a.result).toBe('done')
  expect(afterA?.experiment.status).toBe('running')
  await reportDone(request, exp.b.sessionId)
  const afterB = await getExperiment(request, exp.id)
  expect(afterB?.experiment.status).toBe('ready')

  // 采用标注持久 + 非法侧别拒绝
  const adopt = await request.post(`${API_BASE}/api/compare-experiments/${exp.id}/adopt`, {
    headers, data: { side: 'b' },
  })
  expect(adopt.ok()).toBeTruthy()
  const adopted = await getExperiment(request, exp.id)
  expect(adopted?.experiment.adopted).toBe('b')
  const badAdopt = await request.post(`${API_BASE}/api/compare-experiments/${exp.id}/adopt`, {
    headers, data: { side: 'z' },
  })
  expect(badAdopt.status()).toBe(400)
})

test('事件即时对账（P-20261004-33）：面板开着回执落位 → experiment.changed 广播秒翻徽标', async ({ page, request }) => {
  const exp = await launchExperiment(request, { dir: serverPath(REPO_MAIN), dirB: serverPath(REPO_SIDE) })
  await waitForFiles(request, exp.id, 3)

  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('[data-testid="agent-compare-entry"]').click()
  const panel = page.locator('[data-testid="compare-experiment-panel"]')
  await expect(panel).toBeVisible({ timeout: 5000 })

  // 选中 running 实验：双侧「等待回执」基线态
  const item = panel.locator('[data-testid="compare-experiment-item"]').filter({ hasText: PROMPT })
  await expect(item).toBeVisible({ timeout: 8000 })
  await item.click()
  const sideA = panel.locator('[data-testid="compare-side-a"]')
  const sideB = panel.locator('[data-testid="compare-side-b"]')
  await expect(sideA.locator('.ced-state')).toContainText('等待回执', { timeout: 8000 })
  await expect(sideB.locator('.ced-state')).toContainText('等待回执')

  // 先等一轮 5s 轮询完整落地（等响应而非请求：在途轮询的旧态响应不再可能
  // 晚于事件刷新到达），让后续断言窗口与轮询节拍错开——3s 断言窗内轮询不可
  // 能再触发，徽标翻转只能是 experiment.changed 事件路径（纯轮询兜底要等
  // 下一个 5s 周期）
  await page.waitForResponse(
    r => r.request().method() === 'GET' && new URL(r.url()).pathname === `/api/compare-experiments/${exp.id}`,
    { timeout: 10000 },
  )

  // 回执落位（观察者同步消费 + 落库先于广播）：事件到达 → 即时重拉对账
  await reportDone(request, exp.a.sessionId)
  await expect(sideA.locator('.ced-state')).toContainText('已完成', { timeout: 3000 })
  await reportDone(request, exp.b.sessionId)
  await expect(sideB.locator('.ced-state')).toContainText('已完成', { timeout: 3000 })
  // 双侧齐备翻 ready：列表行状态点随 refreshList 同步翻转（同一事件的列表对账）
  await expect(item.locator('.cep-dot.ready')).toBeVisible({ timeout: 3000 })
})

test('UI：管理页头部入口 → 面板详情三态徽标 → diff → 采用徽标重开仍在', async ({ page, request }) => {
  const exp = await launchExperiment(request, { dir: serverPath(REPO_MAIN), dirB: serverPath(REPO_SIDE) })
  await waitForFiles(request, exp.id, 3)
  // 双侧都报完成：面板直接呈现 ready + 双「已完成」
  await reportDone(request, exp.a.sessionId)
  await reportDone(request, exp.b.sessionId)

  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })

  // 头部入口开面板
  await view.locator('[data-testid="agent-compare-entry"]').click()
  const panel = page.locator('[data-testid="compare-experiment-panel"]')
  await expect(panel).toBeVisible({ timeout: 5000 })

  // 列表行 + 详情三态徽标
  const item = panel.locator('[data-testid="compare-experiment-item"]')
  await expect(item.filter({ hasText: PROMPT })).toBeVisible({ timeout: 8000 })
  await item.filter({ hasText: PROMPT }).click()
  await expect(panel.locator('[data-testid="compare-side-a"]')).toContainText('已完成', { timeout: 8000 })
  await expect(panel.locator('[data-testid="compare-side-b"]')).toContainText('已完成')

  // 三态徽标：仅 A / 仅 B（分目录夹具）；点击文件行开 diff
  await panel.locator(`[data-testid="compare-file-${F_A}"]`).click()
  await expect(panel.locator('.ced-diff-head')).toContainText(F_A)
  await expect(panel.locator('.diff-line').first()).toBeVisible({ timeout: 8000 })

  // 采用 B → 徽标现身；重开面板仍在（标注在服务端持久）
  const sideB = panel.locator('[data-testid="compare-side-b"]')
  await sideB.locator('[data-testid="compare-adopt"]').click()
  await expect(sideB.locator('.ced-adopted-badge')).toContainText('B', { timeout: 8000 })
  const adopted = await getExperiment(request, exp.id)
  expect(adopted?.experiment.adopted).toBe('b')

  // 落盘入口可发现：已标注侧出现「落盘到工作区」→ 确认弹窗预告动作面 →
  // 取消不执行（工作区保持原状，失败可恢复出口）
  await expect(panel.locator('[data-testid="compare-apply"]')).toBeVisible({ timeout: 5000 })
  await panel.locator('[data-testid="compare-apply"]').click()
  const applyDlg = page.locator('.n-dialog').filter({ hasText: '落盘' })
  await expect(applyDlg).toBeVisible({ timeout: 5000 })
  await applyDlg.locator('button').filter({ hasText: '取消' }).click()
  await expect(applyDlg).not.toBeVisible({ timeout: 5000 })
  const afterCancel = await getExperiment(request, exp.id)
  expect(afterCancel?.experiment.adopted).toBe('b')
  expect(git(REPO_SIDE, ['status', '--porcelain'])).not.toBe('')

  await page.keyboard.press('Escape')
  await expect(panel).not.toBeVisible({ timeout: 5000 })
  await view.locator('[data-testid="agent-compare-entry"]').click()
  await expect(panel.locator('[data-testid="compare-side-b"] .ced-adopted-badge')).toBeVisible({ timeout: 8000 })
})

test('采用落盘二阶段：adopt A apply → B 独有消失 A 保留 status 干净 → 备份可查', async ({ request }) => {
  // 分目录夹具（仅 A / 仅 B 的唯一形态；「同目录双开改不同文件」在同目录视图
  // 下全落「双方」→ apply 按语义只注记，破坏性回滚必须分目录）
  const exp = await launchExperiment(request, { dir: serverPath(REPO_MAIN), dirB: serverPath(REPO_SIDE) })
  const detail = await waitForFiles(request, exp.id, 4)
  const byPath = new Map(detail.files.map(f => [f.path, f]))
  expect(byPath.get(F_A)?.inA).toBe(true)
  expect(byPath.get(F_B)?.inB).toBe(true)
  expect(byPath.get(F_B_NEW)?.inB).toBe(true)
  await reportDone(request, exp.a.sessionId)
  await reportDone(request, exp.b.sessionId)

  // 一键落盘：标注 + 快照 + 执行单请求完成
  const headers = await unlockHeaders(request)
  const apply = await request.post(`${API_BASE}/api/compare-experiments/${exp.id}/adopt`, {
    headers, data: { side: 'a', mode: 'apply' },
  })
  expect(apply.status()).toBe(200)
  const applied = ((await apply.json()) as { data?: { applied?: { kept: number; rolledBack: number; deleted: number; backupId: string } } }).data?.applied
  expect(applied).toMatchObject({ kept: 2, rolledBack: 1, deleted: 1 })
  expect(applied?.backupId).toBeTruthy()

  // B 独有消失：side 仓回到基线（tracked 还原 + untracked 删除），status 干净
  expect(git(REPO_SIDE, ['status', '--porcelain'])).toBe('')
  expect(fs.readFileSync(path.join(REPO_SIDE, F_B), 'utf8')).toBe(B_BASELINE)
  expect(fs.existsSync(path.join(REPO_SIDE, F_B_NEW))).toBe(false)
  // A 保留：主仓两处产出原样
  const mainStatus = git(REPO_MAIN, ['status', '--porcelain'])
  expect(mainStatus).toContain(F_A)
  expect(mainStatus).toContain(F_A_NEW)

  // 备份可查：列表 + 单条还原补丁（含被删 untracked 字节）
  const list = await request.get(`${API_BASE}/api/compare-experiments/${exp.id}/applies`, { headers })
  expect(list.status()).toBe(200)
  const records = ((await list.json()) as { data?: { id: string; rolledBack: number; deleted: number }[] }).data || []
  expect(records).toHaveLength(1)
  expect(records[0]).toMatchObject({ rolledBack: 1, deleted: 1 })
  const patch = await request.get(`${API_BASE}/api/compare-experiments/${exp.id}/applies/${records[0]!.id}/patch`, { headers })
  expect(patch.status()).toBe(200)
  const backup = (await patch.json()) as { data?: { patch: string; untracked?: Record<string, string> } }
  expect(backup.data?.patch).toContain(`diff --git a/${F_B} b/${F_B}`)
  // untracked 字节 JSON 落形为 base64（Go []byte 通道，二进制安全）
  expect(Buffer.from(backup.data?.untracked?.[F_B_NEW] || '', 'base64').toString('utf8')).toBe('export const bn = 1\n')

  // 快照在案（annotate/apply 响应增量形状）+ 未结算拒绝先于破坏
  const adopted = await getExperiment(request, exp.id)
  expect(adopted?.experiment.adopted).toBe('a')
  expect(adopted?.experiment.applySnapshot?.side).toBe('a')
})

test('表单校验：空 prompt 拦截不发请求', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })
  await page.locator('[data-testid="agent-compare-entry"]').click()
  const panel = page.locator('[data-testid="compare-experiment-panel"]')
  await expect(panel).toBeVisible({ timeout: 5000 })

  // prompt 留空直接点发起：前端拦截（组合式 launch 守卫），不产生 POST
  const reqPromise = page.waitForRequest(r => r.url().includes('/api/compare-experiments') && r.method() === 'POST', { timeout: 3000 })
  await panel.locator('[data-testid="compare-launch"]').click()
  let fired = false
  await reqPromise.then(() => { fired = true }).catch(() => { /* 未发请求即预期 */ })
  expect(fired).toBe(false)
})
