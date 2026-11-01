import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 回收站敏感条目标记（P-20261005-163）UI 闭环：删 .env 系文件 → 入站 toast
// 敏感变体（含「立即彻底删」动作）→ 点动作直达回收站 → 条目带「敏感」徽标 +
// 驻留提示行 + 前置快捷彻底删钮 → 确认弹层 → 条目消失。探针名以 .env 前缀
// 命中敏感模式表（sensitivePatterns 前缀 glob 语义），docs/ 下建 unique 后缀
// 探针（file-trash 同款自含清理：beforeAll 清残留 + afterAll 按名前缀扫列
// 逐条 purge，不依赖 7 天 TTL）。
const PROBE_DIR = 'docs'

interface TrashEntryLike {
  id: string
  path: string
  name: string
}

function probeName(testInfo: { workerIndex: number; repeatEachIndex: number }): string {
  // 必须以 .env 开头才命中「.env*」模式（后缀式 .env.x 不行——glob 是前缀锚定）
  return `.env.e2e-trash-sens-${testInfo.workerIndex}-${testInfo.repeatEachIndex}`
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

async function apiTrashList(pid: string): Promise<TrashEntryLike[]> {
  const token = await lockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/trash`, { headers: { 'X-Lock-Token': token } })
  const body = await res.json()
  return Array.isArray(body?.data) ? body.data : []
}

async function apiTrashPurge(pid: string, entryId: string): Promise<number> {
  const token = await lockToken()
  const res = await fetch(`${API_BASE}/api/projects/${pid}/trash/${encodeURIComponent(entryId)}`, {
    method: 'DELETE', headers: { 'X-Lock-Token': token },
  })
  return res.status
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

// 探针是 .env 前缀 dotfile：树默认不渲染隐藏文件（FileTreeView filterHidden），
// 先开「显示隐藏文件」（title 即开关文案，开态切换为「隐藏隐藏文件」故幂等）
async function showHiddenFiles(page: Page) {
  const eyeBtn = page.locator('.tree-action-btn[title="显示隐藏文件"]')
  for (let i = 0; i < 3; i++) {
    if (!await eyeBtn.isVisible().catch(() => false)) return
    await eyeBtn.click()
    await page.waitForTimeout(800)
  }
}

// 反复收起/展开 docs 直到探针可见（展开态竞态，file-trash 同款）
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

test('敏感删除闭环：toast 变体带动作 → 回收站徽标/提示/快捷彻底删 → 确认 → 条目消失', async ({ page: p }, testInfo) => {
  const pid = await projectId()
  const name = probeName(testInfo)
  const rel = `${PROBE_DIR}/${name}`
  // 清残留：磁盘探针 + 回收站同名条目（复跑自含）
  await apiFile(pid, 'delete', rel)
  for (const e of await apiTrashList(pid)) {
    if (e.path === rel || e.name === name) await apiTrashPurge(pid, e.id).catch(() => {})
  }
  await apiFile(pid, 'create', rel, 'E2E_SENSITIVE_MARK=1\n')

  await enterProject(p)
  await showHiddenFiles(p)
  const probe = await revealProbe(p, name)

  // 右键删除 → 既有确认弹窗 → 树中消失
  await probe.click({ button: 'right' })
  const menu = p.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  await menu.getByText('删除', { exact: true }).click()
  await expect(p.getByText('可从回收站在 7 天内恢复')).toBeVisible()
  await p.getByRole('button', { name: '确认' }).click()
  await expect(itemByName(p, name)).not.toBeVisible()

  // 入站 toast 敏感变体：变体文案 + 「立即彻底删」动作（普通删除是 plain toast）
  const toast = p.locator('.n-message').filter({ hasText: '已移入回收站——敏感内容将驻留 7 天' })
  await expect(toast).toBeVisible()

  // 点动作直达回收站浮层（不逐跳找树头部按钮）
  await toast.getByTestId('delete-sensitive-open-trash').click()
  const modal = p.locator('.n-modal.trash-modal')
  await expect(modal).toBeVisible({ timeout: 8000 })

  // 条目带「敏感」徽标 + 行内驻留提示 + 剩余天数；敏感行是前置实心快捷彻底删
  // （常规 ghost 彻底删在敏感行隐去——同一动作不一行双钮）
  const item = modal.locator('.trash-item').filter({ hasText: name })
  await expect(item).toBeVisible({ timeout: 8000 })
  await expect(item.getByTestId('trash-item-sensitive')).toHaveText('敏感')
  await expect(item).toContainText('敏感文件：恢复窗口内明文驻留数据目录')
  await expect(item.getByTestId('trash-item-days')).toHaveText('剩 7 天')
  await expect(item.getByTestId('trash-purge')).toHaveCount(0)

  // 快捷彻底删 → 沿既有确认文案 → 确认后条目出列
  await item.getByTestId('trash-purge-urgent').click()
  await expect(p.getByText('将被永久删除，此操作不可恢复')).toBeVisible()
  await p.getByRole('button', { name: '确认' }).click()
  await expect(p.locator('.n-message').filter({ hasText: `已彻底删除「${name}」` })).toBeVisible()
  await expect(modal.locator('.trash-item').filter({ hasText: name })).toHaveCount(0, { timeout: 8000 })

  await p.keyboard.press('Escape')
  await expect(modal).toBeHidden()
})

test.afterAll(async () => {
  try {
    const pid = await projectId()
    const rel = `${PROBE_DIR}/.env.e2e-trash-sens-`
    for (const e of await apiTrashList(pid)) {
      if (e.path?.startsWith(rel)) await apiTrashPurge(pid, e.id).catch(() => {})
    }
    // 失败兜底清磁盘探针（worker×repeat 全组合覆盖，不存在路径静默忽略）
    for (let w = 0; w < 4; w++) {
      for (let r = 0; r < 2; r++) {
        await apiFile(pid, 'delete', `${PROBE_DIR}/.env.e2e-trash-sens-${w}-${r}`)
      }
    }
  } catch { /* 服务未起等场景忽略 */ }
})
