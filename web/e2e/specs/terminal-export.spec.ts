import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端「导出为文本」E2E：新建终端 → 执行 echo 回显唯一标记 → 更多操作 →
 * 导出为文本 → 下载 .txt 内容含标记（scrollback 缓冲导出链路此前零覆盖）。
 */

const MARKER = 'SC-E2E-EXPORT-MARKER-9527'
const DL_DIR = path.join(os.tmpdir(), 'sc-e2e-terminal-export')

test('终端导出为文本：回显内容进入下载文件', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')

  // 归一化：底部终端面板可见
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }

  // 新建终端并等待 shell 就绪
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(2500)

  // 聚焦终端输入唯一标记回显（多 tab xterm 取 last 可见屏：前序 spec 的
  // keep-alive 隐藏终端与任务终端会让 first() 命中不可见屏——CLAUDE.md 经验 1）
  await page.locator('.xterm-screen:visible').last().click()
  await page.keyboard.type(`echo ${MARKER}`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)

  // 更多操作 → 导出为文本
  await page.locator('.term-tabbar button[title="更多操作"]').click()
  const exportOpt = page.locator('.n-dropdown-option').filter({ hasText: '导出为文本' }).first()
  await expect(exportOpt).toBeVisible({ timeout: 3000 })

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    exportOpt.click(),
  ])

  fs.mkdirSync(DL_DIR, { recursive: true })
  const file = path.join(DL_DIR, download.suggestedFilename())
  await download.saveAs(file)
  expect(download.suggestedFilename()).toMatch(/\.txt$/)
  const content = fs.readFileSync(file, 'utf8')
  expect(content).toContain(MARKER)
})
