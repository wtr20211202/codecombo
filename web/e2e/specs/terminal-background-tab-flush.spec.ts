import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 后台终端 tab 输出解析暂停（P-20261004-46）E2E：
 * tab 全部 v-show 常驻挂载，隐藏 pane 的输出帧不再直写 xterm（解析渲染暂停），
 * 入有界延迟队列；OSC 数据链（未读点亮等）照常；激活时一次性重放落屏。
 *
 * 断言链（后台 tab 输出 → 激活 → 内容完整的用户可见契约）：
 * 1. 隐藏 pane 收到输出：未读点点亮——写入管线的会话级记账不因门控断流；
 * 2. 激活 tab → 积压帧完整上屏（首/中/尾标记齐全；flush 断裂时标记永不
 *    上屏必红）；
 * 3. 可见 pane 直写不延迟（回归基线）；再隐藏再激活的二次队列循环可用。
 *
 * 隐藏期「未写入」本身不在 e2e 断言（xterm v6 对 display:none pane 不更新行
 * DOM，DOM 侧无法区分「延迟未写」与「直写后未渲染」；解析暂停由队列单测与
 * 写路径收口保证）。
 *
 * 输出驱动走 broadcast-write（用户令牌，写入 PTY 输入由 shell echo 产生真实
 * 输出，全链路经 WS → 写入路径；terminal-unread-dot 同款）。
 */

const TS = Date.now()
const NAME_A = 'bgflush-shell-a'
const NAME_B = 'bgflush-shell-b'
const FIRST = `sc-bg-first-${TS}`
const MID = `sc-bg-mid-${TS}`
const LAST = `sc-bg-last-${TS}`
const VIS = `sc-bg-vis-${TS}`
const SECOND = `sc-bg-second-${TS}`

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

interface SessionRow { id: string; kind?: string; projectId?: string; name?: string }

async function listSessions(request: APIRequestContext): Promise<SessionRow[]> {
  const headers = await unlockHeaders()
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const body = await res.json() as { data?: SessionRow[] }
  return body.data || []
}

/** 向指定会话写入一段 PTY 输入（尾部 \r 执行） */
async function writeInput(request: APIRequestContext, id: string, data: string): Promise<void> {
  const headers = await unlockHeaders()
  const res = await request.post(`${API_BASE}/api/terminals/broadcast-write`, {
    headers,
    data: { ids: [id], data },
  })
  expect(res.ok()).toBeTruthy()
}

async function openProject(page: Page, request: APIRequestContext): Promise<string> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  const headers = await unlockHeaders()
  const plist = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  const proj = ((plist?.data || []) as { id: string; name: string }[]).find(x => x.name === 'simple-coding')
  if (!proj) throw new Error('simple-coding project not seeded')
  return proj.id
}

test('后台 tab 输出激活后完整上屏，未读链路与可见直写不回退', async ({ page, request }) => {
  test.setTimeout(150000)
  const projId = await openProject(page, request)
  const headers = await unlockHeaders()

  // 归一化前置：清掉同名遗留（spec 可重复入跑）
  for (const s of await listSessions(request)) {
    if (s.kind === 'shell' && (s.name === NAME_A || s.name === NAME_B)) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
  }

  // 归一化：底部终端面板可见
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }

  // 预置两个 shell 会话（terminals.changed 对账自动追加 tab 并自行连接）
  await request.post(`${API_BASE}/api/terminals`, { headers, data: { projectId: projId, name: NAME_A } })
  await request.post(`${API_BASE}/api/terminals`, { headers, data: { projectId: projId, name: NAME_B } })
  const tabA = page.locator('.term-tab').filter({ hasText: NAME_A })
  const tabB = page.locator('.term-tab').filter({ hasText: NAME_B })
  await expect(tabA).toBeVisible({ timeout: 10000 })
  await expect(tabB).toBeVisible({ timeout: 10000 })
  const sessions = (await listSessions(request)).filter(s => s.projectId === projId && s.kind === 'shell')
  const idA = sessions.find(s => s.name === NAME_A)?.id
  if (!idA) throw new Error(`${NAME_A} not found`)

  // 等两会话 WS 建立完毕（xterm 挂载 + 连接中 loading 全退场），再越过未读点亮闸
  // 的附着稳定窗（R 哨兵 +1.2s）——此后输出才参与点亮
  await expect.poll(async () => {
    const screens = await page.locator('.xterm-screen').count()
    const loading = await page.locator('.term-pane-loading').count()
    return screens >= 2 && loading === 0
  }, { timeout: 20000 }).toBe(true)
  await page.waitForTimeout(1700)

  // 激活 b：a 成为后台 tab（v-show 隐藏、pane 常驻）
  await tabB.click()
  await expect(tabB).toHaveClass(/is-active/)

  // 隐藏期向 a 写入三段标记输出（echo 全 shell 通用；输入回显含标记不影响断言）
  await writeInput(request, idA, `echo ${FIRST}\r`)
  await writeInput(request, idA, `echo ${MID}\r`)
  await writeInput(request, idA, `echo ${LAST}\r`)

  // 隐藏期写入管线存活：未读点在后台 tab a 上点亮（会话级记账在段循环即时做，
  // 不随写入延迟积压）
  await expect(tabA.locator('[data-testid="term-tab-unread"]')).toBeVisible({ timeout: 10000 })
  await page.waitForTimeout(800)

  // 激活 a：积压帧一次性重放，首/中/尾标记完整上屏（无丢字节）
  await tabA.click()
  await expect(tabA).toHaveClass(/is-active/)
  const activeXterm = page.locator('.xterm:visible').last()
  await expect(activeXterm).toContainText(FIRST, { timeout: 10000 })
  await expect(activeXterm).toContainText(MID)
  await expect(activeXterm).toContainText(LAST)
  // 激活即清未读点（既有语义回归）
  await expect(tabA.locator('[data-testid="term-tab-unread"]')).toHaveCount(0)

  // 可见 pane 直写不延迟：激活会话自身输出即时上屏（回归基线）
  await writeInput(request, idA, `echo ${VIS}\r`)
  await expect(activeXterm).toContainText(VIS, { timeout: 10000 })

  // 二次队列循环：再隐藏 → 再输出 → 再激活（队列/flush 可重入）
  await tabB.click()
  await expect(tabB).toHaveClass(/is-active/)
  await writeInput(request, idA, `echo ${SECOND}\r`)
  await expect(tabA.locator('[data-testid="term-tab-unread"]')).toBeVisible({ timeout: 10000 })
  await tabA.click()
  await expect(tabA).toHaveClass(/is-active/)
  await expect(page.locator('.xterm:visible').last()).toContainText(SECOND, { timeout: 10000 })
})
