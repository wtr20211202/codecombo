import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 本地文件历史（P-20261002-130）：写路径快照 → 历史弹窗（列表/diff/恢复）闭环。
//   1. 同一文件写 3 次 → 弹窗列 2 个旧版（首建不留档，当前盘上内容不入档）
//   2. diff 两侧正确（左 = 所选历史版，右 = 当前盘上内容）
//   3. 「恢复此版本」带确认 → 磁盘内容回滚且恢复前状态自动入档（可再撤销）
//   4. 无历史文件呈现空态；取消确认不落盘
// 探针建在 simple-coding 仓库 docs/ 下（未被 gitignore，默认可见）。探针名带
// 运行唯一后缀：快照按「项目+相对路径」独立于文件存在持久（删除文件不清史，
// 项目删除才级联清理）——固定探针名在 --repeat-each/复跑时会撞上一轮残留的
// 历史列表，唯一后缀让每轮用例自含（播种与清理都在用例体内）。
const PROBE_DIR = 'docs'

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

// 直写探针内容（PUT /file 走生产写路径——快照钩子在该链路上）
async function apiWrite(pid: string, path: string, content: string) {
  const token = await lockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path, content }),
  })
  if (!res.ok) throw new Error(`write ${path}: ${res.status}`)
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

async function apiHistoryCount(pid: string, path: string): Promise<number> {
  const token = await lockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/file/history?path=${encodeURIComponent(path)}`, {
    headers: { 'X-Lock-Token': token },
  })
  const body = await res.json()
  return Array.isArray(body?.data) ? body.data.length : -1
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

async function openLocalHistory(page: Page, probe: ReturnType<Page['locator']>) {
  await probe.click({ button: 'right' })
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  await menu.getByText('本地历史', { exact: true }).click()
  await expect(page.locator('.n-modal.local-history-modal')).toBeVisible({ timeout: 8000 })
}

// 本轮探针名（repeat/复跑唯一）：worker+repeat 维度隔离，同轮内两用例用不同 tag
function probeName(testInfo: { repeatEachIndex: number; workerIndex: number }, tag: string): string {
  return `e2e-fh-${tag}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}.md`
}

test('写 3 次 → 列表 2 旧版 → diff 两侧正确 → 恢复回滚且恢复前状态入档', async ({ page: p }, testInfo) => {
  const pid = await projectId()
  const name = probeName(testInfo, 'a')
  const rel = `${PROBE_DIR}/${name}`

  // 播种 + 写 3 次：首建（无旧内容不留档）→ v2 → v3，快照层应留 v1/v2 两旧版
  await apiFile(pid, 'delete', rel)
  await apiFile(pid, 'create', rel, 'fh-a-v1-marker\nshared tail\n')
  try {
    await apiWrite(pid, rel, 'fh-a-v2-marker\nshared tail\n')
    await apiWrite(pid, rel, 'fh-a-v3-marker\nshared tail\n')
    expect(await apiHistoryCount(pid, rel)).toBe(2)

    await enterProject(p)
    const probe = await revealProbe(p, name)

    // 右键「本地历史」→ 弹窗列出 2 个旧版
    await openLocalHistory(p, probe)
    const modal = p.locator('.n-modal.local-history-modal')
    await expect(modal.locator('.lhm-version-item')).toHaveCount(2)

    // diff：左（original）= 默认选中的最新历史版 v2，右（modified）= 当前盘上 v3
    await expect(p.locator('.monaco-diff-editor .editor.original .view-lines')).toContainText('fh-a-v2-marker', { timeout: 8000 })
    await expect(p.locator('.monaco-diff-editor .editor.modified .view-lines')).toContainText('fh-a-v3-marker', { timeout: 8000 })

    // 恢复最旧版（选第 2 行 = v1）→ 确认弹窗 → 磁盘回滚
    await modal.locator('.lhm-version-item').nth(1).click()
    await expect(p.locator('.monaco-diff-editor .editor.original .view-lines')).toContainText('fh-a-v1-marker', { timeout: 8000 })
    await p.getByTestId('lh-restore').click()
    await p.getByRole('button', { name: '确认' }).click()

    // 磁盘内容回滚为 v1；恢复前状态（v3）自动入档 → 列表变 3 版
    await expect(modal.locator('.lhm-version-item')).toHaveCount(3, { timeout: 8000 })
    expect(await apiRead(pid, rel)).toBe('fh-a-v1-marker\nshared tail\n')
    expect(await apiHistoryCount(pid, rel)).toBe(3)
  } finally {
    await apiFile(pid, 'delete', rel)
  }
})

test('无历史空态；恢复取消不落盘', async ({ page: p }, testInfo) => {
  const pid = await projectId()
  const name = probeName(testInfo, 'b')
  const rel = `${PROBE_DIR}/${name}`

  // 播种：仅首建（1 次写，无旧内容可保）→ 弹窗空态
  await apiFile(pid, 'delete', rel)
  await apiFile(pid, 'create', rel, 'fh-b-v1-marker\n')
  try {
    await enterProject(p)
    const probe = await revealProbe(p, name)

    await openLocalHistory(p, probe)
    const modal = p.locator('.n-modal.local-history-modal')
    await expect(modal.getByText('暂无本地历史——文件被覆盖保存/重命名时自动留档')).toBeVisible()

    // 关闭弹窗，覆盖一次（快照层留首建内容 1 版）→ 重开可见
    await p.keyboard.press('Escape')
    await apiWrite(pid, rel, 'fh-b-v2-marker\n')
    await expect(modal).toBeHidden()
    await probe.click({ button: 'right' })
    const menu = p.locator('.n-dropdown-menu')
    await expect(menu).toBeVisible()
    await menu.getByText('本地历史', { exact: true }).click()
    await expect(modal.locator('.lhm-version-item')).toHaveCount(1, { timeout: 8000 })

    // 恢复走取消：磁盘内容不被改写
    await p.getByTestId('lh-restore').click()
    await p.getByRole('button', { name: '取消' }).click()
    expect(await apiRead(pid, rel)).toBe('fh-b-v2-marker\n')
    expect(await apiHistoryCount(pid, rel)).toBe(1)
  } finally {
    await apiFile(pid, 'delete', rel)
  }
})
