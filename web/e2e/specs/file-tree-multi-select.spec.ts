import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 文件树多选与批量操作（P-20261002-20）：Ctrl+Click 增删、Shift+Click 范围、
// Ctrl+A 全选可见层级、多选 ≥2 右键切批量形态（汇总确认删除 / 批量 git exclude）。
//
// 探针分两处：
// - 删除/全选用例：simple-coding 仓库 docs/ 下 e2e-multi-del-*.md（与
//   file-tree-context 同款宿主，纯文件操作无 git 语义依赖）；
// - git exclude 用例：git-test fixture（.e2e-data/fixtures/git-test）根目录
//   e2e-multi-git-*.md——该用例依赖 git-exclude 端点写 .git/info/exclude，
//   而 worktree 宿主（含 e2e 实例的 simple-coding 项目）的 .git 是 gitdir
//   指针文件，AddGitExcludeRule 的 MkdirAll 必 500（既有服务端缺陷，非本
//   提案引入）；fixture 是真实克隆、数据面可丢弃，故探针落于此。
// beforeAll/afterAll 统一经 API 播种清理，绕过 UI 竞态。
const PROBE_DIR = 'docs'
const DEL_PROBES = ['e2e-multi-del-a.md', 'e2e-multi-del-b.md', 'e2e-multi-del-c.md']
const GIT_PROBES = ['e2e-multi-git-a.md', 'e2e-multi-git-b.md', 'e2e-multi-git-c.md']

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

async function apiFile(pid: string, action: 'create' | 'delete', path: string) {
  const token = await unlockToken()
  await fetch(`${API_BASE}/api/projects/${pid}/file/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify(action === 'create' ? { path, content: 'probe' } : { path }),
  }).catch(() => {})
}

async function enterProject(page: Page, cardName: string, readyText: string) {
  await gotoAndUnlock(page, '/')
  // 整词锚定项目名：卡面路径文本可能含另一项目的名字子串（git-test 夹具
  // 路径 <repo>/.e2e-data/fixtures/git-test 含 "simple-coding"）
  const projectCard = projectCardByName(page, cardName).first()
  await projectCard.click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——可见即就位，否则奇数次点击保证最终打开
  for (let i = 0; i < 3; i++) {
    if (await page.getByText(readyText).isVisible().catch(() => false)) return
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
  const scPid = await projectId('simple-coding')
  for (const p of DEL_PROBES) {
    await apiFile(scPid, 'delete', `${PROBE_DIR}/${p}`)
    await apiFile(scPid, 'create', `${PROBE_DIR}/${p}`)
  }
  const gtPid = await projectId('git-test')
  for (const p of GIT_PROBES) {
    await apiFile(gtPid, 'delete', p)
    await apiFile(gtPid, 'create', p)
  }
})

test.afterAll(async () => {
  try {
    const scPid = await projectId('simple-coding')
    for (const p of DEL_PROBES) await apiFile(scPid, 'delete', `${PROBE_DIR}/${p}`)
    const gtPid = await projectId('git-test')
    for (const p of GIT_PROBES) await apiFile(gtPid, 'delete', p)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('文件树多选与批量操作', () => {
  test('Ctrl+Click 选 3 文件 → 右键批量删除 → 汇总确认 → 全部移除', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page, 'simple-coding', 'README.md')

    const probes = []
    for (const name of DEL_PROBES) probes.push(await revealProbe(page, name))

    // Ctrl+Click 逐个加入多选：selected 高亮计数 = 3
    for (const probe of probes) await probe.click({ modifiers: ['Control'] })
    await expect(page.locator('.tree-item.selected')).toHaveCount(3)

    // 右键集合内节点：菜单切批量形态（标签带总数）
    await probes[1]!.click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.locator('.n-dropdown-menu').getByText('删除 3 项', { exact: true }).click()

    // 破坏性聚合红线：汇总确认弹窗列总数 + 前几项名
    await expect(page.getByText(/将删除 3 项/)).toBeVisible()
    await page.getByRole('button', { name: '确认' }).click()

    for (const name of DEL_PROBES) {
      await expect(itemName(page, name)).toHaveCount(0, { timeout: 5000 })
    }
    // 批量完成后选择清空
    await expect(page.locator('.tree-item.selected')).toHaveCount(0)
  })

  test('Ctrl+A 全选可见层级 → 普通点击清除多选', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page, 'simple-coding', 'README.md')

    const total = await page.locator('.tree-item').count()
    expect(total).toBeGreaterThan(0)

    // 焦点落在树容器（tabindex=0）后 Ctrl+A 全选当前可见层级
    await page.locator('.tree-list').focus()
    await page.keyboard.press('Control+a')
    await expect(page.locator('.tree-item.selected')).toHaveCount(total)

    // 普通点击：清多选并保持既有行为（打开文件）
    await itemByName(page, 'README.md').click()
    await expect(page.locator('.tree-item.selected')).toHaveCount(0)
  })

  test('Shift+Click 范围选 3 → 批量加入 git exclude → 一次确认 → 刷新命中忽略标记', async ({ page }) => {
    await fixedLocale(page)
    // 打开「显示 gitignore 忽略的文件」：git exclude 规则落在 .git/info/exclude 且无
    // 删除端点，跨运行残留会让默认视图（hideIgnored=true）从一开始就藏起探针——
    // 本用例改为断言忽略徽标（服务端 check-ignore 标记），对首跑/复跑均确定性成立
    await page.addInitScript(([key]) => { localStorage.setItem(key, '0') }, ['sc.fileTree.hideIgnored'])
    await enterProject(page, 'git-test', 'README')

    // git-test 根目录条目少，探针直接可见（无需展开）
    const first = itemByName(page, GIT_PROBES[0]!)
    const last = itemByName(page, GIT_PROBES[2]!)
    await expect(first).toBeVisible({ timeout: 5000 })
    await expect(last).toBeVisible({ timeout: 5000 })

    // Ctrl 锚定首项，Shift 取范围（三探针按名称排序相邻）
    await first.click({ modifiers: ['Control'] })
    await last.click({ modifiers: ['Shift'] })
    await expect(page.locator('.tree-item.selected')).toHaveCount(3)

    // 右键集合内节点 → 批量形态
    await last.click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.locator('.n-dropdown-menu').getByText('加入 git exclude', { exact: false }).click()

    // 一次确认覆盖整批（非逐项弹窗）
    await expect(page.getByText(/将把 3 项加入 git exclude/)).toBeVisible()
    await page.getByRole('button', { name: '确认' }).click()

    // 服务端 git 状态缓存 3s TTL（status_cache.go gitStatusCacheTTL）：批量
    // addRule 后紧跟的自动刷新命中的是陈旧 ignored 集——等缓存过期后手动点
    // 「刷新（保留目录展开状态）」再断言（与用户实际操作一致）
    await page.waitForTimeout(3500)
    await page.getByRole('button', { name: '刷新（保留目录展开状态）' }).click()

    // 刷新后三个探针命中 check-ignore（--exclude-standard 含 info/exclude），行内出现忽略徽标
    for (const name of GIT_PROBES) {
      await expect(
        itemByName(page, name).locator('.item-ignored-badge'),
      ).toBeVisible({ timeout: 5000 })
    }
  })
})
