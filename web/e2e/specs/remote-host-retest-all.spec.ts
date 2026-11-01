import { test, expect } from '@playwright/test'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 主机列表「全部重测」一键 E2E（P-20261006-3，纯前端编排既有单台测试 API）：
 * 工具条按钮逐台触发既有测试连接（并发钳在 store）→ 进行中逐台蓝色脉冲徽章
 * （store.testing 驱动）→ 完成 toast 汇总（N 台 OK / 1 台失败，失败主机名直列）。
 * 测试端点经 page.route 拦截回放两种应答——成功 { ok:true,... } 与业务失败
 * HTTP 200 { ok:false, error }（探测语义：业务失败不抛错，与 probeRemoteHost
 * 一致），环境无关（不依赖 WSL sshd 可达）；主机经 API 创建、收尾清理。
 */

const NAME_OK = `e2e-retest-ok-${Math.random().toString(36).slice(2, 8)}`
const NAME_FAIL = `e2e-retest-fail-${Math.random().toString(36).slice(2, 8)}`

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function createHost(name: string): Promise<string> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/remotehosts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name,
      host: '127.0.0.1',
      port: 22,
      user: 'e2e',
      authType: 'password',
      protocol: 'ssh',
      password: 'e2e-secret-pass-9527',
    }),
  })
  expect(res.ok).toBeTruthy()
  const created = ((await res.json()) as { data?: { id?: string } }).data
  expect(created?.id, '测试主机应创建成功').toBeTruthy()
  return created!.id!
}

/** 幂等清理：按名删除（用例失败中断也不留残骸） */
async function deleteHostByName(name: string): Promise<void> {
  const headers = await unlockHeaders()
  const list = ((await (await fetch(`${API_BASE}/api/remotehosts`, { headers })).json()) as {
    data?: Array<{ name?: string; id?: string }>
  }).data || []
  const found = list.find(h => h.name === name)
  if (found?.id) await fetch(`${API_BASE}/api/remotehosts/${found.id}`, { method: 'DELETE', headers })
}

/** 打开项目页并经 ActivityBar 进入远程管理内嵌视图（remote-console.spec 同款入口） */
async function openRemoteView(page: Parameters<typeof gotoAndUnlock>[0]) {
  await gotoAndUnlock(page, `${API_BASE}/project`)
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
}

test.afterAll(async () => {
  await deleteHostByName(NAME_OK)
  await deleteHostByName(NAME_FAIL)
})

test('全部重测：逐台脉冲徽章 → 完成 toast 汇总（失败主机名直列）', async ({ page }) => {
  const [idOk, idFail] = [await createHost(NAME_OK), await createHost(NAME_FAIL)]
  expect(idOk).not.toBe(idFail)

  // 拦截测试端点按 id 回放：失败主机延迟应答（留出进行中徽章观察窗），
  // 其余主机（含播种 WSL 等存量主机）一律回成功应答——业务失败计数即恒为 1
  await page.route('**/api/remotehosts/*/test', async (route) => {
    const segs = route.request().url().split('/')
    const id = segs[segs.length - 2] || ''
    if (id === idFail) {
      await new Promise(r => setTimeout(r, 700))
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'auth rejected: e2e-mock' }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, whoami: 'e2e', os: 'linux', arch: 'amd64' }),
    })
  })

  await fixedLocale(page)
  await openRemoteView(page)

  // 两台新建主机已入列（store.hosts 与侧栏同源，计数即 testAll 的目标总数）
  const cardOk = page.locator('.host-card').filter({ hasText: NAME_OK })
  const cardFail = page.locator('.host-card').filter({ hasText: NAME_FAIL })
  await expect(cardOk).toBeVisible({ timeout: 10000 })
  await expect(cardFail).toBeVisible()
  const total = await page.locator('.host-card').count()
  expect(total).toBeGreaterThanOrEqual(2)

  await page.locator('[data-testid="retest-all"]').click()

  // 进行中徽章：失败主机延迟 700ms，窗口内该卡状态点应呈蓝色脉冲态
  await expect(cardFail.locator('.host-status.is-testing')).toBeVisible({ timeout: 3000 })

  // 完成 toast 汇总：N-1 台连通 / 1 台失败，失败主机名直列
  await expect(
    page.locator('.n-message').filter({ hasText: `${total - 1} 台连通 / 1 台失败：${NAME_FAIL}` }),
  ).toBeVisible({ timeout: 5000 })

  // 批后按钮回位（不残留 loading/禁用，可再次点击）
  await expect(page.locator('[data-testid="retest-all"]')).toBeEnabled()
})
