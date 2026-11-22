import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName, closeShareManagerAndClearState } from '../../tests/helpers'
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

// 分享管理开态残留清场（P-20261112-6-S3）：本 spec 用例以管理视图在屏结束，
// 开态即时写落 uiState 后会在后续用例/后续 spec 的新页面恢复出管理视图——rail
// 再点被 toggle 语义反转（closeDshConsoleAndClearState 头注同款事故面）。先卸载
// SPA 防 unload 路径回写，再 API 只清 shareManager 命名空间
test.afterEach(async ({ page, request }) => {
  await closeShareManagerAndClearState(page, request, BASE)
})
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

// ── 本机缓存「复制完整链接」（P-20261117-1）四用例 ──
// 服务端只存 scd_ 哈希（明文仅生成/轮换响应显示一次），主人侧在成功回调那刻把
// 完整链接缓存进本机 localStorage（sc.quickdrop.url，随行 rotatedAt）——刷新/
// 换天后复制出口仍在；他处轮换（rotatedAt 失配）/清存储（缓存缺失）置灰如实提示；
// 撤销清除。四态与提案验证清单一一对应。
async function openShareManager(page: Page): Promise<Locator> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-share-manager"]').click()
  const card = page.locator('[data-testid="qd-card"]')
  await expect(card).toBeVisible({ timeout: 10000 })
  return card
}

/** 刷新后回卡：锁凭据是 HttpOnly cookie 随上下文存活自动解锁；管理视图开态落
 *  uiState（restoreShareManagerOnce）刷新后自动恢复，无需再点 rail（点了反而
 *  toggle 关闭——closeShareManagerAndClearState 头注同款事故面） */
async function reloadBackToCard(page: Page, card: Locator): Promise<void> {
  await page.reload()
  await expect(card).toBeVisible({ timeout: 15000 })
}

/** 清态起点：撤销既有凭据（他用例/上次运行残留）——必须在 openShareManager
 *  之前调，卡开着时 API 撤销不刷新卡片显态，qd-generate 仍不可见（既有用例
 *  「撤销后开卡」同序） */
async function revokeTokenApi(request: APIRequestContext): Promise<void> {
  await request.delete(`${BASE}/api/quickdrop/token`, { headers: await unlockHeaders(request) })
}

/** 开卡后点「生成」（清态前提由 revokeTokenApi 保证），回完整明文链接 */
async function generateViaCard(card: Locator): Promise<string> {
  await card.locator('[data-testid="qd-generate"]').click()
  const plainUrl = (await card.locator('[data-testid="qd-plain-url"]').textContent()) || ''
  expect(plainUrl, '生成成功回显完整链接').toContain('/drop/scd_')
  return plainUrl
}

test('本机缓存复制：生成后刷新页面仍可复制完整链接（明文仅显示一次的常驻出口）', async ({ page, request }) => {
  test.setTimeout(90000)
  await revokeTokenApi(request)
  const card = await openShareManager(page)
  const plainUrl = await generateViaCard(card)

  // 刷新：明文回显消失（qd-plain-url 是一次性回显），常驻「复制完整链接」
  // 凭本机缓存复原为可用态
  await reloadBackToCard(page, card)
  await expect(card.locator('[data-testid="qd-plain-url"]')).toHaveCount(0)
  const copyBtn = card.locator('[data-testid="qd-copy-cached"]')
  await expect(copyBtn).toBeVisible()
  await expect(copyBtn).toBeEnabled()
  await copyBtn.click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip, '剪贴板 = 缓存的完整投递链接').toBe(plainUrl)
})

test('本机缓存复制：他处轮换后置灰并提示（rotatedAt 与 Meta 失配，死链不供出）', async ({ page, request }) => {
  test.setTimeout(90000)
  await revokeTokenApi(request)
  const card = await openShareManager(page)
  await generateViaCard(card)

  // 脚本 API 直接轮换（模拟脚本侧/他机浏览器轮换，本浏览器缓存不知情）：
  // rotatedAt 随新凭据变化，与缓存随行值失配。间隔 >1s 跨秒——RotatedAt 是
  // RFC3339 秒级精度，同秒内轮换新旧值等值，失配语义无从区分（2026-11-17
  // 实勘：快机亚秒级连发令本用例必红）
  await page.waitForTimeout(1100)
  await request.post(`${BASE}/api/quickdrop/token`, { headers: await unlockHeaders(request) })
  await reloadBackToCard(page, card)
  const copyBtn = card.locator('[data-testid="qd-copy-cached"]')
  await expect(copyBtn).toBeVisible()
  await expect(copyBtn).toBeDisabled()
  await expect(card.locator('[data-testid="qd-cache-hint"]')).toContainText('他处轮换')
})

test('本机缓存复制：撤销后缓存清除（本机键移除，复制按钮撤场）', async ({ page, request }) => {
  test.setTimeout(90000)
  await revokeTokenApi(request)
  const card = await openShareManager(page)
  await generateViaCard(card)
  expect(await page.evaluate(() => localStorage.getItem('sc.quickdrop.url'))).toBeTruthy()

  // 卡内撤销 → 缓存清除点：本机键移除 + 复制按钮随凭据撤场（卡回未生成态）
  await card.locator('[data-testid="qd-revoke"]').click()
  await page.locator('.n-dialog', { hasText: '撤销快投递链接' }).getByRole('button', { name: '确认' }).click()
  await expect(card.locator('[data-testid="qd-generate"]')).toBeVisible({ timeout: 5000 })
  await expect(card.locator('[data-testid="qd-copy-cached"]')).toHaveCount(0)
  expect(await page.evaluate(() => localStorage.getItem('sc.quickdrop.url'))).toBeNull()
})

test('本机缓存复制：换浏览器/清存储后置灰并如实提示（生成或轮换一次可重获）', async ({ page, request }) => {
  test.setTimeout(90000)
  await revokeTokenApi(request)
  const card = await openShareManager(page)
  await generateViaCard(card)

  // 模拟换浏览器/清存储：只抹本机缓存键（凭据仍在服务端）
  await page.evaluate(() => localStorage.removeItem('sc.quickdrop.url'))
  await reloadBackToCard(page, card)
  const copyBtn = card.locator('[data-testid="qd-copy-cached"]')
  await expect(copyBtn).toBeVisible()
  await expect(copyBtn).toBeDisabled()
  await expect(card.locator('[data-testid="qd-cache-hint"]')).toContainText('本机无缓存')
})

// ── S2 访客页升级与产品化（P-20261117-2-S2）用例 ──
// 暂存式多文件交互（多选 input + 粘贴通道；拖拽是增强非主链不在 e2e 模拟）+
// 单批 multipart XHR 进度 + 本地投递历史（sc.drop.history 纯本机）+
// enforcing CSP + 白名单外逐文件错误态 + 门禁前置回归（无效 token 大体请求
// 零落地）。urlencoded 旧表单 303 回归由既有「访客页投递」用例承接。

/** PNG 魔数（缩略图 objectURL 形态即可，无需可解码全图） */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

test('S2 访客页：暂存多文件 + 粘贴通道 + 文本混合投递全链 + 本地历史入账', async ({ page, request }) => {
  test.setTimeout(90000)
  const headers = await unlockHeaders(request)
  const token = await createDropToken(request)

  // enforcing CSP 响应头（自持脚本外链形态的服务端契约）
  const pageRes = await request.get(`${BASE}/drop/${token}`)
  expect(pageRes.status()).toBe(200)
  const csp = pageRes.headers()['content-security-policy'] || ''
  expect(csp, 'enforcing CSP script-src 锁同源').toContain("script-src 'self'")
  expect(csp).toContain('form-action')

  await page.goto(`${BASE}/drop/${token}`)
  await expect(page.getByTestId('qd-dropzone')).toBeVisible()
  await expect(page.locator('script[src="/drop/assets/app.js"]')).toHaveCount(1)

  // 多选 input 暂存两文件 → 逐项删除 → 粘贴截图补位（paste 事件 ClipboardItem）
  await page.setInputFiles('#qd-file-input', [
    { name: 'report.log', mimeType: 'text/plain', buffer: Buffer.from('panic line 1\nline 2') },
    { name: 'shot.png', mimeType: 'image/png', buffer: PNG_MAGIC },
  ])
  const items = page.getByTestId('qd-staged-item')
  await expect(items).toHaveCount(2)
  await expect(page.getByTestId('qd-staged-summary')).toContainText('2 个文件')
  await items.first().getByTestId('qd-item-del').click()
  await expect(items).toHaveCount(1)
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'image.png', { type: 'image/png' }))
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }))
  })
  await expect(items).toHaveCount(2)

  // 文本 + 文件混合投递 → PRG 成功态 → 本地历史 ok 位
  await page.locator('#content').fill('S2 mixed drop 8f2c')
  await page.getByTestId('qd-send').click()
  await expect(page).toHaveURL(/sent=1/, { timeout: 15000 })
  await expect(page.locator('.banner')).toContainText('已送达')
  await expect(page.getByTestId('qd-history-badge')).toBeVisible()
  const hist = await page.evaluate(() => JSON.parse(localStorage.getItem('sc.drop.history') || '[]')) as Array<{ r?: string }>
  expect(hist.length, '成功投递落一条本地历史').toBe(1)
  expect(hist[0].r).toBe('ok')

  // 收件箱：混合投递入账（文本在前 + 文件元数据块）
  const list = await request.get(`${BASE}/api/quickdrop`, { headers })
  const inbox = ((await list.json()) as { data?: { content: string }[] }).data || []
  expect(inbox.some(d => d.content.includes('S2 mixed drop 8f2c') && d.content.includes('[文件'))).toBeTruthy()
})

test('S2 访客页：XHR 进度条 + 百分比 + 上传角标（提交即显，onprogress 推进）', async ({ page, request }) => {
  test.setTimeout(90000)
  const token = await createDropToken(request)
  await page.goto(`${BASE}/drop/${token}`)
  await page.setInputFiles('#qd-file-input', [
    { name: 'medium.log', mimeType: 'text/plain', buffer: Buffer.alloc(3 * 1024 * 1024, 0x61) },
  ])
  // 拦截闸门：响应在断言完成前不放行（本地小体上传的 onprogress 一闪而过，
  // 观察窗靠闸门制造；真实响应继续透传，服务端副作用不受影响）
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route(`**/drop/${token}`, async route => {
    if (route.request().method() === 'POST') {
      await gate
      await route.continue()
      return
    }
    await route.continue()
  })
  await page.getByTestId('qd-send').click()
  // 提交即显进度面（0% 起步——操作即时反馈 + 停滞感知），进度事件到达后推进百分比
  await expect(page.getByTestId('qd-progress')).toBeVisible({ timeout: 3000 })
  await expect(page.getByTestId('qd-progress-label')).toContainText('%')
  await expect(page.getByTestId('qd-upload-badge')).toBeVisible()
  release()
  await expect(page).toHaveURL(/sent=1/, { timeout: 20000 })
})

test('S2 访客页：白名单外文件逐文件错误态（added[] rejected 占位不回滚）', async ({ page, request }) => {
  test.setTimeout(90000)
  const token = await createDropToken(request)
  await page.goto(`${BASE}/drop/${token}`)
  await page.setInputFiles('#qd-file-input', [
    { name: 'evil.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') },
    { name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('ok') },
  ])
  await page.getByTestId('qd-send').click()
  // 可达文件照收（200 added[] 含 rejected 占位）→ 页面停留呈现逐文件失败位
  const errItem = page.locator('[data-testid="qd-staged-item"].qd-item-err')
  await expect(errItem).toHaveCount(1, { timeout: 15000 })
  await expect(errItem).toContainText('evil.exe')
  await expect(page.getByTestId('qd-msg')).toContainText('已投递 1 个')
})

test('S2 访客页：纯文本零文件 multipart 投递成功（只发文字合法，sent=1）', async ({ page, request }) => {
  test.setTimeout(90000)
  const headers = await unlockHeaders(request)
  const token = await createDropToken(request)
  await page.goto(`${BASE}/drop/${token}`)
  // 零文件 + 纯文本：multipart 走文本通道同一到达语义（files.go 文本通道，
  // P-20261118-8 访客页形态覆盖——此前仅 API 级用例）
  await page.locator('#content').fill('QDROP text-only 3d81')
  await page.getByTestId('qd-send').click()
  await expect(page).toHaveURL(/sent=1/, { timeout: 15000 })
  await expect(page.locator('.banner')).toContainText('已送达')
  const list = await request.get(`${BASE}/api/quickdrop`, { headers })
  const items = ((await list.json()) as { data?: { content: string }[] }).data || []
  expect(items.some(d => d.content === 'QDROP text-only 3d81')).toBeTruthy()
})

test('S2 访客页：空表单提交被拦（qd-msg 错误可见，传达「至少一项」）', async ({ page, request }) => {
  test.setTimeout(90000)
  const token = await createDropToken(request)
  await page.goto(`${BASE}/drop/${token}`)
  // 无文本无文件：前端拦截不发请求——错误文案显性说出「内容与文件至少
  // 一项」，不再被误读为「文件必须」（P-20261118-8 传达修正）
  await page.getByTestId('qd-send').click()
  const msg = page.getByTestId('qd-msg')
  await expect(msg).toBeVisible()
  await expect(msg).toContainText('至少填写一项')
  await expect(msg).toContainText('at least one is required')
})

test('S2 访客页：历史角标面板与清空（纯本地记录生命周期）', async ({ page, request }) => {
  test.setTimeout(90000)
  const token = await createDropToken(request)
  await page.goto(`${BASE}/drop/${token}`)
  // 预置一条历史（真实投递入账链由上一用例覆盖；此处聚焦面板生命周期）
  await page.evaluate(() => {
    localStorage.setItem('sc.drop.history', JSON.stringify([{ t: Date.now(), n: 'seed.log', s: 123, r: 'ok' }]))
  })
  await page.reload()
  const badge = page.getByTestId('qd-history-badge')
  await expect(badge).toBeVisible()
  await badge.click()
  await expect(page.getByTestId('qd-history-panel')).toBeVisible()
  await expect(page.getByTestId('qd-hist-item').first()).toContainText('seed.log')
  await page.getByTestId('qd-history-clear').click()
  await expect(badge).toBeHidden()
  expect(await page.evaluate(() => localStorage.getItem('sc.drop.history'))).toBeNull()
})

// ── 宽屏视觉冒烟（P-20261120-6 + P-20261120-7）：860px 旧列在 ~1900px 视口
// 四周大留白（用户截图红框实锚）+ 访客页族「两有一无」缺 blob 氛围层——内容
// 放大一档（min(92vw,1120px)）+ 双 blob 光斑对齐文件/终端分享页（page_css.go
// :25-27 同源取值）；P-20261120-7 追加双栏两输入框等高断言（同轨 stretch、
// boundingBox 容差 ≤2px + 顶缘相等 + 动作行全宽）。服务端渲染契约由
// page_s2_test.go 钉死，此处断言真实渲染几何。──
test('S2 访客页：宽屏视觉冒烟——1920 视口卡片 1120 封顶 + blob 氛围层 + 两框等高对齐 + 单栏触达回落', async ({ page, request }) => {
  test.setTimeout(90000)
  const token = await createDropToken(request)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto(`${BASE}/drop/${token}`)
  await expect(page.getByTestId('qd-dropzone')).toBeVisible()

  // 卡片放大一档：1920 视口下列宽 = min(92vw,1120) = 1120px 封顶（旧 860 只
  // 占一角），水平居中
  const cardBox = await page.locator('.card').boundingBox()
  expect(cardBox, '卡片包围盒在位').toBeTruthy()
  expect(cardBox!.width, '1920 视口卡片宽放大到 1120 档').toBeGreaterThanOrEqual(1100)
  expect(cardBox!.width).toBeLessThanOrEqual(1121)
  expect(Math.abs((cardBox!.x + cardBox!.width / 2) - 960), '卡片水平居中').toBeLessThanOrEqual(2)

  // 品牌头与卡片同组放大：.top 是 auto 边距下的收缩适应紧凑行（P-20261119-6
  // 垂直居中组既有形态，实测基线同此），与卡片共享同一居中锚
  const topBox = await page.locator('header.top').boundingBox()
  expect(topBox, '品牌头包围盒在位').toBeTruthy()
  const topCenter = topBox!.x + topBox!.width / 2
  expect(Math.abs(topCenter - 960), '品牌头与卡片同一居中锚').toBeLessThanOrEqual(2)

  // blob 氛围层：双光斑挂载、取值同源、不挡交互（pointer-events:none）；
  // 内容列 z-index:1 压 blob 之上（层级契约——光斑只在内容四周透出）
  await expect(page.locator('.blob.b1')).toHaveCount(1)
  await expect(page.locator('.blob.b2')).toHaveCount(1)
  const b1Style = await page.locator('.blob.b1').evaluate((el) => {
    const s = getComputedStyle(el)
    return { bg: s.backgroundColor, pe: s.pointerEvents, filter: s.filter }
  })
  expect(b1Style.bg.replace(/\s/g, ''), 'b1 紫光斑取值同源').toBe('rgba(106,92,255,0.3)')
  expect(b1Style.pe).toBe('none')
  expect(b1Style.filter).toContain('blur(90px)')
  const mainZ = await page.locator('main').evaluate((el) => {
    const s = getComputedStyle(el)
    return s.position + ':' + s.zIndex
  })
  expect(mainZ, '内容列压 blob 之上').toBe('relative:1')

  // 两框等高对齐（P-20261120-7）：dropzone 与 textarea 同处行 2 轨道（缺省
  // stretch），顶缘 y 相等 + 高度差 ≤2px + 双栏等宽；min-height 归一 200px
  // 双双生效；动作行（hint+提交）脱离右列移 .cols 之下全宽——提交钮 y 不低于
  // 两框底缘（此前 hint/提交行把右列拖低、两框顶底均不齐，用户截图实锚）
  const dzBox = await page.getByTestId('qd-dropzone').boundingBox()
  const taBox = await page.locator('#content').boundingBox()
  expect(dzBox, 'dropzone 包围盒在位').toBeTruthy()
  expect(taBox, 'textarea 包围盒在位').toBeTruthy()
  expect(Math.abs(dzBox!.y - taBox!.y), '两框顶缘对齐').toBeLessThanOrEqual(2)
  expect(Math.abs(dzBox!.height - taBox!.height), '两框等高（容差 2px）').toBeLessThanOrEqual(2)
  expect(Math.abs(dzBox!.width - taBox!.width), '双栏等宽').toBeLessThanOrEqual(2)
  expect(dzBox!.height, 'dropzone min-height 200 生效').toBeGreaterThanOrEqual(200)
  expect(taBox!.height, 'textarea min-height 200 生效').toBeGreaterThanOrEqual(200)
  const wideSend = await page.getByTestId('qd-send').boundingBox()
  expect(wideSend, '宽屏提交钮包围盒在位').toBeTruthy()
  const boxesBottom = Math.max(dzBox!.y + dzBox!.height, taBox!.y + taBox!.height)
  expect(wideSend!.y, '提交行在双栏之下全宽（不低于两框底缘）').toBeGreaterThanOrEqual(boxesBottom)

  // ≤760px 单栏回落 + 触达红线：390 视口单栏堆叠、提交钮热区 ≥44px 不缩
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('qd-dropzone')).toBeVisible()
  const colsCols = await page.locator('.cols').evaluate((el) => getComputedStyle(el).gridTemplateColumns)
  expect(colsCols, '390 视口单栏（单列轨道）').not.toContain(' ')
  // 单栏回落=块流自然堆叠（display:block + .col 复原），文件列在前内容列在后
  const mDz = await page.getByTestId('qd-dropzone').boundingBox()
  const mTa = await page.locator('#content').boundingBox()
  expect(mDz && mTa, '单栏两框包围盒在位').toBeTruthy()
  expect(mTa!.y, '单栏内容列堆叠在文件列之下').toBeGreaterThan(mDz!.y + mDz!.height)
  const sendBox = await page.getByTestId('qd-send').boundingBox()
  expect(sendBox, '提交钮包围盒在位').toBeTruthy()
  expect(sendBox!.height, '提交钮触达红线 44px').toBeGreaterThanOrEqual(44)
})

test('S2 门禁前置回归：无效 token 的 multipart 大体请求 404 零落地', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const before = await fetch(`${BASE}/api/quickdrop`, { headers })
  const beforeCount = (((await before.json()) as { data?: unknown[] }).data || []).length

  const res = await request.post(`${BASE}/drop/scd_wrongwrongwrongwrongwrongwr`, {
    multipart: {
      content: 'gate-first regression',
      files: { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1024 * 1024) },
    },
  })
  expect(res.status(), '门禁前置：凭据无效先于读体 404').toBe(404)

  // 零落地：收件箱不新增条目（大体量请求无账可查）
  const after = await fetch(`${BASE}/api/quickdrop`, { headers })
  const afterCount = (((await after.json()) as { data?: unknown[] }).data || []).length
  expect(afterCount).toBe(beforeCount)
})

// ── S3 主人侧接收面（P-20261117-3）：dropfile 逐文件下载（fid 消歧 + 附件
// 红线）/ 管理卡投递记录区 / 摘除联动回收 / 轮换清盘互涉 / 交给会话路径
// 投影。文本 multipart 兼容回归复用 S1/S2 既有用例不另起 ──

/** QdFileProj 清单行 files[] 投影（服务端 qdFileItem 镜像子集） */
interface QdFileProj {
  id: string
  name: string
  size: number
  kind: string
  sensitive?: boolean
  absPath: string
}

/** QdListRow 清单行（QuickdropItem 投影子集） */
interface QdListRow {
  id: string
  content: string
  createdAt: string
  files?: QdFileProj[]
}

async function listInbox(request: APIRequestContext): Promise<QdListRow[]> {
  const res = await request.get(`${BASE}/api/quickdrop`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: QdListRow[] }).data || []
}

/** 手工组 multipart 体（同名字段重复出现——Playwright multipart 的 files 数组
 *  形态在本版不受支持〔stream3.on is not a function〕，字节级构造同批双 part；
 *  文本字段在前 + files 依序，与 mpRequestBody（files_test.go）DOM 序惯例一致） */
function multipartSameName(content: string, files: Array<{ filename: string; data: Buffer }>): { body: Buffer; ctype: string } {
  const boundary = '----qd-e2e-' + Math.random().toString(36).slice(2)
  const chunks: Buffer[] = []
  if (content !== '') {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n${content}\r\n`,
      'utf8',
    ))
  }
  for (const f of files) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${f.filename}"\r\nContent-Type: text/plain\r\n\r\n`, 'utf8'),
      f.data,
      Buffer.from('\r\n', 'utf8'),
    )
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return { body: Buffer.concat(chunks), ctype: `multipart/form-data; boundary=${boundary}` }
}

/** 访客侧 multipart 同批同名双文件投递（fid 消歧用例的种子；双文件均 accepted） */
async function postSameNameBatch(
  request: APIRequestContext,
  token: string,
  content: string,
): Promise<{ docId: string; fids: string[] }> {
  const { body, ctype } = multipartSameName(content, [
    { filename: 'report.txt', data: Buffer.from('run A output') },
    { filename: 'report.txt', data: Buffer.from('run B output') },
  ])
  const res = await request.post(`${BASE}/drop/${token}`, {
    data: body,
    headers: { 'Content-Type': ctype },
    maxRedirects: 0,
  })
  expect(res.ok(), '双文件投递 200').toBeTruthy()
  const out = (await res.json()) as { data?: { id?: string }; added?: { id?: string; kind?: string }[] }
  const fids = (out.added || []).map(a => a.id || '').filter(Boolean)
  expect(fids, 'added[] 两枚 fid').toHaveLength(2)
  return { docId: out.data?.id || '', fids }
}

test('S3 dropfile 下载：同名同批 fid 消歧 + 附件头 + 门面 404/400', async ({ request }) => {
  const token = await createDropToken(request)
  const { docId, fids } = await postSameNameBatch(request, token, 'S3 fid 消歧 3a1f')

  // 清单投影：逐文件 id/name/absPath（机器面元数据，前端记录区与交给会话的取数面）
  const row = (await listInbox(request)).find(d => d.id === docId)
  expect(row, '清单行在场').toBeTruthy()
  expect(row!.files?.length, '逐文件投影 = 2').toBe(2)
  expect(row!.files![0].id, 'fid 天然唯一').not.toBe(row!.files![1].id)
  expect(row!.files![0].name).toBe('report.txt')
  expect(row!.files![0].absPath, '主人侧绝对路径投影').toContain('artifacts')

  // fid 消歧：两个 fid 各取回各自字节（落盘名 <id>_<名> 天然唯一，同名不歧义）
  const dl0 = await request.get(`${BASE}/api/quickdrop/dropfile/${docId}?fid=${fids[0]}`)
  expect(dl0.status()).toBe(200)
  expect(await dl0.text()).toBe('run A output')
  // 附件红线：octet-stream + attachment（上传素材永不内联渲染）
  expect(dl0.headers()['content-type']).toBe('application/octet-stream')
  expect(dl0.headers()['content-disposition']).toContain('attachment')
  const dl1 = await request.get(`${BASE}/api/quickdrop/dropfile/${docId}?fid=${fids[1]}`)
  expect(dl1.status()).toBe(200)
  expect(await dl1.text()).toBe('run B output')

  // 门面：未知 fid 404 / 缺 fid 400 / 未知条目 404（与「不存在」不可区分）
  expect((await request.get(`${BASE}/api/quickdrop/dropfile/${docId}?fid=999`)).status()).toBe(404)
  expect((await request.get(`${BASE}/api/quickdrop/dropfile/${docId}`)).status()).toBe(400)
  expect((await request.get(`${BASE}/api/quickdrop/dropfile/sc_qd_none?fid=${fids[0]}`)).status()).toBe(404)
})

test('S3 管理卡记录区：清单可见 + 浏览器直链下载 + 摘除联动', async ({ page, request }) => {
  test.setTimeout(90000)
  const token = await createDropToken(request)
  const { docId, fids } = await postSameNameBatch(request, token, 'S3 记录区 e5d2')

  const card = await openShareManager(page)
  const record = card.locator('[data-testid="qd-record"]').filter({ hasText: 'S3 记录区 e5d2' })
  await expect(record).toHaveCount(1, { timeout: 10000 })
  await expect(record.locator('[data-testid="qd-file-row"]')).toHaveCount(2)
  await expect(record.locator('[data-form="files"]')).toContainText('2 个文件')

  // 浏览器直链下载：<a download> 程序化点击 → 下载事件（服务端附件头 = 保存名权威）
  const dlPromise = page.waitForEvent('download')
  await record.locator('[data-testid="qd-file-download"]').first().click()
  const dl = await dlPromise
  expect(dl.suggestedFilename()).toBe('report.txt')

  // 摘除联动：确认弹层 → 记录消失 → dropfile 双亡 404（配额即时回收的端点面）
  await record.locator('[data-testid="qd-record-del"]').click()
  await page.locator('.n-dialog', { hasText: '摘除投递记录' }).getByRole('button', { name: '确认' }).click()
  await expect(record).toHaveCount(0, { timeout: 5000 })
  expect((await request.get(`${BASE}/api/quickdrop/dropfile/${docId}?fid=${fids[0]}`)).status()).toBe(404)
  expect((await request.get(`${BASE}/api/quickdrop/dropfile/${docId}?fid=${fids[1]}`)).status()).toBe(404)
})

test('S3 轮换清盘：在册条目保留、文件投影清零、dropfile 404', async ({ request }) => {
  const token = await createDropToken(request)
  const { docId, fids } = await postSameNameBatch(request, token, 'S3 轮换互涉 b7c9')

  // 轮换（生成即轮换）→ 隔离区显式清盘；收件箱 doc 不随动（文本照常 TTL 过窗）
  await createDropToken(request)
  const row = (await listInbox(request)).find(d => d.id === docId)
  expect(row, '在册条目保留').toBeTruthy()
  expect(row!.files?.length ?? 0, '文件投影清零').toBe(0)
  expect(
    (await request.get(`${BASE}/api/quickdrop/dropfile/${docId}?fid=${fids[0]}`)).status(),
    '目录清盘即 404',
  ).toBe(404)
})

test('S3 交给会话路径投影：新会话 launchArgs 含逐文件绝对路径', async ({ page, request }) => {
  test.setTimeout(90000)
  const token = await createDropToken(request)
  const upload = await request.post(`${BASE}/drop/${token}`, {
    multipart: {
      content: 'S3 投影 c9e1 panic in parser.go',
      files: { name: 'trace.log', mimeType: 'text/plain', buffer: Buffer.from('goroutine 1 panic') },
    },
  })
  expect(upload.ok()).toBeTruthy()
  const row = (await listInbox(request)).find(d => d.content.includes('S3 投影 c9e1'))
  expect(row?.files?.[0]?.absPath, '投影含 absPath').toBeTruthy()
  const absPath = row!.files![0].absPath

  await openNotificationCenter(page)
  const nrow = page.locator('.nc-item').filter({ hasText: '收到快投递文件' }).filter({ hasText: 'trace.log' }).first()
  await expect(nrow).toBeVisible({ timeout: 5000 })
  const newBtn = nrow.locator('.nc-second-action', { hasText: '新会话处理' })
  await expect(newBtn).toBeVisible()

  // 拦截创建请求：launchArgs = 模板头 + 投递原文 + 逐文件绝对路径段
  //（dropPathSection 投影——Content 明细行 4KB 裁切的免疫面）
  const reqPromise = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await newBtn.click()
  const req = await reqPromise
  const body = req.postDataJSON() as { kind?: string; launchArgs?: string }
  expect(body.kind, '请求体 kind=agent').toBe('agent')
  expect(body.launchArgs, 'launchArgs 含文本载荷').toContain('S3 投影 c9e1')
  expect(body.launchArgs, 'launchArgs 含逐文件绝对路径').toContain(absPath)

  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
})
