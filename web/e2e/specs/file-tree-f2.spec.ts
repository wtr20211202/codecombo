import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 文件树 F2 重命名快捷键（P-20261001-23）：
//   - 范围限定：焦点在 .tree-list 内且存在选中节点才响应；无选中不出现行内输入
//   - 选中 → F2 → 行内编辑预填旧名 → 改名成功（与右键「重命名」同一入口）
// 探针建在 simple-coding 仓库 docs/ 下（同 file-tree-context.spec，探针名不同
// 避免并行/残留互踩）。beforeAll/afterAll 统一播种清理。
const PROBE_DIR = 'docs'
const PROBE_PATH = 'docs/e2e-f2-probe.md'
const PROBE = 'e2e-f2-probe.md'
const PROBE_RENAMED = 'e2e-f2-probe-renamed.md'

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
  await apiFile(pid, 'delete', PROBE_PATH)
  await apiFile(pid, 'delete', `docs/${PROBE_RENAMED}`)
  await apiFile(pid, 'create', PROBE_PATH)
})

test.afterAll(async () => {
  try {
    const pid = await projectId()
    await apiFile(pid, 'delete', PROBE_PATH)
    await apiFile(pid, 'delete', `docs/${PROBE_RENAMED}`)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('文件树 F2 重命名', () => {
  test('无选中节点按 F2：不出现行内输入（范围限定）', async ({ page }) => {
    await enterProject(page)

    // 焦点落在 .tree-list（快捷键作用域内）但不选中任何节点：
    // focusedIndex 初始 -1，F2 必须无操作
    await page.locator('.tree-list').focus()
    await page.keyboard.press('F2')
    await expect(page.locator('.inline-input-row')).toHaveCount(0)
  })

  test('选中 → F2 → 预填旧名 → 改名成功', async ({ page }) => {
    await enterProject(page)

    const probe = await revealProbe(page, PROBE)
    // 左键选中（focusedIndex 指向探针）；file-click 会打开编辑器可能抢焦点，
    // 显式把焦点拉回 .tree-list，保证 F2 命中树容器内的键盘处理
    await probe.click()
    await page.locator('.tree-list').focus()

    await page.keyboard.press('F2')

    // 与右键「重命名」同一入口：行内输入预填旧名
    const inlineInput = page.locator('.inline-input-row input')
    await expect(inlineInput).toBeVisible()
    await expect(inlineInput).toHaveValue(PROBE)
    await inlineInput.fill(PROBE_RENAMED)
    await inlineInput.press('Enter')

    await expect(page.locator('.item-name').filter({ hasText: /^e2e-f2-probe-renamed\.md$/ })).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.item-name').filter({ hasText: /^e2e-f2-probe\.md$/ })).toHaveCount(0)
  })
})
