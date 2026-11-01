import { test, expect } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 非项目内容轻投递 E2E（P-20261023-1 方案④）：文件树右键「同步到其他实例…」
 * → 对端+目标路径对话框 → POST /api/sync/deliver 纯落位（不注册项目）。
 *
 * 断言聚焦最小面：菜单项 → 对话框（对端下拉/目标路径预填）→ 投递受理 →
 * 对端存根收到的 X-Sync-Meta 携 deliver 单元与显式 dest。对端白名单前缀
 * 校验/穿越拒绝的完整语义在 Go 单测 landDeliver 链。
 */

const BASE = API_BASE
const PEER_NAME = 'e2e-deliver-peer'
const PEER_TOKEN = 'sc_e2e_deliver_token'
const SEED_DIR = 'e2e-sync-deliver'
const SEED_FILE = `${SEED_DIR}/deploy.sh`

let unlockToken = ''
let instanceId = ''

const peerState = {
  deliverCount: 0,
  dest: '',
  metaKind: '',
}

function peerHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.url?.startsWith('/api/settings')) {
    // 探活分类口（tryCheckInstance 探对端 /api/settings）：200 + data.version
    // 判 online——缺了本分支实例被判 invalid，投递对话框对端下拉按在线过滤恒空
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: { version: '9.9.9-deliver-e2e' } }))
    return
  }
  if (req.url?.startsWith('/api/meta')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      version: { version: '9.9.9-deliver-e2e', commit: 'e2e', buildTime: '', apiVersion: '1.0.0' },
      capabilities: ['sync'],
    }))
    return
  }
  if (req.url?.startsWith('/api/sync/units') && req.method === 'POST') {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      peerState.deliverCount++
      const meta = req.headers['x-sync-meta'] as string || '{}'
      try {
        const parsed = JSON.parse(meta) as { units?: { kind?: string; dest?: string }[] }
        peerState.metaKind = parsed.units?.[0]?.kind || ''
        peerState.dest = parsed.units?.[0]?.dest || ''
      } catch { /* 形态异常即断言失败 */ }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        data: { units: [{ key: 'deliver:e2e', ok: true }], destRoot: '/stub/dest' },
      }))
    })
    return
  }
  res.statusCode = 404
  res.end('not a sync endpoint')
}

async function lockToken(): Promise<string> {
  const res = await fetch(`${BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  return (await res.json()).token || ''
}

async function projectId(): Promise<string> {
  const token = await lockToken()
  const list = await (await fetch(`${BASE}/api/projects`, { headers: { 'X-Lock-Token': token } })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === 'simple-coding')
  if (!mine) throw new Error('simple-coding 项目不存在')
  return mine.id
}

async function seedFile(pid: string) {
  const token = await lockToken()
  await fetch(`${BASE}/api/projects/${pid}/file/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path: SEED_FILE }),
  }).catch(() => {})
  await fetch(`${BASE}/api/projects/${pid}/file/create`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path: SEED_FILE, content: '#!/usr/bin/env bash\necho deliver-e2e\n' }),
  }).then(async r => { if (!r.ok) throw new Error(`seed create failed: HTTP ${r.status}`) })
}

async function enterProjectWithTree(page: import('@playwright/test').Page) {
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // 文件树打开（侧栏 toggle 语义，奇数次点击保证最终态）
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.tree-item', { hasText: 'README.md' }).first().isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

let peer: http.Server

test.beforeAll(async ({ request }) => {
  unlockToken = (await lockToken())
  peer = http.createServer(peerHandler)
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
  const port = (peer.address() as AddressInfo).port
  const res = await request.post(`${BASE}/api/instances`, {
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    data: { name: PEER_NAME, url: `http://127.0.0.1:${port}`, token: PEER_TOKEN },
  })
  expect(res.ok(), '注册对端实例应成功').toBeTruthy()
  instanceId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(instanceId).toBeTruthy()
  await seedFile(await projectId())
})

test.afterAll(async ({ request }) => {
  const auth = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
  if (instanceId) await request.delete(`${BASE}/api/instances/${instanceId}`, { headers: auth }).catch(() => {})
  await fetch(`${BASE}/api/projects/${await projectId()}/file/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: JSON.stringify({ path: SEED_FILE }),
  }).catch(() => {})
  await fetch(`${BASE}/api/projects/${await projectId()}/file/delete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: JSON.stringify({ path: SEED_DIR }),
  }).catch(() => {})
  peer?.close()
})

test('文件树右键「同步到其他实例…」：对话框投递 → 对端收到 deliver 单元与显式 dest', async ({ page }) => {
  await fixedLocale(page)
  await enterProjectWithTree(page)

  // 展开到种子目录（树惰性展开：目录行点击一次展开子级）
  const dirRow = page.locator('.tree-item').filter({ hasText: SEED_DIR }).first()
  await dirRow.click()
  const fileRow = page.locator('.tree-item').filter({ hasText: 'deploy.sh' }).first()
  await expect(fileRow).toBeVisible({ timeout: 10000 })

  // 右键 → 轻投递入口（分享导出组）
  await fileRow.click({ button: 'right' })
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  await menu.getByText('同步到其他实例…', { exact: true }).click()

  // 对话框：选对端（在线实例）→ 目标路径已预填文件名 → 投递
  const dlg = page.locator('.n-modal')
  await expect(dlg).toBeVisible()
  await dlg.locator('select').selectOption({ label: PEER_NAME })
  await dlg.getByRole('button', { name: '投递' }).click()

  // 对端收到 deliver 单元（kind/dest 断言；正文 zip 字节不落盘——落位语义在
  // Go 单测 landDeliver 链）
  await expect.poll(() => peerState.deliverCount, { timeout: 15000 }).toBeGreaterThan(0)
  expect(peerState.metaKind).toBe('deliver')
  expect(peerState.dest).toBe('deploy.sh')

  // 成功反馈
  await expect(page.getByText('已投递“deploy.sh”').or(page.getByText('已投递「deploy.sh」'))).toBeVisible({ timeout: 10000 })
})
