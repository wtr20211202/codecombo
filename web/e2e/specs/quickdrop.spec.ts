import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 快投递 quickdrop E2E（P-20261006-51）：手机/脚本 → 工作台的最轻投递通道。
 * 真实后端流走完全链（不做通知播种——到达通知本身是本特性的一部分）：
 *   1. 造 token（POST /api/quickdrop/token）→ 分享区快投递卡渲染（生成态可逆）；
 *   2. 访客页 GET /drop/<token> 渲染表单 → 表单投递 303 PRG → 内容入收件箱；
 *   3. 到达通知入账（类别 drop、标题模板 + 摘要行）+ 行内动作双出口可见；
 *   4. 点「新会话处理」→ 拦截 POST /api/terminals：kind=agent 且 launchArgs
 *      含投递内容（deploy-agent-fix 同款拦截口径）；
 *   5. 撤销 token → POST /api/quickdrop 与 GET /drop/<token> 一律 404
 *      （端点存在性不可探测）。
 * 交付原语 POST /api/quickdrop（agent/快捷指令 curl 面）以 API 断言覆盖
 * （200/404/413/400 四态），浏览器侧主要走访客页表单（同一 ingest 主链）。
 */

const BASE = API_BASE
const DROP_CONTENT = 'QDROP-7f3a panic: nil map at fastapi/router.py:42'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function createDropToken(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${BASE}/api/quickdrop/token`, { headers })
  expect(res.ok()).toBeTruthy()
  const token = ((await res.json()) as { data?: { token?: string } }).data?.token || ''
  expect(token.startsWith('scd_')).toBeTruthy()
  return token
}

/** 清理本 spec 状态：收件箱 + 通知 + agent 会话（token 由各用例自管轮换） */
async function cleanupAll(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  await fetch(`${BASE}/api/notifications/clear`, { method: 'POST', headers })
  const res = await fetch(`${BASE}/api/quickdrop`, { headers })
  for (const d of ((await res.json()) as { data?: { id: string }[] }).data || []) {
    await fetch(`${BASE}/api/quickdrop/${d.id}`, { method: 'DELETE', headers })
  }
  const terms = await fetch(`${BASE}/api/terminals`, { headers })
  for (const s of ((await terms.json()) as { data?: { id: string }[] }).data || []) {
    await fetch(`${BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers })
  }
}

test.beforeAll(async ({ request }) => {
  await cleanupAll(request)
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  // 收口撤销凭据：不留活链接（其他 spec 不依赖 quickdrop 态）
  await fetch(`${BASE}/api/quickdrop/token`, { method: 'DELETE', headers })
  await cleanupAll(request)
})

async function openNotificationCenter(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 5000 })
}

test('投递原语四态：无效凭据 404 / 有效 200 / 空内容 400 / 超限 413', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const token = await createDropToken(request)

  // 无凭据/错凭据 → 404（与端点不存在不可区分）
  for (const tok of ['', 'scd_wrongwrongwrongwrongwrongwr']) {
    const res = await request.post(`${BASE}/api/quickdrop`, {
      data: { token: tok, content: 'x' },
    })
    expect(res.status(), '无效凭据必须 404').toBe(404)
  }
  // 空内容 400
  expect((await request.post(`${BASE}/api/quickdrop`, {
    headers, data: { token, content: '   ' },
  })).status()).toBe(400)
  // 超限 413（4KB 字节口径）
  expect((await request.post(`${BASE}/api/quickdrop`, {
    headers, data: { token, content: 'a'.repeat(4097) },
  })).status()).toBe(413)
  // 有效投递 200 + 收件箱可见
  const ok = await request.post(`${BASE}/api/quickdrop`, {
    headers, data: { token, content: 'api-path delivery' },
  })
  expect(ok.status()).toBe(200)
  const list = await request.get(`${BASE}/api/quickdrop`, { headers })
  const items = ((await list.json()) as { data?: { content: string }[] }).data || []
  expect(items.some(d => d.content === 'api-path delivery')).toBeTruthy()
})

test('访客页投递 → 通知到达 → 「新会话处理」launchArgs 含内容', async ({ page, request }) => {
  test.setTimeout(90000)
  const headers = await unlockHeaders(request)
  const token = await createDropToken(request)

  // 访客页：渲染表单（零依赖单页）→ 表单投递 303 PRG 回成功态
  const pageRes = await request.get(`${BASE}/drop/${token}`)
  expect(pageRes.status()).toBe(200)
  expect((await pageRes.text()).toLowerCase()).toContain('<textarea')
  const post = await request.post(`${BASE}/drop/${token}`, {
    form: { content: DROP_CONTENT },
    maxRedirects: 0,
  })
  expect(post.status()).toBe(303)
  expect(post.headers().location).toContain(`/drop/${token}?sent=1`)

  // 收件箱（管理面）可见投递内容
  const list = await request.get(`${BASE}/api/quickdrop`, { headers })
  const items = ((await list.json()) as { data?: { content: string }[] }).data || []
  expect(items.some(d => d.content === DROP_CONTENT)).toBeTruthy()

  // 到达通知：行内动作双出口可见（主动作「交给当前会话」+ 第二动作「新会话处理」）
  await openNotificationCenter(page)
  const row = page.locator('.nc-item').filter({ hasText: '收到快投递' }).filter({ hasText: 'router.py' }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  await expect(row).toContainText('交给当前会话')
  const newBtn = row.locator('.nc-second-action', { hasText: '新会话处理' })
  await expect(newBtn).toBeVisible()

  // 拦截创建请求：kind=agent 且 launchArgs 含投递内容（任务文件降级未触发——
  // 短内容直接装箱进 launchArgs）
  const reqPromise = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await newBtn.click()
  const req = await reqPromise
  const body = req.postDataJSON() as { kind?: string; launchArgs?: string }
  expect(body.kind, '请求体 kind=agent').toBe('agent')
  expect(body.launchArgs, 'launchArgs 含投递内容').toContain(DROP_CONTENT)

  // docked 管理页打开（createAgent 链收口）
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
})

test('分享区快投递卡：生成明文链接一次可见；撤销 token 后端点与访客页 404', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  // 清态起点：撤销既有凭据（其他用例/上次运行残留），卡片才显示「生成」
  await request.delete(`${BASE}/api/quickdrop/token`, { headers })

  // 分享管理器 → 快投递卡生成（明文链接只此一次可见）
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-share-manager"]').click()
  const card = page.locator('[data-testid="qd-card"]')
  await expect(card).toBeVisible({ timeout: 10000 })
  await card.locator('[data-testid="qd-generate"]').click()
  const plainUrl = (await card.locator('[data-testid="qd-plain-url"]').textContent()) || ''
  const token = plainUrl.split('/drop/')[1] || ''
  expect(token.startsWith('scd_'), `明文链接含 token：${plainUrl}`).toBeTruthy()

  // 撤销（卡片按钮 → 确认弹层）→ 卡回未生成态（确认钮文案 = common.confirm「确认」，
  // share.spec.ts 撤销弹层同款定位）
  await card.locator('[data-testid="qd-revoke"]').click()
  await page.locator('.n-dialog', { hasText: '撤销快投递链接' }).getByRole('button', { name: '确认' }).click()
  await expect(card.locator('[data-testid="qd-generate"]')).toBeVisible({ timeout: 5000 })

  // 服务端口径：投递原语与访客页一律 404（撤销即时生效）
  expect((await request.post(`${BASE}/api/quickdrop`, {
    data: { token, content: 'x' },
  })).status()).toBe(404)
  expect((await request.get(`${BASE}/drop/${token}`)).status()).toBe(404)
  void headers
})
