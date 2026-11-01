import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 分享访客留言板（P-20261006-13）E2E——出域分享的双向闭环：
 *   1. 全链路：访客页底部留言区（空态 → 昵称+正文提交 → 即见回显）→ 主人侧
 *      「留言 N」角标 → 管理面板只读列表 → 单删出清（角标同步归零）
 *   2. 写入面防线：限长（>500 rune 400）、空文本 400、(token,IP) 频控
 *      （第 6 条起 429 + Retry-After）、口令分享同门（无 cookie 401）
 *   3. 生命周期：撤销级联删除（留言列表 404；同 token 幂等重建后空态）、
 *      新留言通知入账（titleKey=share.msg.notify.title，3s 攒批冲刷）
 * 共享实例的全局分享列表（workers=1 串行），beforeEach/afterEach 清空；
 * 每例自建唯一文件（唯一 token → 全新频控桶），重跑不被上一轮窗口沾染。
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'

// 访客页文案随 Accept-Language（prefLang），浏览器用例锁 zh-CN context
// （share-ttl 同款先例）；API 用例不受 context locale 影响
test.use({ locale: 'zh-CN' })

/** 本轮用例创建的文件（afterEach 统一删除，保种子项目工作树干净） */
const createdFiles: string[] = []

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态，保证确定性） */
async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  }
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJECT_NAME)
  if (!p) throw new Error(`project ${PROJECT_NAME} not found`)
  return p.id
}

/** 分享子服务基址（访客短链端口，经 status 端点取实际值） */
async function shareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  expect(status?.running, 'share sub-service must be running').toBeTruthy()
  return `${status!.scheme || 'http'}://localhost:${status!.port}`
}

/** 建唯一分享目标文件并分享：返回 token（唯一路径 → 唯一 token → 全新频控桶） */
async function createUniqueShare(
  request: APIRequestContext,
  headers: Record<string, string>,
  tag: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const projectId = await getProjectId(request, headers)
  const path = `e2e-guestbook-${Date.now()}-${tag}.md`
  const mk = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path, content: `# guestbook e2e target (${tag})\n` },
  })
  expect(mk.ok(), await mk.text()).toBeTruthy()
  createdFiles.push(path)
  const res = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path, ...extra } })
  expect(res.ok(), await res.text()).toBeTruthy()
  const body = (await res.json()) as { data?: { token: string } }
  expect(body.data?.token).toBeTruthy()
  return body.data!.token
}

/** 访客面写一条留言（API 口径），返回状态码与 Retry-After */
async function postMessage(shareBase0: string, token: string, body: string) {
  const res = await fetch(`${shareBase0}/s/${token}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  })
  const retryAfter = res.headers.get('retry-after') || ''
  await res.body?.cancel()
  return { status: res.status, retryAfter }
}

/** 轮询管理列表直至该分享 messages 计数就绪（计数随留言写入即时落库，
 * 无攒批——但列表投影走管理 API，给短轮询免时序脆断） */
async function waitMsgBadge(
  request: APIRequestContext,
  headers: Record<string, string>,
  token: string,
  want: number,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const res = await request.get(`${BASE}/api/share`, { headers })
    const list = ((await res.json()) as { data?: { token: string; messages?: number }[] }).data || []
    const s = list.find(x => x.token === token)
    if (s && (s.messages ?? 0) === want) return
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`share ${token} messages badge never reached ${want}`)
}

async function openManager(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.sm-card table')).toBeVisible({ timeout: 10000 })
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})

test.afterEach(async ({ request }) => {
  await cleanupShares(request)
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  for (const path of createdFiles.splice(0)) {
    await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path } })
  }
})

test('访客留言全链路：访客页提交 → 主人侧角标与面板 → 单删出清', async ({ page, request }) => {
  test.setTimeout(90_000)
  const headers = await unlockHeaders(request)
  const visitor = await shareBase(request, headers)
  const token = await createUniqueShare(request, headers, 'loop')

  // 访客页：留言区挂载（三形态统一挂载的 file 形态观测）→ 展开见空态
  await page.goto(`${visitor}/s/${token}`)
  const board = page.getByTestId('gb-root')
  await expect(board).toBeVisible()
  await expect(board).toContainText('留言')
  await page.getByTestId('gb-toggle').click()
  await expect(board.getByText('还没有留言')).toBeVisible()

  // 提交：昵称 + 正文 → 即见回显（POST 响应即持久化回执）+ 成功反馈
  await page.getByTestId('gb-nick').fill('同事甲')
  await page.getByTestId('gb-text').fill('这个配置第 3 行为什么是幂等键？')
  await page.getByTestId('gb-send').click()
  await expect(page.getByTestId('gb-status')).toContainText('已收到')
  await expect(page.getByTestId('gb-item').first()).toContainText('同事甲')
  await expect(page.getByTestId('gb-item').first()).toContainText('幂等键')

  // 主人侧 API：角标计数 = 1
  await waitMsgBadge(request, headers, token, 1)

  // 管理器 UI：角标 → 面板 → 只读列表（转义渲染语义：文本按原文可见）
  await openManager(page)
  const row = page.locator('.sm-card tbody tr').filter({ hasText: 'guestbook-' })
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId('sm-msg-count')).toHaveText('1')
  // 留言入口收进行尾「更多」菜单（P-20261020-9），计数随菜单项文案给出
  await row.getByTestId('sm-more-btn').click()
  await page.locator('.n-dropdown-menu').last().getByText('留言 1', { exact: true }).click()
  const modal = page.getByTestId('sm-msg-modal')
  await expect(modal).toBeVisible()
  const item = modal.getByTestId('sm-msg-item')
  await expect(item).toHaveCount(1)
  await expect(item).toContainText('同事甲')
  await expect(item).toContainText('幂等键')

  // 单删出清：条目消失 + 角标同步归零
  await item.getByTestId('sm-msg-del').click()
  await expect(modal.getByTestId('sm-msg-empty')).toBeVisible()
  await expect(row.getByTestId('sm-msg-count')).toHaveCount(0)
})

test('写入面防线：限长/空文本 400、频控 429 + Retry-After、口令分享同门 401', async ({ request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  const visitor = await shareBase(request, headers)
  const token = await createUniqueShare(request, headers, 'guard')

  // 限长：501 rune → 400；恰 500 rune → 200
  expect((await postMessage(visitor, token, JSON.stringify({ text: '字'.repeat(501) }))).status).toBe(400)
  expect((await postMessage(visitor, token, JSON.stringify({ text: '字'.repeat(500) }))).status).toBe(200)
  // 空文本/纯空白 → 400
  expect((await postMessage(visitor, token, JSON.stringify({ text: '' }))).status).toBe(400)
  expect((await postMessage(visitor, token, JSON.stringify({ text: '   ' }))).status).toBe(400)

  // 频控：本例已写 1 条，再写满窗口（第 6 条起 429 + Retry-After）
  for (let i = 0; i < 4; i++) {
    expect((await postMessage(visitor, token, JSON.stringify({ text: `msg-${i}` }))).status).toBe(200)
  }
  const over = await postMessage(visitor, token, JSON.stringify({ text: 'over' }))
  expect(over.status).toBe(429)
  expect(over.retryAfter).toBeTruthy()

  // 口令分享同门：无门会话的留言读写一律 401（与内容子资源同一守卫）
  const locked = await createUniqueShare(request, headers, 'gate', { passphrase: 'gb-pass' })
  expect((await postMessage(visitor, locked, JSON.stringify({ text: 'hi' }))).status).toBe(401)
  const lg = await request.get(`${visitor}/s/${locked}/messages`)
  expect(lg.status()).toBe(401)
})

test('生命周期：撤销级联删除（重建同 token 空态幂等）+ 新留言通知入账', async ({ request }) => {
  test.setTimeout(90_000)
  const headers = await unlockHeaders(request)
  const visitor = await shareBase(request, headers)

  // 通知基线：既有留言通知条数（全局通知中心，先记后比对增量）
  const listNotices = async (): Promise<number> => {
    const res = await request.get(`${BASE}/api/notifications`, { headers })
    const data = ((await res.json()) as { data?: { titleKey?: string }[] }).data || []
    return data.filter(n => n.titleKey === 'share.msg.notify.title').length
  }
  const baseline = await listNotices()

  const token = await createUniqueShare(request, headers, 'cycle')
  expect((await postMessage(visitor, token, JSON.stringify({ nickname: '同事乙', text: '撤销前留言' }))).status).toBe(200)

  // 新留言通知入账（3s 攒批冲刷，轮询增量 +1）
  let notices = baseline
  for (let i = 0; i < 40 && notices <= baseline; i++) {
    notices = await listNotices()
    if (notices <= baseline) await new Promise(r => setTimeout(r, 400))
  }
  expect(notices, 'new-message notification should arrive').toBeGreaterThan(baseline)

  // 撤销级联：留言列表随记录死亡（404）；同 token 幂等重建后空态——
  // 「随分享撤销级联删除」的对外观测口径
  expect((await request.delete(`${BASE}/api/share/${token}`, { headers })).ok()).toBeTruthy()
  expect((await request.get(`${visitor}/s/${token}/messages`)).status()).toBe(404)
  const projectId = await getProjectId(request, headers)
  const re = await request.post(`${BASE}/api/share`, {
    headers,
    data: { projectId, path: createdFiles.find(p => p.includes('cycle')) },
  })
  expect(re.ok()).toBeTruthy()
  const reToken = (((await re.json()) as { data?: { token: string } }).data)?.token
  expect(reToken).toBe(token) // 派生确定性：同目标恒同链
  const after = await request.get(`${visitor}/s/${token}/messages`)
  expect(after.status()).toBe(200)
  const body = (await after.json()) as { messages?: unknown[]; count?: number }
  expect(body.count).toBe(0)
  expect(body.messages).toEqual([])
})
