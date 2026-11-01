import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName, rightClickTreeBackground } from '../../tests/helpers'

/**
 * 分享访问口令门（P-20261006-25）E2E——「链接+口令」双因子：
 *   1. 负向：带口令分享的页面出口令页；meta/list/render/raw/download/deep-dl
 *      子资源无 cookie 一律 401 passphrase_required（防绕口令页直取子资源）；
 *      错口令 ×10 → 401，第 11 次起 429 + Retry-After（限流窗内连正确口令也暂拒）
 *   2. 正向：正确口令 POST /gate → 303 + 门会话 cookie → 全子资源可达、页面
 *      直出内容；改口令后旧 cookie 立即失效（cookie 绑定记录哈希）；移除口令
 *      回到「知道链接即能看」；snippet 同门
 * 子服务端口经 /api/share/status 动态获取（默认主端口+2）。
 * 可重跑关键：分享 token 按 (项目, 路径) 确定性派生、限流按 (token, IP) 计数
 * ——每例自建唯一文件（唯一 token → 全新限流桶），重跑不被上一轮窗口沾染；
 * afterEach 删除用例文件（进回收站），种子项目工作树不留痕。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const PASS_V1 = 'e2e-pass-v1'
const PASS_V2 = 'e2e-pass-v2'

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

async function getShareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

/** 打开分享管理主区视图（共享实例串行，列表加载完再操作） */
async function openManager(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.sm-card table')).toBeVisible({ timeout: 10000 })
}

/** 建唯一分享目标文件并带口令分享：返回 {token, path}（唯一路径 → 唯一 token） */
async function createLockedShare(
  request: APIRequestContext,
  headers: Record<string, string>,
  suffix: string,
  passphrase: string,
): Promise<{ token: string; path: string }> {
  const projectId = await getProjectId(request, headers)
  const path = `e2e-pass-${Date.now()}-${suffix}.md`
  const mk = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path, content: `# passphrase e2e target (${suffix})\n\nsecret body for ${suffix}\n` },
  })
  expect(mk.ok(), await mk.text()).toBeTruthy()
  createdFiles.push(path)
  const res = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path, passphrase } })
  expect(res.ok(), await res.text()).toBeTruthy()
  const body = (await res.json()) as { data?: { token: string; hasPassphrase?: boolean } }
  expect(body.data?.hasPassphrase).toBe(true)
  return { token: body.data!.token!, path }
}

/** POST /gate 一次（不跟随 303；走 Node fetch 与 Playwright cookie jar 完全
 * 隔离，cookie 只经显式头传递），返回 {status, location, setCookie, retryAfter} */
async function postGate(shareBase: string, token: string, passphrase: string) {
  const res = await fetch(`${shareBase}/s/${token}/gate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept-Language': 'zh-CN' },
    body: new URLSearchParams({ passphrase }).toString(),
    redirect: 'manual',
  })
  const out = {
    status: res.status,
    location: res.headers.get('location') || '',
    setCookie: res.headers.get('set-cookie') || '',
    retryAfter: res.headers.get('retry-after') || '',
  }
  await res.body?.cancel()
  return out
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})

test.afterEach(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  for (const path of createdFiles.splice(0)) {
    await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path } })
  }
})

test('错口令限流 + 子资源 401：门页拦在前面，绕过口令页直取子资源一律 401', async ({ request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  const shareBase = await getShareBase(request, headers)
  const { token } = await createLockedShare(request, headers, 'neg', PASS_V1)

  // 页面：口令页（表单指向 /gate），不是内容页
  const page = await request.get(`${shareBase}/s/${token}`)
  expect(page.status()).toBe(200)
  const pageHtml = await page.text()
  expect(pageHtml).toContain(`action="/s/${token}/gate"`)

  // 子资源直取：全部 401 passphrase_required（守卫统一——meta/list/render/raw/download/deep-dl）
  for (const ep of ['/meta', '/list', '/render', '/raw', '/download', '/dl/']) {
    const r = await request.get(`${shareBase}/s/${token}${ep}`)
    expect(r.status(), ep).toBe(401)
    expect(((await r.json()) as { error?: string }).error, ep).toBe('passphrase_required')
  }

  // 错口令 ×10 → 401（窗口内限额）；文案随 Accept-Language 中文
  for (let i = 0; i < 10; i++) {
    const r = await postGate(shareBase, token, `wrong-${i}`)
    expect(r.status, `wrong #${i + 1}`).toBe(401)
  }
  // 第 11 次起 429 + Retry-After；限流窗内连正确口令也暂拒
  const limited = await postGate(shareBase, token, 'wrong-overflow')
  expect(limited.status).toBe(429)
  expect(limited.setCookie).toBe('')
  const retry = await postGate(shareBase, token, PASS_V1)
  expect(retry.status).toBe(429)
  expect(retry.retryAfter).toBeTruthy()
})

test('口令正确：验证 → 全子资源可达 → 改门旧会话失效 → 移除门回归裸链接', async ({ page, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  const shareBase = await getShareBase(request, headers)
  const { token, path } = await createLockedShare(request, headers, 'pos', PASS_V1)
  const fileName = path.split('/').pop()!

  // 真实浏览器表单流：口令页渲染（CSP form-action 'self' 允许同源提交）→
  // 填口令提交 → 303 回程 → 内容页（门会话 cookie 由浏览器持有）
  await page.goto(`${shareBase}/s/${token}`)
  const form = page.locator(`form[action="/s/${token}/gate"]`)
  await expect(form).toBeVisible()
  await form.locator('input[type="password"]').fill(PASS_V1)
  await form.locator('button[type="submit"]').click()
  await page.waitForURL(`**/s/${token}`)
  await expect(page.locator(`form[action="/s/${token}/gate"]`)).toHaveCount(0)

  // 正确口令（API 口径）：303 回内容页 + HttpOnly 门会话 cookie
  const ok = await postGate(shareBase, token, PASS_V1)
  expect(ok.status).toBe(303)
  expect(ok.location).toBe(`/s/${token}`)
  expect(ok.setCookie).toContain(`sc_gate_${token}=`)
  const cookie = ok.setCookie.split(';')[0]!

  // 带 cookie：页面直出内容（不再是口令页），meta/raw/download/deep-dl 全通
  const noGate = await request.get(`${shareBase}/s/${token}`, { headers: { cookie } })
  expect(noGate.status()).toBe(200)
  expect(await noGate.text()).not.toContain(`action="/s/${token}/gate"`)
  const meta = await request.get(`${shareBase}/s/${token}/meta`, { headers: { cookie } })
  expect(meta.status()).toBe(200)
  expect(((await meta.json()) as { entry?: { name: string } }).entry?.name).toBe(fileName)
  expect((await request.get(`${shareBase}/s/${token}/raw`, { headers: { cookie } })).status()).toBe(200)
  expect((await request.get(`${shareBase}/s/${token}/download`, { headers: { cookie } })).status()).toBe(200)
  expect((await request.get(`${shareBase}/s/${token}/dl/`, { headers: { cookie } })).status()).toBe(200)

  // 改口令（rotate=false，短链不变）：旧 cookie 立即失效，新口令重新解锁
  const ch = await request.post(`${BASE}/api/share/${token}/passphrase`, {
    headers, data: { passphrase: PASS_V2 },
  })
  expect(ch.ok()).toBeTruthy()
  const stale = await request.get(`${shareBase}/s/${token}/meta`, { headers: { cookie } })
  expect(stale.status()).toBe(401)
  const relock = await postGate(shareBase, token, PASS_V2)
  expect(relock.status).toBe(303)
  const cookie2 = relock.setCookie.split(';')[0]!
  expect((await request.get(`${shareBase}/s/${token}/meta`, { headers: { cookie: cookie2 } })).status()).toBe(200)
  // 旧口令已证伪：重放被 401（非限流——仅失败计数，远低于阈值）
  expect((await postGate(shareBase, token, PASS_V1)).status).toBe(401)

  // 移除口令：回到「知道链接即能看」，无 cookie 全通、页面非门页
  const rm = await request.post(`${BASE}/api/share/${token}/passphrase`, { headers, data: { passphrase: '' } })
  expect(rm.ok()).toBeTruthy()
  const rmBody = (await rm.json()) as { data?: { hasPassphrase?: boolean } }
  expect(rmBody.data?.hasPassphrase).toBeFalsy()
  const freed = await request.get(`${shareBase}/s/${token}/meta`)
  expect(freed.status()).toBe(200)
  const freedPage = await request.get(`${shareBase}/s/${token}`)
  expect(await freedPage.text()).not.toContain(`action="/s/${token}/gate"`)

  // snippet 同门：带口令片段页面出口令页、raw 无 cookie 401
  const sn = await request.post(`${BASE}/api/share/snippet`, { headers, data: { content: `e2e passphrase snippet ${Date.now()}`, passphrase: PASS_V1 } })
  expect(sn.ok()).toBeTruthy()
  const snBody = (await sn.json()) as { data?: { token: string; hasPassphrase?: boolean } }
  expect(snBody.data?.hasPassphrase).toBe(true)
  const snToken = snBody.data!.token
  const snPage = await request.get(`${shareBase}/s/${snToken}`)
  expect(await snPage.text()).toContain(`action="/s/${snToken}/gate"`)
  expect((await request.get(`${shareBase}/s/${snToken}/raw`)).status()).toBe(401)
})

test('UI：口令文件分享结果卡提供邀请复制，二维码/链接均不含口令', async ({ page, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')

  // 背景右键 = 分享项目根；创建弹层填口令后确认
  await rightClickTreeBackground(page)
  await expect(page.locator('.n-dropdown-menu')).toBeVisible()
  await page.locator('.n-dropdown-menu').getByText('生成分享链接', { exact: true }).click()
  const createModal = page.locator('.share-create-modal')
  await expect(createModal).toBeVisible()
  await createModal.locator('[data-testid="share-create-passphrase"] input').fill(PASS_V1)
  await createModal.locator('[data-testid="share-create-confirm"]').click()

  const modal = page.locator('.share-result-modal')
  await expect(modal).toBeVisible({ timeout: 10000 })
  const linkInput = modal.locator('[data-testid="share-result-qr-url"] input')
  await expect(linkInput).toBeVisible({ timeout: 10000 })
  const link = await linkInput.inputValue()
  expect(link).toMatch(/\/s\/[0-9a-z]{16}$/)
  // 结果卡二维码：码源=链接输入框，绝不含口令
  await expect(modal.locator('[data-testid="share-result-qr-canvas"] canvas')).toBeVisible({ timeout: 5000 })
  expect(link).not.toContain(PASS_V1)
  await expect(modal.locator('[data-testid="share-invite-note"]')).toBeVisible()

  // 邀请复制：链接 + 本次明文口令 + 有效期/一次性说明
  await page.context().grantPermissions(['clipboard-read'])
  await modal.locator('[data-testid="share-invite-copy"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '邀请信息已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain(link)
  expect(clip).toContain(`访问口令：${PASS_V1}`)
  // 剪贴板换行随平台归一（Windows 为 CRLF）：链接行单独成行且不含口令——
  // 即口令只出现在邀请正文的口令行，不混进链接
  const clipLines = clip.split(/\r?\n/)
  expect(clipLines).toHaveLength(3)
  expect(clipLines[0]).toContain(link)
  expect(clipLines[0]).not.toContain(PASS_V1)

  // 访客面：带口令的文件分享页面是口令页（邀请里的链接确实带门）
  const token = link.split('/s/')[1]!
  const shareBase = await getShareBase(request, headers)
  const visitorHtml = await (await request.get(`${shareBase}/s/${token}`)).text()
  expect(visitorHtml).toContain(`action="/s/${token}/gate"`)
})

test('UI：管理器设口令保存后就地复制邀请信息（含新口令）', async ({ page, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const path = 'docs/design/polish-rounds.md'
  const create = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path } })
  expect(create.ok()).toBeTruthy()

  await openManager(page)
  const row = page.locator('.sm-card tbody tr').filter({ hasText: 'polish-rounds.md' })
  await expect(row).toHaveCount(1)
  // 行操作收口（P-20261020-9）：口令入口在「更多」菜单（带文字标签），
  // 不再是行内 aria-label 按钮
  await row.getByTestId('sm-more-btn').click()
  await page.locator('.n-dropdown-menu').last().getByText('访问口令', { exact: true }).click()
  const modal = page.locator('.n-modal.sm-pass-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })
  await modal.locator('[data-testid="sm-pass-input"] input').fill(PASS_V2)
  await modal.locator('[data-testid="sm-pass-save"]').click()

  // 保存成功后弹层不关闭，就地出现邀请区；链接不含口令
  const invite = modal.locator('[data-testid="sm-pass-invite"]')
  await expect(invite).toBeVisible({ timeout: 10000 })
  const inviteUrl = await invite.locator('[data-testid="sm-pass-invite-url"] input').inputValue()
  expect(inviteUrl).toMatch(/\/s\/[0-9a-z]{16}$/)
  expect(inviteUrl).not.toContain(PASS_V2)

  await page.context().grantPermissions(['clipboard-read'])
  await invite.locator('[data-testid="sm-pass-invite-copy"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '邀请信息已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain(inviteUrl)
  expect(clip).toContain(`访问口令：${PASS_V2}`)
})
