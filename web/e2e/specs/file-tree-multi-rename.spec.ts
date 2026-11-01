import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 文件树多选批量重命名（P-20261003-283）：多选右键「批量重命名」弹层（查找/
// 替换串 + 实时预览改名前后 + 非法红标 P-132 同源）→ 确认逐个 renameFile
// （重名 409 跳过报告 P-160 惯例）→ 仅选中集生效。
//
// 探针宿主与 file-tree-multi-move 同款（simple-coding 仓库，纯文件操作无 git
// 语义依赖）；探针集中在新播种子目录 docs/e2e-bren/（改名都在目录内原地发生，
// afterAll 删整目录即净），探针名 e2e-bren-*/e2e-p3* 前缀避免跨 spec 残留互踩。
const PROBE_DIR = 'docs/e2e-bren'
const A_PROBES = ['e2e-bren-a1.md', 'e2e-bren-a2.md', 'e2e-bren-a3.md']
const A_RENAMED = ['e2e-bren-z1.md', 'e2e-bren-z2.md', 'e2e-bren-z3.md']
const DUP_NAME = 'e2e-bren-b1.md' // 改名目标与预置文件撞名（409 跳过报告）
const SOLO_NAME = 'e2e-bren-b2.md' // 同批合法改名
const CONFLICT_TARGET = 'e2e-bren-ok1.md'
const ILLEGAL_NAME = 'e2e-p3con.md' // 改名结果 con.md = Windows 保留设备名（红标拦截）
const LEGAL_NAME = 'e2e-p3zed.md' // 同批合法改名 → zed.md

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

function itemName(page: Page, name: string) {
  return page.locator('.item-name').filter({ hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) })
}

async function unlockToken(): Promise<string> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  return (await res.json()).token || ''
}

async function projectId(name: string): Promise<string> {
  const token = await unlockToken()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers: { 'X-Lock-Token': token } })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === name)
  if (!mine) throw new Error(`${name} 项目不存在`)
  return mine.id
}

async function apiFile(pid: string, action: 'create' | 'delete' | 'mkdir', path: string) {
  const token = await unlockToken()
  await fetch(`${API_BASE}/api/projects/${pid}/file/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path, content: 'probe' }),
  }).catch(() => {})
}

async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——可见即就位，否则奇数次点击保证最终打开
  for (let i = 0; i < 3; i++) {
    if (await page.getByText('README.md').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

/** 虚拟列表行进 DOM 保证：窗口外的行根本不渲染——先归位顶部再逐步进滚动 */
async function ensureRowVisible(page: Page, name: string) {
  for (let i = 0; i < 25; i++) {
    if (await itemByName(page, name).isVisible().catch(() => false)) return
    await page.locator('.virtual-list-container').evaluate((el, step) => {
      el.scrollTop = step === 0 ? 0 : el.scrollTop + 200
    }, i)
    await page.waitForTimeout(150)
  }
  throw new Error(`tree row ${name} 未进入虚拟窗口`)
}

/** 展开目录直到箭头朝下（点击 toggle；重试兜底虚拟列表重渲染竞态） */
async function expandDir(page: Page, name: string) {
  const dir = itemByName(page, name)
  await ensureRowVisible(page, name)
  for (let i = 0; i < 6; i++) {
    const arrow = (await dir.locator('.dir-arrow').textContent().catch(() => '')) || ''
    if (arrow === '▼') return
    await dir.click()
    await page.waitForTimeout(600)
  }
}

/** 逐级展开 docs → e2e-bren 直到探针可见（被虚拟窗口裁掉时步进滚动补位） */
async function revealProbe(page: Page, name: string) {
  await expandDir(page, 'docs')
  await expandDir(page, 'e2e-bren')
  await ensureRowVisible(page, name)
  return itemByName(page, name)
}

/** 多选一组探针（Ctrl+Click 逐个加入）并右键末位打开批量菜单 → 点「批量重命名」 */
async function openBatchRename(page: Page, names: string[]) {
  const probes = []
  for (const name of names) probes.push(await revealProbe(page, name))
  for (const probe of probes) await probe.click({ modifiers: ['Control'] })
  await expect(page.locator('.tree-item.selected')).toHaveCount(names.length)
  await probes[probes.length - 1]!.click({ button: 'right' })
  await expect(page.locator('.n-dropdown-menu')).toBeVisible()
  await page.locator('.n-dropdown-menu').getByText(new RegExp(`^批量重命名（${names.length} 项）$`)).click()
  const modal = page.locator('[data-testid="batch-rename-modal"]')
  await expect(modal).toBeVisible()
  return modal
}

test.beforeAll(async () => {
  const pid = await projectId('simple-coding')
  // 探针目录整树重置（上一轮残留会让重名/改名断言翻车），再播种本轮探针
  await apiFile(pid, 'delete', PROBE_DIR)
  await apiFile(pid, 'mkdir', PROBE_DIR)
  for (const p of [...A_PROBES, DUP_NAME, SOLO_NAME, ILLEGAL_NAME, LEGAL_NAME]) {
    await apiFile(pid, 'create', `${PROBE_DIR}/${p}`)
  }
  // 409 跳过用例的目标侧同名文件（DUP 改名终点）
  await apiFile(pid, 'create', `${PROBE_DIR}/${CONFLICT_TARGET}`)
})

test.afterAll(async () => {
  try {
    const pid = await projectId('simple-coding')
    await apiFile(pid, 'delete', PROBE_DIR)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('文件树多选批量重命名', () => {
  test('多选 3 文件：预览改名前后 → 确认逐个改名落盘', async ({ page }) => {
    await enterProject(page)

    const modal = await openBatchRename(page, A_PROBES)
    await modal.locator('[data-testid="batch-rename-find"] input').fill('bren-a')
    await modal.locator('[data-testid="batch-rename-replace"] input').fill('bren-z')

    // 实时预览：3 行对照（旧名 → 新名），无红标
    await expect(modal.locator('[data-testid="batch-rename-row"]')).toHaveCount(3)
    await expect(modal.locator('[data-testid="batch-rename-row"]').first()).toContainText('e2e-bren-a1.md')
    await expect(modal.locator('[data-testid="batch-rename-row"]').first()).toContainText('e2e-bren-z1.md')
    await expect(modal.locator('[data-testid="batch-rename-issue"]')).toHaveCount(0)

    await modal.locator('[data-testid="batch-rename-confirm"]').click()
    await expect(page.getByText('已重命名 3 项')).toBeVisible({ timeout: 5000 })
    // 旧名消失、新名出现（批量完成后多选清空）
    for (const name of A_PROBES) await expect(itemName(page, name)).toHaveCount(0, { timeout: 5000 })
    for (const name of A_RENAMED) {
      await ensureRowVisible(page, name)
      await expect(itemByName(page, name)).toBeVisible()
    }
    await expect(page.locator('.tree-item.selected')).toHaveCount(0)
  })

  test('改名目标撞已有同名：409 项跳过报告不中断批次', async ({ page }) => {
    await enterProject(page)

    const modal = await openBatchRename(page, [DUP_NAME, SOLO_NAME])
    await modal.locator('[data-testid="batch-rename-find"] input').fill('bren-b')
    await modal.locator('[data-testid="batch-rename-replace"] input').fill('bren-ok')
    await expect(modal.locator('[data-testid="batch-rename-row"]')).toHaveCount(2)

    await modal.locator('[data-testid="batch-rename-confirm"]').click()
    // P-117 目标防护（409 file already exists）：重名项跳过并逐个报告，批次不中断
    await expect(page.getByText(/已重命名 1 项，跳过 1 项：e2e-bren-b1\.md（目标已存在同名）/))
      .toBeVisible({ timeout: 5000 })
    // 不落盘：dup 仍在（count 1）、solo 已改名（旧名 0 / 新名可见）
    await expect(itemName(page, DUP_NAME)).toHaveCount(1, { timeout: 5000 })
    await expect(itemName(page, SOLO_NAME)).toHaveCount(0)
    await ensureRowVisible(page, 'e2e-bren-ok2.md')
    await expect(itemByName(page, 'e2e-bren-ok2.md')).toBeVisible()
  })

  test('非法红标（P-132 保留设备名）：红行不出现在确认计数，合法行照常改名', async ({ page }) => {
    await enterProject(page)

    const modal = await openBatchRename(page, [ILLEGAL_NAME, LEGAL_NAME])
    // 删除前缀 e2e-p3 → con.md（保留设备名，红标）/ zed.md（合法）
    await modal.locator('[data-testid="batch-rename-find"] input').fill('e2e-p3')
    await modal.locator('[data-testid="batch-rename-replace"] input').fill('')

    await expect(modal.locator('[data-testid="batch-rename-row"]')).toHaveCount(2)
    // con.md 行红标 + 保留设备名红字说明；确认按钮计数只含合法行
    const illegalRow = modal.locator('[data-testid="batch-rename-row"]').filter({ hasText: ILLEGAL_NAME })
    await expect(illegalRow).toHaveClass(/illegal/)
    await expect(illegalRow.locator('[data-testid="batch-rename-issue"]')).toContainText('保留设备名')
    await expect(modal.locator('[data-testid="batch-rename-confirm"]')).toHaveText(/重命名 1 项/)

    await modal.locator('[data-testid="batch-rename-confirm"]').click()
    await expect(page.getByText('已重命名 1 项')).toBeVisible({ timeout: 5000 })
    // 非法行未落盘（原名仍在、con.md 不存在）；合法行已改名
    await ensureRowVisible(page, ILLEGAL_NAME)
    await expect(itemByName(page, ILLEGAL_NAME)).toBeVisible()
    await expect(itemName(page, 'con.md')).toHaveCount(0)
    await ensureRowVisible(page, 'zed.md')
    await expect(itemByName(page, 'zed.md')).toBeVisible()
  })

  test('查找串无命中：空态提示 + 确认入口禁用', async ({ page }) => {
    await enterProject(page)

    const modal = await openBatchRename(page, A_RENAMED)
    await modal.locator('[data-testid="batch-rename-find"] input').fill('zzz-no-match')

    await expect(modal.getByText('没有文件名包含查找串')).toBeVisible()
    await expect(modal.locator('[data-testid="batch-rename-confirm"]')).toBeDisabled()
  })
})
