import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 命令历史单条删除（P-20261003-63）E2E：
 *   1. 面板条目删除钮：删一条 → 列表少一条（服务端同少，身份删除 ?at=）
 *   2. 全清保留不变：清空后空态 + 服务端为空
 * 前置（spec 内自备）：临时空项目；历史经 API 直播种（同一落盘链路，
 * 绕开真终端跑命令的平台差异——Linux bash OSC 133 上报是已知产品缺口，
 * terminal-history-snippet 有守卫；本 spec 不依赖真实命令执行，无该缺口）
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ_NAME = 'e2e-thd'
// 标记词全仓唯一防串扰；三条不同命令（store 2s 窗口指纹去重按命令区分）
const SEEDS = [
  { command: 'e2ethd-alpha --seed', exitCode: 0, durationMs: 100 },
  { command: 'e2ethd-beta --seed', exitCode: 7, durationMs: 200 },
  { command: 'e2ethd-gamma --seed', exitCode: 0, durationMs: 300 },
]

let unlockToken = ''
let projectId = ''

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
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const list = await api('GET', '/api/projects')
  const old = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await api('DELETE', `/api/projects/${old.id}`)
  const dir = path.resolve(HERE, '../../../.sc-tmp/e2e-thd')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(dir, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(dir) })
  expect([200, 201]).toContain(proj.status)
  projectId = (proj.json?.data as { id: string }).id
  // 先清历史再逐条播种（幂等：实例复用/用例重试不叠加）
  await api('DELETE', `/api/projects/${projectId}/terminal-history`)
  for (const seed of SEEDS) {
    const rec = await api('POST', `/api/projects/${projectId}/terminal-history`, seed)
    expect(rec.status).toBe(200)
  }
})

test.afterAll(async () => {
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(path.resolve(HERE, '../../../.sc-tmp/e2e-thd'), { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 进项目页 + 归一化到底部终端分区（面板开合状态跨用例持久，rail 点击须幂等） */
async function openTerminalSection(page: Page) {
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  const panel = page.locator('.bottom-panel')
  // 面板可能已由 uiState 恢复为展开态；且项目切换的异步布局应用可能在点击后
  // 把面板收起（持久化布局 showBottomPanel=false 迟到覆盖，分片负载下恢复请求
  // 常晚于本 helper 的单次点击——run9 实测 13×hidden 自续形态：败一轮存一轮
  // 收起态）——rail 点击幂等重验（terminal-history-repeat 同款守卫）
  for (let i = 0; i < 3 && !(await panel.isVisible().catch(() => false)); i++) {
    await page.locator('.rail-btn[title="终端"]').click()
    await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态，重试 */ })
  }
  await expect(panel).toBeVisible({ timeout: 5000 })
  // 底部面板可能留在其他分区：归一化到终端分区（历史面板按钮挂在终端工具栏）
  const toolbar = page.locator('.term-toolbar')
  if (!(await toolbar.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await expect(toolbar).toBeVisible({ timeout: 5000 })
}

test('单条删除：删一条列表少一条（免确认，服务端同少）', async ({ page }) => {
  test.setTimeout(120000)
  await openTerminalSection(page)

  // 打开命令历史面板；种子在 beforeAll 落盘，面板挂载即拉到 3 条
  await page.locator('.term-toolbar button[title*="命令历史"]').click()
  const panel = page.locator('.history-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.history-item').filter({ hasText: 'e2ethd-' })).toHaveCount(3, { timeout: 10000 })

  // 悬停出操作区 → 点删除（免确认，直接生效）
  const alphaItem = panel.locator('.history-item').filter({ hasText: 'e2ethd-alpha' }).first()
  await alphaItem.hover()
  await alphaItem.locator('.history-mini-btn.is-danger').click()

  // 列表少一条：被删项消失、其余两条保留 + 成功提示
  await expect(panel.locator('.history-item').filter({ hasText: 'e2ethd-alpha' })).toHaveCount(0, { timeout: 5000 })
  await expect(panel.locator('.history-item').filter({ hasText: 'e2ethd-' })).toHaveCount(2)
  await expect(page.locator('.n-message').filter({ hasText: '已删除该条' }).first()).toBeVisible({ timeout: 5000 })

  // 服务端同少（身份删除落盘，非仅前端视图）
  const list = await api('GET', `/api/projects/${projectId}/terminal-history`)
  const cmds = ((list.json?.data || []) as { command: string }[]).map(e => e.command)
  expect(cmds).toHaveLength(2)
  expect(cmds).not.toContain('e2ethd-alpha --seed')
  expect(cmds).toContain('e2ethd-beta --seed')
  expect(cmds).toContain('e2ethd-gamma --seed')
})

test('全清保留不变：清空后空态且服务端为空', async ({ page }) => {
  test.setTimeout(120000)
  await openTerminalSection(page)

  await page.locator('.term-toolbar button[title*="命令历史"]').click()
  const panel = page.locator('.history-panel')
  await expect(panel).toBeVisible()
  await expect(panel.locator('.history-item').filter({ hasText: 'e2ethd-' })).toHaveCount(2, { timeout: 10000 })

  // 头部清空按钮（历史行为不变：直接清空）
  await panel.locator('.history-header-actions button[title="清空历史"]').click()
  await expect(panel.locator('.history-empty')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.n-message').filter({ hasText: '历史已清空' }).first()).toBeVisible({ timeout: 5000 })

  const list = await api('GET', `/api/projects/${projectId}/terminal-history`)
  expect(list.json?.data).toHaveLength(0)
})
