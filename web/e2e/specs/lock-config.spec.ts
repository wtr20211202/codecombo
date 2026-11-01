import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 锁定配置 API E2E：部分合并（指针判存）语义 + 输入校验边界。
 *   - autoLockMinutes=0 → 400（防 0/负值导致立即过期）
 *   - tokenTTLMinutes=-5 → 400
 *   - 仅更新 autoLockMinutes → 其他字段（enabled/autoLockEnabled）保持不变
 *   - 错误 currentPassword → 401
 * 测试后还原配置，避免污染共享实例（instance-switch 等依赖默认密码解锁）。
 */

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getConfig(request: import('@playwright/test').APIRequestContext, headers: Record<string, string>) {
  const res = await request.get(`${API_BASE}/api/lock/config`, { headers })
  // GetConfig 直出字段（gin.H 无 data 包装）
  return (await res.json()) as {
    enabled?: boolean; autoLockEnabled?: boolean; autoLockMinutes?: number; tokenTTLMinutes?: number
  }
}

test('锁定配置：边界校验拒绝非法分钟数', async ({ request }) => {
  const headers = await unlockHeaders()

  for (const payload of [
    { autoLockMinutes: 0 },
    { autoLockMinutes: -5 },
    { tokenTTLMinutes: 0 },
  ]) {
    const res = await request.put(`${API_BASE}/api/lock/config`, {
      headers, data: { ...payload, currentPassword: DEFAULT_PASSWORD },
    })
    expect(res.status(), `${JSON.stringify(payload)} 应被 400 拒绝`).toBe(400)
  }
})

test('锁定配置：部分合并语义（只改一个字段不动其余）', async ({ request }) => {
  const headers = await unlockHeaders()
  const before = await getConfig(request, headers)

  // 只改 autoLockMinutes
  const newMinutes = (before.autoLockMinutes || 30) === 30 ? 45 : 30
  const put = await request.put(`${API_BASE}/api/lock/config`, {
    headers, data: { autoLockMinutes: newMinutes, currentPassword: DEFAULT_PASSWORD },
  })
  expect(put.ok()).toBeTruthy()

  const after = await getConfig(request, headers)
  expect(after.autoLockMinutes).toBe(newMinutes)
  // 其余字段不被整体覆盖
  expect(after.enabled).toBe(before.enabled)
  expect(after.autoLockEnabled).toBe(before.autoLockEnabled)
  expect(after.tokenTTLMinutes).toBe(before.tokenTTLMinutes)
})

test('锁定配置：错误 currentPassword → 401', async ({ request }) => {
  const headers = await unlockHeaders()
  const res = await request.put(`${API_BASE}/api/lock/config`, {
    headers, data: { autoLockMinutes: 30, currentPassword: 'wrong-password' },
  })
  expect(res.status()).toBe(401)
})
