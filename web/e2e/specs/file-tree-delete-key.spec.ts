import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 文件树 Delete 键删除焦点项（P-20261002-134）：
//   - 范围限定同 F2：焦点在 .tree-list 内且存在焦点节点才响应；无焦点节点不弹确认框
//   - 焦点 → Delete → 确认弹窗（右键删除同链路 useFileTreeContext.startDelete）
//     → 确认后删除生效，焦点转移到相邻项（后继项顶上原位置）
//   - Delete → 取消 → 文件保留（既有确认对话框语义不变）
// 探针建在 simple-coding 仓库 docs/ 下（同 file-tree-f2.spec，探针名不同
// 避免并行/残留互踩）。beforeAll/afterAll 统一播种清理。
const PROBE_DIR = 'docs'
const PROBE_A = 'e2e-delkey-a.md'
const PROBE_B = 'e2e-delkey-b.md'
const PROBE_A_PATH = `docs/${PROBE_A}`
const PROBE_B_PATH = `docs/${PROBE_B}`

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
  await fixedLocale(page)
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

// 反复收起/展开 docs 直到探针可见（展开态在 uiState 恢复 + 虚拟列表重渲染下有竞态）
async function revealProbe(page: Page, name: string) {
  const dir = itemByName(page, PROBE_DIR)
  await expect(dir).toBeVisible({ timeout: 5000 })
  for (let i = 0; i < 5; i++) {
    const probe = itemByName(page, name)
    if (await probe.isVisible().catch(() => false)) return probe
    const arrow = (await dir.locator('.dir-arrow').textContent().catch(() => '')) || ''
    if (arrow === '▼') {
      // 已展开但子项缺失：收起再展开强制重取子树
      await dir.click()
      await page.waitForTimeout(500)
      await dir.click()
    } else {
      await dir.click()
    }
    await page.waitForTimeout(700)
  }
  return itemByName(page, name)
}

test.beforeAll(async () => {
  const pid = await projectId()
  await apiFile(pid, 'delete', PROBE_A_PATH)
  await apiFile(pid, 'delete', PROBE_B_PATH)
  await apiFile(pid, 'create', PROBE_A_PATH)
  await apiFile(pid, 'create', PROBE_B_PATH)
})

test.afterAll(async () => {
  try {
    const pid = await projectId()
    await apiFile(pid, 'delete', PROBE_A_PATH)
    await apiFile(pid, 'delete', PROBE_B_PATH)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('文件树 Delete 键删除焦点项', () => {
  test('无焦点节点按 Delete：不弹确认框（范围限定）', async ({ page }) => {
    await enterProject(page)

    // 焦点落在 .tree-list（快捷键作用域内）但不选中任何节点：
    // focusedIndex 初始 -1，Delete 必须无操作（连确认框都不出现）
    await page.locator('.tree-list').focus()
    await page.keyboard.press('Delete')
    await page.waitForTimeout(500)
    await expect(page.locator('.n-dialog')).toHaveCount(0)
  })

  test('焦点文件 → Delete → 确认 → 删除生效且焦点移至相邻项', async ({ page }) => {
    await enterProject(page)

    const probe = await revealProbe(page, PROBE_A)
    // 左键选中（focusedIndex 指向探针 A，紧邻的后继是探针 B）；file-click 会打开
    // 编辑器可能抢焦点，显式把焦点拉回 .tree-list，保证 Delete 命中树容器内的键盘处理
    await probe.click()
    await page.locator('.tree-list').focus()

    await page.keyboard.press('Delete')

    // 与右键「删除」同一入口：确认弹窗点名探针 A
    const dialog = page.locator('.n-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(PROBE_A)
    await page.getByRole('button', { name: '确认' }).click()

    // 删除生效：A 从树中移除，B 仍在
    await expect(page.locator('.item-name').filter({ hasText: /^e2e-delkey-a\.md$/ })).toHaveCount(0, { timeout: 5000 })
    await expect(page.locator('.item-name').filter({ hasText: /^e2e-delkey-b\.md$/ })).toBeVisible()

    // 焦点转移到相邻项：A 原位置由后继 B 顶上，树内焦点态（.tree-item.focused）落在 B
    await expect(page.locator('.tree-item.focused .item-name')).toHaveText(PROBE_B, { timeout: 5000 })
  })

  test('焦点文件 → Delete → 取消 → 文件保留', async ({ page }) => {
    await enterProject(page)

    const probe = await revealProbe(page, PROBE_B)
    await probe.click()
    await page.locator('.tree-list').focus()

    await page.keyboard.press('Delete')

    // 取消：对话框关闭，文件保留
    await expect(page.locator('.n-dialog')).toBeVisible()
    await page.getByRole('button', { name: '取消' }).click()
    await expect(page.locator('.n-dialog')).toHaveCount(0)
    await expect(page.locator('.item-name').filter({ hasText: /^e2e-delkey-b\.md$/ })).toBeVisible()
  })
})
