import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 哨兵命中通知「交给智能体修复」第二动作（P-20261005-150）E2E：
 * 真实后端流播种哨兵命中（规则 echo 标记 → 终端输出命中 → 通知入账），锁定：
 *   1. 通知行渲染第二动作小钮「交给智能体修复」（data-testid
 *      notif-second-action-<id>；主动作 terminal 保持整行点击形态、不加主钮
 *      ——P-140 登记制，「两钮」落地为「整行主动作 + 行内副钮」）；
 *   2. 点副钮 → 拦截 POST /api/terminals：kind=agent、dir=通知归属项目根，
 *      修复上下文（哨兵规则名 + 命中行摘录）随装箱 launchArgs 或——超 500
 *      字节时的设计内主分支（P-20261006-44）——任务文件短引用指令 +
 *      项目根 .sc-task.md 全文（两分支分别断言）；
 *   3. 发起后 docked 管理页打开（P-109 修复链收口语义不变）；
 *   4. 主钮直达仍工作：点通知行（非副钮）→ 重开终端面板直达触发会话
 *      （output-sentinel.spec 主动作契约在本提案改动后零回归）。
 * 规则/通知/项目经共享实例 API 清理；会话清理按基线差集（只删本 spec 新建的）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-sentinel-fix'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-sentinel-fix')
const RULE_NAME = 'e2e 哨兵修复盯标'
const MARK = 'E2ESENTINELFIX'
const HIT_TITLE = `哨兵命中：${RULE_NAME}`
// 与 src/utils/promptFit TASK_FILE_NAME 同值（e2e 不 import src，字面量对齐）
const TASK_FILE_NAME = '.sc-task.md'

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

async function cleanupRule(): Promise<void> {
  const list = await api('GET', '/api/sentinels')
  for (const r of ((list.json?.data || []) as { id: string; name: string }[])) {
    if (r.name === RULE_NAME) await api('DELETE', `/api/sentinels/${r.id}`)
  }
}

/** 服务端已入账的哨兵命中条目数（按存储 Title 精确匹配） */
async function hitCount(): Promise<number> {
  const res = await api('GET', '/api/notifications')
  const list = ((res.json?.data || []) as Array<{ title?: string }>)
  return list.filter(n => n.title === HIT_TITLE).length
}

/** 轮询等待命中入账到目标数（readLoop tap → Notification.Add → WS 广播）；
 *  目标取相对基线（重试重入时上轮遗留条目不误伤断言） */
async function waitHitCount(target: number, timeoutMs = 15000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const n = await hitCount()
    if (n >= target || Date.now() > deadline) return n
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** 整串粘贴命令进终端（output-sentinel.spec 同款） */
async function pasteCommand(page: Page, xterm: ReturnType<Page['locator']>, text: string) {
  await xterm.locator('textarea').evaluate((el, t) => {
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: { getData: () => t } })
    el.dispatchEvent(ev)
  }, text)
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) await api('DELETE', `/api/projects/${oldProj.id}`)
  await cleanupRule()
  await api('POST', '/api/notifications/clear')
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
  // 规则播种（global 作用域：项目会话命中；warning 级别默认通知样式）
  const rule = await api('POST', '/api/sentinels', { name: RULE_NAME, pattern: MARK, scope: 'global', level: 'warning' })
  expect([200, 201]).toContain(rule.status)
})

let baselineSessionIds: string[] = []

test.afterAll(async () => {
  await cleanupRule()
  await api('POST', '/api/notifications/clear')
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
  // 会话清理按基线差集：只删本 spec 新建的（修复会话 + 触发用 shell 会话）
  const before = new Set(baselineSessionIds)
  const res = await api('GET', '/api/terminals')
  for (const s of ((res.json?.data || []) as { id: string }[])) {
    if (!before.has(s.id)) await api('DELETE', `/api/terminals/${s.id}`)
  }
})

test('哨兵命中通知：第二动作小钮发起修复会话（launchArgs 含规则名+命中行+项目根），主动作直达零回归', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto(`${BASE}/`)
  await waitForAppReady(page)
  await unlockIfNeeded(page)

  // 进入目标项目（修复会话 cwd 取该项目根）并开一个项目终端做触发源
  await projectCardByName(page, PROJ_NAME).first().click()
  await page.waitForURL('**/project')
  const projList = await api('GET', '/api/projects')
  const mineProj = ((projList.json?.data || []) as { name: string; id: string; path: string }[]).find(p => p.name === PROJ_NAME)
  const projPath = mineProj?.path || ''
  const projId = mineProj?.id || ''
  expect(projPath).toBeTruthy()
  expect(projId).toBeTruthy()
  const termList = await api('GET', '/api/terminals')
  baselineSessionIds = ((termList.json?.data || []) as { id: string }[]).map(s => s.id)

  // 底部终端面板：rail 打开（面板可能已由 uiState 恢复为展开态，幂等处理）→
  // 新建终端 → 等 shell 提示符（平台分支同 output-sentinel）。开面板用有界
  // 重试：bootstrap 的布局恢复（restoreLayoutOnly）与 rail 点击存在竞态——
  // 恢复后到者胜会把刚点开的面板翻回关闭态，单击可能被吞（实测 flake 一例），
  // 循环点击直至可见。xterm 取值圈定在底部面板内：playwright 重试重入时上一
  // 轮的 docked 修复会话视图仍在渲染 xterm，全局 last 会误取
  const panel = page.locator('.bottom-panel')
  for (let i = 0; i < 5; i++) {
    if (await panel.isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="终端"]').click()
    await page.waitForTimeout(600)
  }
  await expect(panel).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: '新建终端' }).first().click()
  const xterm = panel.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText(/[$#] |PS /, { timeout: 20000 })

  // 触发哨兵命中：命令 echo end-<MARK> 把 pattern 放在行尾——首命中摘录取的
  // 是「命中时点滑窗内的行内容」，PTY 回显分帧若切在 pattern 之后、行尾之前
  // （实测会出现，见 output-sentinel 的整串粘贴注记），行尾仍会在后续帧的
  // 文本会被切掉；pattern 收尾则命中时点行必已完整，摘录确定性
  const base = await hitCount()
  await xterm.click()
  await pasteCommand(page, xterm, `echo end-${MARK}`)
  await page.keyboard.press('Enter')
  expect(await waitHitCount(base + 1)).toBe(base + 1)

  // 关掉底部终端面板制造「跳转前不可见」基线（通知中心蒙层会拦面板点击）
  await page.locator('.bottom-actions button[title="关闭"]').click()
  await expect(panel).toBeHidden({ timeout: 5000 })

  // 通知中心出现命中条目，行内第二动作小钮可见（入口可发现）
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const row = page.locator('.nc-item').filter({ hasText: RULE_NAME }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  await expect(row).toContainText(`end-${MARK}`)
  const fixBtn = row.locator('.nc-second-action', { hasText: '交给智能体修复' })
  await expect(fixBtn).toBeVisible()

  // 点副钮 → 拦截创建请求：kind=agent、dir=项目根，修复上下文（规则名+命中行）
  // 随 launchArgs（装箱面）或全文 .sc-task.md（P-20261006-44 超限降级面）送达——
  // 哨兵链 output=触发会话完整 scrollback，几乎必然超 500 字节走任务文件降级，
  // 短引用指令是设计内主分支（首跑实测即是），装箱截断为兼容分支一并锁定
  const reqPromise = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await fixBtn.click()
  const req = await reqPromise
  const body = req.postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind, '请求体 kind=agent').toBe('agent')
  expect(body.dir, '修复会话 cwd=通知归属项目根').toBe(projPath)
  const launchArgs = body.launchArgs ?? ''
  if (launchArgs.includes(TASK_FILE_NAME)) {
    // 降级分支：短引用指令发起，全文（含规则行/命中行/会话输出）落项目根 .sc-task.md
    const file = await api('GET', `/api/projects/${projId}/file?path=${TASK_FILE_NAME}`)
    expect(file.status, '任务文件已落项目根').toBe(200)
    const doc = String(file.json?.data ?? '')
    for (const part of [RULE_NAME, `end-${MARK}`]) {
      expect(doc, `任务文件含「${part}」`).toContain(part)
    }
  } else {
    for (const part of [RULE_NAME, `end-${MARK}`]) {
      expect(launchArgs, `launchArgs 含「${part}」`).toContain(part)
    }
  }

  // docked 管理页打开（修复链收口：创建 → 激活 → 打开）
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1, { timeout: 15000 })

  // 主钮直达仍工作：重开通知中心，点行（非副钮）→ 终端面板重开直达触发会话。
  // xterm 断言圈定在底部面板内——此刻 docked 修复会话视图也在渲染 xterm，
  // 全局 last 会误取（修复会话 prompt 同样含标记，断言会假阳）
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const row2 = page.locator('.nc-item').filter({ hasText: RULE_NAME }).first()
  await row2.click()
  await expect(panel).toBeVisible({ timeout: 5000 })
  const jumped = panel.locator('.xterm:visible').last()
  await expect(jumped).toContainText(MARK, { timeout: 5000 })
})
