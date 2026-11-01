import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 搜索范围扩展名 chips E2E（P-20261003-148）：
 *   1. 点 .md chip → glob 预填 *.md → 结果仅 md；再点已亮 chip → glob 清空、
 *      全部文件回来（toggle-off 即「不过滤」）
 *   2. 手改 glob 双向联动：手填 *.ts → .ts chip 亮；手填非 chip 形态（packages/**）
 *      → 全灭不猜语义；再点 .go chip → 覆盖手改值预填 *.go（单选语义）
 * 夹具五文件同含关键词 alpha（.md/.ts/.json/.go/.txt），glob 过滤的「仅 md」
 * 断言才有区分度；自备临时仓库，afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-search-ext-chips')
const PROJ = 'e2e-search-ext-chips'
const KEYWORD = 'alpha'

// ext → 文件名：断言「该扩展名 chip 命中且仅命中该文件」
const FIXTURES: Record<string, string> = {
  ts: 'main.ts',
  md: 'README.md',
  json: 'data.json',
  go: 'main.go',
}

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function deleteProjectByName(name: string): Promise<void> {
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === name) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await deleteProjectByName(PROJ)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 不 smudge
  for (const [ext, name] of Object.entries(FIXTURES)) {
    fs.writeFileSync(path.join(REPO_DIR, name), `${KEYWORD} ${ext} file\n`)
  }
  // 控制组：任何 chip 都不覆盖 .txt——「无过滤时 5 文件齐中」由此锚定
  fs.writeFileSync(path.join(REPO_DIR, 'notes.txt'), `${KEYWORD} plain text\n`)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: fixture'])
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  expect(body.data?.id).toBeTruthy()
})

test.afterAll(async () => {
  await deleteProjectByName(PROJ)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 进项目页并打开搜索面板、搜出全部 5 个夹具文件（面板聚焦即查询输入框） */
async function openPanelWithResults(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  const card = page.locator('.ps-card')
  await page.keyboard.press('Control+Shift+f')
  await expect(card).toBeVisible({ timeout: 10000 })
  await card.locator('input').first().fill(KEYWORD)
  // 无过滤：md/ts/json/go/txt 五文件齐中（工具栏轮询重渲染抗性：expect 轮询自带重试）
  await expect(card.locator('.ps-file-header')).toHaveCount(5, { timeout: 30000 })
  // 搜索落地即入查询历史 → 历史下拉弹出（P-48 交互）。P-20261006-32 起下拉改锚
  // 头部件下缘、不再盖选项 chips，此处 Esc 分层收起（先收下拉不关面板）照旧保留
  // 作双保险——chip 点击断言与下拉遮挡状态解耦，布局回退也不至连红
  if (await card.locator('.ps-history').isVisible()) {
    await page.keyboard.press('Escape')
  }
  await expect(card.locator('.ps-history')).toBeHidden()
  return card
}

test('点 .md chip → glob 预填 *.md → 结果仅 md；再点已亮 chip 清空过滤全量回来', async ({ page }) => {
  const card = await openPanelWithResults(page)
  const mdChip = card.locator('[data-testid="ps-ext-chip-md"]')

  await mdChip.click()
  // 预填契约：glob 精确等值 *.md；chip 点亮（aria-pressed）
  await expect(card.locator('.ps-glob input')).toHaveValue('*.md')
  await expect(mdChip).toHaveClass(/is-active/)
  // 结果仅 README.md：其余 4 文件（含 .txt 控制组）被 glob 排除
  await expect(card.locator('.ps-file-header')).toHaveCount(1, { timeout: 30000 })
  await expect(card.locator('.ps-file-path').filter({ hasText: 'README.md' })).toBeVisible()
  await expect(card.locator('.ps-file-path').filter({ hasText: 'main.ts' })).toHaveCount(0)
  await expect(card.locator('.ps-file-path').filter({ hasText: 'notes.txt' })).toHaveCount(0)

  // 再点已亮 chip = 清除过滤：glob 归空、五文件全回来
  await mdChip.click()
  await expect(card.locator('.ps-glob input')).toHaveValue('')
  await expect(mdChip).not.toHaveClass(/is-active/)
  await expect(card.locator('.ps-file-header')).toHaveCount(5, { timeout: 30000 })
})

test('手改 glob 双向联动：手填 *.ts 点亮 .ts；非 chip 形态全灭；点 .go 覆盖手改值', async ({ page }) => {
  const card = await openPanelWithResults(page)
  const globInput = card.locator('.ps-glob input')

  // 手填（不经 chip）→ 对应 chip 点亮：读方向联动
  await globInput.fill('*.ts')
  await expect(card.locator('[data-testid="ps-ext-chip-ts"]')).toHaveClass(/is-active/, { timeout: 5000 })
  await expect(card.locator('.ps-file-header')).toHaveCount(1, { timeout: 30000 })
  await expect(card.locator('.ps-file-path').filter({ hasText: 'main.ts' })).toBeVisible()

  // 手填非 chip 形态（目录 glob）→ 全部熄灭（不猜语义，glob 框是自定义兜底）
  await globInput.fill('**/*')
  for (const ext of Object.keys(FIXTURES)) {
    await expect(card.locator(`[data-testid="ps-ext-chip-${ext}"]`)).not.toHaveClass(/is-active/)
  }

  // 单选覆盖：点 .go chip 直接换预填 *.go（覆盖手改值），结果仅 main.go
  await card.locator('[data-testid="ps-ext-chip-go"]').click()
  await expect(globInput).toHaveValue('*.go')
  await expect(card.locator('.ps-file-header')).toHaveCount(1, { timeout: 30000 })
  await expect(card.locator('.ps-file-path').filter({ hasText: 'main.go' })).toBeVisible()
  await expect(card.locator('.ps-file-path').filter({ hasText: 'main.ts' })).toHaveCount(0)
})
