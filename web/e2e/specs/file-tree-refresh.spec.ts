import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 文件树手动刷新入口（P-20261002-124）：树不订阅 file.changed（仅 agent marks 消费），
// watch 漏网/外部同步后树不自动跟进。两个手动入口——头部「刷新（保留目录展开状态）」
// 与背景右键「刷新」——都走 FileTreeView.refreshRoot（先记展开集、重载后逐级恢复），
// 各断言：外部新建文件出现 + 目录展开态保留。
// 探针建在 simple-coding 仓库 docs/ 下（与 file-tree-context.spec 同位：根目录条目
// 多、虚拟列表铺满无空白背景可右键，背景右键用例借搜索过滤清空列表腾出空白；
// docs 已提交，探针落盘为 untracked，beforeAll/afterAll 统一清理不留残留）。
const PROBE_A = 'docs/e2e-refresh-probe-a.md'
const PROBE_B = 'docs/e2e-refresh-probe-b.md'
const NAME_A = 'e2e-refresh-probe-a.md'
const NAME_B = 'e2e-refresh-probe-b.md'

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

async function projectId(): Promise<string> {
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = (await unlockRes.json()).token || ''
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers: { 'X-Lock-Token': token } })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === 'simple-coding')
  if (!mine) throw new Error('simple-coding 项目不存在')
  return mine.id
}

async function apiFile(pid: string, action: 'create' | 'delete', path: string) {
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = (await unlockRes.json()).token || ''
  await fetch(`${API_BASE}/api/projects/${pid}/file/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify(action === 'create' ? { path, content: 'probe' } : { path }),
  }).catch(() => {})
}

async function enterProject(page: Page) {
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——奇数次点击保证最终打开
  for (let i = 0; i < 3; i++) {
    if (await page.getByText('README.md').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

// 反复点击 docs 直到展开（展开态在 uiState 恢复 + 虚拟列表重渲染下有竞态）
async function expandDocs(page: Page) {
  const dir = itemByName(page, 'docs')
  await expect(dir).toBeVisible({ timeout: 5000 })
  for (let i = 0; i < 5; i++) {
    if (((await dir.locator('.dir-arrow').textContent().catch(() => '')) || '') === '▼') return
    await dir.click()
    await page.waitForTimeout(700)
  }
}

// 外部改文件后树不自动跟进：断言探针刷新前不可见（无命中即 count 0）
async function assertProbeHidden(page: Page, name: string) {
  await expect(itemByName(page, name)).toHaveCount(0)
}

test.beforeAll(async () => {
  const pid = await projectId()
  await apiFile(pid, 'delete', PROBE_A)
  await apiFile(pid, 'delete', PROBE_B)
})

test.afterAll(async () => {
  try {
    const pid = await projectId()
    await apiFile(pid, 'delete', PROBE_A)
    await apiFile(pid, 'delete', PROBE_B)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('文件树手动刷新', () => {
  test('外部改文件 → 背景右键「刷新」→ 树更新且展开态保留', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await expandDocs(page)

    // 外部建 docs/ 探针（走 API，树不 watch）：刷新前不可见
    const pid = await projectId()
    await apiFile(pid, 'create', PROBE_A)
    await assertProbeHidden(page, NAME_A)

    // 根目录条目铺满虚拟列表、无空白背景：搜索无命中词清空列表腾出空白
    await page.locator('.tree-action-btn[title="搜索文件"]').click()
    await page.locator('.tree-search input').fill('zzz-no-match')
    await expect(page.locator('.tree-item')).toHaveCount(0)

    // 右键空白背景 → 根菜单含「刷新」→ 点击
    const tree = page.locator('.tree-list')
    const box = await tree.boundingBox()
    await tree.click({ button: 'right', position: { x: 80, y: Math.floor((box?.height ?? 400) / 2) } })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.locator('.n-dropdown-menu').getByText('刷新', { exact: true }).click()

    // 收起搜索（toggle 关闭并清词），断言：探针出现在仍展开的 docs 下
    await page.locator('.tree-action-btn[title="搜索文件"]').click()
    await expect(itemByName(page, 'docs').locator('.dir-arrow')).toHaveText('▼')
    await expect(itemByName(page, NAME_A)).toBeVisible({ timeout: 5000 })
  })

  test('外部改文件 → 头部「刷新（保留目录展开状态）」→ 同语义兜底', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)
    await expandDocs(page)

    // 外部建 docs/ 探针：刷新前不可见
    const pid = await projectId()
    await apiFile(pid, 'create', PROBE_B)
    await assertProbeHidden(page, NAME_B)

    await page.getByRole('button', { name: '刷新（保留目录展开状态）' }).click()

    // docs 仍展开 + 探针可见（refreshRoot 保留展开状态）
    await expect(itemByName(page, 'docs').locator('.dir-arrow')).toHaveText('▼')
    await expect(itemByName(page, NAME_B)).toBeVisible({ timeout: 5000 })
  })
})
