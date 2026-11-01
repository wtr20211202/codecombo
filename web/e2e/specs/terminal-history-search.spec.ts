import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 跨项目命令历史检索（P-20261004-2）E2E：
 *   1. 命令面板「搜索命令历史（全项目）」→ 浮层 → 查询词两项目双命中
 *      （项目名 + 命令 + 失败退出码徽标）→ 点选命中插入当前终端（不执行）；
 *      无活跃终端降级为复制并提示
 *   2. 查询词 <2 字符显示下限提示（服务端 q≥2 防全量扫的前端同门槛）
 * 前置（spec 内自备）：两个临时空项目；历史经 API 直播种——绕开真终端跑命令的
 * 平台差异（Linux bash OSC 133 上报是已知产品缺口，terminal-history-snippet 有守卫），
 * 播种的是同一落盘链路（同一 store Append），检索面语义等价且确定性
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ_A = 'e2e-ths-a'
const PROJ_B = 'e2e-ths-b'
// 双项目各一条含同一标记词的命令：q 命中必须双项目齐亮；标记词全仓唯一防串扰
const CMD_A = 'e2eth-docker-up'   // 成功（✓）
const CMD_B = 'e2eth-docker-ps'   // 失败（exit 125 徽标）
const QUERY = 'e2eth-docker'

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'admin' }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  for (const name of [PROJ_A, PROJ_B]) {
    const list = await api('GET', '/api/projects')
    const old = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === name)
    if (old) await api('DELETE', `/api/projects/${old.id}`)
    const dir = path.resolve(HERE, '../../../.sc-tmp/e2e-ths', name)
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
    fs.mkdirSync(dir, { recursive: true })
    const proj = await api('POST', '/api/projects', { name, path: serverPath(dir) })
    expect([200, 201]).toContain(proj.status)
    const projectId = (proj.json?.data as { id: string }).id
    // 先清历史再直播种（幂等：实例复用/用例重试不叠加）
    await api('DELETE', `/api/projects/${projectId}/terminal-history`)
    const seed = name === PROJ_A
      ? { command: CMD_A, exitCode: 0, durationMs: 100 }
      : { command: CMD_B, exitCode: 125, durationMs: 200 }
    const rec = await api('POST', `/api/projects/${projectId}/terminal-history`, seed)
    expect(rec.status).toBe(200)
  }
})

test.afterAll(async () => {
  const list = await api('GET', '/api/projects')
  for (const name of [PROJ_A, PROJ_B]) {
    const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === name)
    if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  }
  try { fs.rmSync(path.resolve(HERE, '../../../.sc-tmp/e2e-ths'), { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 进项目页 + 命令面板命令模式（palette-notifications 同配方） */
async function openCommandMode(page: Page, projectName: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: projectName }).first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  return input
}

test('全局搜索双命中：项目名 + 失败码徽标 + 点选降级复制提示', async ({ page }) => {
  const input = await openCommandMode(page, PROJ_A)
  await input.fill('>搜索命令历史')
  const cmd = page.locator('.palette-item').first()
  await expect(cmd).toContainText('搜索命令历史', { timeout: 5000 })
  await page.keyboard.press('Enter')

  // 浮层打开、命令面板收起
  const overlay = page.locator('[data-testid="terminal-history-search"]')
  await expect(overlay).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.palette-mask')).toHaveCount(0)

  const searchInput = overlay.locator('input').first()
  // q<2 字符：前端同门槛提示，不发起检索
  await searchInput.fill('e')
  await expect(overlay).toContainText('输入至少 2 个字符', { timeout: 5000 })

  // 双命中：两项目各一行，项目名/命令/失败码徽标齐备
  await searchInput.fill(QUERY)
  const rowA = overlay.locator('.thsearch-item').filter({ hasText: CMD_A })
  const rowB = overlay.locator('.thsearch-item').filter({ hasText: CMD_B })
  await expect(rowA).toBeVisible({ timeout: 10000 })
  await expect(rowA).toContainText(PROJ_A)
  await expect(rowB).toBeVisible({ timeout: 10000 })
  await expect(rowB).toContainText(PROJ_B)
  await expect(rowB.locator('.thsearch-item-exit')).toContainText('125')
  await expect(rowA.locator('.thsearch-item-exit.is-ok')).toBeVisible()

  // 点选命中：本项目无终端会话 → 降级复制并提示（检索动作不因落位缺失静默失败）
  await rowA.click()
  await expect(overlay).toHaveCount(0)
  await expect(page.locator('.n-message').filter({ hasText: '已复制到剪贴板' }).first()).toBeVisible({ timeout: 5000 })
})

test('点选命中插入当前终端（不执行）', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_A }).first().click()
  await page.waitForURL('**/project')

  // 开一个真实终端会话（面板开合状态跨用例持久，rail 点击须幂等）
  const panel = page.locator('.bottom-panel')
  // 项目切换的异步布局应用可能在点击后把面板收起（持久化布局 showBottomPanel=
  // false 迟到覆盖，分片负载下恢复请求常晚于单次点击，run9 实测）——rail 点击
  // 幂等重验（terminal-history-repeat 同款守卫）
  for (let i = 0; i < 3 && !(await panel.isVisible().catch(() => false)); i++) {
    await page.locator('.rail-btn[title="终端"]').click()
    await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态，重试 */ })
  }
  await expect(panel).toBeVisible({ timeout: 5000 })
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：多 tab 时 last 即当前活跃屏
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })

  // 命令面板 → 浮层 → 查询 → 点选项目 A 命中
  await page.keyboard.press('Control+k')
  const paletteInput = page.locator('.palette-input input')
  await expect(paletteInput).toBeVisible({ timeout: 5000 })
  await paletteInput.fill('>搜索命令历史')
  await expect(page.locator('.palette-item').first()).toContainText('搜索命令历史', { timeout: 5000 })
  await page.keyboard.press('Enter')

  const overlay = page.locator('[data-testid="terminal-history-search"]')
  await expect(overlay).toBeVisible({ timeout: 5000 })
  const searchInput = overlay.locator('input').first()
  await searchInput.fill(QUERY)
  const rowA = overlay.locator('.thsearch-item').filter({ hasText: CMD_A })
  await expect(rowA).toBeVisible({ timeout: 10000 })
  await rowA.click()

  // 命令文本进入终端输入行（sendText 无换行 = 不执行）+ 成功提示
  await expect(xterm).toContainText(CMD_A, { timeout: 5000 })
  await expect(page.locator('.n-message').filter({ hasText: '已插入当前终端' }).first()).toBeVisible({ timeout: 5000 })
})
