import { test, expect } from '@playwright/test'
import net from 'node:net'
import { DEFAULT_PASSWORD, fetchWslHost } from '../tests/helpers'

/**
 * 远程终端 tmux 持久化（设置开关 + 会话契约）E2E——HTTP 级验证，不依赖远端已装 tmux：
 *   1. 设置开关：PUT settings terminalRemoteTmux=true → GET 回读一致，关闭后回读 false
 *   2. 会话契约：开关开启时创建终端回显 tmuxName；重开回传同名（服务端 attach-or-create）
 *      → 关闭开关后创建返回空 tmuxName（原生 shell）
 * 环境门控：需要预配置的 WSL 主机（端口以播种记录为准，槽位专用实例非 23，
 * P-20261004-115）可达
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
let token = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

function tcpReachable(port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

let wslUp = false
let wslHostId = ''
let originalTmuxSetting: boolean | undefined

test.beforeAll(async () => {
  // 先取播种记录再探针：端口以记录为准（槽位专用实例非 23，P-20261004-115）
  const wslHost = await fetchWslHost(BASE)
  wslHostId = wslHost?.id || ''
  wslUp = await tcpReachable(wslHost?.port || 23)
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  token = (await unlockRes.json()).token || ''
  if (!wslUp) return
  const settings = await api('GET', '/api/settings')
  originalTmuxSetting = settings.json?.data?.terminalRemoteTmux
})

test.afterAll(async () => {
  if (originalTmuxSetting !== undefined) {
    await api('PUT', '/api/settings', { terminalRemoteTmux: originalTmuxSetting })
  }
})

test('远程终端 tmux：设置开关 + 创建/重开回传 tmuxName + 关闭后回退原生', async ({ page }) => {
  test.skip(!wslUp || !wslHostId, 'WSL sshd 不可达或无 WSL 主机，跳过')
  test.setTimeout(60000)
  await gotoProjectUnlocked(page)

  // 1) 开启开关：写入 + 回读
  const put = await api('PUT', '/api/settings', { terminalRemoteTmux: true })
  expect([200, 201]).toContain(put.status)
  const read = await api('GET', '/api/settings')
  expect(read.json?.data?.terminalRemoteTmux).toBe(true)

  // 2) 创建终端 → 响应携带 tmuxName（sc_rtm_ 前缀 + 合法字符集）
  const created = await api('POST', `/api/remotehosts/${wslHostId}/terminals`, { rows: 24, cols: 80 })
  expect(created.status).toBe(200)
  const tmuxName: string = created.json?.data?.tmuxName || ''
  expect(tmuxName).toMatch(/^sc_rtm_[A-Za-z0-9_-]{1,56}$/)
  const sessionId: string = created.json?.data?.sessionId
  expect(sessionId).toBeTruthy()

  // 3) 重开回传同名：服务端按该名 attach-or-create（新 sessionId、tmuxName 原样）
  const reopen = await api('POST', `/api/remotehosts/${wslHostId}/terminals`, { rows: 24, cols: 80, tmuxName })
  expect(reopen.status).toBe(200)
  expect(reopen.json?.data?.tmuxName).toBe(tmuxName)
  expect(reopen.json?.data?.sessionId).not.toBe(sessionId)
  await api('DELETE', `/api/remotehosts/${wslHostId}/terminals/${reopen.json?.data?.sessionId}`)

  // 4) 非法 tmuxName 拒绝（防 shell 注入的字符集白名单）
  const evil = await api('POST', `/api/remotehosts/${wslHostId}/terminals`, { rows: 24, cols: 80, tmuxName: 'a;rm -rf /' })
  expect(evil.status).toBe(400)

  // 5) 清理首个会话；关闭开关后创建返回空 tmuxName（原生 shell）
  await api('DELETE', `/api/remotehosts/${wslHostId}/terminals/${sessionId}`)
  await api('PUT', '/api/settings', { terminalRemoteTmux: false })
  const plain = await api('POST', `/api/remotehosts/${wslHostId}/terminals`, { rows: 24, cols: 80 })
  expect(plain.status).toBe(200)
  expect(plain.json?.data?.tmuxName).toBe('')
  await api('DELETE', `/api/remotehosts/${wslHostId}/terminals/${plain.json?.data?.sessionId}`)
})

/** 打开项目页并完成解锁（页面仅用于取得解锁态，断言全部走 HTTP） */
async function gotoProjectUnlocked(page: import('@playwright/test').Page) {
  const { gotoAndUnlock } = await import('../tests/helpers')
  await gotoAndUnlock(page, BASE + '/project')
}
