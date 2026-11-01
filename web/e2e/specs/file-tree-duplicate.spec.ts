import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 文件树右键「复制副本」（P-20261004-135）——变体文件两步变一步的 UI 闭环：
// 服务端端点一次调用（命名自增 -copyN 在服务端，响应 path 是唯一权威）→ 树刷新
// → 新文件落位即选中。服务端命名/递归/护栏语义由 Go 单测锚定
// （server/api/files/duplicate_test.go），本 spec 锚定前端链路：菜单项 → 端点
// 调用 → 刷新出现 → 选中态 → 自增不覆盖既有副本 → 目录递归副本。
// 探针建在 simple-coding 仓库 docs/ 下（同 file-tree-context 惯例：
// 根目录条目填满虚拟列表，docs 可展开可右键）。
const PROBE_DIR = 'docs'
const PROBE_NAME = 'e2e-dup-probe.md'
const PROBE_PATH = 'docs/e2e-dup-probe.md'
const PROBE_CONTENT = 'dup-probe-v1'
const DUP_DIR = 'e2e-dup-dir'
const DUP_DIR_INNER = 'docs/e2e-dup-dir/inner.txt'

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

async function unlockToken(): Promise<string> {
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  return (await unlockRes.json()).token || ''
}

async function projectId(): Promise<string> {
  const token = await unlockToken()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers: { 'X-Lock-Token': token } })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === 'simple-coding')
  if (!mine) throw new Error('simple-coding 项目不存在')
  return mine.id
}

async function apiFile(pid: string, action: 'create' | 'delete' | 'mkdir', path: string, content = '') {
  const token = await unlockToken()
  const endpoint = action === 'create' ? 'file/create' : action === 'mkdir' ? 'file/mkdir' : 'file/delete'
  await fetch(`${API_BASE}/api/projects/${pid}/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify(action === 'create' ? { path, content } : { path }),
  }).catch(() => {})
}

async function apiRead(pid: string, path: string): Promise<string | null> {
  const token = await unlockToken()
  try {
    const res = await fetch(`${API_BASE}/api/projects/${pid}/file?path=${encodeURIComponent(path)}`, {
      headers: { 'X-Lock-Token': token },
    })
    if (!res.ok) return null
    const json = await res.json()
    return typeof json?.data === 'string' ? json.data : null
  } catch { return null }
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

// 反复收起/展开 docs 直到探针可见（展开态在 uiState 恢复 + 虚拟列表重渲染下有竞态，
// file-tree-context 同款自愈轮询）
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

test.beforeAll(async () => {
  const pid = await projectId()
  // 探针与历史副本（自增用例要 -copy1/-copy2 从干净序列起）统一清场
  for (const p of [
    PROBE_PATH, 'docs/e2e-dup-probe-copy1.md', 'docs/e2e-dup-probe-copy2.md',
    DUP_DIR_INNER, `docs/${DUP_DIR}`, `docs/${DUP_DIR}-copy1`,
  ]) {
    await apiFile(pid, 'delete', p)
  }
  await apiFile(pid, 'create', PROBE_PATH, PROBE_CONTENT)
  await apiFile(pid, 'mkdir', `docs/${DUP_DIR}`)
  await apiFile(pid, 'create', DUP_DIR_INNER, 'inner-v1')
})

test.afterAll(async () => {
  try {
    const pid = await projectId()
    for (const p of [
      PROBE_PATH, 'docs/e2e-dup-probe-copy1.md', 'docs/e2e-dup-probe-copy2.md',
      DUP_DIR_INNER, `docs/${DUP_DIR}`, `docs/${DUP_DIR}-copy1`,
    ]) {
      await apiFile(pid, 'delete', p)
    }
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('文件树右键「复制副本」', () => {
  test('文件复制副本：新文件出现并选中、内容与源一致、副本名服务端派生', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const probe = await revealProbe(page, PROBE_NAME)
    await expect(probe).toBeVisible({ timeout: 5000 })

    // 右键 → 复制副本（服务端端点一次调用，前端不再拼名）
    await probe.click({ button: 'right' })
    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()
    await menu.getByText('复制副本', { exact: true }).click()

    // 成功反馈 + 刷新后新文件落位且选中（selectedPaths 收缩为新文件，
    // VS Code 资源管理器「副本落位即选中」同款）
    await expect(page.locator('.n-message')).toContainText('已复制为 e2e-dup-probe-copy1.md', { timeout: 5000 })
    const copy = await revealProbe(page, 'e2e-dup-probe-copy1.md')
    await expect(copy).toBeVisible({ timeout: 5000 })
    await expect(copy).toHaveClass(/selected/, { timeout: 5000 })

    // 内容与源一致（服务端字节级复制——UI 只管触发，内容权威在服务端）
    const pid = await projectId()
    expect(await apiRead(pid, 'docs/e2e-dup-probe-copy1.md')).toBe(PROBE_CONTENT)
  })

  test('再次复制自增 -copy2：既有 copy1 不被静默覆盖', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const probe = await revealProbe(page, PROBE_NAME)
    await expect(probe).toBeVisible({ timeout: 5000 })
    await probe.click({ button: 'right' })
    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()
    await menu.getByText('复制副本', { exact: true }).click()

    const copy2 = await revealProbe(page, 'e2e-dup-probe-copy2.md')
    await expect(copy2).toBeVisible({ timeout: 5000 })

    // 既有副本完好（自增语义 = 首个不冲突，绝不覆盖）
    const pid = await projectId()
    expect(await apiRead(pid, 'docs/e2e-dup-probe-copy1.md')).toBe(PROBE_CONTENT)
    expect(await apiRead(pid, 'docs/e2e-dup-probe-copy2.md')).toBe(PROBE_CONTENT)
  })

  test('目录复制副本：目录副本递归出现（含子文件）', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const dir = await revealProbe(page, DUP_DIR)
    await expect(dir).toBeVisible({ timeout: 5000 })
    await dir.click({ button: 'right' })
    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()
    await menu.getByText('复制副本', { exact: true }).click()

    const copyDir = await revealProbe(page, `${DUP_DIR}-copy1`)
    await expect(copyDir).toBeVisible({ timeout: 5000 })
    // 递归：副本目录可展开且子文件在内（服务端 copyTree 整树复制的 UI 可见面）
    await copyDir.click()
    await expect(itemByName(page, 'inner.txt').first()).toBeVisible({ timeout: 5000 })

    const pid = await projectId()
    expect(await apiRead(pid, `docs/${DUP_DIR}-copy1/inner.txt`)).toBe('inner-v1')
  })
})
