import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话输出留档导出 E2E（P-20261003-100）：GET /api/terminals/:id/export——
 * 服务端 scrollback 读取链剥 ANSI 直出 txt 附件。与 terminal-export.spec.ts
 * （客户端「导出为文本」，xterm 缓冲直下）互补，本文件覆盖服务端链路：
 *   1. API 链路：未知会话 404 / 建会话回显唯一标记 → 导出体含标记行 +
 *      Content-Disposition 附件名（terminal-<会话名>-<日期>.txt）+ 零 ESC 残留
 *   2. UI 链路：会话 tab 右键「导出输出」→ 下载文件含已知输出行
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || API_BASE
const PROJECT_NAME = 'simple-coding'
const API_MARK = 'SC-E2E-SRV-EXPORT-4100'
const UI_MARK = 'SC-E2E-TAB-EXPORT-4100'
const DL_DIR = path.join(os.tmpdir(), 'sc-e2e-terminal-export-output')

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function createTerminal(request: APIRequestContext, headers: Record<string, string>, name: string): Promise<string> {
  const projects = await request.get(`${BASE}/api/projects`, { headers })
  const list = ((await projects.json()) as { data?: { id: string; name: string }[] }).data || []
  const projectId = list.find(x => x.name === PROJECT_NAME)?.id
  if (!projectId) throw new Error(`project ${PROJECT_NAME} not found`)
  const res = await request.post(`${BASE}/api/terminals`, { headers, data: { projectId, name } })
  expect(res.ok()).toBeTruthy()
  const data = ((await res.json()) as { data?: { id?: string } }).data
  if (!data?.id) throw new Error('terminal id missing')
  return data.id
}

test('API 链路：404 门 + 导出体含已知输出行 + 附件名 + 零 ESC 残留', async ({ request }) => {
  const headers = await unlockHeaders(request)

  // 未知会话 404（错误路径不携带附件头）
  const bad = await request.get(`${BASE}/api/terminals/no-such-session/export`, { headers })
  expect(bad.status()).toBe(404)

  const sessionId = await createTerminal(request, headers, 'e2e-srv-export')
  try {
    // 回显唯一标记（broadcast-write 原始 PTY 输入，尾部 \r 执行）
    const wr = await request.post(`${BASE}/api/terminals/broadcast-write`, {
      headers, data: { ids: [sessionId], data: `echo ${API_MARK}\r` },
    })
    expect(wr.ok()).toBeTruthy()

    // 导出（轮询等 PTY 回显落进服务端缓冲）
    let body = ''
    let disp = ''
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500))
      const res = await request.get(`${BASE}/api/terminals/${sessionId}/export`, { headers })
      expect(res.status()).toBe(200)
      disp = res.headers()['content-disposition'] || ''
      body = await res.text()
      if (body.includes(API_MARK)) break
    }
    expect(body).toContain(API_MARK)
    // 附件头：terminal-<会话名>-<yyyymmdd>.txt（净化 helper + mime.FormatMediaType）
    expect(disp).toContain('attachment')
    expect(disp).toMatch(/terminal-e2e-srv-export-\d{8}\.txt/)
    // ANSI 剥离：留档是可读纯文本（StripANSI 单实现），零转义字节残留
    expect(body).not.toContain('\x1b')
  } finally {
    await request.delete(`${BASE}/api/terminals/${sessionId}`, { headers })
  }
})

test('UI 链路：会话 tab 右键「导出输出」→ 下载文件含已知输出行', async ({ page }) => {
  test.setTimeout(60_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')

  // 归一化：底部终端面板可见（面板开合是 uiState 持久态，随跑序而异）
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }

  // 新建终端并等待 shell 就绪
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(2500)

  // 聚焦最新 tab 的可见屏输入唯一标记（多 tab xterm 断言取 last——CLAUDE.md 经验）
  await page.locator('.xterm-screen:visible').last().click()
  await page.keyboard.type(`echo ${UI_MARK}`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)

  // 最新 tab 右键 → 「导出输出」（tab 右键菜单为多提案热区，断言走专属 testid；
  // 菜单 teleport 到 body，先右键等菜单渲染再点项——download 事件与点击并行等）
  const tab = page.locator('.term-tab').last()
  await tab.click({ button: 'right' })
  const exportItem = page.locator('[data-testid="terminal-export-output"]')
  await expect(exportItem).toBeVisible({ timeout: 3000 })
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    exportItem.click(),
  ])

  fs.mkdirSync(DL_DIR, { recursive: true })
  const file = path.join(DL_DIR, download.suggestedFilename())
  await download.saveAs(file)
  // 下载名客户端合成：terminal-<会话名摘要>-<yyyymmdd>.txt
  expect(download.suggestedFilename()).toMatch(/^terminal-.*-\d{8}\.txt$/)
  const content = fs.readFileSync(file, 'utf8')
  expect(content).toContain(UI_MARK)
  expect(content).not.toContain('\x1b')
})
