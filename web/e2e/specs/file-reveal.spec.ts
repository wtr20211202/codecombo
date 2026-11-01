import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 在系统资源管理器中显示（P-20261003-323）：文件树右键 + 编辑器 tab 右键
// 「在系统中显示」→ POST /api/projects/:id/reveal。
// 断言聚焦最小面——菜单项存在 + API 校验语义（400/404）+ 成功路径环境兼容
// （200 带 opener 或 headless 501，都属合法宿主形态）；三平台命令拼装的
// 精确断言在 Go 单测 reveal_test.go（纯函数 goos 注入 + SC_REVEAL_STUB_DIR
// 桩，e2e 不真开窗也不依赖宿主桌面环境）。
// 探针打在播种仓库 simple-coding 的 README.md 与 docs/ 上（零播种）。

async function lockToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  return (await res.json()).token || ''
}

async function projectId(): Promise<string> {
  const token = await lockToken()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers: { 'X-Lock-Token': token } })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === 'simple-coding')
  if (!mine) throw new Error('simple-coding 项目不存在')
  return mine.id
}

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  // 按项目名元素精确匹配（hasText 整卡匹配会被 git-test 卡的 remoteURL
  // 「…/coding/simple-coding.git」误命中——实测踩坑：.first() 落进 git-test）
  const projectCard = page.locator('.project-card')
    .filter({ has: page.locator('.project-name').filter({ hasText: /^simple-coding$/ }) })
    .first()
  await projectCard.click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——奇数次点击保证最终打开
  for (let i = 0; i < 3; i++) {
    if (await page.getByText('README.md').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

test.describe('在系统资源管理器中显示（P-20261003-323）', () => {
  test('API：越界路径 400 / 不存在 404', async () => {
    const token = await lockToken()
    const pid = await projectId()
    const base = `${API_BASE}/api/projects/${pid}/reveal`
    const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }

    const escape = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ path: '../../escape.txt' }) })
    expect(escape.status, '路径越出项目根应 400').toBe(400)

    const ghost = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ path: 'docs/e2e-reveal-ghost.txt' }) })
    expect(ghost.status, '不存在的目标应 404').toBe(404)
  })

  test('API：真实文件 200 带 opener 或 headless 501（环境兼容）', async () => {
    const token = await lockToken()
    const pid = await projectId()
    const res = await fetch(`${API_BASE}/api/projects/${pid}/reveal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
      body: JSON.stringify({ path: 'README.md' }),
    })
    const body = await res.json().catch(() => ({}))
    if (res.status === 501) {
      // headless 宿主（无 DISPLAY/WAYLAND）：501 明确语义，不应重试
      expect(String((body as { error?: string }).error)).toContain('no display environment')
      return
    }
    expect(res.status, `body=${JSON.stringify(body)}`).toBe(200)
    expect(['explorer', 'open', 'xdg-open']).toContain((body as { opener?: string }).opener)
  })

  test('文件树右键：目录与文件都有「在系统中显示」且点击即发正确请求', async ({ page }) => {
    test.setTimeout(120000)
    await enterProject(page)
    const readme = itemByName(page, 'README.md')
    await expect(readme).toBeVisible({ timeout: 10000 })

    // 拦截 reveal 请求就地应答（提案「拦截断言、不真开窗」）：e2e 不真开宿主
    // 文件管理器窗口，只断言菜单→请求链路与载荷；服务端 exec 语义由 API 用例
    // 与 Go 单测覆盖
    await page.route('**/api/projects/*/reveal', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, opener: 'explorer' }),
      })
    })

    // 文件项：菜单含「在系统中显示」，点击发出 POST {"path":"README.md"}
    await readme.click({ button: 'right' })
    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()
    const revealPromise = page.waitForRequest(
      r => r.url().includes('/reveal') && r.method() === 'POST',
    )
    await menu.getByText('在系统中显示', { exact: true }).click()
    const req = await revealPromise
    expect(req.postDataJSON()).toEqual({ path: 'README.md' })
    await expect(menu).toHaveCount(0)
    await expect(readme).toBeVisible() // 页面仍可交互

    // 目录项：同菜单项存在（目录/文件共用一项）；左键点树头标题收菜单
    //（树内行已不可用：P-20261023-2③a 菜单新增粘贴/复制/剪切三项后目录菜单
    // 变高，向下盖住 README.md 行——点击被菜单 subtree 拦截；.tree-title 是
    // 菜单锚点上方的纯文本 span，必不被盖且无点击副作用。Escape 依赖页面焦点，
    // 左键外点是确定性收起）
    const docs = itemByName(page, 'docs')
    await docs.click({ button: 'right' })
    await expect(menu).toBeVisible()
    await expect(menu.getByText('在系统中显示', { exact: true })).toBeVisible()
    await page.locator('.tree-header .tree-title').click()
    await expect(menu).toHaveCount(0)
    await expect(readme).toBeVisible()
  })

  test('编辑器 tab 右键：菜单含「在系统中显示」', async ({ page }) => {
    test.setTimeout(120000)
    await enterProject(page)
    const readme = itemByName(page, 'README.md')
    await expect(readme).toBeVisible({ timeout: 10000 })
    await readme.click()
    const tab = page.locator('.editor-tab').filter({ hasText: 'README.md' })
    await expect(tab).toBeVisible({ timeout: 15000 })

    await tab.click({ button: 'right' })
    const revealItem = page.getByTestId('tab-reveal-in-system')
    await expect(revealItem).toBeVisible()
    // tab 菜单无 Esc 处理：点 tabs 行关闭（.editor-tabs 的 click 即 closeTabContextMenu）
    await page.locator('.editor-tabs').click()
    await expect(revealItem).toBeHidden()
  })
})
