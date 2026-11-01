import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 删除目录确认展示递归规模（P-20261002-137）：
//   - 服务端 GET /file/stat 递归统计：隐藏文件计入（误删盲区必须可见）、子目录
//     计数、单文件直返；本 spec 先在 API 层断言载荷精度，再走 UI 链路
//   - 目录右键删除 → 确认弹层在「删除 X？可从回收站在 7 天内恢复」（P-20261005-154
//     真实威胁级措辞）下追加「N 个文件 / M 个目录 / 共 X」规模行 → 确认后目录整体
//     删除 / 取消则保留
//   - 文件删除确认不出现规模行（③ 只在目录删除时调用；点名+可恢复措辞同目录删除）
// 探针建在 simple-coding 仓库 docs/ 下（同 file-tree-* spec 家族惯例，探针名
// 互不重叠避免并行/残留互踩）。beforeAll/afterAll 统一播种清理。
const DIR_MAIN = 'e2e-dirstat'          // 确认删除用：2 可见文件 + 1 隐藏 + 1 子目录
const DIR_CANCEL = 'e2e-dirstat-cancel' // 取消保留用：单文件
const FILE_PROBE = 'e2e-statfile.md'    // 文件删除确认不变用
const DIR_MAIN_PATH = `docs/${DIR_MAIN}`
const DIR_CANCEL_PATH = `docs/${DIR_CANCEL}`
const FILE_PROBE_PATH = `docs/${FILE_PROBE}`
// 字节总量与 locale 文案强耦合：zh summary = '{files} 个文件 / {dirs} 个目录 / 共 {size}'
// （HumanBytes 一位小数 KB/MB，小值为整数 B），种子内容改一处这里必须同步
const DIR_MAIN_SCALE = '3 个文件 / 1 个目录 / 共 15 B' // probe(5B)+hidden(6B)+deep(4B)
const DIR_CANCEL_SCALE = '1 个文件 / 0 个目录 / 共 1 B'

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

async function authToken(): Promise<string> {
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  return (await unlockRes.json()).token || ''
}

async function projectId(): Promise<string> {
  const token = await authToken()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers: { 'X-Lock-Token': token } })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === 'simple-coding')
  if (!mine) throw new Error('simple-coding 项目不存在')
  return mine.id
}

async function apiFile(pid: string, action: 'create' | 'mkdir' | 'delete', path: string, content = 'probe') {
  const token = await authToken()
  await fetch(`${API_BASE}/api/projects/${pid}/file/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify(action === 'create' ? { path, content } : { path }),
  }).catch(() => {})
}

async function apiStat(pid: string, path: string) {
  const token = await authToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/file/stat?path=${encodeURIComponent(path)}`, {
    headers: { 'X-Lock-Token': token },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
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

test.beforeAll(async () => {
  const pid = await projectId()
  // 幂等重建：先清残留（delete 走 RemoveAll，目录连带内容整体移除）
  await apiFile(pid, 'delete', DIR_MAIN_PATH)
  await apiFile(pid, 'delete', DIR_CANCEL_PATH)
  await apiFile(pid, 'delete', FILE_PROBE_PATH)
  await apiFile(pid, 'mkdir', DIR_MAIN_PATH)
  await apiFile(pid, 'mkdir', `${DIR_MAIN_PATH}/sub`)
  await apiFile(pid, 'create', `${DIR_MAIN_PATH}/a.md`, 'probe')          // 5B 可见
  await apiFile(pid, 'create', `${DIR_MAIN_PATH}/.e2e-hidden`, 'hidden')  // 6B 隐藏（计入规模）
  await apiFile(pid, 'create', `${DIR_MAIN_PATH}/sub/inner.md`, 'deep')   // 4B 嵌套
  await apiFile(pid, 'mkdir', DIR_CANCEL_PATH)
  await apiFile(pid, 'create', `${DIR_CANCEL_PATH}/only.txt`, 'x')        // 1B
  await apiFile(pid, 'create', FILE_PROBE_PATH, 'plain')
})

test.afterAll(async () => {
  try {
    const pid = await projectId()
    await apiFile(pid, 'delete', DIR_MAIN_PATH)
    await apiFile(pid, 'delete', DIR_CANCEL_PATH)
    await apiFile(pid, 'delete', FILE_PROBE_PATH)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('删除目录确认展示递归规模', () => {
  test('API 层：/file/stat 隐藏文件计入 + 子目录计数 + 单文件直返', async () => {
    const pid = await projectId()

    const dir = await apiStat(pid, DIR_MAIN_PATH)
    expect(dir.status).toBe(200)
    expect(dir.body?.data).toMatchObject({ isDir: true, files: 3, dirs: 1, bytes: 15, truncated: false })

    const file = await apiStat(pid, FILE_PROBE_PATH)
    expect(file.status).toBe(200)
    expect(file.body?.data).toMatchObject({ isDir: false, files: 1, dirs: 0 })
  })

  test('目录右键删除：确认弹层含递归规模（含隐藏文件）→ 确认后整体删除', async ({ page }) => {
    await enterProject(page)

    const probe = await revealProbe(page, DIR_MAIN)
    await probe.click({ button: 'right' })
    await page.locator('.n-dropdown-menu').getByText('删除', { exact: true }).click()

    // 知情确认：既有点名文案 + 递归规模行（3 = 2 可见 + 1 隐藏，隐藏文件计入即此断言）
    const dialog = page.locator('.n-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(`删除 ${DIR_MAIN}？`)
    await expect(dialog).toContainText('可从回收站在 7 天内恢复')
    await expect(dialog).toContainText(DIR_MAIN_SCALE)

    await page.getByRole('button', { name: '确认' }).click()
    await expect(page.locator('.item-name').filter({ hasText: new RegExp(`^${DIR_MAIN}$`) })).toHaveCount(0, { timeout: 5000 })
  })

  test('目录右键删除：规模行照常展示，取消则目录保留', async ({ page }) => {
    await enterProject(page)

    const probe = await revealProbe(page, DIR_CANCEL)
    await probe.click({ button: 'right' })
    await page.locator('.n-dropdown-menu').getByText('删除', { exact: true }).click()

    const dialog = page.locator('.n-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(DIR_CANCEL_SCALE)

    await page.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(itemByName(page, DIR_CANCEL)).toBeVisible()
  })

  test('文件删除确认不变：不出现规模行（只在目录删除时调用）', async ({ page }) => {
    await enterProject(page)

    const probe = await revealProbe(page, FILE_PROBE)
    await probe.click({ button: 'right' })
    await page.locator('.n-dropdown-menu').getByText('删除', { exact: true }).click()

    const dialog = page.locator('.n-dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(`删除 ${FILE_PROBE}？`)
    await expect(dialog).toContainText('可从回收站在 7 天内恢复')
    await expect(dialog).not.toContainText('个文件')

    await page.getByRole('button', { name: '取消' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(itemByName(page, FILE_PROBE)).toBeVisible()
  })
})
