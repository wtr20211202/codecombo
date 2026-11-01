import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 文件回收站（P-20261003-304）闭环：删除 → 回收站在列 → 恢复 → 文件回来
// 内容一致 + API 面（恢复目标已存在 409 / 彻底删 / 条目不存在 404）+
// 批量恢复/批量彻底删（P-20261005-175：全选一次操作、409 跳过计数回告、
// 单次确认清点）。探针建在 simple-coding 仓库 docs/ 下，名带 worker/repeat
// 唯一后缀（file-history 同款——回收站条目跨用例残留会让列表断言不定，
// 唯一后缀让每轮用例自含）。批量用例依赖「全选 = 恰为本用例探针」，开跑前
// purgeAllTrash 清场。清理链：恢复/删除动作落进回收站的条目在 afterAll
// 按前缀扫列逐条 purge，不留垃圾也不依赖 7 天 TTL。
const PROBE_DIR = 'docs'

interface TrashEntryLike {
  id: string
  path: string
  name: string
  degraded?: boolean
}

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

async function lockToken(): Promise<string> {
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  return (await unlockRes.json()).token || ''
}

async function projectId(): Promise<string> {
  const token = await lockToken()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers: { 'X-Lock-Token': token } })).json()
  const mine = ((list?.data || []) as { id: string; name: string }[]).find(p => p.name === 'simple-coding')
  if (!mine) throw new Error('simple-coding 项目不存在')
  return mine.id
}

async function apiFile(pid: string, action: 'create' | 'delete', path: string, content = '') {
  const token = await lockToken()
  await fetch(`${API_BASE}/api/projects/${pid}/file/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path, content }),
  }).catch(() => {})
}

async function apiRead(pid: string, path: string): Promise<string> {
  const token = await lockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/file?path=${encodeURIComponent(path)}`, {
    headers: { 'X-Lock-Token': token },
  })
  const body = await res.json()
  return typeof body?.data === 'string' ? body.data : ''
}

async function apiTrashList(pid: string): Promise<TrashEntryLike[]> {
  const token = await lockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/trash`, { headers: { 'X-Lock-Token': token } })
  const body = await res.json()
  return Array.isArray(body?.data) ? body.data : []
}

async function apiTrashRestore(pid: string, entryId: string): Promise<number> {
  const token = await lockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/trash/${encodeURIComponent(entryId)}/restore`, {
    method: 'POST', headers: { 'X-Lock-Token': token },
  })
  return res.status
}

// as 重命名恢复（P-20261006-15）：返回 status + 结构化 code（穿越名 400 断言面）
async function apiTrashRestoreAs(pid: string, entryId: string, as: string): Promise<{ status: number; code?: string }> {
  const token = await lockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/trash/${encodeURIComponent(entryId)}/restore?as=${encodeURIComponent(as)}`, {
    method: 'POST', headers: { 'X-Lock-Token': token },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, code: body?.code }
}

async function apiTrashPurge(pid: string, entryId: string): Promise<number> {
  const token = await lockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/trash/${encodeURIComponent(entryId)}`, {
    method: 'DELETE', headers: { 'X-Lock-Token': token },
  })
  return res.status
}

async function apiMkdir(pid: string, path: string) {
  const token = await lockToken()
  await fetch(`${API_BASE}/api/projects/${pid}/file/mkdir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path }),
  }).catch(() => {})
}

// 批量用例清场：全选语义要求回收站内恰为本用例探针——开跑前把本实例回收站
// 清空（e2e 实例数据面独享，条目只可能来自本 spec 的前序用例，清空无损）
async function purgeAllTrash(pid: string) {
  for (const e of await apiTrashList(pid)) {
    await apiTrashPurge(pid, e.id).catch(() => {})
  }
}

// 清理：删探针（入站）+ 按名前缀扫回收站逐条彻底删，双清不留残留
async function cleanupProbe(pid: string, rel: string, name: string) {
  await apiFile(pid, 'delete', rel)
  const entries = await apiTrashList(pid)
  for (const e of entries) {
    if (e.path === rel || e.name === name) await apiTrashPurge(pid, e.id).catch(() => {})
  }
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

// 本轮探针名（repeat/复跑唯一）：worker+repeat 维度隔离
function probeName(testInfo: { workerIndex: number; repeatEachIndex: number }, tag: string): string {
  return `e2e-trash-${tag}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}.md`
}

test('UI 闭环：删除 → 回收站在列 → 恢复 → 文件回来内容一致', async ({ page: p }, testInfo) => {
  const pid = await projectId()
  const name = probeName(testInfo, 'ui')
  const rel = `${PROBE_DIR}/${name}`
  const marker = `trash-ui-marker-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`
  await cleanupProbe(pid, rel, name)
  await apiFile(pid, 'create', rel, `${marker}\n`)

  await enterProject(p)
  const probe = await revealProbe(p, name)

  // 右键删除 → 确认弹窗（决策面含回收站可恢复提示，P-20261005-155 断言面）→ 树中消失
  await probe.click({ button: 'right' })
  const menu = p.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  await menu.getByText('删除', { exact: true }).click()
  await expect(p.getByText('可从回收站在 7 天内恢复')).toBeVisible()
  await p.getByRole('button', { name: '确认' }).click()
  await expect(itemByName(p, name)).not.toBeVisible()

  // 树头部「回收站」按钮 → 浮层在列（原名 + 原路径 + 剩余天数徽标：刚入站 ceil=7）
  await p.getByTestId('trash-open').click()
  const modal = p.locator('.n-modal.trash-modal')
  await expect(modal).toBeVisible({ timeout: 8000 })
  const item = modal.locator('.trash-item').filter({ hasText: name })
  await expect(item).toBeVisible({ timeout: 8000 })
  await expect(item).toContainText(rel)
  await expect(item.getByTestId('trash-item-days')).toHaveText('剩 7 天')

  // 行内恢复 → 条目出列；文件回原路径且内容一致
  await item.getByTestId('trash-restore').click()
  await expect(item).toHaveCount(0, { timeout: 8000 })
  await p.keyboard.press('Escape')
  await expect(modal).toBeHidden()

  const back = await revealProbe(p, name)
  await expect(back).toBeVisible()
  expect(await apiRead(pid, rel)).toBe(`${marker}\n`)

  // 收尾自清（失败时留给 afterAll 兜底入站清理；磁盘探针唯一后缀不串轮）
  await cleanupProbe(pid, rel, name)
})

test('API 面：恢复目标已存在 409 → 彻底删 → 条目不存在 404', async ({ }, testInfo) => {
  const pid = await projectId()
  const name = probeName(testInfo, 'api')
  const rel = `${PROBE_DIR}/${name}`
  await cleanupProbe(pid, rel, name)
  await apiFile(pid, 'create', rel, 'api-marker\n')
  await apiFile(pid, 'delete', rel)

  const entries = await apiTrashList(pid)
  const mine = entries.find(e => e.path === rel)
  expect(mine, '删除后回收站应在列').toBeTruthy()
  expect(mine!.degraded, '正常入站条目不应是降级态').toBeFalsy()

  // 目标位置已有同名文件（删除后重建）→ 恢复 409，现有内容不被覆盖
  await apiFile(pid, 'create', rel, 'newer-content\n')
  expect(await apiTrashRestore(pid, mine!.id)).toBe(409)
  expect(await apiRead(pid, rel)).toBe('newer-content\n')

  // 清掉占位文件后恢复成功 → 条目出列
  await apiFile(pid, 'delete', rel)
  expect(await apiTrashRestore(pid, mine!.id)).toBe(200)
  expect(await apiRead(pid, rel)).toBe('api-marker\n')
  expect((await apiTrashList(pid)).find(e => e.id === mine!.id)).toBeUndefined()

  // 彻底删后再删同 id → 404
  await apiFile(pid, 'delete', rel)
  const again = (await apiTrashList(pid)).find(e => e.path === rel)
  expect(again).toBeTruthy()
  expect(await apiTrashPurge(pid, again!.id)).toBe(200)
  expect(await apiTrashPurge(pid, again!.id)).toBe(404)
})

test('批量恢复：全选 → 一次恢复 N 项 + 全成功回告 + 内容一致', async ({ page: p }, testInfo) => {
  const pid = await projectId()
  const names = [0, 1, 2].map(i => probeName(testInfo, `batch${i}`))
  await purgeAllTrash(pid)
  for (const [i, name] of names.entries()) {
    await apiFile(pid, 'create', `${PROBE_DIR}/${name}`, `batch-marker-${i}\n`)
    await apiFile(pid, 'delete', `${PROBE_DIR}/${name}`)
  }
  expect((await apiTrashList(pid)).filter(e => names.includes(e.name))).toHaveLength(3)

  await enterProject(p)
  await p.getByTestId('trash-open').click()
  const modal = p.locator('.n-modal.trash-modal')
  await expect(modal).toBeVisible({ timeout: 8000 })
  await expect(modal.getByTestId('trash-item')).toHaveCount(3)

  // 未选中时无批量动作条；全选 → 批量条出现且计数正确
  await expect(modal.getByTestId('trash-batch-bar')).toHaveCount(0)
  await modal.getByTestId('trash-select-all').click()
  const bar = modal.getByTestId('trash-batch-bar')
  await expect(bar).toBeVisible()
  await expect(bar.getByTestId('trash-batch-restore')).toHaveText('恢复 3 项')

  // 一次恢复 → 条目全出列 + 全成功回告（.n-message 按文本过滤定位——裸
  // locator 多 toast 并存时会 strict mode violation）
  await bar.getByTestId('trash-batch-restore').click()
  await expect(p.locator('.n-message').filter({ hasText: '已恢复 3 项' })).toBeVisible()
  await expect(modal.getByTestId('trash-item')).toHaveCount(0, { timeout: 8000 })
  await p.keyboard.press('Escape')
  await expect(modal).toBeHidden()

  // 三个文件回原路径且内容一致
  for (const [i, name] of names.entries()) {
    await expect(await revealProbe(p, name)).toBeVisible()
    expect(await apiRead(pid, `${PROBE_DIR}/${name}`)).toBe(`batch-marker-${i}\n`)
    await cleanupProbe(pid, `${PROBE_DIR}/${name}`, name)
  }
})

test('批量恢复：同名冲突跳过计数（部分成功回告）', async ({ page: p }, testInfo) => {
  const pid = await projectId()
  const nameA = probeName(testInfo, 'batchconf0')
  const nameB = probeName(testInfo, 'batchconf1')
  const relA = `${PROBE_DIR}/${nameA}`
  const relB = `${PROBE_DIR}/${nameB}`
  await purgeAllTrash(pid)
  await apiFile(pid, 'create', relA, 'conflict-a\n')
  await apiFile(pid, 'create', relB, 'conflict-b\n')
  await apiFile(pid, 'delete', relA)
  await apiFile(pid, 'delete', relB)
  // A 的目标位被同名新文件占住 → 批量恢复时 A 409 跳过
  await apiFile(pid, 'create', relA, 'newer-content\n')

  await enterProject(p)
  await p.getByTestId('trash-open').click()
  const modal = p.locator('.n-modal.trash-modal')
  await expect(modal).toBeVisible({ timeout: 8000 })
  await modal.getByTestId('trash-select-all').click()
  await modal.getByTestId('trash-batch-restore').click()

  // 部分成功如实回告（1 恢复 / 1 因同名跳过），不掉队静默
  await expect(p.locator('.n-message').filter({ hasText: '已恢复 1 项，1 项跳过' })).toBeVisible()
  // 跳过条目留在回收站（恰为冲突条 A）；占位文件内容不被覆盖
  await expect(modal.getByTestId('trash-item')).toHaveCount(1)
  await expect(modal.getByTestId('trash-item').first()).toContainText(nameA)
  expect(await apiRead(pid, relA)).toBe('newer-content\n')
  await p.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  await expect(await revealProbe(p, nameB)).toBeVisible()
  expect(await apiRead(pid, relB)).toBe('conflict-b\n')

  // 收尾：清占位文件 + 回收站剩余条目
  await cleanupProbe(pid, relA, nameA)
  await apiFile(pid, 'delete', relB)
})

test('批量彻底删：单次确认清点（文件/目录）→ 选中条目出列', async ({ page: p }, testInfo) => {
  const pid = await projectId()
  const nameA = probeName(testInfo, 'batchpurge0')
  const nameB = probeName(testInfo, 'batchpurge1')
  const dirName = probeName(testInfo, 'batchpurge2').replace(/\.md$/, '.d')
  await purgeAllTrash(pid)
  await apiFile(pid, 'create', `${PROBE_DIR}/${nameA}`, 'purge-a\n')
  await apiFile(pid, 'create', `${PROBE_DIR}/${nameB}`, 'purge-b\n')
  await apiMkdir(pid, `${PROBE_DIR}/${dirName}`)
  await apiFile(pid, 'delete', `${PROBE_DIR}/${nameA}`)
  await apiFile(pid, 'delete', `${PROBE_DIR}/${nameB}`)
  await apiFile(pid, 'delete', `${PROBE_DIR}/${dirName}`)
  expect(await apiTrashList(pid)).toHaveLength(3)

  await enterProject(p)
  await p.getByTestId('trash-open').click()
  const modal = p.locator('.n-modal.trash-modal')
  await expect(modal).toBeVisible({ timeout: 8000 })
  await modal.getByTestId('trash-select-all').click()
  await modal.getByTestId('trash-batch-purge').click()

  // 单次确认弹层列清点（2 文件 + 1 目录），确认一次即整批执行
  await expect(p.getByText('将永久删除选中的 2 个文件、1 个目录')).toBeVisible()
  await p.getByRole('button', { name: '确认' }).click()
  await expect(p.locator('.n-message').filter({ hasText: '已彻底删除 3 项' })).toBeVisible()
  await expect(modal.getByTestId('trash-item')).toHaveCount(0, { timeout: 8000 })
  await expect(modal.locator('.trash-empty')).toBeVisible()
})

test('冲突重命名恢复：409 弹三选 → 恢复为 -restaged 建议名（P-20261006-15）', async ({ page: p }, testInfo) => {
  const pid = await projectId()
  const name = probeName(testInfo, 'conflict')
  const rel = `${PROBE_DIR}/${name}`
  const restaged = name.replace(/\.md$/, '-restaged.md')
  const restagedRel = `${PROBE_DIR}/${restaged}`
  await cleanupProbe(pid, rel, name)
  await cleanupProbe(pid, restagedRel, restaged)
  await apiFile(pid, 'create', rel, 'conflict-marker\n')
  await apiFile(pid, 'delete', rel)
  // 原位置被新文件占住 → 恢复 409 弹三选
  await apiFile(pid, 'create', rel, 'occupy\n')

  await enterProject(p)
  await p.getByTestId('trash-open').click()
  const modal = p.locator('.n-modal.trash-modal')
  await expect(modal).toBeVisible({ timeout: 8000 })
  const item = modal.locator('.trash-item').filter({ hasText: name })
  await expect(item).toBeVisible({ timeout: 8000 })

  await item.getByTestId('trash-restore').click()
  // 三选弹层：内容点名 + 重命名主钮携建议名 + 引用断裂如实注明
  const dialog = p.getByTestId('trash-conflict-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('不会被覆盖')
  await expect(dialog).toContainText('不会跟随更新')
  const renameBtn = p.getByTestId('trash-conflict-rename')
  await expect(renameBtn).toContainText(restaged)
  await renameBtn.click()

  // 一键重命名恢复：新叶子名内容 = 原删除内容，占位文件不被触碰
  await expect(p.locator('.n-message').filter({ hasText: `已恢复为「${restaged}」` })).toBeVisible()
  await expect(modal.getByTestId('trash-item').filter({ hasText: name })).toHaveCount(0, { timeout: 8000 })
  expect(await apiRead(pid, restagedRel)).toBe('conflict-marker\n')
  expect(await apiRead(pid, rel)).toBe('occupy\n')

  await p.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  await cleanupProbe(pid, restagedRel, restaged)
  await cleanupProbe(pid, rel, name)
})

test('API 面：as 穿越名/非法名 400 拒绝（零落盘）+ 合法 as 换名恢复', async ({ }, testInfo) => {
  const pid = await projectId()
  const name = probeName(testInfo, 'guard')
  const rel = `${PROBE_DIR}/${name}`
  await cleanupProbe(pid, rel, name)
  await apiFile(pid, 'create', rel, 'guard-marker\n')
  await apiFile(pid, 'delete', rel)
  const entries = await apiTrashList(pid)
  const mine = entries.find(e => e.path === rel)
  expect(mine, '删除后回收站在列').toBeTruthy()

  // 穿越名（..、分隔符）与 Windows 保留名 → 400 code files.name_invalid
  for (const bad of ['../escape', 'sub/escape', 'a\\b', '..', 'CON.txt']) {
    const r = await apiTrashRestoreAs(pid, mine!.id, bad)
    expect(r.status, `as=${bad} 应 400`).toBe(400)
    expect(r.code, `as=${bad} 应携结构化码`).toBe('files.name_invalid')
  }
  // 零落盘：守卫拒绝不产生任何文件，条目原封在站
  expect(await apiRead(pid, `${PROBE_DIR}/escape`)).toBe('')
  expect((await apiTrashList(pid)).find(e => e.id === mine!.id)).toBeTruthy()

  // 合法 as 换名恢复成功 → 条目出列，内容保真
  const restaged = name.replace(/\.md$/, '-restaged.md')
  expect(await apiTrashRestoreAs(pid, mine!.id, restaged)).toEqual({ status: 200 })
  expect(await apiRead(pid, `${PROBE_DIR}/${restaged}`)).toBe('guard-marker\n')
  expect((await apiTrashList(pid)).find(e => e.id === mine!.id)).toBeUndefined()
  await cleanupProbe(pid, `${PROBE_DIR}/${restaged}`, restaged)
})

test.afterAll(async () => {
  try {
    const pid = await projectId()
    // 按名前缀扫回收站清残留（含 UI 用例恢复后未再删除的磁盘探针）
    for (const tag of ['ui', 'api', 'batch0', 'batch1', 'batch2', 'batchconf', 'batchpurge', 'conflict', 'guard']) {
      const token = await lockToken()
      const list = await (await fetch(`${API_BASE}/api/projects/${pid}/trash`, { headers: { 'X-Lock-Token': token } })).json()
      for (const e of (list?.data || []) as TrashEntryLike[]) {
        if (e.name?.includes(`e2e-trash-${tag}`)) await apiTrashPurge(pid, e.id).catch(() => {})
      }
    }
  } catch { /* 服务未起等场景忽略 */ }
})
