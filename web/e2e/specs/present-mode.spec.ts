import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 投屏演示模式 E2E（P-20261002-45，配方同 qr-relay：Ctrl+K → `>` 命令模式）：
 *   - 命令进入：编辑器/终端字号临时 ×1.5（--fs-editor/--fs-terminal 是 Monaco/xterm
 *     消费的生效字号出口在根元素的投影）+ 侧栏与底栏收起
 *   - Esc 退出 / 再次执行同一命令退出：字号与面板开合全还原——
 *     进入前置非默认态（底栏终端打开），退出后仍是该态，证明快照恢复而非默认拼凑
 *
 * 前置态自管（changes-filter 同款）：uiState 面板开合是服务端跨用例全局状态，
 * beforeAll 归零 + 退出还原链路自愈；演示中途失败会把「面板收起」autosave 落盘，
 * afterAll 再归零一次防布局恢复污染后续 spec。
 */

function unlockHeaders(): Promise<Record<string, string>> {
  return fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  }).then(async (res) => {
    const token = ((await res.json()) as { token?: string }).token || ''
    return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  })
}

test.beforeAll(async () => {
  // 归零面板开合等布局残留：否则上个用例/上次失败运行 autosave 的「面板收起」
  // 会在 bootstrap 恢复后与 toggle 键盲按叠加，前置态不可预期
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ local: null }),
  })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ local: null }),
  })
})

async function openProjectPage(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

async function runPaletteCommand(page: Page, text: string) {
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(`>${text}`)
  const item = page.locator('.palette-item').filter({ hasText: text }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
  // 面板关闭 = 命令已执行（activate 统一 emit update:show false）
  await expect(input).toBeHidden({ timeout: 5000 })
}

function fontVars(page: Page) {
  return page.evaluate(() => ({
    editor: document.documentElement.style.getPropertyValue('--fs-editor'),
    terminal: document.documentElement.style.getPropertyValue('--fs-terminal'),
  }))
}

/** 把侧栏/底栏归位到「都开」的已知前置态。Ctrl+B / Ctrl+` 是 toggle 键，
 *  盲按会反向关闭——先探可见性再按，循环归一化（changes-filter.openCommitPanel
 *  同款 bounded loop，兜住 bootstrap uiState 恢复的异步落地） */
async function ensurePanelsOpen(page: Page) {
  const sidePanel = page.locator('#side-panel')
  const bottomPanel = page.locator('.bottom-panel')
  for (let i = 0; i < 3; i++) {
    const sideVisible = await sidePanel.isVisible().catch(() => false)
    const bottomVisible = await bottomPanel.isVisible().catch(() => false)
    if (sideVisible && bottomVisible) return
    if (!sideVisible) await page.keyboard.press('Control+b')
    if (!bottomVisible) await page.keyboard.press('Control+`')
    await page.waitForTimeout(600)
  }
  expect(await sidePanel.isVisible()).toBe(true)
  expect(await bottomPanel.isVisible()).toBe(true)
}

test('命令进入演示态：字号放大 + 面板收起，Esc 退出全还原', async ({ page }) => {
  await openProjectPage(page)
  // 进入前置非默认态：底栏终端打开（退出须还原为开）
  await ensurePanelsOpen(page)
  const bottomPanel = page.locator('.bottom-panel')
  const sidePanel = page.locator('#side-panel')

  const before = await fontVars(page)
  const expected = {
    editor: `${Math.round(parseFloat(before.editor) * 1.5)}px`,
    terminal: `${Math.round(parseFloat(before.terminal) * 1.5)}px`,
  }

  await runPaletteCommand(page, '投屏演示模式')

  // 演示态：面板收起 + 字号临时放大
  await expect(sidePanel).toBeHidden({ timeout: 5000 })
  await expect(bottomPanel).toBeHidden()
  expect(await fontVars(page)).toEqual(expected)

  // Esc 退出（命令面板已关、焦点回落 body——非输入框，走 useLayoutKeyboard Esc 链）
  await page.keyboard.press('Escape')

  // 全还原：面板回到进入前（底栏开、侧栏开）、字号回到进入前
  await expect(sidePanel).toBeVisible({ timeout: 5000 })
  await expect(bottomPanel).toBeVisible({ timeout: 5000 })
  expect(await fontVars(page)).toEqual(before)
})

test('再次执行同一命令退出：字号与面板开合全还原', async ({ page }) => {
  await openProjectPage(page)
  await ensurePanelsOpen(page)
  const bottomPanel = page.locator('.bottom-panel')
  const sidePanel = page.locator('#side-panel')

  const before = await fontVars(page)
  await runPaletteCommand(page, '投屏演示模式')
  await expect(sidePanel).toBeHidden({ timeout: 5000 })
  await expect(bottomPanel).toBeHidden()

  await runPaletteCommand(page, '投屏演示模式')

  await expect(sidePanel).toBeVisible({ timeout: 5000 })
  await expect(bottomPanel).toBeVisible({ timeout: 5000 })
  expect(await fontVars(page)).toEqual(before)
})
