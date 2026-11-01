import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 任意两工作区文件互比（P-20261002-75）：
//   1. 文件树右键「选为对比基准」→ 状态栏「对比基准：x（点击取消）」
//   2. 第二文件右键「与基准对比」→ diff 标签（标题「a ↔ b (Diff)」）两侧内容正确
//   3. 一次性语义：对比成功开出后基准清除；取消走状态栏点击 / 基准文件右键
//   4. binary 走 filePolicy 拦截：就地提示、不开 diff、基准保留
// 探针建在 simple-coding 仓库 docs/ 下（未被 gitignore，默认可见），beforeAll/
// afterAll 统一播种清理；.bin 探针靠扩展名即被判 binary（filepolicy.binaryByExt）。
const PROBE_DIR = 'docs'
const FILE_A = 'e2e-cmp-a.md'
const FILE_B = 'e2e-cmp-b.md'
const FILE_BIN = 'e2e-cmp-bad.bin'
const CONTENT_A = 'cmp-base-alpha-marker\nshared tail\n'
const CONTENT_B = 'cmp-target-beta-marker\nshared tail\n'
const TAB_LABEL = `${FILE_A} ↔ ${FILE_B} (Diff)`

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

async function apiFile(pid: string, action: 'create' | 'delete', path: string, content = '') {
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = (await unlockRes.json()).token || ''
  await fetch(`${API_BASE}/api/projects/${pid}/file/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path, content }),
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

async function pickContextItem(page: Page, probe: ReturnType<Page['locator']>, label: string) {
  await probe.click({ button: 'right' })
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  await menu.getByText(label, { exact: true }).click()
}

const baselineIndicator = (p: Page) => p.locator('[data-testid="compare-baseline"]')

test.beforeAll(async () => {
  const pid = await projectId()
  for (const f of [FILE_A, FILE_B, FILE_BIN]) await apiFile(pid, 'delete', `docs/${f}`)
  await apiFile(pid, 'create', `docs/${FILE_A}`, CONTENT_A)
  await apiFile(pid, 'create', `docs/${FILE_B}`, CONTENT_B)
  await apiFile(pid, 'create', `docs/${FILE_BIN}`, 'x')
})

test.afterAll(async () => {
  try {
    const pid = await projectId()
    for (const f of [FILE_A, FILE_B, FILE_BIN]) await apiFile(pid, 'delete', `docs/${f}`)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('任意两文件对比', () => {
  test('选基准 → 与基准对比 → diff 两侧内容/标题正确 → 基准清除', async ({ page: p }) => {
    await enterProject(p)
    const a = await revealProbe(p, FILE_A)
    const b = await revealProbe(p, FILE_B)

    // 右键 a：选为对比基准 → 状态栏出现「对比基准：a.md（点击取消）」
    await pickContextItem(p, a, '选为对比基准')
    await expect(baselineIndicator(p)).toBeVisible()
    await expect(baselineIndicator(p)).toContainText(`对比基准：${FILE_A}`)

    // 右键 b：与基准对比 → diff 标签，标题「a ↔ b (Diff)」
    await pickContextItem(p, b, '与基准对比')
    await expect(p.locator(`.editor-tab[aria-label="${TAB_LABEL}"]`)).toBeVisible({ timeout: 8000 })
    await expect(p.locator('.monaco-diff-editor')).toBeVisible({ timeout: 8000 })

    // 两侧内容正确：左（original）= 基准 a，右（modified）= 目标 b
    await expect(p.locator('.monaco-diff-editor .editor.original .view-lines')).toContainText('cmp-base-alpha-marker', { timeout: 8000 })
    await expect(p.locator('.monaco-diff-editor .editor.modified .view-lines')).toContainText('cmp-target-beta-marker', { timeout: 8000 })
    // 面包屑比较标签为「a ↔ b」（cmpto- 伪 ref 解码，非「基准 ↔ 工作区」ref 语义）
    await expect(p.getByText(`${FILE_A} ↔ ${FILE_B}`, { exact: true })).toBeVisible()

    // 一次性语义：对比成功开出后基准清除
    await expect(baselineIndicator(p)).toHaveCount(0, { timeout: 5000 })
  })

  test('取消基准：基准文件右键「取消对比基准」与状态栏点击两条路', async ({ page: p }) => {
    await enterProject(p)
    const a = await revealProbe(p, FILE_A)

    // 路径一：基准文件右键 → 取消对比基准
    await pickContextItem(p, a, '选为对比基准')
    await expect(baselineIndicator(p)).toBeVisible()
    await pickContextItem(p, a, '取消对比基准')
    await expect(baselineIndicator(p)).toHaveCount(0)

    // 路径二：状态栏指示条点击取消
    await pickContextItem(p, a, '选为对比基准')
    await expect(baselineIndicator(p)).toBeVisible()
    await baselineIndicator(p).click()
    await expect(baselineIndicator(p)).toHaveCount(0)
  })

  test('binary 走 filePolicy 拦截：就地提示、不开 diff、基准保留', async ({ page: p }) => {
    await enterProject(p)
    const a = await revealProbe(p, FILE_A)
    const bad = await revealProbe(p, FILE_BIN)

    // 基准 = .bin：与 a 对比被拦（策略命中基准侧）。
    // 两次拦截 toast 文案相同且存活时间重叠：断言取 .first() 防 strict 多命中
    await pickContextItem(p, bad, '选为对比基准')
    await expect(baselineIndicator(p)).toBeVisible()
    await pickContextItem(p, a, '与基准对比')
    await expect(p.locator('.n-message').filter({ hasText: `${FILE_BIN} 为二进制文件或超过大小上限，无法对比` }).first()).toBeVisible({ timeout: 5000 })
    await expect(p.locator('.editor-tab[aria-label*="(Diff)"]')).toHaveCount(0)
    // 被拦下不清基准：指示条仍在，可换文件再试
    await expect(baselineIndicator(p)).toBeVisible()

    // 基准 = a：目标侧 .bin 同样被拦
    await pickContextItem(p, a, '选为对比基准')
    await expect(baselineIndicator(p)).toContainText(`对比基准：${FILE_A}`)
    await pickContextItem(p, bad, '与基准对比')
    await expect(p.locator('.n-message').filter({ hasText: `${FILE_BIN} 为二进制文件或超过大小上限，无法对比` }).first()).toBeVisible({ timeout: 5000 })
    await expect(baselineIndicator(p)).toBeVisible()
  })
})
