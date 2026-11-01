import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 重命名目标存在防护（P-20261002-117）：服务端 rename 前 os.Stat 目标，已存在
// 即 409（os.SameFile 幂等放行同名自身）——Linux os.Rename 静默覆盖的数据丢失
// 边界关闭，跨平台行为归一。前端行内重命名态输入行保持打开 + 同名红提示（就地
// 改名），不落盘。
//   - UI：重命名到已存在名 → 红提示可见、旧名仍在树（不落盘）→ 改名修正后成功
//   - API：目标已存在 → 409 携带 file already exists、双方内容不变
// 探针建在 simple-coding 仓库 docs/ 下（同 file-tree-f2.spec，探针名不同避免
// 并行/残留互踩）。beforeAll/afterAll 统一播种清理。
const PROBE_A = 'e2e-guard-a.md'
const PROBE_B = 'e2e-guard-b.md'
const PROBE_C = 'e2e-guard-c.md'
const A_PATH = `docs/${PROBE_A}`
const B_PATH = `docs/${PROBE_B}`
const C_PATH = `docs/${PROBE_C}`

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
    body: JSON.stringify(action === 'create' ? { path, content: 'guard probe' } : { path }),
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
  const dir = itemByName(page, 'docs')
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

// 选中探针 → F2 进行内重命名（与 file-tree-f2.spec 同一入口链路）
async function startInlineRename(page: Page, name: string) {
  const probe = await revealProbe(page, name)
  // 左键选中；file-click 会打开编辑器可能抢焦点，显式把焦点拉回 .tree-list
  await probe.click()
  await page.locator('.tree-list').focus()
  await page.keyboard.press('F2')
  const inlineInput = page.locator('.inline-input-row input')
  await expect(inlineInput).toBeVisible()
  await expect(inlineInput).toHaveValue(name)
  return inlineInput
}

test.beforeAll(async () => {
  const pid = await projectId()
  for (const p of [A_PATH, B_PATH, C_PATH]) await apiFile(pid, 'delete', p)
  await apiFile(pid, 'create', A_PATH)
  await apiFile(pid, 'create', B_PATH)
})

test.afterAll(async () => {
  try {
    const pid = await projectId()
    for (const p of [A_PATH, B_PATH, C_PATH]) await apiFile(pid, 'delete', p)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('重命名目标存在防护', () => {
  test('重命名到已存在名：行内红提示 + 输入行保持打开 + 不落盘', async ({ page }) => {
    await enterProject(page)

    const inlineInput = await startInlineRename(page, PROBE_A)
    await inlineInput.fill(PROBE_B)
    await inlineInput.press('Enter')

    // 红提示可见且带同名反馈；输入行不关闭（就地改名）
    const hint = page.locator('[data-testid="inline-rename-error"]')
    await expect(hint).toBeVisible({ timeout: 5000 })
    await expect(hint).toContainText(PROBE_B)
    await expect(page.locator('.inline-input-row input')).toBeVisible()

    // 不落盘：A 未消失、B 未被覆盖（树里两者都在）
    await expect(itemByName(page, PROBE_A)).toBeVisible()
    await expect(itemByName(page, PROBE_B)).toBeVisible()
  })

  test('红提示后改名修正：重命名成功落盘', async ({ page }) => {
    await enterProject(page)

    const inlineInput = await startInlineRename(page, PROBE_A)
    await inlineInput.fill(PROBE_C)
    await inlineInput.press('Enter')

    await expect(itemByName(page, PROBE_C)).toBeVisible({ timeout: 5000 })
    await expect(itemByName(page, PROBE_A)).toHaveCount(0)
  })

  test('API：目标已存在 → 409 双方不变；同名自身重命名幂等 200', async ({ request }) => {
    const pid = await projectId()
    const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: DEFAULT_PASSWORD }),
    })
    const token = (await unlockRes.json()).token || ''
    const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }
    const X_PATH = 'docs/e2e-guard-api-x.md'
    const Y_PATH = 'docs/e2e-guard-api-y.md'
    await apiFile(pid, 'delete', X_PATH)
    await apiFile(pid, 'delete', Y_PATH)
    await apiFile(pid, 'create', X_PATH)
    await apiFile(pid, 'create', Y_PATH)
    try {
      const res = await request.post(`${API_BASE}/api/projects/${pid}/file/rename`, {
        headers, data: { oldPath: X_PATH, newPath: Y_PATH },
      })
      expect(res.status()).toBe(409)
      expect(((await res.json()) as { error?: string }).error).toContain('file already exists')

      // 不落盘：X 仍在（内容保留）——覆盖失败重命名不破坏源
      const read = await request.get(`${API_BASE}/api/projects/${pid}/file?path=${X_PATH}`, { headers })
      expect(read.ok()).toBeTruthy()
      expect(((await read.json()) as { data?: string }).data).toContain('guard probe')

      // 同名自身重命名（目标即源）幂等放行：200 而非 409
      const self = await request.post(`${API_BASE}/api/projects/${pid}/file/rename`, {
        headers, data: { oldPath: Y_PATH, newPath: Y_PATH },
      })
      expect(self.ok()).toBeTruthy()
    } finally {
      await apiFile(pid, 'delete', X_PATH)
      await apiFile(pid, 'delete', Y_PATH)
    }
  })
})
