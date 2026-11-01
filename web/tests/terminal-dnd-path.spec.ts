import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * 分屏拖拽互传 E2E（路线图 #6）：文件树条目拖到终端 = 粘贴路径。
 *
 * 覆盖点：
 *   1. 文件树 → 终端 pane：拖入后路径原样粘贴（不执行）
 *   2. 文件树 → tab 头：路由粘贴到该 tab 的终端并激活
 *
 * 内部路径拖拽走自定义 dataTransfer 类型 application/x-sc-file-path
 * （dragstart 由 useFileTreeDragDrop.onDragStart setData）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getSimpleCodingProjectId(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = list.find(x => x.name === 'simple-coding')
  if (!p) throw new Error('simple-coding project not found')
  return p.id
}

async function cleanupProjectTerminals(request: APIRequestContext, projectId: string) {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; projectId?: string }[] }).data || []
  for (const s of list) {
    if (s.projectId === projectId) {
      await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  }
}

async function openTerminalPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) return
    await page.locator('.ide-rail .rail-btn[title="终端"]').click()
    await page.waitForTimeout(600)
  }
}

/** 派发文件树 → 目标的内部路径拖拽（dragstart 携带 sc path 类型） */
async function dragTreeItemTo(page: Page, src: ReturnType<Page['locator']>, dst: ReturnType<Page['locator']>) {
  const srcEl = await src.elementHandle()
  const dstEl = await dst.elementHandle()
  await page.evaluate(([s, d]) => {
    const dt = new DataTransfer()
    s!.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    s!.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
  }, [srcEl, dstEl])
}

test.describe('分屏拖拽互传（路线图 #6）', () => {
  let projectId = ''

  test.beforeEach(async ({ page, request }) => {
    projectId = await getSimpleCodingProjectId(request)
    await cleanupProjectTerminals(request, projectId)

    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')
    await openTerminalPanel(page)
    // 关闭遗留 tab（恢复流程可能拉起上一轮会话）
    for (let i = 0; i < 20; i++) {
      const lastTab = page.locator('.term-tab').last()
      if ((await lastTab.count()) === 0) break
      await lastTab.locator('.term-close-btn').click()
      if (await page.locator('.n-modal').isVisible().catch(() => false)) {
        await page.getByRole('button', { name: '确认' }).click()
      }
      await page.waitForTimeout(300)
    }

    await page.locator('.term-toolbar button[title="新建终端"]').click()
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 8000 })
    // xterm 断言取 last（CLAUDE.md「测试」节）：多 tab 时旧屏 DOM 序在前，last 才是当前活跃屏
    await expect(page.locator('.term-tab-content .xterm').last()).toBeVisible({ timeout: 10000 })
    // 等 WS 首批数据到达（shell banner/提示符）：拖拽粘贴经 ws.send 进 stdin，
    // readyState 未 OPEN 时粘贴数据被静默丢弃——必须等可交互再拖
    await expect(page.locator('.term-tab-content .xterm-rows').last()).toContainText(/[A-Za-z]/, { timeout: 15000 })
  })

  test.afterEach(async ({ request }) => {
    await cleanupProjectTerminals(request, projectId)
  })

  test('文件树拖到终端 pane = 粘贴路径', async ({ page }) => {
    const item = page.locator('.tree-item').filter({ hasText: 'README.md' }).first()
    await expect(item).toBeVisible({ timeout: 8000 })
    const pane = page.locator('.term-tab-content:not(.is-floating) .term-pane').first()

    await dragTreeItemTo(page, item, pane)
    // 粘贴的路径渲染进 xterm 缓冲（pane 级：拖到哪个 pane 就贴到哪个 pane）
    await expect(pane.locator('.xterm-rows')).toContainText('README.md', { timeout: 5000 })
  })

  test('文件树拖到 tab 头 = 路由粘贴到该 tab 并激活', async ({ page }) => {
    // 建第二个 tab
    await page.locator('.term-toolbar button[title="新建终端"]').click()
    await expect(page.locator('.term-tab')).toHaveCount(2, { timeout: 8000 })
    // 第二个 pane 的 WS 也要交付过首批数据（同 beforeEach：未连上时粘贴丢失）
    await expect(page.locator('.term-tab-content').nth(1).locator('.xterm-rows')).toContainText(/[A-Za-z]/, { timeout: 15000 })

    const item = page.locator('.tree-item').filter({ hasText: 'README.md' }).first()
    await expect(item).toBeVisible({ timeout: 8000 })
    // 拖到第二个 tab 头上
    await dragTreeItemTo(page, item, page.locator('.term-tab').nth(1))

    // 该 tab 被激活且路径粘贴进它的终端。
    // 注意 .term-tab-content 全部常驻 DOM（v-show 保活），按 tab 序取第 2 个
    await expect(page.locator('.term-tab').nth(1)).toHaveClass(/is-active/, { timeout: 5000 })
    const targetContent = page.locator('.term-tab-content').nth(1)
    await expect(targetContent).toBeVisible()
    await expect(targetContent.locator('.xterm-rows')).toContainText('README.md', { timeout: 5000 })
  })
})
