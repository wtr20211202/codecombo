import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 更新链出站代理设置 E2E（P-20261109-12 + P-20261110-1 S6）：版本面板「更新代理」
 * 输入与「自动探测系统代理」开关/生效档位展示。
 *   1. 面板可见性与回显——挂载 settings GET 的 updateProxy 灌入输入框
 *   2. 客户端 scheme 早反馈——非法形态报错不发请求
 *   3. 服务端保存 + 归一回读——缺端口补默认（socks5→1080）经真实后端往返，
 *      重开面板回显存盘形态
 *   4. 空串清除——回环境变量感知形态，测试末复位防共享实例泄漏
 *      4b. S7 补强「proxy-status 呈现」：显式代理在场窗口内三方一致（确定性，不
 *          依赖宿主代理态）——设置存盘形态 ↔ 端点 tier=explicit+精确地址回显 ↔
 *          面板档位文案「显式代理 · <地址>」；清空后三面同步离开 explicit
 *      4c. S7 补强脱敏呈现（确定性）：显式代理带 userinfo 时端点回显与面板档位
 *          文案都是 ***@ 形态、整份 payload 与档位展示无口令——第 6 条的脱敏检查
 *          是「地址含 @ 才断言」，宿主无带凭据代理时恒不触发
 *   5. S6 自动探测开关：默认关 → 开（持久化，刷新仍开）→ 档位展示在场且属四档
 *      之一（不断言具体档位——宿主代理态不确定，精确裁决由 Go 单测背书）→ 关复位
 *   6. S6 proxy-status 端点：200 且字段齐、档位四值、代理地址回显脱敏
 *
 * 传输层行为（CONNECT 隧道 / SOCKS5 / 域名白名单守卫 / 四档优先级 / NO_PROXY）
 * 由 Go 单测覆盖（server/update/urlsafety_test.go、proxytier_test.go，测试内自起
 * 本地代理与假探测器，零外部网络副作用）；本 spec 只钉 UI→API 契约。代理行为用
 * 真实外呼验证既不可控也违护栏（不碰本机/WSL 系统代理、持久 env、git/npm 配置），
 * 刻意不做。
 */

/** 版本面板经首页 logo 版本弹窗打开（与 version-uptodate-feedback 同款入口） */
async function openVersionPanel(page: Page) {
  await page.locator('[data-testid="home-logo"]').click()
  const card = page.locator('.version-card')
  await expect(card).toBeVisible({ timeout: 5000 })
  return card
}

/** 「更新代理」输入框与其保存按钮（占位符含 socks5，与中心分发源输入区分） */
function proxyControls(card: ReturnType<Page['locator']>) {
  const input = card.locator('input[placeholder*="socks5"]')
  const save = input.locator('xpath=following-sibling::button')
  return { input, save }
}

async function saveProxy(page: Page, card: ReturnType<Page['locator']>, value: string, expectToast: string) {
  const { input, save } = proxyControls(card)
  await input.fill(value)
  await save.click()
  await expect(page.locator('.n-message').filter({ hasText: expectToast })).toBeVisible({ timeout: 5000 })
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

// 失败兜底复位（update-autocheck-switch 同款）：两例都改服务端全局设置，成功路径
// 各自在流程内复位；断言中途失败则会把显式代理（含带凭据夹具）或探测开关留在
// 共享实例上——后续 spec 的更新检查会被指到不可达代理。此处无条件还原出厂默认
//（空代理 + 开关关，成功路径上幂等）
test.afterEach(async ({ request }) => {
  await request.put(`${API_BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { updateProxy: '', updateProxyAutoDetect: false },
  })
})

test('更新代理：非法早反馈 / 保存归一回读 / 空串清除 / 显式档三方一致 / 凭据脱敏', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const card = await openVersionPanel(page)
  const { input, save } = proxyControls(card)
  await expect(input).toBeVisible()

  // 非法 scheme：客户端早反馈报错，不发保存请求（无成功 toast；保存态留在输入框）
  await input.fill('ftp://proxy.example')
  await save.click()
  await expect(page.locator('.n-message').filter({ hasText: '代理地址须以' })).toBeVisible({ timeout: 5000 })

  // 合法形态：保存成功 toast（服务端热化 + 落盘）
  await saveProxy(page, card, 'socks5://proxy.example', '更新代理已保存')

  // S7「proxy-status 呈现」三方一致（显式档确定性形态）：端点档位/地址与设置面板
  // 同源——tier=explicit + 存盘归一地址原样回显 + 开关默认关；面板档位文案精确
  // 「显式代理 · <归一地址>」（保存后档位展示跟随刷新，VersionPanel loadProxyStatus）
  const res = await request.get(`${API_BASE}/api/updates/proxy-status`)
  expect(res.status()).toBe(200)
  const data = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {}
  expect(data.tier).toBe('explicit')
  expect(data.proxy).toBe('socks5://proxy.example:1080')
  expect(data.autoDetect).toBe(false)
  await expect(card.locator('[data-testid="version-proxy-tier"] .version-value')).toHaveText(
    '显式代理 · socks5://proxy.example:1080', { timeout: 5000 },
  )

  // 重开面板回显服务端归一形态：socks5 缺端口补默认 1080（NormalizeProxyURL 真实栈往返）
  await page.reload()
  await gotoAndUnlock(page, `${API_BASE}/`)
  const card2 = await openVersionPanel(page)
  const { input: input2 } = proxyControls(card2)
  await expect(input2).toHaveValue('socks5://proxy.example:1080', { timeout: 5000 })

  // S7「proxy-status 呈现」脱敏（确定性形态）：第二用例里的脱敏检查是「地址含 @
  // 才断言」的条件式，宿主未配带凭据代理时恒不触发——这里以显式代理带 userinfo
  // 的形态钉死：端点回显与面板档位文案都是 ***@ 形态，口令不出现在任何回显字段
  //（输入框回显原值属 GET /settings 既有面，不在本断言内）。同步点取保存请求
  // 响应而非 toast：随后的清除步骤还要等同文案 toast，这里等它散尽免得两条并存
  const credSaved = page.waitForResponse(r =>
    r.url().includes('/api/settings') && r.request().method() === 'PUT' && r.ok())
  await input2.fill('http://e2e-user:e2e-pass@proxy.example:8080')
  await proxyControls(card2).save.click()
  await credSaved
  const resCred = await request.get(`${API_BASE}/api/updates/proxy-status`)
  expect(resCred.status()).toBe(200)
  const dataCred = ((await resCred.json()) as { data?: Record<string, unknown> }).data ?? {}
  expect(dataCred.tier).toBe('explicit')
  expect(dataCred.proxy).toBe('http://***@proxy.example:8080')
  expect(JSON.stringify(dataCred)).not.toContain('e2e-pass') // 整份 payload 无口令回显
  const tierCred = card2.locator('[data-testid="version-proxy-tier"] .version-value')
  await expect(tierCred).toHaveText('显式代理 · http://***@proxy.example:8080', { timeout: 5000 })
  await expect(tierCred).not.toContainText('e2e-pass')
  await expect(page.locator('.n-message').filter({ hasText: '更新代理已保存' })).toHaveCount(0, { timeout: 10000 })

  // 空串 = 清除：保存后重开回显空（复位共享实例，防泄入其他 spec）
  const { input: input3, save: save3 } = proxyControls(card2)
  await input3.fill('')
  await save3.click()
  await expect(page.locator('.n-message').filter({ hasText: '更新代理已保存' })).toBeVisible({ timeout: 5000 })

  // 清除后三面同步离开 explicit（落到 env/direct 视宿主代理态而定，不精确裁决）：
  // 端点档位不再是 explicit、direct 档生效地址回空（env 档宿主态定），面板档位
  // 文案不再含「显式代理」
  const res2 = await request.get(`${API_BASE}/api/updates/proxy-status`)
  expect(res2.status()).toBe(200)
  const data2 = ((await res2.json()) as { data?: Record<string, unknown> }).data ?? {}
  expect(data2.tier).not.toBe('explicit')
  if (data2.tier === 'direct') expect(data2.proxy).toBe('')
  await expect(card2.locator('[data-testid="version-proxy-tier"]')).not.toContainText('显式代理', { timeout: 5000 })

  await page.reload()
  await gotoAndUnlock(page, `${API_BASE}/`)
  const card3 = await openVersionPanel(page)
  await expect(proxyControls(card3).input).toHaveValue('', { timeout: 5000 })
})

// S6 自动探测开关持久化 + 生效档位展示。开关服务端全局设置：首尾显式复位默认关，
// 不泄给共享实例的其他 spec
test('系统代理自动探测：开关持久化 + 当前生效档位展示 + proxy-status 端点契约', async ({ page, request }) => {
  test.setTimeout(90_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  // proxy-status 端点：200 且字段齐（恒在场形态）、档位四值、目标口径 github.com、
  // 地址回显脱敏（含 userinfo 时必须是 ***@ 形态）
  const res = await request.get(`${API_BASE}/api/updates/proxy-status`)
  expect(res.status()).toBe(200)
  const payload = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {}
  for (const key of ['tier', 'target', 'proxy', 'autoDetect', 'detectedProxy', 'detectedSource', 'detectedAt', 'detectError', 'noProxyMatch']) {
    expect.soft(payload, `proxy-status 缺字段 ${key}`).toHaveProperty(key)
  }
  expect(['explicit', 'env', 'sysdetect', 'direct']).toContain(payload.tier)
  expect(payload.target).toBe('github.com')
  for (const key of ['proxy', 'detectedProxy']) {
    const v = payload[key]
    if (typeof v === 'string' && v.includes('@')) {
      expect.soft(v, `${key} 回显须脱敏 userinfo`).toContain('***@')
    }
  }

  // 开关默认关 → 开（保存成功 toast 即生效：服务端装配点同步探测）
  const card = await openVersionPanel(page)
  const sw = card.locator('[data-testid="version-proxy-autodetect-switch"]')
  await expect(sw).toHaveAttribute('aria-checked', 'false', { timeout: 5000 })
  await sw.click()
  await expect(page.locator('.n-message').filter({ hasText: '自动探测设置已保存' })).toBeVisible({ timeout: 5000 })

  // 刷新仍开（持久化）；档位展示在场且属四档之一（不断言具体档位——宿主代理态不确定）
  await page.reload()
  await gotoAndUnlock(page, `${API_BASE}/`)
  const card2 = await openVersionPanel(page)
  const sw2 = card2.locator('[data-testid="version-proxy-autodetect-switch"]')
  await expect(sw2).toHaveAttribute('aria-checked', 'true', { timeout: 5000 })
  const tier = card2.locator('[data-testid="version-proxy-tier"]')
  await expect(tier).toBeVisible({ timeout: 5000 })
  const tierText = (await tier.textContent()) ?? ''
  expect(['显式代理', '环境变量', '系统代理', '直连'].some(label => tierText.includes(label)))
    .toBe(true)

  // 关（复位共享实例默认关）
  await sw2.click()
  await expect(page.locator('.n-message').filter({ hasText: '自动探测设置已保存' })).toBeVisible({ timeout: 5000 })
  await page.reload()
  await gotoAndUnlock(page, `${API_BASE}/`)
  const card3 = await openVersionPanel(page)
  await expect(card3.locator('[data-testid="version-proxy-autodetect-switch"]')).toHaveAttribute('aria-checked', 'false', { timeout: 5000 })
})
