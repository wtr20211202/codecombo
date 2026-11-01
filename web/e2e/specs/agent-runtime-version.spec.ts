import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话 runtime 版本快照（P-20261003-134）：
 *   1. 创建→meta 含版本→tooltip 显：注册自定义智能体（命令=node 裸名——e2e
 *      环境前端构建必备二进制，裸名不吃「路径形态包装脚本」预检豁免）后经
 *      POST /api/terminals kind=agent 创建：创建响应同步携带 runtimeVersion
 *      （node --version 首行 v<major>.<minor>），meta 异步落库后 GET /terminals
 *      快照反查同携（tooltip 持久数据面），会话中心侧栏行 title 含版本原文
 *   2. 旧会话/无值空显：runtime=shell 会话走预检一等豁免链（永远无版本探测）
 *      ——行 title 不含版本形态，空显不虚构
 * 自定义智能体写全局 settings——beforeAll 注册、afterAll 删除，不污染其他
 * 用例；创建的会话用后即删。
 */

const VERSION_RT = 'e2e-version-rt'
const VERSION_SESSION = 'e2e-ver-node'
const SHELL_SESSION = 'e2e-nover-shell'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function registerVersionRuntime(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  // upsert 语义：重跑残留同名项直接覆盖，不撞重复名校验
  const res = await request.post(`${API_BASE}/api/settings/custom-agents`, {
    headers,
    data: { name: VERSION_RT, displayName: 'E2E Version RT', command: 'node' },
  })
  if (!res.ok()) throw new Error(`register version runtime failed: ${res.status()}`)
}

async function cleanup(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  for (const name of [VERSION_SESSION, SHELL_SESSION]) {
    const list = await request.get(`${API_BASE}/api/terminals`, { headers })
    const sessions = ((await list.json()) as { data?: { id?: string; name?: string }[] }).data || []
    for (const s of sessions) {
      if (s.name === name && s.id) {
        await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers }).catch(() => { /* 已不存在即目标态 */ })
      }
    }
  }
  await request.delete(`${API_BASE}/api/settings/custom-agents/${VERSION_RT}`, { headers }).catch(() => { /* 不存在即目标态 */ })
}

test.beforeAll(async ({ request }) => {
  await registerVersionRuntime(request)
})

test.afterAll(async ({ request }) => {
  await cleanup(request)
})

/** 解锁后延迟出现的「建议修改默认密码」提醒遮罩会拦截点击，先收起（既有惯例） */
async function dismissPasswordTip(page: Page): Promise<void> {
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

async function enterProject(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await dismissPasswordTip(page)
}

test('创建→meta 含版本→快照携带→会话中心行 tooltip 显版本', async ({ page, request }) => {
  const headers = await unlockHeaders(request)

  // 创建响应同步携带版本（预检顺取，同一 --version 子进程）
  const res = await request.post(`${API_BASE}/api/terminals`, {
    headers,
    data: { name: VERSION_SESSION, kind: 'agent', runtime: VERSION_RT },
  })
  expect(res.status()).toBe(200)
  const created = ((await res.json()) as { data?: { id?: string; runtime?: string; runtimeVersion?: string } }).data
  expect(created?.id, '会话应创建成功').toBeTruthy()
  expect(created?.runtime).toBe(VERSION_RT)
  // node --version 首行形如 v22.11.0
  expect(created?.runtimeVersion || '').toMatch(/^v\d+\.\d+/)

  // meta 异步落库 → GET /terminals 快照反查持久携带（刷新/重连后 tooltip 仍可得）
  await expect(async () => {
    const list = await request.get(`${API_BASE}/api/terminals`, { headers })
    const sessions = ((await list.json()) as { data?: { id?: string; runtimeVersion?: string }[] }).data || []
    expect(sessions.find(s => s.id === created?.id)?.runtimeVersion).toBe(created?.runtimeVersion)
  }).toPass({ timeout: 10_000 })

  // 会话中心（终端会话管理侧栏）行 tooltip 显版本：title 属性含创建响应的版本原文
  await enterProject(page)
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10_000 })
  const row = view.locator('.ats-item', { hasText: VERSION_SESSION }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  const escaped = created!.runtimeVersion!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  await expect(row).toHaveAttribute('title', new RegExp(escaped))
})

test('旧会话/无值空显：shell 一等豁免链行 tooltip 不含版本形态', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${API_BASE}/api/terminals`, {
    headers,
    data: { name: SHELL_SESSION, kind: 'agent', runtime: 'shell' },
  })
  expect(res.status()).toBe(200)

  await enterProject(page)
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10_000 })
  const row = view.locator('.ats-item', { hasText: SHELL_SESSION }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  // 无版本记录（shell 预检豁免/旧会话同形态）：tooltip 只有名字/活动行，不虚构版本
  const title = await row.getAttribute('title')
  expect(title || '').not.toMatch(/v\d+\.\d+\.\d+/)
})
