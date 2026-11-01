import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixedLocale, unlockIfNeeded, waitForAppReady, projectCardByName } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 请求 ID 跨面排障关联（P-20261003-216）E2E
 *
 * 三层链路一次验证（真实后端错误，不 route.fulfill——拦截响应没有 X-Request-Id 头）：
 *   1. 响应头：POST /api/projects 400（AddProject 对不存在路径的真实拒绝）带 X-Request-Id
 *   2. 前端 errorLog：错误条目行内展示同值短码（axios 拦截器捕获响应头）
 *   3. 后端日志：数据面 logs/codecombo-*.log 含 rid= 同值访问行（gin formatter 追加；
 *      P-20261025-1 标识切换后日志文件名前缀 simple-coding- → codecombo-）
 *
 * 造错方式：添加项目弹窗填一个不存在的路径 → 服务端 400
 *「path does not exist or is not a directory」→ KNOWN_ERROR_I18N 映射「路径不存在…」，
 * 错误行落错误日志（silent 与否都写 Console）。
 */

// 数据面日志目录：e2e-restart.sh 默认 .e2e-data（SC_E2E_DATA_DIR 可覆盖）。
// playwright 调用方 cwd 有两种形态——web/（e2e-worktree.sh / 全量分片）或
// 仓库根；逐一探测兼容（ESM 无 __dirname，同 ssh-tofu 先例）
function resolveLogDir(): string {
  const data = process.env.SC_E2E_DATA_DIR || '.e2e-data'
  const cwd = process.cwd()
  for (const p of [path.resolve(cwd, data, 'logs'), path.resolve(cwd, '..', data, 'logs')]) {
    if (fs.existsSync(p)) return p
  }
  return path.resolve(cwd, data, 'logs')
}
const LOG_DIR = resolveLogDir()

/** 在数据面日志文件中检索 rid（逐文件读，15 天滚动小体量；找不到返回 false） */
function ridInServerLogs(rid: string): boolean {
  let files: string[] = []
  try {
    files = fs.readdirSync(LOG_DIR).filter(f => f.startsWith('codecombo-') && f.endsWith('.log'))
  } catch {
    return false
  }
  const needle = `rid=${rid}`
  for (const f of files) {
    try {
      if (fs.readFileSync(path.join(LOG_DIR, f), 'utf-8').includes(needle)) return true
    } catch { /* 文件滚动竞争忽略，继续其他文件 */ }
  }
  return false
}

test('请求 ID 三层对齐：响应头 → 错误条目短码 → 后端日志 rid 行', async ({ page }) => {
  await fixedLocale(page)
  await page.goto('/')
  await page.waitForSelector('body')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await page.waitForSelector('.project-card', { timeout: 8000 })

  // 进入项目页（错误面板的 message API 在 Layout 内挂载）
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project', { timeout: 10000 })

  // 真实后端 400：添加项目填不存在路径
  const respPromise = page.waitForResponse(
    r => r.request().method() === 'POST' && r.url().includes('/api/projects') && r.status() === 400,
    { timeout: 15000 },
  )
  await page.getByRole('button', { name: '添加项目' }).first().click()
  const modal = page.locator('.n-modal').filter({ hasText: '添加项目' })
  await expect(modal).toBeVisible({ timeout: 3000 })
  // tmpdir 下必不存在的绝对路径（服务端 os.Stat 400）；linux 服务端形态经 serverPath
  const noSuchDir = path.join(os.tmpdir(), `sc-no-such-${Date.now()}`)
  const pathInput = modal.locator('input').first()
  await pathInput.fill(serverPath(noSuchDir))
  await pathInput.press('Enter')

  // 第 1 层：响应头带 16 位 hex 关联 ID
  const resp = await respPromise
  const rid = resp.headers()['x-request-id'] || ''
  expect(rid).toMatch(/^[0-9a-f]{16}$/)

  // 失败时弹窗保持打开并挡住底部面板——先取消收起
  await modal.getByRole('button', { name: '取消' }).click()
  await expect(modal).toBeHidden({ timeout: 3000 })

  // 第 2 层：错误条目行内展示同值短码（打开底部控制台 → 错误子标签）
  const consoleTab = page.locator('.bottom-tabs button').filter({ hasText: '控制台' })
  if (!(await consoleTab.isVisible().catch(() => false))) {
    await page.keyboard.press('Control+`')
    await consoleTab.waitFor({ state: 'visible', timeout: 5000 })
  }
  await consoleTab.click()
  await page.locator('.sub-tab').filter({ hasText: '错误' }).click()

  const errRow = page.locator('.log-row').filter({ hasText: '路径不存在或不是目录' }).first()
  await expect(errRow).toBeVisible({ timeout: 10000 })
  await expect(errRow.locator('[data-testid="errorlog-request-id"]')).toHaveText(rid)

  // 第 3 层：后端日志存在 rid= 同值的访问行（跨面对齐的最终证据）
  expect(ridInServerLogs(rid)).toBe(true)
})
