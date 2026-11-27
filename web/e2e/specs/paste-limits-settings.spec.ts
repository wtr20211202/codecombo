import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

// 粘贴上传限额后台可配置（P-20261123-6 S2 e2e，方案⑧）：设置页把 share file
// 调到 1MB → 分享访客页 reload 断言 window.__scPasteLimits 注入恰一次且在
// writable 生命周期前 → 2MB 上传被拒（服务端 413 早拒兜底路径访客面是 400
// too_large → puTooLarge 可读提示）→ 恢复默认。owner 25MB 默认成功由 P-5 保留
//（Go 端点单测实上传覆盖，此处不做大载荷 e2e）。
// 说明：API 面用例走直调（PUT /api/settings 叶子级增量）——设置页尚无 vitest
// 组件测试，且 jsdom 无布局，控件可见性/数值宽度只能由本文件的 Playwright UI
// 用例断言（P-20261125-1）；P-20261126-1 起「恢复默认」写显示默认数字而非 pending 0
//（0 哨兵只在 PUT 载荷出现），UI 用例同时断言恢复后的显示值/脏标记/载荷。

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const DEFAULT_PASSWORD = 'admin'

/** 用例建的临时 shell 会话 id：afterEach 统一删除——残留会话会在底部终端面板
 *  堆出多 tab，同套件的「新建终端 → .xterm.last()」断言会选到别的屏（实锚：
 *  narrow-screen 终端抽屉用例在多次复跑累积 4+ 残留后稳定失败） */
const createdSessionIds: string[] = []

/** 建可写终端分享两段式（share-writable-paste-key 同款）：unlock→project→
 * terminal→share/terminal→writable（confirm+口令）。token 缺失=环境不支持 */
async function makeWritableTerminalShare(
  request: import('@playwright/test').APIRequestContext,
  tag: string,
): Promise<string | null> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const unlock = ((await res.json()) as { token?: string }).token || ''
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': unlock }
  const projects = ((await (await request.get(`${BASE}/api/projects`, { headers })).json()) as { data?: { id: string; name: string }[] }).data || []
  const project = projects.find(x => x.name === 'simple-coding')
  if (!project) return null
  const tr = await request.post(`${BASE}/api/terminals`, {
    headers, data: { projectId: project.id, name: `e2e-pl-${tag}-${Date.now()}`, kind: 'shell' },
  })
  if (!tr.ok()) return null
  const sessionId = ((await tr.json()) as { data?: { id?: string } }).data?.id
  if (!sessionId) return null
  createdSessionIds.push(sessionId)
  const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
  if (!share.ok()) return null
  const token = ((await share.json()) as { data?: { token?: string } }).data?.token
  if (!token) return null
  const wr = await request.post(`${BASE}/api/share/${token}/writable`, {
    headers, data: { on: true, confirm: true, passphrase: 'wr-e2e-pass-1' },
  })
  if (!wr.ok()) return null
  return token
}

async function getShareBase(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const unlock = ((await res.json()) as { token?: string }).token || ''
  const headers = { 'X-Lock-Token': unlock }
  const st = ((await (await request.get(`${BASE}/api/share/status`, { headers })).json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!st?.running) throw new Error('share service not running')
  return `${st.scheme || 'http'}://localhost:${st.port}`
}

type PasteLimitsSeed = Partial<Record<'owner' | 'share' | 'remote', { fileMB?: number; imageMB?: number }>>

/** PUT pasteLimits 播种（解锁拿 token——锁定开启时写接口需 X-Lock-Token） */
async function seedPasteLimits(
  request: import('@playwright/test').APIRequestContext,
  pasteLimits: PasteLimitsSeed,
): Promise<void> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const unlock = ((await res.json()) as { token?: string }).token || ''
  const r = await request.put(`${BASE}/api/settings`, {
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlock },
    data: { pasteLimits },
  })
  expect(r.ok()).toBeTruthy()
}

async function resetPasteLimits(request: import('@playwright/test').APIRequestContext): Promise<void> {
  // 显式 0 = 恢复默认（PUT 协议哨兵）；前端显示/载荷分离后测试复位仍走此契约
  await seedPasteLimits(request, { share: { fileMB: 0, imageMB: 0 }, owner: { fileMB: 0, imageMB: 0 } })
}

interface PasteLimitsEffective {
  owner: { fileMB: number; imageMB: number }
  share: { fileMB: number; imageMB: number }
  remote: { fileMB: number; imageMB: number }
}

async function fetchPasteLimits(request: import('@playwright/test').APIRequestContext): Promise<PasteLimitsEffective> {
  const res = await request.get(`${BASE}/api/settings`)
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { pasteLimits: PasteLimitsEffective } }).data.pasteLimits
}

test.describe('paste-limits settings (P-20261123-6)', () => {
  const SHARED = '1'

  async function getSettings(request: import('@playwright/test').APIRequestContext) {
    const res = await request.get('/api/settings')
    expect(res.ok()).toBeTruthy()
    return (await res.json()).data
  }

  async function putPasteLimits(
    request: import('@playwright/test').APIRequestContext,
    pasteLimits: unknown,
  ) {
    const res = await request.put('/api/settings', { data: { pasteLimits } })
    expect(res.ok()).toBeTruthy()
  }

  test.afterEach(async ({ request }) => {
    // 临时终端会话（分享链建的）best-effort 删除：残留会堆多 tab（见 helper 注记）
    for (const id of createdSessionIds.splice(0)) {
      await request.delete(`${BASE}/api/terminals/${id}`).catch(() => undefined)
    }
    // 恢复默认（显式 0）——测试隔离：不论断言成败都复位，防污染后续用例
    await resetPasteLimits(request)
  })

  test('GET 生效值+spec 存在（默认 owner 100/20、share 20/10）', async ({ request }) => {
    const data = await getSettings(request)
    const pl = data.pasteLimits
    expect(pl).toBeTruthy()
    expect(pl.owner.fileMB).toBe(100)
    expect(pl.owner.imageMB).toBe(20)
    expect(pl.owner.bodyMB).toBe(104)
    expect(pl.share.fileMB).toBe(20)
    expect(pl.share.imageMB).toBe(10)
    expect(pl.remote.fileMB).toBe(20)
    const spec = data.pasteLimitsSpec
    expect(spec.defaults.owner.fileMB).toBe(100)
    expect(spec.ranges.owner.fileMax).toBe(512)
    expect(spec.ranges.share.fileMax).toBe(20)
  })

  test('PUT 叶子级增量：只改 owner.fileMB，share/remote 不动', async ({ request }) => {
    await putPasteLimits(request, { owner: { fileMB: 200 } })
    const data = await getSettings(request)
    expect(data.pasteLimits.owner.fileMB).toBe(200)
    expect(data.pasteLimits.owner.bodyMB).toBe(204) // body 随 file 联动 +4MB
    expect(data.pasteLimits.share.fileMB).toBe(20) // 未携带 = 不动
    expect(data.pasteLimits.remote.fileMB).toBe(20)
  })

  test('非法值 400 + share 上调拒绝（上限=默认只许下调）', async ({ request }) => {
    const res1 = await request.put('/api/settings', { data: { pasteLimits: { owner: { fileMB: 600 } } } })
    expect(res1.status()).toBe(400)
    expect(await res1.text()).toContain('pasteLimits.owner.fileMB out of range (1-512 or 0 to reset)')
    const res2 = await request.put('/api/settings', { data: { pasteLimits: { share: { fileMB: 50 } } } })
    expect(res2.status()).toBe(400)
  })

  test('热改 share 1MB → 2MB 上传 400 too_large → 恢复默认后 200（按请求现读）', async ({ page, request }) => {
    const token = await makeWritableTerminalShare(request, 'hot')
    test.skip(!token, 'share creation unavailable in this data plane')

    // 口令门（gateGuard）：分享带口令——page 过一次口令页拿会话 cookie，其后
    // 页内 fetch 携带凭证打 paste-upload
    const shareBase = await getShareBase(request)
    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill('wr-e2e-pass-1')
    await page.locator('.field button').click()
    await page.waitForURL(`**/s/${token}**`)

    await putPasteLimits(request, { share: { fileMB: 1, imageMB: 1 } })
    const upload2MB = (): Promise<{ status: number; body: string }> => page.evaluate(async (tok) => {
      const twoMB = new Uint8Array(2 * 1024 * 1024).fill(97)
      const fd = new FormData()
      fd.append('visitorId', 'e2e-limits')
      fd.append('file', new File([twoMB], 'a.zip', { type: 'application/zip' }), 'a.zip')
      const res = await fetch(`/s/${tok}/paste-upload`, { method: 'POST', body: fd })
      return { status: res.status, body: await res.text() }
    }, token)
    const r1 = await upload2MB()
    expect(r1.status).toBe(400)
    expect(r1.body).toContain('too_large')

    // 恢复默认（显式 0）→ 2MB 上传成功（20MB 限内）——同请求现读，无缓存墙
    await putPasteLimits(request, { share: { fileMB: 0, imageMB: 0 } })
    const r2 = await upload2MB()
    expect(r2.status).toBe(200)
    expect(r2.body).toContain('sc-paste-')
  })

  test('访客页注入 __scPasteLimits：恰一次且为当前生效值', async ({ page, request }) => {
    const token = await makeWritableTerminalShare(request, 'inject')
    test.skip(!token, 'share creation unavailable in this data plane')

    await putPasteLimits(request, { share: { fileMB: 3, imageMB: 2 } })
    // no-store：reload 必拿新鲜注入；口令门先过（gateGuard）
    const shareBase2 = await getShareBase(request)
    await page.goto(`${shareBase2}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill('wr-e2e-pass-1')
    await page.locator('.field button').click()
    await page.goto(`${shareBase2}/s/${token}`)
    const injected = await page.evaluate(() => ({
      count: (window as unknown as { __scPasteLimitsSeen?: number }).__scPasteLimitsSeen ?? 1,
      limits: (window as unknown as { __scPasteLimits?: { fileMB: number; imageMB: number } }).__scPasteLimits,
    }))
    expect(injected.limits).toBeTruthy()
    expect(injected.limits.fileMB).toBe(3)
    expect(injected.limits.imageMB).toBe(2)
    // 注入恰一次（页面脚本不含重复赋值——评审 ⑧「恰出现一次」）
    expect(injected.count).toBe(1)
  })
})

// P-20261125-1：六框结构收口的 UI 断言。回归形态 —— 数值在 DOM 有值但
// `.n-input__input` 被 NInputNumber 的 suffix（「文件 MB」+ 上下按钮，flex-shrink:0）
// 压成 0 宽，视觉全空、不可编辑；宽度/命中类断言只有真实布局的 Playwright 能守
// （jsdom 无布局）。150px 无 suffix 实测数值区 72px，断言取 ≥60px 留字体回退余量。
test.describe('paste-limits settings UI（P-20261125-1）', () => {
  /** 项目页 rail（窄屏经「更多」抽屉）→ 设置 → 终端分区 → 限额块滚入视口 */
  async function openTerminalPane(page: Page) {
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    const railSettings = page.locator('[data-testid="rail-settings"]')
    if (await railSettings.count()) {
      await railSettings.click()
    } else {
      // 窄屏（<700px）rail 收进「更多」抽屉
      await page.locator('[data-testid="rail-more"]').click()
      await page.locator('[data-testid="sheet-settings"]').click()
    }
    await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
    await page.locator('[data-testid="settings-nav-terminal"]').click()
    const block = page.locator('[data-testid="settings-paste-limits"]')
    await expect(block).toBeVisible({ timeout: 5000 })
    await block.scrollIntoViewIfNeeded()
    return block
  }

  /** owner 行（首行）：nth 0 = 文件、nth 1 = 图片 */
  function ownerRow(block: import('@playwright/test').Locator) {
    return block.locator('.paste-limit-row').first()
  }
  /** 行内「恢复默认」按钮：必须真实 <button>——行尾 SettingModifiedMark 的回退钮是
   *  span[role=button] 且同 aria-label，按 role 取会命中两个 */
  function restoreButton(row: import('@playwright/test').Locator) {
    return row.locator('button.n-button').filter({ hasText: '恢复默认' })
  }
  /** 收集保存链全部 PUT 载荷：SettingsModal.handleSave 先无条件调
   *  GeneralSettings.save()（每次全量 PUT），不能按请求序号取第一个 */
  function collectSettingsPuts(page: Page): string[] {
    const bodies: string[] = []
    page.on('request', (req) => {
      if (req.method() === 'PUT' && req.url().includes('/api/settings')) bodies.push(req.postData() || '')
    })
    return bodies
  }
  async function saveAndWaitClosed(page: Page) {
    await page.locator('.settings-footer').getByRole('button', { name: '保存' }).click()
    await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 10000 })
  }

  // 测试隔离：UI 用例会改落盘限额——每条后复位（既有复位原本只在 API describe）
  test.afterEach(async ({ request }) => {
    await resetPasteLimits(request)
  })

  test('六框非 0 宽、内层 input 可点击可聚焦、值完整可见且可编辑（1440）', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    const block = await openTerminalPane(page)
    const inputs = block.locator('.n-input-number input')
    await expect(inputs).toHaveCount(6)

    for (let i = 0; i < 6; i++) {
      const input = inputs.nth(i)
      await expect(input).toBeVisible()
      const geo = await input.evaluate((el) => {
        const inputEl = el as HTMLInputElement
        return { clientWidth: inputEl.clientWidth, scrollWidth: inputEl.scrollWidth, value: inputEl.value }
      })
      expect(geo.value, `第 ${i + 1} 框数值应存在`).toMatch(/^\d+$/)
      // 0 宽回归的主断言：数值区实际渲染宽度（原实现恒 0）
      expect(geo.clientWidth, `第 ${i + 1} 框数值区被压缩（宽度 0 回归）`).toBeGreaterThanOrEqual(60)
      // 值完整可见：无横向裁剪（scrollWidth 不超 clientWidth）
      expect(geo.scrollWidth, `第 ${i + 1} 框数值被裁切`).toBeLessThanOrEqual(geo.clientWidth + 1)
      // 可点击（0 宽时 Playwright 命中测试即失败）且可聚焦
      await input.click()
      await expect(input).toBeFocused()
    }

    // 可编辑：首框输入同值（不应产生「已修改」脏态，不落盘、不污染后续用例）
    const first = inputs.first()
    const original = await first.inputValue()
    await first.click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type(original)
    await expect(first).toHaveValue(original)
    await block.locator('.form-label').first().click() // 失焦提交显示值（同值）
    await expect(block.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  })

  test('390×844 窄屏：内容区零横向溢出，组内标签与数字框不被拆行且数值区不缩 0', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    const block = await openTerminalPane(page)
    const content = page.locator('.settings-content')

    // 与 narrow-screen.spec 同口径（1px 容差给亚像素取整）：旧布局此处溢出 98px
    await expect.poll(() => content.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1)

    const inputs = block.locator('.n-input-number input')
    await expect(inputs).toHaveCount(6)
    for (let i = 0; i < 6; i++) {
      const clientWidth = await inputs.nth(i).evaluate(el => (el as HTMLInputElement).clientWidth)
      expect(clientWidth, `第 ${i + 1} 框数值区被压缩（窄屏宽度 0 回归）`).toBeGreaterThanOrEqual(60)
    }

    // nowrap 子组：每组内「文件/图片」标签与数字框同一行——垂直中心对齐
    // （字号线盒高度不同，直接比 top 会差 ~4.4px，取中心距）且标签在框左缘之前
    const grouped = await block.evaluate((el) => {
      const rows = [...el.querySelectorAll('.paste-limit-row')]
      return rows.every(row => [...row.querySelectorAll('.paste-limit-group')].every((group) => {
        const label = group.querySelector('.paste-limit-field-label')
        const input = group.querySelector('.n-input-number')
        if (!label || !input) return false
        const l = label.getBoundingClientRect()
        const i = input.getBoundingClientRect()
        return Math.abs((l.top + l.height / 2) - (i.top + i.height / 2)) < 3
          && l.right <= i.left + 1
      }))
    })
    expect(grouped, '「文件/图片 + 数字框」组被拆行').toBe(true)
  })

  test('恢复默认：150/30 → 显示 100/20 + 脏标记，失焦不被钳成 1，保存发 0/0 且回读默认', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    // 播种两叶都偏离默认（image 30 ≤ file 150、≤64 合法）：恢复后两叶都要发 0
    await seedPasteLimits(request, { owner: { fileMB: 150, imageMB: 30 } })

    const block = await openTerminalPane(page)
    const row = ownerRow(block)
    const inputs = row.locator('.n-input-number input')
    await expect(inputs.nth(0)).toHaveValue('150')
    await expect(inputs.nth(1)).toHaveValue('30')

    await restoreButton(row).click()
    // 显示值/哨兵分离（P-20261126-1 S1）：恢复默认写真实默认数字，不再显示 0
    await expect(inputs.nth(0)).toHaveValue('100')
    await expect(inputs.nth(1)).toHaveValue('20')
    await expect(row.locator('[data-testid="settings-modified-mark"]')).toBeVisible()

    // 1MB 钳制回归：点进框再点走（focus+blur，不改值）仍是 100/20
    for (let i = 0; i < 2; i++) {
      await inputs.nth(i).click()
      await expect(inputs.nth(i)).toBeFocused()
      await block.locator('.form-label').first().click()
    }
    await expect(inputs.nth(0)).toHaveValue('100')
    await expect(inputs.nth(1)).toHaveValue('20')

    const puts = collectSettingsPuts(page)
    await saveAndWaitClosed(page)

    const plPuts = puts.filter(b => b.includes('"pasteLimits"'))
    expect(plPuts.length, '保存链应恰有一个 pasteLimits PUT（TerminalSettings）').toBe(1)
    const payload = JSON.parse(plPuts[0]) as {
      pasteLimits: { owner: Record<string, number>; share: Record<string, number>; remote: Record<string, number> }
    }
    // 恢复默认的叶子发 0 哨兵（保留「跟随未来默认」契约）
    expect(payload.pasteLimits.owner).toEqual({ fileMB: 0, imageMB: 0 })
    // 未变更端对象仍存在但无叶子（叶子级增量，不整体缺省）
    expect(payload.pasteLimits.share).toEqual({})
    expect(payload.pasteLimits.remote).toEqual({})

    // 服务端回读：0 哨兵落 0，生效值 = 默认
    const effective = await fetchPasteLimits(request)
    expect(effective.owner.fileMB).toBe(100)
    expect(effective.owner.imageMB).toBe(20)

    // 重开：显示生效值且无脏标记
    const reopened = await openTerminalPane(page)
    const reRow = ownerRow(reopened)
    await expect(reRow.locator('.n-input-number input').nth(0)).toHaveValue('100')
    await expect(reRow.locator('.n-input-number input').nth(1)).toHaveValue('20')
    await expect(reRow.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  })

  test('已默认态点「恢复默认」：值不变、无脏标记，保存载荷不含 pasteLimits', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await resetPasteLimits(request) // 起点显式复位为默认（不受前序套件污染）
    const block = await openTerminalPane(page)
    const row = ownerRow(block)
    const inputs = row.locator('.n-input-number input')
    await expect(inputs.nth(0)).toHaveValue('100')
    await expect(inputs.nth(1)).toHaveValue('20')

    await restoreButton(row).click()
    await expect(inputs.nth(0)).toHaveValue('100')
    await expect(inputs.nth(1)).toHaveValue('20')
    await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)

    const puts = collectSettingsPuts(page)
    await saveAndWaitClosed(page)
    // GeneralSettings 的全量 PUT 仍在（不能说「不发 PUT」），但没有任何载荷带 pasteLimits
    expect(puts.length, '保存链仍应发出 GeneralSettings 的 PUT').toBeGreaterThan(0)
    expect(puts.filter(b => b.includes('"pasteLimits"'))).toHaveLength(0)
  })

  test('行级「已修改」标记的回退钮：改 owner.fileMB 120 → 点标记恢复 → 100 且标记消失', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await resetPasteLimits(request) // 起点默认，恢复后才会回到无脏态
    const block = await openTerminalPane(page)
    const row = ownerRow(block)
    const inputs = row.locator('.n-input-number input')
    await inputs.nth(0).click()
    await page.keyboard.press('Control+a')
    await page.keyboard.type('120')
    await block.locator('.form-label').first().click() // 失焦提交显示值
    await expect(inputs.nth(0)).toHaveValue('120')
    await expect(row.locator('[data-testid="settings-modified-mark"]')).toBeVisible()

    // 与行内「恢复默认」按钮同一函数：标记 @restore 回退该行全部叶子
    await row.locator('[data-testid="settings-restore-default"]').click()
    await expect(inputs.nth(0)).toHaveValue('100')
    await expect(inputs.nth(1)).toHaveValue('20')
    await expect(row.locator('[data-testid="settings-modified-mark"]')).toHaveCount(0)
  })

  test('恢复默认后不保存关闭：出现未保存确认（isDirty 覆盖限额）', async ({ page, request }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await seedPasteLimits(request, { owner: { fileMB: 150, imageMB: 30 } })
    const block = await openTerminalPane(page)
    const row = ownerRow(block)
    await restoreButton(row).click()
    await expect(row.locator('[data-testid="settings-modified-mark"]')).toBeVisible()

    await page.locator('.settings-close').click()
    const dialog = page.locator('.n-dialog')
    await expect(dialog).toBeVisible({ timeout: 3000 })
    await expect(dialog).toContainText('未保存的修改')
    await dialog.getByRole('button', { name: '丢弃并关闭' }).click()
    await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })
  })
})
