import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 设置 → 通用「工作区状态备份」E2E（roadmap #9：uiState 导出/导入收口）：
 *   导出：点击导出 → 触发 JSON 下载，内容带 scUiState 标记与 states 集合
 *   导入：setInputFiles 注入带标记的备份 → 确认覆盖 → API 校验值写回
 *   （本用例选「稍后」不刷新，直接读服务端 ui-state 断言命名空间落盘）
 */

const DL_DIR = path.join(os.tmpdir(), 'sc-e2e-backup-dl')

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function openGeneralSettings(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
}

test('导出：下载 JSON 带 scUiState 标记与 states 集合', async ({ page }) => {
  // 播种一条可导出状态：P-20261002-8 起写入是键级补丁、零变更页零请求——
  // 纯打开项目页不再产生 uiState 记录（旧实现依赖挂载 auto-save 整包 PUT
  // 的副作用填库），空文档导出走「暂无状态」警告不发下载；与「备份回环」
  // 用例导出前 setWidth 播种同款
  const headers = await unlockHeaders()
  const seed = await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT', headers,
    body: JSON.stringify({ local: { layout: { sidePanelWidth: 300 } } }),
  })
  expect(seed.ok).toBeTruthy()

  await openGeneralSettings(page)

  const section = page.locator('.wb-section')
  await expect(section).toBeVisible({ timeout: 3000 })

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    section.getByRole('button', { name: '导出状态' }).click(),
  ])
  // 导出名前缀随品牌切换（4adaf9da）改 codecombo-*
  expect(download.suggestedFilename()).toMatch(/^codecombo-ui-state-\d{4}-\d{2}-\d{2}\.json$/)

  fs.mkdirSync(DL_DIR, { recursive: true })
  const file = path.join(DL_DIR, download.suggestedFilename())
  await download.saveAs(file)
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  expect(parsed.scUiState).toBe(1)
  expect(typeof parsed.exportedAt).toBe('string')
  expect(Object.keys(parsed.states || {}).length).toBeGreaterThan(0)
})

test('导入：注入备份 → 确认覆盖 → 命名空间写回服务端', async ({ page }) => {
  await openGeneralSettings(page)

  // 构造备份：本机实例（local）的 layout 命名空间带可断言的标记值
  const backup = {
    scUiState: 1,
    exportedAt: new Date().toISOString(),
    states: {
      local: {
        layout: { sidePanelWidth: 333, showSidePanel: true, sideView: 'files', bottomTab: 'terminal', showBottomPanel: false, bottomPanelHeight: 260 },
      },
      // 未知实例 id + 未知命名空间都应被静默接受（白名单过滤在写入侧收口）
      'e2e-unknown-instance': { layout: { sidePanelWidth: 280 } },
    },
  }
  const backupFile = path.join(DL_DIR, 'import-backup.json')
  fs.mkdirSync(DL_DIR, { recursive: true })
  fs.writeFileSync(backupFile, JSON.stringify(backup))

  const section = page.locator('.wb-section')
  await section.locator('input[type=file]').setInputFiles(backupFile)

  // 覆盖确认 → 导入（新旧对话框交接期会短暂同屏，按内容过滤定位）
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: '导入工作区状态' })
  await expect(confirmDlg).toBeVisible({ timeout: 3000 })
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: '导入' }).click()

  // 完成提示：选「稍后」不刷新，直接校验服务端状态
  const doneDlg = page.locator('.n-dialog').filter({ hasText: '导入完成' })
  await expect(doneDlg).toBeVisible({ timeout: 3000 })
  await doneDlg.locator('.n-dialog__action button').filter({ hasText: '稍后' }).click()

  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
  const all = ((await res.json()) as { data?: Record<string, { layout?: { sidePanelWidth?: number } }> }).data || {}
  expect(all.local?.layout?.sidePanelWidth).toBe(333)
})

test('导入负向：非备份 JSON → 本地化报错不写盘', async ({ page }) => {
  await openGeneralSettings(page)

  const badFile = path.join(DL_DIR, 'not-a-backup.json')
  fs.writeFileSync(badFile, JSON.stringify({ hello: 'world' }))

  const section = page.locator('.wb-section')
  await section.locator('input[type=file]').setInputFiles(badFile)

  await expect(page.locator('.n-message').filter({ hasText: '文件格式无效' })).toBeVisible({ timeout: 5000 })
  // 未弹覆盖确认（校验前置拦截）
  await expect(page.locator('.n-dialog').filter({ hasText: '导入工作区状态' })).toHaveCount(0)
})

test('备份回环：导出 → 外部改动 → 导入 → 状态还原', async ({ page }) => {
  const headers = await unlockHeaders()
  // 1) 基线：当前 sidePanelWidth = 300
  const setWidth = async (w: number) => {
    const put = await fetch(`${API_BASE}/api/ui-state`, {
      method: 'PUT', headers,
      body: JSON.stringify({ local: { layout: { sidePanelWidth: w } } }),
    })
    expect(put.ok).toBeTruthy()
  }
  await setWidth(300)

  await openGeneralSettings(page)
  const section = page.locator('.wb-section')

  // 2) 导出快照（含 300）
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    section.getByRole('button', { name: '导出状态' }).click(),
  ])
  const backupFile = path.join(DL_DIR, 'roundtrip.json')
  await download.saveAs(backupFile)

  // 3) 外部把值改成 400（模拟导入前的漂移）
  await setWidth(400)

  // 4) 导入快照 → 确认覆盖 → 稍后不刷新
  await section.locator('input[type=file]').setInputFiles(backupFile)
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: '导入工作区状态' })
  await expect(confirmDlg).toBeVisible({ timeout: 3000 })
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: '导入' }).click()
  const doneDlg = page.locator('.n-dialog').filter({ hasText: '导入完成' })
  await expect(doneDlg).toBeVisible({ timeout: 3000 })
  await doneDlg.locator('.n-dialog__action button').filter({ hasText: '稍后' }).click()

  // 5) 服务端状态还原为快照值 300（备份真的恢复了导入前的状态）
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
  const all = ((await res.json()) as { data?: Record<string, { layout?: { sidePanelWidth?: number } }> }).data || {}
  expect(all.local?.layout?.sidePanelWidth).toBe(300)
})
