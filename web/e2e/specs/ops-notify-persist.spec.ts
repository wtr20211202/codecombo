import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知入账原语 notify.persist E2E（P-20261007-10）：
 * 全链路真实验证（agent 的「留痕找人」通道）：
 *   agent 经 ops-notify 上报 notify.persist（title 携敏感赋值形态）
 *   → 发布口校验 + 入账即遮蔽 → 服务端直调 notification.Add（与系统通知同库）
 *   → /ws/notifications 实时进通知中心 → 条目带「查看会话」动作（action=terminal）
 *   → 点击直达终端会话（pendingAction 既有分发）。
 * 附：发布口校验面（坏 action/伪协议/越枚举 level 400 退回不入账）+
 *     类别静音（任务子开关关 → 不入账，响应仍 200 静默）。
 * 通知/会话/偏好经共享实例 API 清理还原，不残留测试数据
 */

const PROJECT_NAME = 'simple-coding'
const NP_TITLE = 'e2e-np-链路收尾 token=supersecret42'
const NP_TITLE_PREFIX = 'e2e-np-链路收尾'
const SESSION_NAME = 'e2e-notify-persist-shell'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${API_BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJECT_NAME)
  if (!p) throw new Error(`project ${PROJECT_NAME} not found`)
  return p.id
}

/** 开一个普通 shell 终端并回读会话 ID（跳转目标，ops-watch-invite 同款） */
async function createTerminal(request: APIRequestContext, headers: Record<string, string>, projectId: string): Promise<string> {
  const res = await request.post(`${API_BASE}/api/terminals`, { headers, data: { projectId, name: SESSION_NAME } })
  expect(res.ok()).toBeTruthy()
  const data = ((await res.json()) as { data?: { id?: string } }).data
  if (!data?.id) throw new Error('terminal id missing')
  return data.id
}

async function cleanup(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  // 撤测试终端 + 清通知（全局状态保证确定性）
  const terms = await request.get(`${API_BASE}/api/terminals`, { headers })
  const sessions = ((await terms.json()) as { data?: Array<{ id?: string; name?: string }> }).data || []
  for (const s of sessions) {
    if (s.name === SESSION_NAME && s.id) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers }).catch(() => {})
    }
  }
  await request.post(`${API_BASE}/api/notifications/clear`, { headers })
}

test.beforeEach(async ({ request }) => {
  await cleanup(request)
})

test.afterEach(async ({ request }) => {
  await cleanup(request)
})

// 服务端入账的同前缀条目数（notify.persist 是服务端直调 notification.Add，
// 无前端往返——轮询只兜 store 写盘时序）。request 由用例参数显式传入
async function serverCount(request: APIRequestContext, titlePrefix: string, headers: Record<string, string>): Promise<number> {
  const res = await request.get(`${API_BASE}/api/notifications`, { headers })
  const list = ((await res.json()) as { data?: Array<{ title?: string }> }).data || []
  return list.filter(n => (n.title || '').startsWith(titlePrefix)).length
}

async function waitServerCount(request: APIRequestContext, titlePrefix: string, headers: Record<string, string>, timeoutMs = 10000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const n = await serverCount(request, titlePrefix, headers)
    if (n > 0 || Date.now() > deadline) return n
    await new Promise(resolve => setTimeout(resolve, 300))
  }
}

// 进项目页（OpsChannelBridge 与通知 store WS 随 App 挂载）：路上留出窗口再上报
async function enterProject(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)
}

test('notify.persist → 入账即遮蔽 → 通知中心条目 → 点击直达会话（terminal 动作）', async ({ page, request }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const sessionId = await createTerminal(request, headers, projectId)

  // ① 进项目页建立 WS 后上报 notify.persist：title 携 token 赋值形态（遮蔽断言锚）
  await enterProject(page)
  const posted = await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: {
      type: 'notify.persist',
      payload: {
        title: NP_TITLE,
        body: '结论一句话 password=hunter2 附敏感形态遮蔽验证',
        level: 'success',
        action: 'terminal',
        actionPayload: sessionId,
      },
    },
  })
  expect(posted.ok()).toBeTruthy()

  // ② 服务端入账（与系统通知同库）：条目在、敏感值入账即遮蔽、level→type、动作透传
  expect(await waitServerCount(request, NP_TITLE_PREFIX, headers)).toBe(1)
  const listRes = await request.get(`${API_BASE}/api/notifications`, { headers })
  const list = ((await listRes.json()) as { data?: Array<Record<string, unknown>> }).data || []
  const entry = list.find(n => String(n.title || '').startsWith(NP_TITLE_PREFIX))!
  expect(String(entry.title)).toContain('token=***')
  expect(String(entry.title)).not.toContain('supersecret42')
  expect(String(entry.body)).toContain('password=***')
  expect(String(entry.body)).not.toContain('hunter2')
  expect(entry.type).toBe('success')
  expect(entry.category).toBe('task')
  expect(entry.action).toBe('terminal')
  expect(entry.actionPayload).toBe(sessionId)

  // ③ 通知中心条目（WS 实时链）：可见 + 可点（带动作）
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const row = page.locator('.nc-item').filter({ hasText: NP_TITLE_PREFIX }).first()
  await expect(row).toBeVisible({ timeout: 8000 })
  await expect(row).toHaveClass(/clickable/)

  // ④ 点击 → terminal 动作直达会话（底部终端面板 + 对应 tab 激活）
  await row.click()
  const panel = page.locator('.bottom-panel')
  await expect(panel).toBeVisible({ timeout: 10000 })
  const tab = panel.locator('.term-tab.is-active')
  await expect(tab).toHaveCount(1, { timeout: 15000 })
  await expect(tab).toContainText(SESSION_NAME)
})

test('发布口校验面：坏 action/伪协议/越枚举 level 400 退回，通知不入账', async ({ request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)

  const badPayloads: Array<[string, Record<string, unknown>]> = [
    ['人裁决面动作不对 agent 开放', { title: 'x', action: 'agent-fix', actionPayload: 'dt1' }],
    ['白名单外动作', { title: 'x', action: 'watch-fallback' }],
    ['缺 action 的载荷无主', { title: 'x', actionPayload: 'tm-1' }],
    ['伪协议外链', { title: 'x', action: 'url', actionPayload: 'javascript:alert(1)' }],
    ['协议相对外链', { title: 'x', action: 'url', actionPayload: '//evil.com/x' }],
    ['越枚举 level', { title: 'x', level: 'critical' }],
    ['缺 title', { body: 'no title' }],
  ]
  for (const [why, payload] of badPayloads) {
    const res = await request.post(`${API_BASE}/api/ops-notify`, {
      headers,
      data: { type: 'notify.persist', payload },
    })
    expect(res.status(), `${why} 应 400`).toBe(400)
    expect(await res.text()).toContain('invalid notify.persist payload')
  }

  // 相似名自定义 type 不受内置校验约束（开放词表零变化）
  const similar = await request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'notify.persists', payload: { title: '' } },
  })
  expect(similar.ok()).toBeTruthy()

  // 坏载荷未入账：通知中心零新增
  await new Promise(resolve => setTimeout(resolve, 1500))
  expect(await serverCount(request, 'x', headers)).toBe(0)
})

test('类别静音：任务子开关关 → 不入账不广播，响应仍 200；恢复后照常', async ({ request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)

  // 关任务类别（Enabled 整表替换语义——先取原表回填）
  const prefsRes = await request.get(`${API_BASE}/api/notifications/prefs`, { headers })
  const prefs = (await prefsRes.json()) as { enabled?: Record<string, boolean> }
  const original = { ...(prefs.enabled || {}) }
  const muted = { ...original, task: false }
  await request.put(`${API_BASE}/api/notifications/prefs`, { headers, data: { enabled: muted } })

  try {
    const posted = await request.post(`${API_BASE}/api/ops-notify`, {
      headers,
      data: { type: 'notify.persist', payload: { title: 'e2e-np-静音验证' } },
    })
    // 响应仍 200（与限流丢弃同款静默语义，不诱发 agent 重试）
    expect(posted.ok()).toBeTruthy()
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(await serverCount(request, 'e2e-np-静音验证', headers)).toBe(0)
  } finally {
    // 还原偏好（子开关回原表）
    await request.put(`${API_BASE}/api/notifications/prefs`, { headers, data: { enabled: original } })
  }

  // 恢复后同载荷照常入账
  const posted = await request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'notify.persist', payload: { title: 'e2e-np-恢复验证' } },
  })
  expect(posted.ok()).toBeTruthy()
  expect(await waitServerCount(request, 'e2e-np-恢复验证', headers)).toBe(1)
})
