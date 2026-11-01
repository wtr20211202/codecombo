import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * md 表格列宽失衡修正 E2E（P-20261010-1）：
 *   ① 分享访客页含四列表格的 md →「状态」短列 min-width 下限保护：
 *      长说明列挤压下「待回复」仍单行（修复前逐字竖排换行）
 *   ② th 右缘手柄拖拽 → 切 fixed + col 显式宽，列宽随拖拽变化
 *   ③ 双击手柄该列回自动 → 全部双击整表回自动布局
 *   ④ 刷新回自动布局（会话内记忆不持久化）
 *   ⑤ 窄屏(<700px)禁用回落：手柄隐藏、拖拽不切 fixed；宽→窄过渡回自动布局
 *   ⑥ 主站编辑器 md 预览同形态：拖拽切 fixed + 双击恢复
 * 访客面打在分享子服务（主端口 +2，经 /api/share/status 动态获取）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ = 'simple-coding'
const MD_FILE = 'e2e-md-table-col-resize.md'
// 说明列 ~160 个汉字：自动布局下贪婪扩张，无下限保护时把「状态」列压到一字宽
const LONG_DESC = '这一列是很长的说明文字用于复现列宽失衡问题。'.repeat(8) + '结尾。'
const MD_CONTENT = [
  '# 对接准备与联调事项',
  '',
  '| # | 事项 | 说明 | 状态 |',
  '| --- | --- | --- | --- |',
  `| 1 | 接口联调 | ${LONG_DESC} | 待回复 |`,
  '| 2 | 环境准备 | 次长一点的说明文字占位。 | 已完成 |',
  '',
].join('\n')

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJ)
  if (!p) throw new Error(`project ${PROJ} not found`)
  return p.id
}

async function getShareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

let headers: Record<string, string>
let projectId = ''
let shareBase = ''

test.beforeAll(async ({ request }) => {
  headers = await unlockHeaders(request)
  projectId = await getProjectId(request, headers)
  shareBase = await getShareBase(request, headers)
  // 临时 md（四列表格 + 长说明列）：先删后建幂等，残留会让 create 409
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: MD_FILE } })
  const created = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path: MD_FILE, content: MD_CONTENT },
  })
  expect(created.ok()).toBeTruthy()
  const shared = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: MD_FILE } })
  expect(shared.ok()).toBeTruthy()
})

test.afterAll(async ({ request }) => {
  // 撤销分享 + 清理探针文件（此 spec 用真实项目仓库，不得残留）
  const list = await (await request.get(`${BASE}/api/share`, { headers })).json()
  for (const s of ((list?.data || []) as { token: string; name: string }[])) {
    if (s.name === MD_FILE) await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  }
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: MD_FILE } })
})

async function openSharedMd(page: Page): Promise<void> {
  // share 列表 API 需要锁令牌（page.request 裸调用会 401）
  const list = await (await page.request.get(`${BASE}/api/share`, { headers })).json()
  const s = ((list?.data || []) as { token: string; name: string }[]).find(x => x.name === MD_FILE)
  expect(s?.token).toBeTruthy()
  await page.goto(`${shareBase}/s/${s!.token}`)
  await expect(page.locator('.md-article table')).toBeVisible({ timeout: 10000 })
}

test('短列下限保护：长说明列挤压下「待回复」单行 + 手柄拖拽/双击恢复', async ({ page }) => {
  await openSharedMd(page)
  const tbl = page.locator('.md-article table')
  const statusCell = tbl.locator('tbody tr').first().locator('td').nth(3)

  // ① min-width 下限：状态列四字短词单行呈现（修复前被压到逐字竖排）。
  // 文本高度用 Range 量——td 的 border-box 会拉伸到整行高（长说明列换行后
  // 整行 ~390px），量不到短词本身的行数
  const textH = await statusCell.evaluate(el => {
    const r = document.createRange()
    r.selectNodeContents(el)
    return r.getBoundingClientRect().height
  })
  expect(textH).toBeLessThan(30) // 单行 ≈22px；两行起 >43（逐字竖排 >60）
  const cellBox = await statusCell.evaluate(el => el.getBoundingClientRect())
  expect(cellBox.width).toBeGreaterThanOrEqual(50) // 4em(≈53px)+壳 下限在起作用

  // 表不撑破容器：长说明列经 anywhere 断行（tbl-wrap 横滚不出现）
  const noHScroll = await tbl.evaluate(el => {
    const wrap = el.parentElement as HTMLElement
    return wrap.scrollWidth <= wrap.clientWidth + 1
  })
  expect(noHScroll).toBe(true)

  // ② 拖拽「状态」列手柄右移 → 切 fixed + col 显式宽变化
  const handle = tbl.locator('th').nth(3).locator('.col-handle')
  await expect(handle).toHaveCount(1)
  const thBefore = await tbl.locator('th').nth(3).evaluate(el => el.getBoundingClientRect().width)
  const hb = await handle.boundingBox()
  expect(hb).toBeTruthy()
  await page.mouse.move(hb!.x + hb!.width / 2, hb!.y + hb!.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb!.x + 140, hb!.y + hb!.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(tbl).toHaveClass(/sc-cols-fixed/)
  const colW = await tbl.evaluate(el =>
    (el.querySelector('colgroup col:nth-child(4)') as HTMLElement).style.width,
  )
  expect(parseFloat(colW)).toBeGreaterThanOrEqual(thBefore + 120)

  // fixed 后列宽确实生效（th 宽度跟随 col 值）
  const thAfter = await tbl.locator('th').nth(3).evaluate(el => el.getBoundingClientRect().width)
  expect(Math.abs(thAfter - parseFloat(colW))).toBeLessThanOrEqual(2)

  // ③ 双击该手柄 → 该列回自动（显式宽清空）；其余列保留后逐一双击 → 整表回自动
  await handle.dblclick()
  const colWAfterDbl = await tbl.evaluate(el =>
    (el.querySelector('colgroup col:nth-child(4)') as HTMLElement).style.width,
  )
  expect(colWAfterDbl).toBe('')
  await expect(tbl).toHaveClass(/sc-cols-fixed/)
  for (let i = 0; i < 3; i++) {
    await tbl.locator('th').nth(i).locator('.col-handle').dblclick()
  }
  await expect(tbl).not.toHaveClass(/sc-cols-fixed/)
  await expect(tbl.locator('colgroup')).toHaveCount(0)

  // ④ 会话内记忆：宽度只落 DOM——刷新回自动布局
  await page.reload()
  await expect(page.locator('.md-article table')).toBeVisible()
  await expect(page.locator('.md-article table')).not.toHaveClass(/sc-cols-fixed/)
})

test('窄屏（<700px）禁用回落：手柄隐藏、拖拽不切 fixed、宽→窄回自动', async ({ page }) => {
  await openSharedMd(page)
  const tbl = page.locator('.md-article table')

  // 宽屏先拖出一张 fixed 表
  const handle = tbl.locator('th').nth(2).locator('.col-handle')
  const hb = await handle.boundingBox()
  await page.mouse.move(hb!.x + 2, hb!.y + hb!.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb!.x + 100, hb!.y + hb!.height / 2, { steps: 4 })
  await page.mouse.up()
  await expect(tbl).toHaveClass(/sc-cols-fixed/)

  // 缩到窄屏：matchMedia 回落监听把 fixed 表整体打回自动布局
  await page.setViewportSize({ width: 500, height: 800 })
  await expect(tbl).not.toHaveClass(/sc-cols-fixed/)
  await expect(tbl.locator('colgroup')).toHaveCount(0)

  // 窄屏重渲染形态：手柄 CSS 隐藏 + 拖拽路径 JS 守卫，表保持自动布局
  await page.reload()
  await expect(page.locator('.md-article table')).toBeVisible()
  const display = await tbl.locator('th').first().locator('.col-handle')
    .evaluate(el => getComputedStyle(el).display)
  expect(display).toBe('none')
  const hb2 = await tbl.locator('th').nth(2).locator('.col-handle').boundingBox()
  if (hb2) {
    await page.mouse.move(hb2.x + 2, hb2.y + hb2.height / 2)
    await page.mouse.down()
    await page.mouse.move(hb2.x + 120, hb2.y + hb2.height / 2, { steps: 4 })
    await page.mouse.up()
  }
  await expect(tbl).not.toHaveClass(/sc-cols-fixed/)
})

test('主站编辑器 md 预览同形态：拖拽切 fixed + 双击恢复', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  // 按 .project-name 整词定位（helpers 惯例）：git-test 夹具卡面路径含
  // "simple-coding" 子串，整卡 hasText 双中且 .first() 误进 git-test——
  // 文件树里永远找不到探针 md，:197 点击超时（本地 Gitea 可达即翻红的既有坑）
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
  // 面板开合是 toggle（uiState 跨用例残留态不定）→ 先归一化到开，再显式等行渲染
  const railFiles = page.locator('[data-testid="rail-files"]')
  if ((await railFiles.getAttribute('aria-expanded')) !== 'true') await railFiles.click()
  await expect(page.locator('.file-tree .item-name', { hasText: MD_FILE }).first()).toBeVisible({ timeout: 10000 })
  await page.locator('.file-tree .item-name', { hasText: MD_FILE }).first().click()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.pane-primary .md-preview')).toBeVisible({ timeout: 10000 })

  const tbl = page.locator('.pane-primary .md-preview-content table')
  await expect(tbl).toBeVisible({ timeout: 10000 })
  // 下限保护同样生效：状态列短词单行（Range 量文本高，原因同上）
  const statusCell = tbl.locator('tbody tr').first().locator('td').nth(3)
  const textH = await statusCell.evaluate(el => {
    const r = document.createRange()
    r.selectNodeContents(el)
    return r.getBoundingClientRect().height
  })
  expect(textH).toBeLessThan(30)

  // 拖拽「状态」列 → fixed；双击全部手柄（拖拽发生时四列实宽均已固化）→ 整表回自动
  const handle = tbl.locator('th').nth(3).locator('.col-handle')
  await expect(handle).toHaveCount(1)
  const hb = await handle.boundingBox()
  await page.mouse.move(hb!.x + hb!.width / 2, hb!.y + hb!.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb!.x + 140, hb!.y + hb!.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(tbl).toHaveClass(/sc-cols-fixed/)
  for (let i = 3; i >= 0; i--) {
    await tbl.locator('th').nth(i).locator('.col-handle').dblclick()
  }
  await expect(tbl).not.toHaveClass(/sc-cols-fixed/)
})
