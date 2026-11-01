import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 文件树多选批量移动（P-20261003-160）：多选拖拽到目录节点逐个 renameFile、
// 重名（P-117 目标防护 409）逐个跳过报告不中断批次、右键「移动到…」目录
// 选择弹层、单文件拖放既有语义不回归。
//
// 探针宿主与 file-tree-multi-select 同款：simple-coding 仓库 docs/ 下纯文件
// 操作无 git 语义依赖。探针集中在新播种子目录 docs/e2e-move-src（移入目标
// docs/e2e-move-dest）——docs 层级只多出两行，探针不挤占根视图虚拟窗口。
// 拖放以 dispatchEvent + 共享 DataTransfer 模拟（editor-tab-cross-drag 同款
// 手法：dragstart 打在源行真实 handler 上携带载荷，dragover/drop 打在目标行）。
const PROBE_DIR = 'docs'
const SRC = `${PROBE_DIR}/e2e-move-src`
const DEST = `${PROBE_DIR}/e2e-move-dest`
const DRAG_PROBES = ['e2e-move-a.md', 'e2e-move-b.md', 'e2e-move-c.md']
const DUP_NAME = 'e2e-move-dup.md'
const SOLO_NAME = 'e2e-move-solo.md'
const DIALOG_PROBES = ['e2e-move-d1.md', 'e2e-move-d2.md']
const SINGLE_NAME = 'e2e-move-single.md'
const ALL_PROBES = [...DRAG_PROBES, DUP_NAME, SOLO_NAME, ...DIALOG_PROBES, SINGLE_NAME]

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

/** 虚拟列表行进 DOM 保证：窗口外的行根本不渲染——先直接命中，未命中自顶
 *  逐步进滚动（docs 层目标在树上部，归位顶部即现；src 深层子项继续步进） */
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

/** 逐级展开 docs → src 直到探针可见；
 *  探针行若只是被虚拟窗口裁掉，由 ensureRowVisible 步进滚动补位 */
async function revealProbe(page: Page, name: string) {
  await expandDir(page, 'docs')
  await expandDir(page, 'e2e-move-src')
  await ensureRowVisible(page, name)
  return itemByName(page, name)
}

/** 派发完整行拖放序列：dragstart 打在源行（真实 handler 记录多选/锚点）→
 *  dragover/drop 打在目标目录行 → dragend 收尾 */
async function dragRowTo(
  page: Page,
  src: ReturnType<Page['locator']>,
  dst: ReturnType<Page['locator']>,
) {
  const srcEl = await src.elementHandle()
  const dstEl = await dst.elementHandle()
  await page.evaluate(([s, d]) => {
    const dt = new DataTransfer()
    s!.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    s!.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, [srcEl, dstEl])
}

test.beforeAll(async () => {
  const pid = await projectId('simple-coding')
  // 源/目标目录整树重置（上一轮残留会让重名/移动断言翻车），再播种本轮探针
  await apiFile(pid, 'delete', SRC)
  await apiFile(pid, 'delete', DEST)
  await apiFile(pid, 'mkdir', SRC)
  await apiFile(pid, 'mkdir', DEST)
  for (const p of ALL_PROBES) {
    await apiFile(pid, 'delete', `${SRC}/${p}`)
    await apiFile(pid, 'create', `${SRC}/${p}`)
  }
  // 重名跳过用例的目标侧同名文件
  await apiFile(pid, 'create', `${DEST}/${DUP_NAME}`)
})

test.afterAll(async () => {
  try {
    const pid = await projectId('simple-coding')
    await apiFile(pid, 'delete', SRC)
    await apiFile(pid, 'delete', DEST)
  } catch { /* 服务未起等场景忽略 */ }
})

test.describe('文件树多选批量移动', () => {
  test('多选 3 文件拖到目录节点 → 全部移动', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const probes = []
    for (const name of DRAG_PROBES) probes.push(await revealProbe(page, name))

    // Ctrl+Click 逐个加入多选
    for (const probe of probes) await probe.click({ modifiers: ['Control'] })
    await expect(page.locator('.tree-item.selected')).toHaveCount(3)

    // 拖锚点行到目标目录行：批量逐个 rename（目标目录在 docs 层级，先归位可见）
    await ensureRowVisible(page, 'e2e-move-dest')
    await dragRowTo(page, probes[0]!, itemByName(page, 'e2e-move-dest'))

    await expect(page.getByText(`已移动 3 项到 ${DEST}`)).toBeVisible({ timeout: 5000 })
    // src 内三个探针全部消失；展开目标目录可见全部移入
    for (const name of DRAG_PROBES) {
      await expect(itemName(page, name)).toHaveCount(0, { timeout: 5000 })
    }
    await ensureRowVisible(page, 'e2e-move-dest')
    await itemByName(page, 'e2e-move-dest').click()
    for (const name of DRAG_PROBES) {
      await ensureRowVisible(page, name)
      await expect(itemByName(page, name)).toBeVisible()
    }
    // 批量完成后多选清空
    await expect(page.locator('.tree-item.selected')).toHaveCount(0)
  })

  test('重名逐个跳过报告不中断批次', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const dup = await revealProbe(page, DUP_NAME)
    const solo = await revealProbe(page, SOLO_NAME)
    await dup.click({ modifiers: ['Control'] })
    await solo.click({ modifiers: ['Control'] })
    await expect(page.locator('.tree-item.selected')).toHaveCount(2)

    await ensureRowVisible(page, 'e2e-move-dest')
    await dragRowTo(page, solo, itemByName(page, 'e2e-move-dest'))

    // P-117 目标防护（409 file already exists）：重名项跳过并逐个报告，批次不中断
    await expect(page.getByText(/已移动 1 项到 .*，跳过 1 项：e2e-move-dup\.md（目标已存在同名）/))
      .toBeVisible({ timeout: 5000 })
    // 目标目录收起态：dup 仍在 src（count 1）、solo 已移入 dest（不可见 = count 0）
    await expect(itemName(page, DUP_NAME)).toHaveCount(1, { timeout: 5000 })
    await expect(itemName(page, SOLO_NAME)).toHaveCount(0)
  })

  test('右键「移动到…」弹层选择目录 → 批量移动', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const probes = []
    for (const name of DIALOG_PROBES) probes.push(await revealProbe(page, name))
    for (const probe of probes) await probe.click({ modifiers: ['Control'] })
    await expect(page.locator('.tree-item.selected')).toHaveCount(2)

    // 右键集合内节点 → 批量菜单「移动到…」
    await probes[1]!.click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.locator('.n-dropdown-menu').getByText('移动到…（2 项）', { exact: true }).click()

    // 弹层列目录清单 → 点选目标目录 → 确认（清单派生自 Quick Open 全量文件
    // 清单，e2e 宿主含 .e2e-data 回收站等同名子串目录——按整径锚定目标行）
    const modal = page.locator('[data-testid="move-to-modal"]')
    await expect(modal).toBeVisible()
    const destRow = modal.locator('[data-testid="move-to-dir"]').filter({
      has: page.locator('.move-to-dir-path', { hasText: new RegExp(`^${DEST.replace(/\//g, '\\/')}$`) }),
    })
    await expect(destRow).toBeVisible({ timeout: 10000 })
    await destRow.click()
    await modal.locator('[data-testid="move-to-confirm"]').click()

    await expect(page.getByText(`已移动 2 项到 ${DEST}`)).toBeVisible({ timeout: 5000 })
    for (const name of DIALOG_PROBES) {
      await expect(itemName(page, name)).toHaveCount(0, { timeout: 5000 })
    }
  })

  test('单文件拖放到目录：既有语义不回归', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const single = await revealProbe(page, SINGLE_NAME)
    // 不做多选直接拖：走单文件 movedTo 分支（目标目录局部刷新 + movedTo toast）
    await ensureRowVisible(page, 'e2e-move-dest')
    await dragRowTo(page, single, itemByName(page, 'e2e-move-dest'))

    await expect(page.getByText(`${DEST}/${SINGLE_NAME}`)).toBeVisible({ timeout: 5000 })
    await expect(itemName(page, SINGLE_NAME)).toHaveCount(0, { timeout: 5000 })
  })
})
