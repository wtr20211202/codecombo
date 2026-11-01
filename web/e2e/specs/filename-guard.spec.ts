import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 文件名跨平台兼容性校验（P-20261002-132）：Windows 保留设备名（CON/PRN/AUX/
// NUL/COM1-9/LPT1-9，主干命中含带扩展名形态）与段结尾点/空格在创建入口拒绝——
// 杜绝「一端创建、三端爆炸」的仓库名字地雷。
//   - UI：行内新建 CON.txt → 输入期间即时红提示（P-117 同款通道），Enter 短路
//     不发请求；就地改正常名创建成功；F2 重命名到保留名同款拦截
//   - API：create/mkdir/rename 三入口 400 携带稳定前缀 invalid file name，
//     正常名照常（行内输入前端已即时拦截，服务端兜底直达 API 的调用方）
// 探针建在 simple-coding 仓库 docs/ 下（同 file-tree-f2.spec，探针名不同避免
// 并行/残留互踩）。beforeAll/afterAll 统一播种清理。
const PROBE_SRC = 'docs/e2e-name-guard-src.md'
const PROBE_OK = 'e2e-name-guard-ok.md'
const PROBE_OK_PATH = `docs/${PROBE_OK}`

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
    body: JSON.stringify(action === 'create' ? { path, content: 'name guard probe' } : { path }),
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

// 右键 docs → 新建文件，返回行内输入框（与 file-tree-context.spec 同一入口链路）
async function startInlineCreate(page: Page) {
  const dir = itemByName(page, 'docs')
  await expect(dir).toBeVisible({ timeout: 5000 })
  await dir.click({ button: 'right' })
  await expect(page.locator('.n-dropdown-menu')).toBeVisible()
  await page.locator('.n-dropdown-menu').getByText('新建文件', { exact: true }).click()
  const inlineInput = page.locator('.inline-input-row input')
  await expect(inlineInput).toBeVisible()
  return inlineInput
}

test.beforeAll(async () => {
  const pid = await projectId()
  await apiFile(pid, 'delete', PROBE_SRC)
  await apiFile(pid, 'delete', PROBE_OK_PATH)
  await apiFile(pid, 'create', PROBE_SRC)
})

test.afterAll(async () => {
  try {
    const pid = await projectId()
    await apiFile(pid, 'delete', PROBE_SRC)
    await apiFile(pid, 'delete', PROBE_OK_PATH)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('文件名跨平台兼容性校验', () => {
  test('新建 CON.txt：输入期间即时红提示，Enter 不发请求不落盘', async ({ page }) => {
    await enterProject(page)

    const inlineInput = await startInlineCreate(page)
    await inlineInput.fill('CON.txt')

    // 即时红提示（无需 Enter）：输入期间就地命中保留名
    const hint = page.locator('[data-testid="inline-rename-error"]')
    await expect(hint).toBeVisible({ timeout: 5000 })
    await expect(hint).toContainText('CON.txt')

    // Enter 短路：输入行保持打开、提示不消失、树里不出现 CON.txt（不发请求）
    await inlineInput.press('Enter')
    await expect(page.locator('.inline-input-row input')).toBeVisible()
    await expect(hint).toBeVisible()
    await expect(itemByName(page, 'CON.txt')).toHaveCount(0)
  })

  test('红提示后就地改成正常名：创建成功落盘', async ({ page }) => {
    await enterProject(page)

    const inlineInput = await startInlineCreate(page)
    await inlineInput.fill('CON.txt')
    await expect(page.locator('[data-testid="inline-rename-error"]')).toBeVisible()

    await inlineInput.fill(PROBE_OK)
    await expect(page.locator('[data-testid="inline-rename-error"]')).toHaveCount(0)
    await inlineInput.press('Enter')

    const probe = await revealProbe(page, PROBE_OK)
    await expect(probe).toBeVisible({ timeout: 5000 })
  })

  test('F2 重命名到保留名：红提示 + 输入行保持打开 + 旧名仍在', async ({ page }) => {
    await enterProject(page)

    const probe = await revealProbe(page, 'e2e-name-guard-src.md')
    await probe.click()
    await page.locator('.tree-list').focus()
    await page.keyboard.press('F2')
    const inlineInput = page.locator('.inline-input-row input')
    await expect(inlineInput).toBeVisible()
    await expect(inlineInput).toHaveValue('e2e-name-guard-src.md')

    await inlineInput.fill('com1')
    const hint = page.locator('[data-testid="inline-rename-error"]')
    await expect(hint).toBeVisible({ timeout: 5000 })
    await expect(hint).toContainText('com1')

    await inlineInput.press('Enter')
    await expect(page.locator('.inline-input-row input')).toBeVisible()
    await expect(itemByName(page, 'e2e-name-guard-src.md')).toBeVisible()
  })

  test('API：create/mkdir/rename 三入口 400 invalid file name，正常名照常', async ({ request }) => {
    const pid = await projectId()
    const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: DEFAULT_PASSWORD }),
    })
    const token = (await unlockRes.json()).token || ''
    const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }

    // 保留名（含带扩展名形态）创建 → 400 稳定前缀
    const resCon = await request.post(`${API_BASE}/api/projects/${pid}/file/create`, {
      headers, data: { path: 'docs/CON.txt', content: 'x' },
    })
    expect(resCon.status()).toBe(400)
    expect(((await resCon.json()) as { error?: string }).error).toContain('invalid file name')

    // 段结尾点目录 → 400（Windows 宿主上原生 mkdir 也会失败，守卫先拦截给稳定口径）
    const resDot = await request.post(`${API_BASE}/api/projects/${pid}/file/mkdir`, {
      headers, data: { path: 'docs/e2e-guard-dot.' },
    })
    expect(resDot.status()).toBe(400)
    expect(((await resDot.json()) as { error?: string }).error).toContain('invalid file name')

    // 重命名到保留名 → 400，源不受影响
    const resRename = await request.post(`${API_BASE}/api/projects/${pid}/file/rename`, {
      headers, data: { oldPath: PROBE_SRC, newPath: 'con' },
    })
    expect(resRename.status()).toBe(400)
    expect(((await resRename.json()) as { error?: string }).error).toContain('invalid file name')
    const read = await request.get(`${API_BASE}/api/projects/${pid}/file?path=${PROBE_SRC}`, { headers })
    expect(read.ok()).toBeTruthy()

    // 正常名三入口照常（守卫不误伤主链路）
    const resOk = await request.post(`${API_BASE}/api/projects/${pid}/file/create`, {
      headers, data: { path: 'docs/e2e-name-guard-api-ok.md', content: 'fine' },
    })
    expect(resOk.status()).toBe(201)
    const resRenameOk = await request.post(`${API_BASE}/api/projects/${pid}/file/rename`, {
      headers, data: { oldPath: 'docs/e2e-name-guard-api-ok.md', newPath: 'docs/e2e-name-guard-api-renamed.md' },
    })
    expect(resRenameOk.ok()).toBeTruthy()
    await apiFile(pid, 'delete', 'docs/e2e-name-guard-api-renamed.md')
  })
})
