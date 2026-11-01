import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端「重启 shell」E2E：设置会话环境变量 → 导出 scrollback 含该值 →
 * 重启 shell（close + 同名新建）→ 再次 echo → 导出内容中环境变量已重置。
 * 两次导出对比验证「重置」语义（重启用于 shell hang / 环境变量污染场景）。
 */

const DL_DIR = path.join(os.tmpdir(), 'sc-e2e-terminal-restart')
const MARKER = 'm9527'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

// 清理前置 spec 遗留的终端会话与 docked tab：字母序相邻的 terminal-export /
// terminal-history-snippet 会留下 tab，旧 tab 的 xterm-screen 拦截后续点击
// （全量串行下曾致本用例三连败，隔离跑无前置遗留则必过）
async function cleanupLeftoverTerminals(page: import('@playwright/test').Page, request: import('@playwright/test').APIRequestContext) {
  const headers = await unlockHeaders()
  const plist = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  const proj = ((plist?.data || []) as { id: string; name: string }[]).find(x => x.name === 'simple-coding')
  if (!proj) return
  const tlist = await (await request.get(`${API_BASE}/api/terminals`, { headers })).json()
  for (const s of ((tlist?.data || []) as { id: string; projectId?: string }[])) {
    if (s.projectId === proj.id) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
  }
  // UI 层兜底：服务端会话已删但前端 tab 残留时逐个关闭
  for (let i = 0; i < 20; i++) {
    const lastTab = page.locator('.term-tab').last()
    if ((await lastTab.count()) === 0) return
    await lastTab.locator('.term-close-btn').click()
    if (await page.locator('.n-modal').isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '确认' }).click()
    }
    await page.waitForTimeout(400)
  }
}

async function openTerminalAndRun(page: import('@playwright/test').Page, command: string) {
  // shell 引导需要时间：等待 xterm 就绪后再聚焦输入（重启后 DOM 可能残留
  // 旧实例，须以可见实例为准）
  // 新 tab 内容追加在 DOM 尾部且叠于旧内容之上——取 last 而非 first
  const screen = page.locator('.xterm-screen:visible').last()
  await expect(screen).toBeVisible({ timeout: 20000 })
  await screen.click()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
}

async function exportScrollback(page: import('@playwright/test').Page, name: string): Promise<string> {
  await page.locator('.term-tabbar button[title="更多操作"]').click()
  const exportOpt = page.locator('.n-dropdown-option').filter({ hasText: '导出为文本' }).first()
  await expect(exportOpt).toBeVisible({ timeout: 3000 })
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    exportOpt.click(),
  ])
  fs.mkdirSync(DL_DIR, { recursive: true })
  const file = path.join(DL_DIR, `${name}.txt`)
  await download.saveAs(file)
  return fs.readFileSync(file, 'utf8')
}

test('重启 shell：会话环境变量重置', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 归一化：底部终端面板可见
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }
  await cleanupLeftoverTerminals(page, request)
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(3500)
  // 激活新建 tab：前置 spec 残留的 tab-content 可能仍挂载在 DOM 里拦截
  // 点击（全量串扰根因），点击新 tab 让其内容置于顶层
  await page.locator('.term-tab').last().click()
  await page.waitForTimeout(600)

  // 1) 设置会话级环境变量并导出：内容含标记
  await openTerminalAndRun(page, `$env:SCE2E = '${MARKER}'`)
  const before = await exportScrollback(page, 'before-restart')
  expect(before).toContain(MARKER)

  // 2) 重启 shell（close + 同名新建，前端组合实现）
  await page.locator('.term-tabbar button[title="更多操作"]').click()
  const restartOpt = page.locator('.n-dropdown-option').filter({ hasText: '重启 shell' }).first()
  await expect(restartOpt).toBeVisible({ timeout: 3000 })
  await restartOpt.click()
  await page.waitForTimeout(4000)

  // 3) 新 shell 中再次查看：环境变量应已重置
  await openTerminalAndRun(page, 'echo before-restart-777')
  const after = await exportScrollback(page, 'after-restart')
  expect(after).toContain('before-restart-777') // 新 shell 已就绪且回显
  expect(after).not.toContain(MARKER) // 旧会话的环境变量已随重启消失
})
