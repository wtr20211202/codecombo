import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 部署历史一键重跑（P-20261002-60）：
 * 真实部署依赖远端 SSH 与部署器二进制，无法在共享实例上确定性重放——本 spec
 * 经 API 造「注定失败」的部署任务（目标 127.0.0.1:59999 端口无人监听，SSH
 * 拒连即失败），但任务记录（hostId + resolved instances）会照常落盘进历史，
 * 与真实部署同形状。锁定前端三段契约：
 *   1. DeployDialog 出现「历史任务」区，行内含状态/主机/工具摘要；
 *   2. 点「相同配置重跑」→ 预填相同主机与工具勾选、直达确认步（不盲触发），
 *      点「开始部署」产生全新任务（taskId ≠ 历史任务，不复用）；
 *   3. 主机已删的历史行降级：行内「主机已删除」提示 + 重跑按钮禁用。
 * 播种主机在 afterAll 清理；失败任务记录留在历史（服务端无任务删除接口，
 * 实例重启清数据面即消失），行定位按 hostId 不受残留记录影响
 */

// 无人监听的回环端口：SSH 拒连秒失败，任务记录照常落盘（不产生真实远端副作用）
const DEAD_PORT = 59999

interface HostMeta {
  id: string
  name: string
  host: string
  port: number
  user: string
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function apiGet(path: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, { headers })
  return ((await res.json()) as any)?.data
}

// 幂等造主机：同名复用（spec 重跑不残留重复行），否则创建
async function seedHost(headers: Record<string, string>, name: string): Promise<HostMeta> {
  const hosts = (await apiGet('/api/remotehosts', headers)) || []
  const existing = hosts.find((h: HostMeta) => h.name === name)
  if (existing) return existing
  const res = await fetch(`${API_BASE}/api/remotehosts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name, host: '127.0.0.1', port: DEAD_PORT,
      user: 'e2erun', authType: 'password', password: 'e2e-not-used',
    }),
  })
  expect(res.ok).toBeTruthy()
  return (await (res.json() as any)).data as HostMeta
}

// 触发部署并等任务记录落盘（回环拒连秒失败，但记录先于结果持久化）。
// init_ssh_key 的 email 为必填无默认（服务端 ResolvePlan 前置校验），显式给全
async function seedDeployTask(headers: Record<string, string>, hostId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/deploy`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      hostId,
      instances: [{
        deployerId: 'init_ssh_key',
        params: { keyName: 'id_ed25519', email: 'e2e@example.com', gitHost: 'github.com' },
      }],
    }),
  })
  expect(res.ok).toBeTruthy()
  const { taskId } = (await res.json()) as { taskId: string }
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const tasks = (await apiGet('/api/deploy/tasks', headers)) || []
    if (tasks.some((t: { id: string }) => t.id === taskId)) return taskId
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`seeded deploy task ${taskId} not listed in time`)
}

// 从首页进设置 → 远程部署，点指定主机行的「更多 → 部署」打开部署弹窗
async function openDeployDialog(page: import('@playwright/test').Page, hostName: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.home-action-btn[title="设置"]').click()
  await page.locator('.settings-nav .nav-item').filter({ hasText: '远程部署' }).click()
  const row = page.locator('.host-row').filter({ hasText: hostName }).first()
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.locator('.host-actions .n-button').last().click()
  await page.locator('.n-dropdown-option').filter({ hasText: '部署' }).first().click()
  await expect(page.locator('.deploy-dialog-content')).toBeVisible({ timeout: 10000 })
}

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const hosts = (await apiGet('/api/remotehosts', headers)) || []
  for (const h of hosts.filter((h: HostMeta) => h.name.startsWith('deploy-rerun-'))) {
    await fetch(`${API_BASE}/api/remotehosts/${h.id}`, { method: 'DELETE', headers })
  }
})

test('历史行相同配置重跑：预填相同勾选 → 确认触发新任务', async ({ page }) => {
  test.setTimeout(60000)
  const headers = await unlockHeaders()
  const host = await seedHost(headers, 'deploy-rerun-a')
  const oldTaskId = await seedDeployTask(headers, host.id)

  await openDeployDialog(page, 'deploy-rerun-a')

  // 历史任务区出现该任务的行（状态/主机/工具摘要；resolved 已含自动补齐的 init_user 依赖）
  const historyRow = page.getByTestId('deploy-history-row').filter({ hasText: 'deploy-rerun-a' }).first()
  await expect(historyRow).toBeVisible({ timeout: 10000 })
  await expect(historyRow).toContainText('初始化 SSH Key')
  // resolved 与原始选择差异的如实标注常驻历史区
  await expect(page.locator('.deploy-dialog-content')).toContainText('清单为解析后结果')

  // 点「相同配置重跑」→ 预填相同主机与工具勾选，直达确认步（开始按钮可见可点）
  await historyRow.getByTestId('deploy-rerun-btn').click()
  const content = page.locator('.deploy-dialog-content')
  await expect(content.locator('.n-base-selection').first()).toContainText('deploy-rerun-a')
  await expect(content.locator('.instance-name').filter({ hasText: '初始化 SSH Key' })).toHaveCount(1)
  const startBtn = page.getByRole('button', { name: '开始部署' })
  await expect(startBtn).toBeVisible()
  await expect(startBtn).toBeEnabled()

  // 确认触发 → 产生新任务（taskId ≠ 历史任务，日志独立），进度区接管弹窗
  await startBtn.click()
  await expect(page.locator('.deploy-dialog-content .progress-section')).toBeVisible({ timeout: 15000 })

  const tasks = (await apiGet('/api/deploy/tasks', headers)) || []
  const hostTasks = tasks.filter((t: { hostId: string }) => t.hostId === host.id)
  expect(hostTasks.length).toBeGreaterThanOrEqual(2)
  const newest = hostTasks[0] // 服务端按 StartedAt 降序
  expect(newest.id).not.toBe(oldTaskId)
  expect(newest.instances.some((i: { deployerId: string }) => i.deployerId === 'init_ssh_key')).toBe(true)
})

test('主机已删的历史行：降级提示 + 重跑禁用', async ({ page }) => {
  test.setTimeout(60000)
  const headers = await unlockHeaders()
  // 造一条「主机随后被删」的历史：任务先落盘，再删主机
  const host = await seedHost(headers, 'deploy-rerun-b')
  await seedDeployTask(headers, host.id)
  const delRes = await fetch(`${API_BASE}/api/remotehosts/${host.id}`, { method: 'DELETE', headers })
  expect(delRes.ok).toBeTruthy()

  // 重试可能落在新 worker（beforeAll 不重跑），被测主机行自给自足幂等重建
  await seedHost(headers, 'deploy-rerun-a')
  // 经仍存在的主机行打开弹窗（弹窗入口挂在主机行「更多 → 部署」）
  await openDeployDialog(page, 'deploy-rerun-a')

  const goneRow = page.getByTestId('deploy-history-row').filter({ hasText: '主机已删除' }).first()
  await expect(goneRow).toBeVisible({ timeout: 10000 })
  // 降级：主机已删提示 + 重跑按钮禁用（预填链源头失效，不给出假动作）
  await expect(goneRow.getByTestId('deploy-rerun-btn')).toBeDisabled()
  // 对照：主机还在的历史行重跑按钮保持可用（降级只作用于已删主机）
  const aliveRow = page.getByTestId('deploy-history-row').filter({ hasText: 'deploy-rerun-a' }).first()
  await expect(aliveRow.getByTestId('deploy-rerun-btn')).toBeEnabled()
})
