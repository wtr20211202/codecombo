import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 首页空态上手引导（P-20261002-22）：空态除主按钮外补两条次级上手路径——
 * 「从 URL 克隆项目」直接打开克隆弹窗（复用项目页 CloneModal）、「查看快速上手指南」
 * 打开帮助中心抽屉；描述区补一句产品定位文案。
 *
 * 数据面：P-48 播种基线预置项目卡，空态需项目列表为空——beforeEach 快照全部项目后
 * 逐个移除注册（不删磁盘目录）；afterEach 清掉当轮项目并按快照原样恢复（id 会变、
 * 名字/路径不变），不影响同实例后续 spec。套件 workers=1 串行共享实例，安全。
 */

type ProjectSnapshot = { id: string; name: string; path: string }

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let saved: ProjectSnapshot[] = []

test.beforeEach(async ({ request }) => {
  const headers = await unlockHeaders()
  const list = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  saved = ((list?.data || []) as ProjectSnapshot[])
    .map(p => ({ id: p.id, name: p.name, path: p.path }))
  for (const p of saved) {
    await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
  }
})

test.afterEach(async ({ request }) => {
  const headers = await unlockHeaders()
  const list = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as ProjectSnapshot[])) {
    await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
  }
  for (const p of saved) {
    await request.post(`${API_BASE}/api/projects`, { headers, data: { name: p.name, path: p.path } })
  }
})

test('空态：定位文案 + 主按钮 + 两条次级上手路径', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const empty = page.locator('.home-empty')
  await expect(empty).toBeVisible({ timeout: 10000 })

  // 描述区：原空态文案 + 产品定位一句话
  await expect(empty).toContainText('还没有添加任何项目')
  await expect(empty).toContainText('浏览器里的远程开发工作台')

  // 主按钮照旧
  await expect(empty.getByRole('button', { name: '添加第一个项目' })).toBeVisible()

  // 两条次级路径可见
  await expect(empty.getByRole('button', { name: '从 URL 克隆项目' })).toBeVisible()
  await expect(empty.getByRole('button', { name: '查看快速上手指南' })).toBeVisible()
})

test('空态「从 URL 克隆项目」直接打开克隆弹窗', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const empty = page.locator('.home-empty')
  await expect(empty).toBeVisible({ timeout: 10000 })
  await empty.getByRole('button', { name: '从 URL 克隆项目' }).click()

  // CloneModal（项目页同款）：标题「克隆远程仓库」+ 仓库 URL 表单
  const modal = page.locator('.n-modal').filter({ hasText: '克隆远程仓库' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  await expect(modal.locator('input').first()).toBeVisible()

  // 取消收起，确认弹窗可正常关闭
  await modal.locator('button').filter({ hasText: '取消' }).click()
  await expect(modal).toBeHidden({ timeout: 5000 })
})

test('空态「查看快速上手指南」打开帮助中心抽屉', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const empty = page.locator('.home-empty')
  await expect(empty).toBeVisible({ timeout: 10000 })
  await empty.getByRole('button', { name: '查看快速上手指南' }).click()

  const drawer = page.locator('.n-drawer').filter({ hasText: '帮助中心' })
  await expect(drawer).toBeVisible({ timeout: 5000 })
  await drawer.locator('.n-base-close').click()
  await expect(drawer).toBeHidden({ timeout: 5000 })
})
