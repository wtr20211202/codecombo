import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 笔记「结论沉淀」E2E（P-20261003-292 → P-20261108-3 单库化改道）：任务终态结论写回
 * 人机共享笔记库——笔记是项目无关的单库（/api/notes），项目归属靠标题前缀，沉淀落
 * 「[项目名] 交接」**单篇**（找到即追加、没有才新建——不按任务新建篇吃 100 篇额度）。
 *   1. agent 写回路径（ops 手册 notes-global 节「结论沉淀约定」的 API 回路）：
 *      清单按标题找交接篇（没有则 POST 新建）→ GET 读现文 → 末尾追加
 *      「## <日期> <任务简称>」一节 → 携 baseUpdatedAt PUT 整份写回 → 原文保留且节
 *      在位；过期基准 409（不盲目覆盖）
 *   2. 前端助力入口：agent 会话 task.progress 上报终态 done → 悬浮球出现
 *      「沉淀到笔记」→ 点击后追加进同一篇交接篇（不新建第二篇）+ 笔记视图打开并
 *      聚焦该篇，API 侧可读到追加节
 * 播种方式：自备临时仓库与项目 / API 造会话 + ops-notify 真实 WS 链路；afterAll 清
 * 项目/会话/本 spec 交接篇/uiState。
 */

const BASE = API_BASE
const REPO = path.join(os.tmpdir(), 'sc-e2e-notes-deposit')
const PROJ = 'e2e-notes-deposit'
const HANDOVER = `[${PROJ}] 交接`
const HUMAN_NOTE = '# 交接说明\n\n- 待办：迁移错误码\n- 决策：旧形态增量兼容\n'

let projId = ''

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

interface NoteMeta { id: string; title: string }

/** 本 spec 项目的交接篇（标题精确匹配；清单 updatedAt 降序取首个） */
async function handoverNotes(headers: Record<string, string>): Promise<NoteMeta[]> {
  const res = await fetch(`${BASE}/api/notes`, { headers })
  expect(res.status).toBe(200)
  return (((await res.json()) as { data?: NoteMeta[] }).data ?? []).filter(n => n.title === HANDOVER)
}

async function readNote(headers: Record<string, string>, id: string): Promise<{ content: string; updatedAt: string }> {
  const res = await fetch(`${BASE}/api/notes/${id}`, { headers })
  expect(res.status).toBe(200)
  const d = ((await res.json()) as { data?: { content?: string; updatedAt?: string } }).data
  return { content: d?.content ?? '', updatedAt: d?.updatedAt ?? '' }
}

/** 清掉本 spec 的交接篇（在册 + 回收站彻底删除）——确定性起点 */
async function purgeHandover(headers: Record<string, string>): Promise<void> {
  for (const trash of [false, true]) {
    const res = await fetch(`${BASE}/api/notes${trash ? '?trash=1' : ''}`, { headers })
    const list = (((await res.json()) as { data?: NoteMeta[] }).data ?? []).filter(n => n.title === HANDOVER)
    for (const n of list) await fetch(`${BASE}/api/notes/${n.id}?purge=1`, { method: 'DELETE', headers })
  }
}

function makeRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# notes deposit e2e\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: 结论沉淀基线'])
}

/** 清理全部终端会话（服务端全局共享，防残留会话的进度归属混入） */
async function cleanupTerminals(headers: Record<string, string>): Promise<void> {
  const list = await (await fetch(`${BASE}/api/terminals`, { headers })).json()
  for (const s of ((list?.data || []) as { id: string }[])) {
    await fetch(`${BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers })
  }
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [REPO]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  await cleanupTerminals(headers)
  await purgeHandover(headers)
  makeRepo(REPO)
  const res = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO) }),
  })
  expect([200, 201]).toContain(res.status)
  projId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projId).toBeTruthy()
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await cleanupTerminals(headers)
  await purgeHandover(headers)
  const list = await (await fetch(`${BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

test('agent 写回路径：找「[项目名] 交接」→ 没有则新建 → 追加「## 日期 任务」节携基准写回 → 单篇且原文保留', async () => {
  const headers = await unlockHeaders()
  await purgeHandover(headers)

  // 先有人写的交接说明（手册约定：没有交接篇才新建，标题「[项目名] 交接」）
  expect(await handoverNotes(headers)).toHaveLength(0)
  const created = await fetch(`${BASE}/api/notes`, {
    method: 'POST', headers, body: JSON.stringify({ title: HANDOVER, content: HUMAN_NOTE }),
  })
  expect(created.status).toBe(201)

  // agent 按手册「结论沉淀约定」回写：清单按标题找篇 → GET 读 → 追加一节 → PUT 携 baseUpdatedAt
  const [hit] = await handoverNotes(headers)
  expect(hit).toBeTruthy()
  const cur = await readNote(headers, hit!.id)
  expect(cur.content).toContain('迁移错误码')
  const d = new Date()
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const section = [
    `## ${ymd} e2e 沉淀任务`,
    '',
    '- 结果：已完成',
    '- 做了什么：迁移 files 域错误码',
    '- 关键决定：旧形态增量兼容',
    '- 遗留项：其余域渐进迁移',
    '',
  ].join('\n')
  const put = await fetch(`${BASE}/api/notes/${hit!.id}`, {
    method: 'PUT', headers,
    body: JSON.stringify({ content: `${cur.content.trimEnd()}\n\n${section}`, baseUpdatedAt: cur.updatedAt }),
  })
  expect(put.status).toBe(200)

  // 过期基准（期间已被写过）→ 409，不盲目覆盖
  const stale = await fetch(`${BASE}/api/notes/${hit!.id}`, {
    method: 'PUT', headers, body: JSON.stringify({ content: 'stale overwrite', baseUpdatedAt: cur.updatedAt }),
  })
  expect(stale.status).toBe(409)

  // 回读：仍是一篇；原文保留（整份写回不丢内容）+ 追加节在位且在原文之后
  expect(await handoverNotes(headers)).toHaveLength(1)
  const after = (await readNote(headers, hit!.id)).content
  expect(after).toContain('决策：旧形态增量兼容')
  expect(after).toContain(`## ${ymd} e2e 沉淀任务`)
  expect(after).toContain('- 关键决定：旧形态增量兼容')
  expect(after.indexOf('交接说明')).toBeLessThan(after.indexOf('e2e 沉淀任务'))
})

test('前端助力入口：终态后悬浮球「沉淀到笔记」一键追加进同一篇交接篇，笔记视图打开并聚焦', async ({ page }) => {
  const headers = await unlockHeaders()
  await fixedLocale(page)

  // 播种侧栏收起基线（uiState 服务端持久，跨 spec 残留不定态；「uiState 播种时机：
  // 种子须在无项目页存活时写入」惯例）：页面加载前写成「侧栏关」，boot 恢复落点即
  // 种子值——迟到恢复不翻转刚打开的视图。GET+合并整键 PATCH：layout 是顶层键整体
  // 替换，裸发两字段会把面板宽高等既有布局抹成默认
  {
    const stateRes = await fetch(`${BASE}/api/ui-state`, { headers })
    const body = (await stateRes.json().catch(() => null)) as { data?: Record<string, { layout?: Record<string, unknown> }> } | null
    const layout = { ...(body?.data?.local?.layout || {}), showSidePanel: false, sideView: 'files' }
    await fetch(`${BASE}/api/ui-state`, {
      method: 'PATCH', headers, body: JSON.stringify({ local: { layout } }),
    }).catch(() => { /* 尽力播种：失败回退 boot 自身恢复 */ })
  }

  // 悬浮球形态播种（openState 持久化键，挂载时消费恢复）——进项目页后球可见
  await page.addInitScript(() => {
    try {
      localStorage.setItem('sc.agentTerminal.openState', JSON.stringify({ visible: true, mode: 'mini' }))
    } catch { /* ignore */ }
  })
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  const ball = page.locator('.agm-root.is-ball')
  await expect(ball).toBeVisible({ timeout: 8000 })

  // agent 会话 + task.progress 终态上报（真实链路：ops-notify → WS → assistantTask）
  const created = await fetch(`${BASE}/api/terminals`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'agent', name: 'e2e-deposit-agent', runtime: 'shell', dir: serverPath(os.tmpdir()) }),
  })
  expect(created.ok).toBeTruthy() // Node fetch Response.ok 是布尔属性（非 Playwright request 的 .ok() 方法）
  const tlist = await (await fetch(`${BASE}/api/terminals`, { headers })).json()
  const session = ((tlist?.data || []) as { id: string; name: string }[]).find(s => s.name === 'e2e-deposit-agent')
  expect(session).toBeTruthy()
  const reported = await fetch(`${BASE}/api/ops-notify`, {
    method: 'POST', headers,
    body: JSON.stringify({ type: 'task.progress', payload: { task: 'e2e 沉淀任务', status: 'done', terminalId: session!.id } }),
  })
  expect(reported.ok).toBeTruthy()

  // 终态到达 → 球下「沉淀到笔记」药丸出现 → 点击
  const depositBtn = page.locator('[data-testid="agent-notes-deposit"]')
  await expect(depositBtn).toBeVisible({ timeout: 10000 })
  await depositBtn.click()

  // 落盘反馈 toast + 笔记视图打开并聚焦交接篇（会话 cwd 非项目目录 → 归属回落当前项目）
  await expect(page.locator('.n-message').filter({ hasText: '已写入笔记' })).toBeVisible({ timeout: 8000 })
  const panel = page.locator('[data-testid="notes-panel"]')
  await expect(panel).toBeVisible({ timeout: 8000 })
  // textarea 的内容在 value 而非 textContent——断言走 toHaveValue
  const editor = panel.locator('[data-testid="notes-editor"]')
  await expect(editor).toHaveValue(/交接说明/, { timeout: 8000 })
  await expect(editor).toHaveValue(/## \d{4}-\d{2}-\d{2} e2e 沉淀任务/)
  await expect(editor).toHaveValue(/- 结果：已完成/)
  await expect(editor).toHaveValue(/- 遗留项：/)

  // API 侧：仍是同一篇交接篇（find-or-create 不按任务新建），一键补写的追加节在位
  // （前序用例的 agent 写回节也被整份写回保留）
  await expect.poll(async () => {
    const list = await handoverNotes(headers)
    if (list.length !== 1) return -1
    const content = (await readNote(headers, list[0]!.id)).content
    return content.split('e2e 沉淀任务').length - 1
  }, { timeout: 8000 }).toBeGreaterThanOrEqual(2)
})
