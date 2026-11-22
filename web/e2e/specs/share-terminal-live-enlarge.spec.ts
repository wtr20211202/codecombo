import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 终端分享访客页宽度自适应放大（P-20261119-2）E2E：
 * 用户实测主诉 = 主机 80 列 vs ~1920px 访客容器（宽度比 ≈2.3×），xterm 元素按
 * 主机栅格定宽居中、两侧大空白。访客侧须宽度优先放大字号（3× 上限）铺满容器。
 *
 * 务实形态（评审核建议采纳）：spec 内先 PUT /api/terminals/:id/resize {cols:80,
 * rows:24} 预设主机栅格再建分享——现有会话从未 Resize 时 hello 无 cols（omitempty），
 * 访客页走 doFit 路径，放大面根本不触发。断言 data-cols=80 + fontSize>14 +
 * xterm 元素宽度填充率；放大致纵向溢出（data-overset=1）时钉底须让最新输出行
 * （提示符）在窗内（钉锚=光标行：满屏输出即贴底、新鲜空格滚到提示符行为止），
 * 勿硬钉 overset 必现——依赖 header/banner 高度。
 * 子服务端口经 /api/share/status 动态获取（默认主端口+2）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const HOST_COLS = 80
const HOST_ROWS = 24

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

test.describe('share-terminal-live-enlarge', () => {
  test.beforeEach(async ({ request }) => {
    await cleanupShares(request)
  })

  let liveSessionId = ''
  test.afterEach(async ({ request }) => {
    if (liveSessionId) {
      const headers = await unlockHeaders(request)
      await request.delete(`${BASE}/api/terminals/${liveSessionId}`, { headers })
      liveSessionId = ''
    }
  })

  test('窄主机+宽视口：访客侧字号放大铺满容器宽度，overset 态钉底可见', async ({ page, request }) => {
    test.setTimeout(90_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)

    const created = await request.post(`${BASE}/api/terminals`, { headers, data: { projectId, name: 'e2e-enlarge-src' } })
    expect(created.ok()).toBeTruthy()
    const sessionId = ((await created.json()) as { data?: { id?: string } }).data!.id!
    liveSessionId = sessionId

    // 预 resize：钉住主机栅格 80×24（hello 帧携 cols→访客页走 scFitGrid 栅格路径）
    const rz = await request.put(`${BASE}/api/terminals/${sessionId}/resize`, {
      headers, data: { rows: HOST_ROWS, cols: HOST_COLS },
    })
    expect(rz.ok()).toBeTruthy()

    const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(share.ok()).toBeTruthy()
    const token = ((await share.json()) as { data?: { token: string } }).data!.token!

    // 宽视口访客页：字号放大收敛 + 栅格保真
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(`${shareBase}/s/${token}`)
    await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 20_000 })

    const box = page.locator('#termBox')
    // 栅格保真：cols×rows 恒为主机值（放大只动字号不动栅格）
    await expect(box).toHaveAttribute('data-cols', String(HOST_COLS), { timeout: 20_000 })
    await expect(box).toHaveAttribute('data-rows', String(HOST_ROWS))

    // 放大段闭环（need→wrap→aw→fs）经数轮 ResizeObserver 迭代收敛（单调递增被
    // 3× cap 兜底），等字号两读相同即稳
    await expect.poll(async () => {
      const a = await box.evaluate((el) => (el as HTMLElement).dataset.fontSize || '')
      await page.waitForTimeout(500)
      const b = await box.evaluate((el) => (el as HTMLElement).dataset.fontSize || '')
      return a !== '' && a === b ? 'stable' : 'moving'
    }, { timeout: 20_000, intervals: [500] }).toBe('stable')
    const fs = parseFloat(await box.evaluate((el) => (el as HTMLElement).dataset.fontSize || '0'))
    expect(fs).toBeGreaterThan(14)

    // xterm 元素宽度填充容器（两侧不再大空白）：宽度 ≥ 可用宽（去滚动条让位）的 80%
    const fill = await box.evaluate((el) => {
      const b = el as HTMLElement
      const term = b.querySelector('.xterm') as HTMLElement | null
      if (!term) return 0
      const cs = getComputedStyle(b)
      const avail = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 14
      return term.getBoundingClientRect().width / avail
    })
    expect(fill).toBeGreaterThan(0.8)

    // overset 条件断言（勿硬钉必现——依赖 header/banner 高度）：放大致纵向溢出时
    // 钉底必须让「最新输出行（提示符）」在窗内——钉到光标行（满屏输出即贴底，
    // 新鲜空格提示符在格顶时只滚到提示符行为止，不留空窗）。评审初稿的
    // scrollTop+clientHeight ≥ scrollHeight−cellH 不等式是「钉到格底」近似的
    // 断言形态，实现细化钉锚为光标行后随之升级为提示符行与窗相交
    const overset = await box.evaluate((el) => (el as HTMLElement).dataset.overset === '1')
    if (overset) {
      const promptVisible = await page.evaluate(() => {
        const box = document.getElementById('termBox')
        if (!box) return null
        const br = box.getBoundingClientRect()
        for (const row of document.querySelectorAll('.xterm-rows > div')) {
          if ((row.textContent || '').includes('PS ')) {
            const rr = row.getBoundingClientRect()
            return rr.bottom > br.top && rr.top < br.bottom
          }
        }
        return null // 提示符行未播种（空 shell）时跳过，不作断言
      })
      if (promptVisible !== null) expect(promptVisible).toBe(true)
    }

    // 直播流健康：徽标直播中 + 输出照常到达（放大面不破坏数据链路）
    await expect(page.locator('#badge[data-state="live"]')).toBeVisible({ timeout: 20_000 })
  })

  test('高会话矮终端区（hR<1）：字号布局宽度优先——不再压缩字号迁就高度（P-20261120-8 必改0）', async ({ page, request }) => {
    // 收缩分支盲区复现（用户第三轮主诉的机制实勘）：主机 80×60 高会话 ×
    // 1920×1080 访客（终端区 ~840px 高，60 行 × 14px 格高装不下 hR<1）——
    // 旧 min(1,wR,hR) 双拟合把字号压到 ~10.75px、网格保持 80 列基础宽（531px）
    // 居中窄条两侧大留白；宽度优先后 fs 随宽度放大（>14）、纵向超出走
    // overset 钉底（P-20261118-9 既有机制），栅格保真不动
    test.setTimeout(90_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)

    const created = await request.post(`${BASE}/api/terminals`, { headers, data: { projectId, name: 'e2e-tall-src' } })
    expect(created.ok()).toBeTruthy()
    const sessionId = ((await created.json()) as { data?: { id?: string } }).data!.id!
    liveSessionId = sessionId

    // 预 resize：钉住主机栅格 80×60（高会话——行数远超访客终端区高度）
    const rz = await request.put(`${BASE}/api/terminals/${sessionId}/resize`, {
      headers, data: { rows: 60, cols: HOST_COLS },
    })
    expect(rz.ok()).toBeTruthy()

    const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(share.ok()).toBeTruthy()
    const token = ((await share.json()) as { data?: { token: string } }).data!.token!

    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(`${shareBase}/s/${token}`)
    await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 20_000 })

    const box = page.locator('#termBox')
    // 栅格保真：宽度优先只动字号，列数行数恒为主机值（必改0 红线）
    await expect(box).toHaveAttribute('data-cols', String(HOST_COLS), { timeout: 20_000 })
    await expect(box).toHaveAttribute('data-rows', '60')

    // 字号收敛后断言：宽度优先 → fs 放大段生效（>14；旧行为 ~10.75 压缩）
    await expect.poll(async () => {
      const a = await box.evaluate((el) => (el as HTMLElement).dataset.fontSize || '')
      await page.waitForTimeout(500)
      const b = await box.evaluate((el) => (el as HTMLElement).dataset.fontSize || '')
      return a !== '' && a === b ? 'stable' : 'moving'
    }, { timeout: 20_000, intervals: [500] }).toBe('stable')
    const fs = parseFloat(await box.evaluate((el) => (el as HTMLElement).dataset.fontSize || '0'))
    expect(fs).toBeGreaterThan(14)

    // 纵向装不下 → overset 态（不再靠压字号规避；钉底让最新输出可见）
    expect(await box.evaluate((el) => (el as HTMLElement).dataset.overset === '1')).toBe(true)

    // 宽度填充：xterm 元素宽度占满容器可用宽（两侧不再大空白）
    const fill = await box.evaluate((el) => {
      const b = el as HTMLElement
      const term = b.querySelector('.xterm') as HTMLElement | null
      if (!term) return 0
      const cs = getComputedStyle(b)
      const avail = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 14
      return term.getBoundingClientRect().width / avail
    })
    expect(fill).toBeGreaterThan(0.8)

    await expect(page.locator('#badge[data-state="live"]')).toBeVisible({ timeout: 20_000 })
  })
})
