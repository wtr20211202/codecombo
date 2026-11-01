import { test, expect } from '@playwright/test'
import net from 'node:net'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD, projectCardByName, fetchWslHost } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 活跃隧道观测入口 E2E（P-20261004-19）：设置·远程部署分区「活跃隧道」行集
 * 消费既有 GET/DELETE tunnels 端点——
 *   1. API 开隧道（POST 既有）→ 分区行出现：「remote:N → local:M」映射
 *      （与预览徽标同措辞）+ 空闲 TTL 估算文案
 *   2. 行内手动关闭（DELETE 既有）→ 行消失 → API 列表确认清空
 *   3. 一致性：preview.port 带 hostId 直达 → 预览面板徽标映射与分区行完全一致
 * 环境门控（同 remote-tunnel-preview 惯例）：WSL 主机记录播种（scripts/
 * e2e-seed-wsl.sh）+ sshd 可达（端口取记录值，P-20261004-115 禁硬编码 :23）。
 * 重试安全：开隧道服务端同 key 幂等复用，重跑自愈。
 */

const BASE = API_BASE
const RPORT = 8977 // 远端测试服务端口（与 remote-tunnel-preview 同款，WSL 内回环）

function tcpReachable(port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

interface TunnelInfo { hostId?: string; remotePort?: number; localPort?: number }

let hostId = ''
let wslUp = false

/** 开（或复用）隧道并返回映射口（服务端同 key 幂等）。Node 全局 fetch：ok 为属性 */
async function ensureTunnel(headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${BASE}/api/remotehosts/${hostId}/tunnels`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ remotePort: RPORT }),
  })
  expect(res.ok, `open tunnel: ${res.status}`).toBeTruthy()
  const info = ((await res.json()) as { data?: TunnelInfo }).data
  expect(info?.localPort, 'localPort should be allocated').toBeTruthy()
  return info!.localPort!
}

async function apiTunnelList(headers: Record<string, string>): Promise<TunnelInfo[]> {
  const res = await fetch(`${BASE}/api/remotehosts/${hostId}/tunnels`, { headers })
  return ((await res.json()) as { data?: TunnelInfo[] }).data || []
}

/** 进项目页并打开设置·远程部署分区（活跃隧道面板宿主） */
async function openDeploySettings(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="settings-nav-deploy"]').click()
  await expect(page.locator('[data-testid="settings-pane-deploy"]')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('[data-testid="tunnel-panel"]')).toBeVisible({ timeout: 5000 })
}

test.beforeAll(async () => {
  // 先取播种记录再探针：端口以记录为准（槽位专用实例非 23，P-20261004-115）
  const wslHost = await fetchWslHost(BASE)
  hostId = wslHost?.id || ''
  wslUp = await tcpReachable(wslHost?.port || 23)
})

test.afterAll(async () => {
  // 清理本用例开的隧道 + 通知（幂等尽力而为；只清 RPORT 隧道不碰他用例资源）
  if (!hostId) return
  const headers = await unlockHeaders()
  for (const t of await apiTunnelList(headers)) {
    if (t.remotePort === RPORT && t.localPort) {
      await fetch(`${BASE}/api/remotehosts/${hostId}/tunnels/${t.localPort}`, { method: 'DELETE', headers })
    }
  }
  await fetch(`${BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('活跃隧道分区：API 开隧道 → 行出现（映射+TTL 文案）→ 行内关闭 → 行消失且列表清空', async ({ page }) => {
  test.skip(!hostId || !wslUp, 'WSL 主机记录未播种或 sshd 不可达')
  test.setTimeout(90000)
  const headers = await unlockHeaders()
  const localPort = await ensureTunnel(headers)

  await openDeploySettings(page)

  // 行出现：映射展示与预览徽标同措辞（远程 :N → 本机 :M），附空闲 TTL 估算
  const row = page.locator('[data-testid="tunnel-row"]').filter({ hasText: `远程 :${RPORT} →` })
  await expect(row, '开隧道后分区应出现该隧道行').toHaveCount(1, { timeout: 10000 })
  await expect(row.locator('.tunnel-mapping')).toHaveText(`远程 :${RPORT} → 本机 :${localPort}`)
  await expect(row).toContainText('空闲约')
  await expect(row).toContainText('分钟后自动回收')

  // 行内手动关闭 → 行消失，分区回落空态
  await row.locator('[data-testid="tunnel-close"]').click()
  await expect(page.locator('[data-testid="tunnel-row"]')).toHaveCount(0, { timeout: 10000 })
  await expect(page.locator('[data-testid="tunnel-panel"]')).toContainText('暂无活跃隧道', { timeout: 5000 })

  // API 侧对账：该远端口隧道已不在列表
  const list = await apiTunnelList(headers)
  expect(list.some(t => t.remotePort === RPORT), '关闭后列表不应再有 RPORT 隧道').toBe(false)
})

test('预览徽标与行集一致：直达链挂徽标，映射与分区行相同', async ({ page }) => {
  test.skip(!hostId || !wslUp, 'WSL 主机记录未播种或 sshd 不可达')
  test.setTimeout(90000)
  const headers = await unlockHeaders()
  await ensureTunnel(headers)

  // 预置悬浮球 mini 形态，进项目页（预览面板挂在项目页底部，同 remote-tunnel-preview 范式）
  await page.addInitScript(([key, value]) => {
    localStorage.setItem(key, value)
  }, ['sc.agentTerminal.openState', JSON.stringify({ visible: true, mode: 'mini' })])
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)

  // 等 WS 桥建立后播种 preview.port 带 hostId；页面自行经隧道桥开（幂等复用既有隧道）
  const tunnelResp = page.waitForResponse(
    r => r.url().includes(`/api/remotehosts/${hostId}/tunnels`) && r.request().method() === 'POST',
    { timeout: 15000 },
  ).catch(() => null)
  await page.request.post(`${BASE}/api/ops-notify`, {
    headers,
    data: { type: 'preview.port', payload: { port: RPORT, label: 'e2e tunnel panel', hostId } },
  })
  const resp = await tunnelResp
  expect(resp, '前端应经隧道桥调 POST tunnels').not.toBeNull()
  const bridged = ((await resp!.json()) as { data?: TunnelInfo }).data
  expect(bridged?.localPort).toBeTruthy()

  // 预览徽标映射（用户口径远端口 → 实打本机口）
  const mini = page.locator('body > .agm-root')
  const previewBtn = mini.locator('.agm-preview-btn')
  await expect(previewBtn).toContainText(`预览 :${RPORT}`, { timeout: 8000 })
  await previewBtn.click()
  await expect(page.locator('.preview-panel')).toBeVisible({ timeout: 8000 })
  const badge = page.locator('.preview-tunnel-badge')
  await expect(badge).toHaveText(`远程 :${RPORT} → 本机 :${bridged!.localPort}`, { timeout: 8000 })

  // 同隧道在设置分区行集中如实回显，映射文案与徽标逐字一致
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="settings-nav-deploy"]').click()
  const row = page.locator('[data-testid="tunnel-row"]').filter({ hasText: `远程 :${RPORT} →` })
  await expect(row).toHaveCount(1, { timeout: 10000 })
  // trim 对齐两处渲染容器的边缘空白，只比映射本体
  expect((await row.locator('.tunnel-mapping').innerText()).trim())
    .toBe((await badge.innerText()).trim())
})
