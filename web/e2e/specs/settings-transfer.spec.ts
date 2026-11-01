import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fixedLocale, gotoAndUnlock, getLockToken, closeDshConsoleAndClearState, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { FONT_SETTINGS_KEY } from '../../src/stores/font'
import { KEYMAP_OVERRIDES_STORAGE_KEY } from '../../src/stores/keymap'
import { DND_STORAGE_KEY } from '../../src/stores/dnd'

/**
 * 设置导出/导入（P-20261005-4）：本地设置族（字号/键位/语言/主题/通知本机偏好）
 * 的多设备迁移包。全链路 = 播种字号+键位覆盖 → 导出（载荷白名单与标记）→ 清除
 * 播种（重置为默认）→ 导入预览显差异 → 勾选仅键位部分导入（键位恢复、字号保持
 * 默认）→ 全量导入（字号恢复）。另有坏 JSON / 未知版本的就地拒绝。
 *
 * 播种用 page.evaluate 写 localStorage（不用 addInitScript——它会在每次导航后
 * 重新执行，「重置」步骤的清除会被再次播回去）。
 */

const DL_DIR = path.join(os.tmpdir(), 'sc-e2e-settings-transfer')

// 种子：全量 font-settings（非默认值）+ 键位覆盖（非默认非保留键）
const SEED_FONT = {
  sizes: { base: 17, editor: 19, terminal: 15, diff: 13, sidebar: 13, bottom: 13 },
  editor: {
    tabSize: 2, insertSpaces: false, wordWrap: 'on', minimap: false, stickyScroll: false,
    renderWhitespace: 'all', autoSave: 'afterDelay', autoSaveDelayMs: 2000,
    formatOnSave: true, gitStatusTabs: true,
  },
  uiFont: 'system',
  terminalLigatures: 'off',
}
const SEED_KEYMAP = { closeTab: 'ctrl+alt+w', saveAll: 'ctrl+alt+u' }

async function seedTransferSettings(page: import('@playwright/test').Page) {
  await page.evaluate(([fontKey, font, keymapKey, keymap]) => {
    localStorage.setItem(fontKey, font)
    localStorage.setItem(keymapKey, keymap)
  }, [FONT_SETTINGS_KEY, JSON.stringify(SEED_FONT), KEYMAP_OVERRIDES_STORAGE_KEY, JSON.stringify(SEED_KEYMAP)])
}

async function enterProjectAndOpenSettings(page: import('@playwright/test').Page) {
  await closeDshConsoleAndClearState(page, page.request, API_BASE)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // 解锁后延迟出现的默认密码提醒遮罩会拦截点击，先收起
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
  await page.locator('[data-testid="rail-settings"]').click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible()
  return modal
}

test.describe('settings transfer (P-20261005-4)', () => {
  test('导出 → 重置 → 部分导入（仅键位）→ 全量导入（字号恢复）', async ({ page }) => {
    test.setTimeout(60000)
    await fixedLocale(page)
    fs.mkdirSync(DL_DIR, { recursive: true })

    // 播种字号+键位覆盖后进设置
    await gotoAndUnlock(page, '/')
    await seedTransferSettings(page)
    await page.reload()
    await gotoAndUnlock(page, '/')
    const modal = await enterProjectAndOpenSettings(page)
    const transfer = modal.locator('[data-testid="settings-transfer"]')

    // ---- 导出：标记/版本/白名单分节 ----
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      transfer.locator('[data-test="settings-export-config"]').click(),
    ])
    // 导出名前缀随品牌切换（4adaf9da）改 codecombo-*
    expect(download.suggestedFilename()).toMatch(/^codecombo-settings-\d{8}\.json$/)
    const exportedPath = path.join(DL_DIR, 'settings-transfer-exported.json')
    await download.saveAs(exportedPath)
    const payload = JSON.parse(fs.readFileSync(exportedPath, 'utf8'))
    expect(payload.scSettings).toBe(1)
    expect(payload.version).toBe(1)
    expect(typeof payload.exportedAt).toBe('string')
    // 白名单：分节键只能是五节之一；播种了 font/keymap，fixedLocale 播了 locale
    expect(Object.keys(payload.sections).sort()).toEqual(['font', 'keymap', 'locale'])
    expect(payload.sections.font.sizes.base).toBe(17)
    expect(payload.sections.font.uiFont).toBe('system')
    expect(payload.sections.keymap).toEqual(SEED_KEYMAP)

    // ---- 重置：清播种键（回到出厂默认）再进设置 ----
    // P-20261007-1 起 keymap 覆盖随服务端 userPrefs 漫游（启动首拉服务端 wins，
    // web/src/stores/userPrefs.ts）：只删本机镜像不够——播种首启已上云，下一次
    // 进页面会把服务端旧值 replaceAll 回本地镜像，预览比较基准随之变成「与导出
    // 一致」。故同步 PUT null 恢复「未配置」三态（与 e2e/global-setup.ts 套件级
    // 复位同语义），比较基准才是真正的出厂默认。先离页再清服务端：避免
    // settings.changed 回流触发在页 store 的防抖补推把旧值写回。
    await modal.locator('.settings-close').click()
    await page.evaluate(([fontKey, keymapKey]) => {
      localStorage.removeItem(fontKey)
      localStorage.removeItem(keymapKey)
    }, [FONT_SETTINGS_KEY, KEYMAP_OVERRIDES_STORAGE_KEY])
    // 令牌在 HttpOnly cookie（P-20261019-2）：页面读不到，经 context.cookies() 取
    const unlockToken = await getLockToken(page)
    await page.goto('about:blank')
    const clearRes = await page.request.put(`${API_BASE}/api/settings`, {
      headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
      data: { userPrefs: null },
    })
    expect(clearRes.status()).toBe(200)
    const modal2 = await enterProjectAndOpenSettings(page)
    const transfer2 = modal2.locator('[data-testid="settings-transfer"]')
    expect(await page.evaluate(k => localStorage.getItem(k), FONT_SETTINGS_KEY)).toBeNull()

    // ---- 导入预览：分节条数 + 差异摘要（重置后 font/keymap 全部不同，locale 一致）----
    await transfer2.locator('input[type=file]').setInputFiles(exportedPath)
    const preview = page.locator('.n-modal:visible').filter({ hasText: '导入配置预览' })
    await expect(preview).toBeVisible()
    const fontRow = preview.locator('[data-test="settings-transfer-section-font"]')
    const keymapRow = preview.locator('[data-test="settings-transfer-section-keymap"]')
    const localeRow = preview.locator('[data-test="settings-transfer-section-locale"]')
    await expect(fontRow).toContainText('与本机不同')
    await expect(keymapRow).toContainText('2 项与本机不同')
    await expect(localeRow).toContainText('与本机一致')

    // ---- 部分导入：只勾键位（取消字号/语言）——键位恢复、字号保持默认 ----
    await preview.locator('[data-test="settings-transfer-check-font"]').click()
    await preview.locator('[data-test="settings-transfer-check-locale"]').click()
    await expect(preview.locator('[data-test="settings-transfer-import-confirm"]')).toContainText('（1 节）')
    await preview.locator('[data-test="settings-transfer-import-confirm"]').click()
    await expect(page.locator('.n-message').filter({ hasText: '已应用 1 个分节的配置' })).toBeVisible({ timeout: 10000 })
    // 键位覆盖已恢复（经 setBinding 正门落盘）
    expect(await page.evaluate(k => localStorage.getItem(k), KEYMAP_OVERRIDES_STORAGE_KEY)).toBe(JSON.stringify(SEED_KEYMAP))
    // 字号未被迁入：font-settings 无键（全默认不落盘）
    expect(await page.evaluate(k => localStorage.getItem(k), FONT_SETTINGS_KEY)).toBeNull()

    // ---- 全量导入：全部勾选——字号与编辑器外观恢复 ----
    await transfer2.locator('input[type=file]').setInputFiles(exportedPath)
    await expect(preview).toBeVisible()
    await preview.locator('[data-test="settings-transfer-import-confirm"]').click()
    await expect(page.locator('.n-message').filter({ hasText: '已应用 3 个分节的配置' })).toBeVisible({ timeout: 10000 })
    const applied = JSON.parse(await page.evaluate(k => localStorage.getItem(k), FONT_SETTINGS_KEY) ?? '{}')
    expect(applied.sizes.base).toBe(17)
    expect(applied.editor.tabSize).toBe(2)
    expect(applied.uiFont).toBe('system')
    // 键位保持
    expect(JSON.parse(await page.evaluate(k => localStorage.getItem(k), KEYMAP_OVERRIDES_STORAGE_KEY) ?? '{}')).toEqual(SEED_KEYMAP)
  })

  test('拒绝面：坏 JSON 与未知版本就地提示，不进预览', async ({ page }) => {
    test.setTimeout(30000)
    await fixedLocale(page)
    fs.mkdirSync(DL_DIR, { recursive: true })
    const modal = await enterProjectAndOpenSettings(page)
    const fileInput = modal.locator('[data-testid="settings-transfer"] input[type=file]')

    // 非 JSON → 格式无效
    const badFile = path.join(DL_DIR, 'bad-settings.json')
    fs.writeFileSync(badFile, 'not-json{{')
    await fileInput.setInputFiles(badFile)
    await expect(page.locator('.n-message').filter({ hasText: '文件格式无效' })).toBeVisible()
    await expect(page.locator('.n-modal').filter({ hasText: '导入配置预览' })).toHaveCount(0)

    // 本应用标记但未知版本 → 版本不受支持
    const futureFile = path.join(DL_DIR, 'future-settings.json')
    fs.writeFileSync(futureFile, JSON.stringify({
      scSettings: 99, version: 99, exportedAt: new Date().toISOString(),
      sections: { font: { sizes: { base: 20 } } },
    }))
    await fileInput.setInputFiles(futureFile)
    await expect(page.locator('.n-message').filter({ hasText: '文件版本不受支持' })).toBeVisible()
    await expect(page.locator('.n-modal').filter({ hasText: '导入配置预览' })).toHaveCount(0)

    // 合法包裹但无有效分节 → 空清单提示
    const emptyFile = path.join(DL_DIR, 'empty-settings.json')
    fs.writeFileSync(emptyFile, JSON.stringify({ scSettings: 1, version: 1, exportedAt: new Date().toISOString(), sections: {} }))
    await fileInput.setInputFiles(emptyFile)
    await expect(page.locator('.n-message').filter({ hasText: '文件中没有可导入的设置分节' })).toBeVisible()
    await expect(page.locator('.n-modal').filter({ hasText: '导入配置预览' })).toHaveCount(0)
  })

  test('通知本机偏好入包：免打扰播种后导出携带 notify 分节', async ({ page }) => {
    test.setTimeout(30000)
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await page.evaluate(([dndKey, dnd]) => {
      localStorage.setItem(dndKey, dnd)
    }, [DND_STORAGE_KEY, JSON.stringify({ enabled: true, start: '23:30', end: '07:00', except: ['approval'], exceptError: false })])
    await page.reload()
    await gotoAndUnlock(page, '/')
    const modal = await enterProjectAndOpenSettings(page)
    const transfer = modal.locator('[data-testid="settings-transfer"]')

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 5000 }),
      transfer.locator('[data-test="settings-export-config"]').click(),
    ])
    const tmpPath = path.join(DL_DIR, 'settings-notify-exported.json')
    await download.saveAs(tmpPath)
    const payload = JSON.parse(fs.readFileSync(tmpPath, 'utf8'))
    expect(payload.sections.notify.dnd).toEqual({
      enabled: true, start: '23:30', end: '07:00', except: ['approval'], exceptError: false,
    })

    // 预览差异：本机同为播种值 → 与本机一致（导入确认不改写）
    await transfer.locator('input[type=file]').setInputFiles(tmpPath)
    const preview = page.locator('.n-modal:visible').filter({ hasText: '导入配置预览' })
    await expect(preview.locator('[data-test="settings-transfer-section-notify"]')).toContainText('与本机一致')
  })
})
