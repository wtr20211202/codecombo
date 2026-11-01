import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 添加项目弹窗 Enter 提交 E2E：
 *   - 项目路径输入框内 Enter = 等价点「添加项目」（提交注册 + 弹窗关闭）
 *   - 项目名留空 → 从路径尾段自动推断
 * 联想下拉选中项的 Enter 仍由 PathInput 内部消费（不上抛提交）。
 * 自备临时目录，用后经 API 清理注册（磁盘目录保留）。
 */

const PROJ = 'e2e-enter-add'
let projDir = ''

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

test.beforeAll(async () => {
  // 清理历史运行残留的同名项目（重试会重复注册同名项目致断言 strict violation）
  try {
    const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: DEFAULT_PASSWORD }),
    })
    const token = ((await unlockRes.json()) as { token?: string }).token || ''
    const headers = { 'X-Lock-Token': token }
    const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
    for (const p of ((list?.data || []) as { id: string; name: string }[])) {
      // 项目名自动取目录名（sc-e2e-enter-add-随机后缀）：目录名前缀匹配才能
      // 清掉历史残留（原固定名精确匹配永远落空，残留卡堆积在首页）
      if (p.name.startsWith('sc-e2e-enter-add-')) {
        await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
      }
    }
  } catch { /* 清理失败不阻塞用例 */ }
  projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-e2e-enter-add-'))
  fs.writeFileSync(path.join(projDir, 'README.md'), 'enter-add probe\n')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name.startsWith('sc-e2e-enter-add-')) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(projDir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('项目路径 Enter 直达提交：注册项目并关闭弹窗', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.getByRole('button', { name: '添加项目' }).first().click()
  const modal = page.locator('.n-modal').filter({ hasText: '添加项目' })
  await expect(modal).toBeVisible({ timeout: 3000 })

  // 项目名留空（断言自动推断），路径输入后直接 Enter
  // 路径按服务端形态填入（注册路径由服务端解释，linux 实例要 /mnt/c 形态）
  const pathInput = modal.locator('input').first()
  await pathInput.fill(serverPath(projDir))
  await pathInput.press('Enter')

  await expect(modal).toBeHidden({ timeout: 10000 })
  await expect(page.locator('.project-card').filter({ hasText: PROJ }).first()).toBeVisible({ timeout: 5000 })
})
