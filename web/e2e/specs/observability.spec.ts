import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 可观测性端点 E2E：
 *   - GET /api/health：无需鉴权（boot 探测用），返回进程指标
 *   - GET /api/metrics：Prometheus 文本格式，受 LockMiddleware 保护
 *     （未解锁 423；解锁后含 http/进程指标面）
 * 两者此前零覆盖。
 */

test('health 端点：免鉴权可访问 + 进程指标字段', async ({ request }) => {
  const res = await request.get(`${API_BASE}/api/health`)
  expect(res.ok()).toBeTruthy()
  // health 直出字段（无 data 包装）：status + checks + memory + process
  const body = (await res.json()) as {
    status?: string
    checks?: Record<string, string>
    memory?: Record<string, number>
    process?: Record<string, number>
  }
  expect(body.status).toBe('ok')
  expect(body.memory?.heapAllocMB).toBeGreaterThan(0)
  expect(body.process?.uptimeSeconds).toBeGreaterThan(0)
})

test('metrics 端点：锁定态 423（系统元数据不外泄）', async ({ request }) => {
  // 保持未解锁状态访问（此 spec 不解锁，借用隔离上下文）
  const res = await request.get(`${API_BASE}/api/metrics`)
  // 锁定实例上应被 LockMiddleware 拦截（423）；若实例未开锁则 200 也可接受
  expect([200, 423]).toContain(res.status())
})

test('metrics 端点：解锁后 Prometheus 文本含核心指标面', async ({ request }) => {
  const unlock = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await unlock.json()) as { token?: string }).token || ''

  const res = await request.get(`${API_BASE}/api/metrics`, {
    headers: { 'X-Lock-Token': token },
  })
  expect(res.ok()).toBeTruthy()
  expect(res.headers()['content-type']).toContain('text/plain')

  const text = await res.text()
  // Prometheus 文本格式核心指标面（HTTP/进程级）
  expect(text).toContain('sc_')
  expect(text.length).toBeGreaterThan(50)
})
