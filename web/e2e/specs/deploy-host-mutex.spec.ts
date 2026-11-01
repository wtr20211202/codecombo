import { test, expect } from '@playwright/test'
import net from 'node:net'
import type { Socket } from 'node:net'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 同主机部署排队模式（P-20261004-36，P-20261003-41 拒绝式的二阶段进化）：
 * 真实部署依赖远端 SSH，无法在共享实例上确定性重放——本 spec 用「静默 TCP
 * 服务」（接受连接但不回应，SSH 版本交换挂起到服务端 15s 拨号超时）让首个
 * 部署任务稳定停在 running 态；close() 断开已吞连接让挂起任务秒级 EOF 失败
 * （sshclient.Dial 非 ctx 感知，cancel 打断不了挂起中的拨号，故用断连而非取消
 * 来收敛任务）。三段契约：
 *   1. 「不等候」（noWait）保留 P-41 拒绝式：同主机二次触发 → 400 + 错误原文
 *      含持锁任务 ID（前端 KNOWN_ERROR_I18N 匹配契约，web/src/api/http.ts
 *      deploy.mutex.busy）；
 *   2. 默认排队：同主机二次触发 200 出任务，详情 queued + waitingFor=持锁任务
 *      + queuePosition；取消排队走既有 POST /cancel；持锁任务落终态后队首被
 *      唤醒自动执行（到达终态即证明离开过排队——只有 run 会推进它）；
 *   3. UI：弹窗默认触发排队 →「排队中（等 #任务）」提示 + 取消排队按钮；勾选
 *      「不等候」恢复拒绝式 → 拦截器映射 deploy.mutex.busy 友好文案。
 * 播种主机在 afterAll 清理；失败任务记录留在历史（服务端无任务删除接口，
 * 实例重启清数据面即消失）。init_user 无必填参数，触发载荷最小
 */

interface HostMeta {
  id: string
  name: string
  host: string
  port: number
  user: string
}

interface TaskDetail {
  id?: string
  status?: string
  waitingFor?: string
  queuePosition?: number
}

// 静默 TCP 服务：accept 后不发任何字节——SSH 客户端版本交换挂起，任务稳定在途
function startSilentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      // 故意不回应：挂起对端 SSH 握手
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      resolve({
        port: addr.port,
        close: () =>
          new Promise((res) => {
            for (const s of sockets) s.destroy()
            server.close(() => res())
          }),
      })
    })
  })
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin' }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function apiGet(path: string, headers: Record<string, string>): Promise<any> {
  const res = await fetch(`${API_BASE}${path}`, { headers })
  return ((await res.json()) as any)?.data
}

// 幂等造主机：同名复用（spec 重跑不残留重复行），否则创建；指向静默服务端口
async function seedHost(headers: Record<string, string>, name: string, port: number): Promise<HostMeta> {
  const hosts = (await apiGet('/api/remotehosts', headers)) || []
  const existing = hosts.find((h: HostMeta) => h.name === name)
  if (existing) return existing
  const res = await fetch(`${API_BASE}/api/remotehosts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name, host: '127.0.0.1', port,
      user: 'e2erun', authType: 'password', password: 'e2e-not-used',
    }),
  })
  expect(res.ok).toBeTruthy()
  return (await (res.json() as any)).data as HostMeta
}

// 触发部署（init_user 无必填参数），返回原始响应体供状态码/错误原文断言
async function triggerDeploy(
  headers: Record<string, string>,
  hostId: string,
  noWait = false,
): Promise<{ ok: boolean; status: number; body: { taskId?: string; error?: string } }> {
  const res = await fetch(`${API_BASE}/api/deploy`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ hostId, instances: [{ deployerId: 'init_user', params: {} }], noWait }),
  })
  return { ok: res.ok, status: res.status, body: (await res.json()) as { taskId?: string; error?: string } }
}

// 轮询任务到目标终态（拨号挂起/失败时序在服务端，400ms 步进轮询最稳）
async function waitTaskStatus(
  headers: Record<string, string>,
  taskId: string,
  want: string[],
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const t = (await apiGet(`/api/deploy/${taskId}`, headers)) as { status?: string } | undefined
    if (t?.status && want.includes(t.status)) return t.status
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`task ${taskId} did not reach ${want.join('/')} in time`)
}

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const hosts = (await apiGet('/api/remotehosts', headers)) || []
  for (const h of hosts.filter((h: HostMeta) => h.name.startsWith('deploy-mutex-'))) {
    await fetch(`${API_BASE}/api/remotehosts/${h.id}`, { method: 'DELETE', headers })
  }
})

test('不等候触发同主机被拒：400 含持锁任务 ID；终态后锁释放可重触发', async () => {
  test.setTimeout(90000)
  const headers = await unlockHeaders()
  const srv = await startSilentServer()
  const host = await seedHost(headers, 'deploy-mutex-a', srv.port)

  // 首个部署：握手挂起稳定在途
  const first = await triggerDeploy(headers, host.id)
  expect(first.ok).toBeTruthy()
  const taskIdA = first.body.taskId || ''
  expect(taskIdA).toBeTruthy()

  // 同主机「不等候」二次触发：400 + 原文含持锁任务 ID（前后端契约锚点）
  const second = await triggerDeploy(headers, host.id, true)
  expect(second.status).toBe(400)
  const errMsg = second.body.error || ''
  expect(errMsg).toMatch(/deploy already in progress for this host/i)
  expect(errMsg).toContain(taskIdA)

  // 断开静默服务：挂起拨号 EOF 秒失败 → 任务落 failed → 锁释放
  await srv.close()
  expect(await waitTaskStatus(headers, taskIdA, ['failed'], 20000)).toBe('failed')

  // 释放后同主机可再次触发（新任务 ≠ 被拒时引用的旧任务）
  const third = await triggerDeploy(headers, host.id, true)
  expect(third.ok).toBeTruthy()
  const taskIdC = third.body.taskId || ''
  expect(taskIdC).toBeTruthy()
  expect(taskIdC).not.toBe(taskIdA)
  expect(await waitTaskStatus(headers, taskIdC, ['failed'], 20000)).toBe('failed')
})

test('默认排队：第二支 queued+waitingFor+位次，首支终态后自动执行；取消排队即时生效', async () => {
  test.setTimeout(120000)
  const headers = await unlockHeaders()
  const srv = await startSilentServer()
  const host = await seedHost(headers, 'deploy-mutex-q', srv.port)

  // 首支：占锁稳定在途
  const first = await triggerDeploy(headers, host.id)
  expect(first.ok).toBeTruthy()
  const firstId = first.body.taskId || ''

  // 第二支（默认排队）：200 出任务，留在 queued，详情带 waitingFor + 位次 1
  const second = await triggerDeploy(headers, host.id)
  expect(second.ok).toBeTruthy()
  const secondId = second.body.taskId || ''
  expect(secondId).toBeTruthy()
  expect(secondId).not.toBe(firstId)
  const qDetail = (await apiGet(`/api/deploy/${secondId}`, headers)) as TaskDetail
  expect(qDetail.status).toBe('queued')
  expect(qDetail.waitingFor).toBe(firstId)
  expect(qDetail.queuePosition).toBe(1)

  // 第三支：FIFO 位次 2；取消排队走既有 POST /cancel → cancelled 出队，
  // 第二支位次前移回 1
  const third = await triggerDeploy(headers, host.id)
  expect(third.ok).toBeTruthy()
  const thirdId = third.body.taskId || ''
  expect(((await apiGet(`/api/deploy/${thirdId}`, headers)) as TaskDetail).queuePosition).toBe(2)
  const cancelRes = await fetch(`${API_BASE}/api/deploy/${thirdId}/cancel`, { method: 'POST', headers })
  expect(cancelRes.ok).toBeTruthy()
  expect(await waitTaskStatus(headers, thirdId, ['cancelled'], 20000)).toBe('cancelled')
  expect(((await apiGet(`/api/deploy/${secondId}`, headers)) as TaskDetail).queuePosition).toBe(1)

  // 断开静默服务：首支 EOF 失败释放锁 → 队首（第二支）被唤醒自动执行 →
  // 对已关端口拨号秒失败落 failed。到达终态即证明它离开过排队（只有 run
  // 会把 queued 推进为 running/failed；唤醒链断了它会永远停在 queued 超时）
  await srv.close()
  expect(await waitTaskStatus(headers, firstId, ['failed'], 20000)).toBe('failed')
  expect(await waitTaskStatus(headers, secondId, ['failed'], 30000)).toBe('failed')
  const doneDetail = (await apiGet(`/api/deploy/${secondId}`, headers)) as TaskDetail
  expect(doneDetail.waitingFor).toBeFalsy()
})

test('弹窗默认触发排队：排队提示 + 取消排队；勾选不等候恢复拒绝式友好文案', async ({ page }) => {
  test.setTimeout(120000)
  const headers = await unlockHeaders()
  const srv = await startSilentServer()
  const host = await seedHost(headers, 'deploy-mutex-ui', srv.port)

  // API 先占锁：让弹窗的触发命中同主机排队
  const holder = await triggerDeploy(headers, host.id)
  expect(holder.ok).toBeTruthy()
  const holderId = holder.body.taskId || ''

  // 从首页进设置 → 远程部署，主机行「更多 → 部署」打开弹窗（主机已预选）
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.home-action-btn[title="设置"]').click()
  await page.locator('.settings-nav .nav-item').filter({ hasText: '远程部署' }).click()
  const row = page.locator('.host-row').filter({ hasText: 'deploy-mutex-ui' }).first()
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.locator('.host-actions .n-button').last().click()
  await page.locator('.n-dropdown-option').filter({ hasText: '部署' }).first().click()
  const content = page.locator('.deploy-dialog-content')
  await expect(content).toBeVisible({ timeout: 10000 })

  // 添加「初始化 cld 用户」（init_user，无必填参数）→ 默认（排队）开始部署
  await content.locator('button', { hasText: '添加工具' }).click()
  await page.locator('.n-dropdown-option').filter({ hasText: '初始化 cld 用户' }).first().click()
  await expect(content.locator('.instance-name').filter({ hasText: '初始化 cld 用户' })).toHaveCount(1)
  await page.getByRole('button', { name: '开始部署' }).click()

  // 排队提示（store 触发后补拉详情）：明示等待的持锁任务 ID；底部按钮变「取消排队」
  const queueInfo = page.locator('[data-testid="deploy-queue-info"]')
  await expect(queueInfo).toBeVisible({ timeout: 15000 })
  await expect(queueInfo).toContainText(holderId)
  const cancelBtn = page.locator('[data-testid="deploy-cancel-btn"]')
  await expect(cancelBtn).toHaveText('取消排队')

  // 取消排队：即时落 cancelled，排队提示消失（状态标签限定进度区——历史行的
  // 同文案标签跨 repeat 累积，宽松定位会 strict mode 撞车）
  await cancelBtn.click()
  await expect(content.locator('.progress-right .n-tag').filter({ hasText: '已取消' })).toBeVisible({ timeout: 15000 })
  await expect(queueInfo).toHaveCount(0)

  // 关闭弹窗（已结束可关）重开，勾选「不等候」再触发 → 恢复 P-41 拒绝式，
  // 拦截器映射 deploy.mutex.busy 友好文案（持锁任务仍是 API 占锁那支）。
  // 弹窗有两枚「关闭」（头部 X 的 aria-label + 页脚文本钮，P-20261005-213
  // 补微提示后 getByRole 双命中）——取 DOM 序在后的页脚动作钮
  await page.getByRole('button', { name: '关闭' }).last().click()
  await expect(content).toHaveCount(0, { timeout: 5000 })
  await row.locator('.host-actions .n-button').last().click()
  await page.locator('.n-dropdown-option').filter({ hasText: '部署' }).first().click()
  await expect(content).toBeVisible({ timeout: 10000 })
  await page.locator('[data-testid="deploy-nowait-switch"]').click()
  await content.locator('button', { hasText: '添加工具' }).click()
  await page.locator('.n-dropdown-option').filter({ hasText: '初始化 cld 用户' }).first().click()
  await page.getByRole('button', { name: '开始部署' }).click()

  // 友好本地化文案（含持锁任务 ID 的插值由 toast 呈现，断言稳定前缀）
  await expect(page.locator('.n-message').filter({ hasText: '该主机有部署进行中' })).toBeVisible({ timeout: 10000 })

  // 收尾：断开让占锁任务快速失败，不留跨 spec 在途任务
  await srv.close()
  await waitTaskStatus(headers, holderId, ['failed'], 20000)
})
