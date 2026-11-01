import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 命令历史「重复命令」视图（P-20261003-199）E2E：
 *   1. 频次聚合：同命令 ×3 在列（频次徽章 + 最近使用时间），×2 未达阈值不在列；
 *      点击插入终端不执行；切回「全部」视图原始流水与过滤器不受影响
 *   2. 每条「存为片段」（P-16 创建链复用）：SaveCodeSnippetModal kind=command
 *      弹窗预填命令 → 保存 → 设置·终端·命令片段管理区可见（片段库入账）
 * 前置（spec 内自备）：临时空项目 + API 直播种历史——同一落盘链路（store Append，
 * terminal-history-search 同配方），绕开 Linux bash OSC 133 上报的已知产品缺口。
 * 同命令多条目的 durationMs 各异：服务端对 2s 窗口内「命令+退出码+时长」指纹相同
 * 的上报按重复投递幂等跳过（server/store/terminal_history.go duplicateWindow），
 * 逐毫秒一致会被去重成 1 条
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ = 'e2e-term-repeat'
const CMD_REPEAT = 'echo sc-repeat-alpha' // ×3：阈值命中
const CMD_BELOW = 'echo sc-repeat-beta'   // ×2：阈值对照（不得入列）
const SNIPPET_TITLE = 'sc-repeat-alpha-snippet'

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
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const list = await api('GET', '/api/projects')
  const old = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
  if (old) await api('DELETE', `/api/projects/${old.id}`)
  const dir = path.resolve(HERE, '../../../.sc-tmp/e2e-term-repeat')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(dir, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ, path: serverPath(dir) })
  expect([200, 201]).toContain(proj.status)
  const projectId = (proj.json?.data as { id: string }).id
  // 片段库全局跨项目存活：同名片段先清（用例重试/上轮残留不叠加重复行）
  const snips = await api('GET', '/api/snippets')
  for (const s of ((snips.json?.data || []) as { id: string; title: string }[])) {
    if (s.title === SNIPPET_TITLE) await api('DELETE', `/api/snippets/${s.id}`)
  }
  // 先清历史再直播种（幂等：实例复用/用例重试不叠加）
  await api('DELETE', `/api/projects/${projectId}/terminal-history`)
  for (const [cmd, times, baseDur] of [
    [CMD_REPEAT, 3, 111],
    [CMD_BELOW, 2, 555],
  ] as const) {
    for (let i = 0; i < times; i++) {
      const rec = await api('POST', `/api/projects/${projectId}/terminal-history`, {
        command: cmd, exitCode: 0, durationMs: baseDur + i,
      })
      expect(rec.status).toBe(200)
    }
  }
})

test.afterAll(async () => {
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(path.resolve(HERE, '../../../.sc-tmp/e2e-term-repeat'), { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 进项目页 + 开一个终端会话（面板开合状态跨用例持久，rail 点击须幂等） */
async function openProjectWithTerminal(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 面板可能已由 uiState 恢复为展开态；且项目切换的异步布局应用可能在点击后
  // 把面板收起（新项目无持久化布局，apply 默认收起）——rail 点击幂等重验
  //（terminal-history-snippet 同款守卫）
  const panel = page.locator('.bottom-panel')
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
  return xterm
}

/** 打开历史面板并切到「重复命令」视图 */
async function openRepeatView(page: Page) {
  await page.locator('.term-toolbar button[title*="命令历史"]').click()
  const panel = page.locator('.history-panel')
  await expect(panel).toBeVisible()
  // 默认落「全部」视图（存量行为不变）；切「重复命令」
  await panel.locator('.history-view-tabs .n-tabs-tab').filter({ hasText: '重复命令' }).click()
  return panel
}

test('重复命令视图：频次 ×3 在列、×2 未达阈值不在列、插入不执行、全部视图回归', async ({ page }) => {
  test.setTimeout(120000)
  const xterm = await openProjectWithTerminal(page)
  const panel = await openRepeatView(page)

  // ×3 命中：频次徽章 + 最近使用时间齐备
  const hit = panel.locator('.history-item').filter({ hasText: CMD_REPEAT })
  await expect(hit).toBeVisible({ timeout: 10000 })
  await expect(hit.locator('[data-testid="history-repeat-count"]')).toHaveText('×3')
  await expect(hit.locator('.history-time')).toContainText('最近使用')

  // ×2 对照：未达 ≥3 阈值不得入列
  await expect(panel.locator('.history-item').filter({ hasText: CMD_BELOW })).toHaveCount(0)

  // 主点击仍是插入不执行（安全默认）：标记在 xterm 仅 1 处（输入行，无输出行）
  const markerCount = async () => (await xterm.innerText()).split('sc-repeat-alpha').length - 1
  await hit.click()
  await expect.poll(markerCount, { timeout: 5000 }).toBe(1)

  // 切回「全部」视图：原始流水 5 条在列（alpha×3 + beta×2），搜索/只看失败过滤器在场
  await panel.locator('.history-view-tabs .n-tabs-tab').filter({ hasText: '全部' }).click()
  await expect(panel.locator('.history-item')).toHaveCount(5, { timeout: 10000 })
  await expect(panel.locator('.history-filters')).toBeVisible()
  await expect(panel.locator('.history-item').filter({ hasText: CMD_BELOW }).first()).toBeVisible()
})

test('存为片段：弹窗预填命令 → 保存 → 片段库（设置·终端·命令片段）入账', async ({ page }) => {
  test.setTimeout(180000)
  await openProjectWithTerminal(page)
  const panel = await openRepeatView(page)

  const hit = panel.locator('.history-item').filter({ hasText: CMD_REPEAT })
  await expect(hit).toBeVisible({ timeout: 10000 })

  // 悬停显操作区 → 存为片段（创建链复用：SaveCodeSnippetModal kind=command）
  await hit.hover()
  await hit.locator('button[data-testid="history-save-snippet"]').click()
  const modal = page.locator('[data-testid="snippet-save-modal"]')
  await expect(modal).toBeVisible({ timeout: 5000 })
  // 标题预填命令首行（免手敲）；内容预览为命令原文
  await expect(modal.locator('[data-testid="snippet-save-title"] input')).toHaveValue(CMD_REPEAT)
  await expect(modal.locator('[data-testid="snippet-save-content"]')).toContainText(CMD_REPEAT)

  // 改成语义化标题保存（toast 自理：命令片段已保存）
  await modal.locator('[data-testid="snippet-save-title"] input').fill(SNIPPET_TITLE)
  await modal.locator('[data-testid="snippet-save-confirm"]').click()
  await expect(modal).toHaveCount(0)
  await expect(page.locator('.n-message').filter({ hasText: '命令片段已保存' }).first()).toBeVisible({ timeout: 5000 })

  // 片段库入账：设置 → 终端 → 命令片段管理区（kind=command 页签默认）可见
  await page.locator('.rail-btn[title="设置"]').click()
  await page.locator('.settings-nav .nav-item').filter({ hasText: '终端' }).click()
  const manager = page.locator('.snippet-manager')
  await expect(manager).toBeVisible({ timeout: 10000 })
  // .first()：片段库跨运行持久，用例重试可能留下同名历史行，取其一即可证明入账
  const row = manager.locator('.snippet-row').filter({ hasText: SNIPPET_TITLE }).first()
  await expect(row).toBeVisible({ timeout: 10000 })
  await expect(row.locator('.snippet-row-cmd')).toContainText(CMD_REPEAT)
})
