import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 本机环境体检（P-20261003-317）E2E：
 *   1. API 契约：GET /api/selfcheck 只读聚合 8 个稳定条目（version/git/lfs/
 *      tmux/agent-runtimes/ports/disk/config），三态词表 + detail 非空 +
 *      warn/fail 带 hint；版本条目承载构建信息。/ops-manual 登记 selfcheck 节
 *      （agent 排障第一步的入口面，公开只读）
 *   2. UI：命令面板「环境体检」→ 浮层渲染逐条目（本地化标题 + 三态徽标 +
 *      明细）+ 三态汇总行；「复制为 Markdown」产物含各条目标题与状态
 *      （issue 直贴形态的完整链路断言）
 * 前置：e2e 金态实例（git 必在——仓库测试基线）；tmux/lfs 等可选探测随环境
 * 变化，断言「结论与状态自洽」而非具体值（与服务端单测同口径）；config 条目
 * 在金态实例恒 ok（配置损坏降级态 P-20261006-10 只在坏文件启动时出现）
 */

let unlockToken = ''

async function api(method: string, url: string) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

interface CheckItem { item: string; status: string; detail: string; hint?: string }

const STABLE_ITEMS = ['version', 'git', 'lfs', 'tmux', 'agent-runtimes', 'ports', 'disk', 'config']
const VALID_STATUS = ['ok', 'warn', 'fail']

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''
  expect(unlockToken).not.toBe('')
})

test('体检端点聚合稳定条目集，/ops-manual 登记 selfcheck 节', async () => {
  const res = await api('GET', '/api/selfcheck')
  expect(res.status).toBe(200)
  const items = (res.json?.data || []) as CheckItem[]
  expect(items.map(i => i.item)).toEqual(STABLE_ITEMS)

  for (const it of items) {
    expect(VALID_STATUS, `item ${it.item} status ${it.status}`).toContain(it.status)
    expect(it.detail.trim(), `item ${it.item} detail`).not.toBe('')
    if (it.status !== 'ok') {
      expect(it.hint?.trim(), `item ${it.item} warn/fail must carry hint`).not.toBe('')
    } else {
      expect(it.hint ?? '', `item ${it.item} ok must not carry hint`).toBe('')
    }
  }

  // 版本条目承载构建信息（issue 环境信息的主体）；版本串品牌随 4adaf9da 为 codecombo
  const version = items.find(i => i.item === 'version')!
  expect(version.status).toBe('ok')
  expect(version.detail).toContain('codecombo')
  expect(version.detail).toContain('/')

  // git 探测成功 ⟹ ok + 版本输出前缀（e2e 环境必有 git——仓库操作基线）
  const git = items.find(i => i.item === 'git')!
  expect(git.status).toBe('ok')
  expect(git.detail).toContain('git version')

  // agent 手册登记：排障第一步入口面（公开只读，免 token）
  const manual = await fetch(API_BASE + '/ops-manual')
  expect(manual.status).toBe(200)
  const manualText = await manual.text()
  expect(manualText).toContain('selfcheck')
  expect(manualText).toContain('/api/selfcheck')
})

test('命令面板「环境体检」→ 浮层渲染条目 → 复制为 Markdown 含各条目标题与状态', async ({ page }) => {
  test.setTimeout(120000)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 命令面板入口（顶栏搜索触发器）挂在项目页 Layout——先进播种项目
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 命令面板命令模式直达「环境体检」
  await page.locator('.header-search-trigger').click()
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>环境体检')
  await expect(page.locator('.palette-item').first()).toContainText('环境体检', { timeout: 5000 })
  await page.keyboard.press('Enter')

  const overlay = page.locator('[data-testid="self-check"]')
  await expect(overlay).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.palette-mask')).toHaveCount(0)

  // 逐条目渲染：本地化标题 + 三态徽标 + 语言中立明细
  const titles = ['应用版本', 'Git 工具链', 'Git LFS', 'tmux（持久会话）', 'Agent 运行时', '已登记端口', '数据盘水位', '配置文件完整性']
  for (const item of STABLE_ITEMS) {
    const row = overlay.locator(`[data-testid="self-check-row-${item}"]`)
    await expect(row).toBeVisible({ timeout: 5000 })
  }
  for (const title of titles) {
    await expect(overlay).toContainText(title)
  }
  // 三态汇总行（打开即体检完成后出现）
  await expect(overlay.locator('[data-testid="self-check-summary"]')).toContainText(/通过/, { timeout: 10000 })

  // 复制为 Markdown：产物含标题行 + 各条目标题 + 状态词（issue 直贴形态）
  await overlay.locator('[data-testid="self-check-copy"]').click()
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('本机环境体检')
  expect(clip).toContain('通过 · ')
  for (const title of titles) {
    expect(clip, `markdown must contain item title ${title}`).toContain(title)
  }
  const statusLines = clip.split('\n').filter(l => /^- \*\*(通过|警告|失败)\*\*/.test(l))
  expect(statusLines.length, 'every item renders as a status line').toBe(STABLE_ITEMS.length)
})
