import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 直播邀请 watch.invite E2E（P-20261005-165）：
 * 全链路真实验证（agent「请人来看」的 human-pull 原语）：
 *   agent 令牌开直播（POST /api/share/terminal）→ ops-notify 上报 watch.invite
 *   → 真实前端链路（ops-channel WS → 直通分发 sc-ops:watch.invite →
 *   OpsChannelBridge → watchInviteNotify 通知链：url 白名单复验 + 拼访客短链）
 *   → 通知中心条目 → 点击新窗打开访客直播页（xterm 渲染 + 「直播中」标记）。
 * 附：发布口校验面——非法 url 形态（外链/穿越/query）400 拒收不进广播流。
 * 直播/会话/通知经共享实例 API 清理，不残留测试数据
 */

const PROJECT_NAME = 'simple-coding'
const INVITE_TITLE = '直播邀请 · e2e-watch-invite'
const SESSION_NAME = 'e2e-watch-invite-src'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${API_BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJECT_NAME)
  if (!p) throw new Error(`project ${PROJECT_NAME} not found`)
  return p.id
}

/** 开一个普通 shell 终端并回读会话 ID（直播源，与 share-terminal-live 同款） */
async function createTerminal(request: APIRequestContext, headers: Record<string, string>, projectId: string): Promise<string> {
  const res = await request.post(`${API_BASE}/api/terminals`, { headers, data: { projectId, name: SESSION_NAME } })
  expect(res.ok()).toBeTruthy()
  const data = ((await res.json()) as { data?: { id?: string } }).data
  if (!data?.id) throw new Error('terminal id missing')
  return data.id
}

async function cleanup(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  // 撤销全部分享（直播撤销即断流；全局状态保证确定性）
  const shares = await request.get(`${API_BASE}/api/share`, { headers })
  const list = ((await shares.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/share/${s.token}`, { headers })
  }
  // 撤测试终端 + 清通知
  const terms = await request.get(`${API_BASE}/api/terminals`, { headers })
  const sessions = ((await terms.json()) as { data?: Array<{ id?: string; name?: string }> }).data || []
  for (const s of sessions) {
    if (s.name === SESSION_NAME && s.id) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers }).catch(() => {})
    }
  }
  await request.post(`${API_BASE}/api/notifications/clear`, { headers })
}

test.beforeEach(async ({ request }) => {
  await cleanup(request)
})

test.afterEach(async ({ request }) => {
  await cleanup(request)
})

// 服务端已入账的同标题条目数（前端链经 WS → 桥 → POST /notifications 入账）。
// request 是 Playwright test fixture 而非全局——必须由用例参数显式传入
// （首版漏传曾以 ReferenceError 炸在运行期；e2e specs 不在 vue-tsc 类型检查范围，
// 编译期拦不住自由变量）
async function serverCount(request: APIRequestContext, title: string, headers: Record<string, string>): Promise<number> {
  const res = await request.get(`${API_BASE}/api/notifications`, { headers })
  const list = ((await res.json()) as { data?: Array<{ title?: string }> }).data || []
  return list.filter(n => n.title === title).length
}

async function waitServerCount(request: APIRequestContext, title: string, headers: Record<string, string>, timeoutMs = 10000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const n = await serverCount(request, title, headers)
    if (n > 0 || Date.now() > deadline) return n
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

// 进项目页（OpsChannelBridge 随 App 挂载、通知 store WS 建连）：路上留出窗口再播种
async function enterProject(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)
}

test('开直播 + watch.invite → 通知条目 → 点击新窗打开访客直播页（直播中）', async ({ page, context, request }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)

  // ① agent 开直播（真实创建链：token→会话锚点，馈线即刻接通）
  const sessionId = await createTerminal(request, headers, projectId)
  const created = await request.post(`${API_BASE}/api/share/terminal`, { headers, data: { sessionId } })
  expect(created.ok()).toBeTruthy()
  const token = ((await created.json()) as { data?: { token: string } }).data!.token!
  expect(token).toMatch(/^[0-9a-zA-Z]+$/) // 白名单字符集同源（现役派生为 16 位 base36）

  // ② 进项目页建立 WS 后上报 watch.invite（url = 访客短链相对路径）
  await enterProject(page)
  const invited = await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'watch.invite', payload: { url: `/s/${token}`, title: INVITE_TITLE, body: '演示关键步骤' } },
  })
  expect(invited.ok()).toBeTruthy()

  // ③ 通知中心条目入账（前端链：WS → 桥 → watchInviteNotify → POST /notifications）
  expect(await waitServerCount(request, INVITE_TITLE, headers)).toBe(1)
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const row = page.locator('.nc-item').filter({ hasText: INVITE_TITLE }).first()
  await expect(row).toBeVisible({ timeout: 8000 })
  await expect(row).toHaveClass(/clickable/)

  // ④ 点击 → url 动作 set 处直开新窗（noopener 新窗 CDP 不派发 popup 事件，
  // 按 pages 清单轮询——notify-home-bridge 同款探针结论）
  await row.click()
  const deadline = Date.now() + 15000
  let popup: import('@playwright/test').Page | undefined
  while (!popup && Date.now() < deadline) {
    popup = context.pages().find(p => p.url().includes(`/s/${token}`))
    if (!popup) await page.waitForTimeout(250)
  }
  expect(popup, '点击邀请应新窗打开访客直播页').toBeTruthy()
  // 新窗落分享子服务访客短链（watchInviteNotify 拼链：主服务 origin + 独立端口）
  expect(popup!.url()).toContain(`/s/${token}`)

  // ⑤ 访客页是真直播页：xterm 渲染 + 「直播中」标记
  await expect(popup!.locator('.xterm-screen')).toBeVisible({ timeout: 30_000 })
  await expect(popup!.locator('#badge[data-state="live"]')).toBeVisible({ timeout: 20_000 })
})

test('发布口校验面：非法 url 形态 400 拒收，通知不入账', async ({ request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)

  // 反钓鱼矩阵：协议相对外链 / .. 穿越 / query 附加 / 缺 url——全部 400
  for (const url of ['//evil.com/s/abc123', '/s/../../etc', '/s/abc123?x=1', '']) {
    const res = await request.post(`${API_BASE}/api/ops-notify`, {
      headers,
      data: { type: 'watch.invite', payload: url ? { url, title: 'x' } : { title: 'x' } },
    })
    expect(res.status(), `非法 url ${url} 应 400`).toBe(400)
    expect(await res.text()).toContain('invalid watch.invite payload')
  }
  // 相似名自定义 type 不受内置校验约束（开放词表零变化）
  const similar = await request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'watch.invites', payload: { url: 'anything' } },
  })
  expect(similar.ok()).toBeTruthy()

  // 坏载荷未进广播流：通知中心零入账
  await new Promise(resolve => setTimeout(resolve, 1500))
  expect(await serverCount(request, 'x', headers)).toBe(0)
})
