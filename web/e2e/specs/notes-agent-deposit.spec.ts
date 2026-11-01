import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 项目笔记「结论沉淀」E2E（P-20261003-292）：任务终态结论写回人机共享笔记层。
 *   1. agent 写回路径（ops 手册 projnotes 节「结论沉淀约定」的 API 回路）：
 *      先有人写交接 → agent 按约定 GET 读现笔记 → 末尾追加「## <日期> <任务简称>」
 *      一节（结果/做了什么/关键决定/遗留项 3~5 行）→ PUT 整份写回 →
 *      GET 断言原文保留 + 追加节在位（last-writer-wins 下读改写回路不丢内容）
 *   2. 前端助力入口：agent 会话 task.progress 上报终态 done → 悬浮球出现
 *      「沉淀到笔记」次级入口 → 点击后预填模板经 PUT 落盘 + 笔记面板自动打开
 *      （agent 忘约定时人一键补），API 侧可读到追加节。
 * 播种方式对齐 project-notes.spec（自备临时仓库）/ monitor-task-stale.spec
 * （API 造会话 + ops-notify 真实 WS 链路）；afterAll 清项目/会话/uiState。
 */

const BASE = API_BASE
const REPO = path.join(os.tmpdir(), 'sc-e2e-notes-deposit')
const PROJ = 'e2e-notes-deposit'
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

async function apiGetNotes(headers: Record<string, string>, pid: string): Promise<string> {
  const res = await fetch(`${BASE}/api/projects/${pid}/notes`, { headers })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data?: { content?: string } }
  return body.data?.content ?? ''
}

async function apiPutNotes(headers: Record<string, string>, pid: string, content: string): Promise<number> {
  const res = await fetch(`${BASE}/api/projects/${pid}/notes`, {
    method: 'PUT', headers, body: JSON.stringify({ content }),
  })
  return res.status
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

test('agent 写回路径：读现笔记 → 追加「## 日期 任务」节 → PUT 整份写回 → 原文保留且节在位', async () => {
  const headers = await unlockHeaders()

  // 先有人写的交接说明（共享层既有内容）
  expect(await apiPutNotes(headers, projId, HUMAN_NOTE)).toBe(200)

  // agent 按手册「结论沉淀约定」回写：GET 读 → markdown 追加一节 → PUT 整份
  const existing = await apiGetNotes(headers, projId)
  expect(existing).toContain('迁移错误码')
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
  expect(await apiPutNotes(headers, projId, `${existing.trimEnd()}\n\n${section}`)).toBe(200)

  // 回读：原文保留（整份写回不丢内容）+ 追加节在位
  const after = await apiGetNotes(headers, projId)
  expect(after).toContain('决策：旧形态增量兼容')
  expect(after).toContain(`## ${ymd} e2e 沉淀任务`)
  expect(after).toContain('- 关键决定：旧形态增量兼容')
  expect(after.indexOf('交接说明')).toBeLessThan(after.indexOf('e2e 沉淀任务'))
})

test('前端助力入口：终态后悬浮球「沉淀到笔记」一键补写，笔记面板自动打开', async ({ page }) => {
  const headers = await unlockHeaders()
  await fixedLocale(page)

  // 播种侧栏收起基线（uiState 服务端持久，跨 spec 残留不定态；CLAUDE.md
  // 「uiState 播种时机：种子须在无项目页存活时写入」惯例）：页面加载前把
  // showSidePanel/sideView 写成「侧栏关」，boot 恢复落点即种子值——否则
  // 前序 spec 留下的布局在恢复流（偶发迟至点击后）落地时会把 revealNotesPanel
  // 刚打开的笔记面板翻回文件视图（实测面板 8s 内从未挂载、快照停在文件树）。
  // GET+合并整键 PATCH：layout 是顶层键整体替换，裸发两字段会把面板宽高等
  // 既有布局抹成默认。恢复与种子同值 = 迟到落地幂等无害，「面板自动打开」
  // 语义完整保留（deposit 前面板确为关，reveal 的 showSidePanel=true 真开）
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

  // 等 boot 恢复落地（种子=侧栏收起；恢复收起面板后本页不再有迟到翻转源）：
  // uiState 恢复偶发迟至点击后落地（负载下恢复 GET 慢），会把 revealNotesPanel
  // 刚打开的笔记面板翻回前序布局（实测快照停在文件视图）。上限 8s：种子未
  // 生效（无记录等场景恢复值本就是开）时不收起，超时后照常存款（同旧行为）
  await page
    .waitForFunction(
      () => {
        const side = document.querySelector('#side-panel')
        return !side || side.getBoundingClientRect().height === 0
      },
      undefined,
      { timeout: 8000 },
    )
    .catch(() => { /* 恢复未收起侧栏：无迟到翻转源，照常存款 */ })

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

  // 落盘反馈 toast + 笔记面板自动打开（预填模板已 PUT，人可编辑补充）
  await expect(page.locator('.n-message').filter({ hasText: '已写入项目笔记' })).toBeVisible({ timeout: 8000 })
  const panel = page.locator('[data-testid="notes-panel"]')
  await expect(panel).toBeVisible({ timeout: 8000 })
  // textarea 的内容在 value 而非 textContent——断言走 toHaveValue
  const editor = panel.locator('[data-testid="notes-editor"]')
  await expect(editor).toHaveValue(/交接说明/, { timeout: 8000 })
  await expect(editor).toHaveValue(/## \d{4}-\d{2}-\d{2} e2e 沉淀任务/)
  await expect(editor).toHaveValue(/- 结果：已完成/)
  await expect(editor).toHaveValue(/- 遗留项：/)

  // API 侧可读到一键补写的追加节（前序用例的沉淀节也被整份写回保留）
  await expect.poll(() => apiGetNotes(headers, projId), { timeout: 8000 })
    .toContain('e2e 沉淀任务')
  const persisted = await apiGetNotes(headers, projId)
  expect(persisted).toContain('e2e 沉淀任务')
  expect(persisted.split('e2e 沉淀任务').length - 1).toBeGreaterThanOrEqual(2)
})
