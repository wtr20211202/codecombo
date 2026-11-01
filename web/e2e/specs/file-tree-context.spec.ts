import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 文件树右键菜单 / 内联新建 / 重命名 / 删除 回归。
// 背景：FileTreeView 的右键菜单与内联输入抽至 useFileTreeContext、拖拽抽至
// useFileTreeDragDrop 后，core-workflow 只覆盖展开+点击，本 spec 补齐文件操作链路。
// 探针建在 simple-coding 仓库 docs/ 下（根目录 26 条目填满虚拟列表，无空白背景可右键；
// docs 目录被 .gitignore 标记 ignored 不影响文件操作）。beforeAll/afterAll 统一播种清理。
const PROBE_DIR = 'docs'
const PROBE_PATH = 'docs/e2e-context-probe.md'
const PROBE = 'e2e-context-probe.md'
const PROBE_RENAMED = 'e2e-context-probe-renamed.md'

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

test.describe('文件树右键与内联操作', () => {
  test('目录右键 → 内联新建文件 → 出现在展开目录中', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    // 先证明 docs 可展开且当前无探针（beforeAll 已删），再删一遍树内残留后重建
    let dir = itemByName(page, PROBE_DIR)
    await expect(dir).toBeVisible({ timeout: 5000 })
    // 收起（保证新建后 refreshTargetPath 走「展开后可见」路径）
    for (let i = 0; i < 3; i++) {
      if (((await dir.locator('.dir-arrow').textContent().catch(() => '')) || '') !== '▼') break
      await dir.click()
      await page.waitForTimeout(600)
    }

    // 右键 docs 目录：菜单包含 新建文件/新建目录/在终端中打开
    await dir.click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.locator('.n-dropdown-menu').getByText('新建文件', { exact: true }).click()

    // 内联输入行出现，输入文件名回车确认（useFileTreeContext.confirmInlineInput）
    const inlineInput = page.locator('.inline-input-row input')
    await expect(inlineInput).toBeVisible()
    await inlineInput.fill(PROBE)
    await inlineInput.press('Enter')

    // 展开看到新文件
    const probe = await revealProbe(page, PROBE)
    await expect(probe).toBeVisible({ timeout: 5000 })
  })

  test('右键重命名 → 内联预填旧名 → 改名生效', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const probe = await revealProbe(page, PROBE)
    await probe.click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.locator('.n-dropdown-menu').getByText('重命名', { exact: true }).click()

    const inlineInput = page.locator('.inline-input-row input')
    await expect(inlineInput).toBeVisible()
    await expect(inlineInput).toHaveValue(PROBE) // 预填旧名
    await inlineInput.fill(PROBE_RENAMED)
    await inlineInput.press('Enter')

    await expect(page.locator('.item-name').filter({ hasText: /^e2e-context-probe-renamed\.md$/ })).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.item-name').filter({ hasText: /^e2e-context-probe\.md$/ })).toHaveCount(0)
  })

  test('右键删除 → 确认弹窗 → 树中移除', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    // 重命名用例可能已把探针改名，这里自愈：改名文件在就删它，否则把探针改回原名
    let probe = await revealProbe(page, PROBE_RENAMED)
    await probe.click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.locator('.n-dropdown-menu').getByText('删除', { exact: true }).click()

    // useDialog confirmDialog：positiveText = t('common.confirm') = 「确认」
    await page.getByRole('button', { name: '确认' }).click()

    await expect(page.locator('.item-name').filter({ hasText: /^e2e-context-probe-renamed\.md$/ })).toHaveCount(0, { timeout: 5000 })
    await expect(page.locator('.item-name').filter({ hasText: /^e2e-context-probe\.md$/ })).toHaveCount(0)
  })

  // 语义分组（P-20261003-210）：组间分隔线呈现 + 既有项全在 + 组序成立。
  // 菜单只能 clickoutside/select 关闭（无 ESC 通道），目录/文件两种形态各开
  // 独立用例（各自 fresh page 一次右键），避免菜单遮住后续右键目标。
  // 钉选文案随钉选态二选一（钉选表持久化、跨用例残留不控）；view-remote 仅在
  // 项目 remote 可解析时出现（环境相关）——两者归一化后断全序。
  // 树内复制/剪切/粘贴（P-20261023-2③a）三入口归文件操作组（组内既有位次：
  // 粘贴随上传列创建族之后、复制/剪切随重命名列编辑族），四组语义与分隔线数不变
  test('目录右键语义分组：四组分隔线 + 既有项全在且组序成立', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const dir = itemByName(page, PROBE_DIR)
    await expect(dir).toBeVisible({ timeout: 5000 })
    await dir.click({ button: 'right' })
    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()

    const labels = (await menu.locator('.n-dropdown-option .n-dropdown-option-body__label').allInnerTexts())
      .map(l => (l === '钉选到顶部' || l === '取消钉选' ? '钉选' : l))
    // 文件操作 → agent 与终端 → git → 分享导出 → 删除殿后（组间即分隔线，见下行计数）
    // 同步到其他实例…（P-20261023-1 方案④）列分享导出组内 share 之后
    expect(labels).toEqual([
      '新建文件', '新建目录', '上传文件…', '粘贴', '重命名', '复制', '剪切', '复制副本', '钉选',
      '在终端中打开', '在此目录搜索', '在此目录新建 agent 会话',
      '添加到 git exclude',
      '生成分享链接', '同步到其他实例…', '下载为 zip', '在系统中显示', '复制路径', '复制绝对路径',
      '删除',
    ])
    expect(await menu.locator('.n-dropdown-divider').count()).toBe(4)
  })

  test('文件右键语义分组：四组分隔线 + 既有项全在且组序成立', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    // 前序用例可能已把探针改名/删除：API 自备一份（幂等，命中残留也无妨）
    const pid = await projectId()
    await apiFile(pid, 'delete', `docs/${PROBE_RENAMED}`)
    await apiFile(pid, 'delete', PROBE_PATH)
    await apiFile(pid, 'create', PROBE_PATH)

    const probe = await revealProbe(page, PROBE)
    await probe.click({ button: 'right' })
    const menu = page.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()

    const labels = (await menu.locator('.n-dropdown-option .n-dropdown-option-body__label').allInnerTexts())
      .filter(l => !/^在 .+ 上查看$/.test(l)) // view-remote 环境相关（有 http(s)/ssh remote 才有）
    // 文件操作（分屏打开 P-20261003-321 列首位；树内复制/剪切 P-20261023-2③a
    // 随重命名列编辑族）→ agent 与终端 → git（对比基准/git exclude/本地历史/改动来源 P-20261005-170）→ 分享导出 → 删除殿后
    // 同步到其他实例…（P-20261023-1 方案④）列分享导出组内 share 之后
    expect(labels).toEqual([
      '在分屏打开', '重命名', '复制', '剪切', '复制副本',
      '在此目录新建 agent 会话',
      '选为对比基准', '添加到 git exclude', '本地历史', '改动来源',
      '生成分享链接', '同步到其他实例…', '下载', '在系统中显示', '复制路径', '复制绝对路径',
      '删除',
    ])
    expect(await menu.locator('.n-dropdown-divider').count()).toBe(4)
  })
})
