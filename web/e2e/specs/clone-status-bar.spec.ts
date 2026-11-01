import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 克隆常驻状态条 E2E（P-20261003-58）：首页顶部细指示条展示进行中克隆任务——
 * 开克隆 → 关对话框 → 状态条条目出现且阶段/百分比更新 → 点击重开 CloneModal
 * 进度视图（CloneProgressWS 按 taskId 幂等重连）→ 完成后条目消失。
 * 多任务并列：第一个克隆运行中重开添加弹窗（跟踪转孤儿但条目保留）再启动
 * 第二个 → 两条目并列展示，各自完成后逐个消失。
 *
 * 数据面：源仓库为随机字节大提交体（不可压缩，file:// 克隆也拉长到十秒级窗口
 * 供 UI 断言）；克隆出的项目按前缀在 afterAll 统一清理，两用例各用独立目录
 * （克隆目标已存在非空会被预检 400，不能复用）。
 */

const SRC_DIR = path.join(os.tmpdir(), 'sc-e2e-clone-bar-src')
const CLONE_DIRS = [
  path.join(os.tmpdir(), 'sc-e2e-clone-bar-dst-1a'),
  path.join(os.tmpdir(), 'sc-e2e-clone-bar-dst-1b'),
  path.join(os.tmpdir(), 'sc-e2e-clone-bar-dst-2a'),
  path.join(os.tmpdir(), 'sc-e2e-clone-bar-dst-2b'),
]
const PROJ_PREFIX = 'e2e-clone-bar'

// 大提交体克隆全程超出 30s 默认用例超时（夹具构建 + 排队 + 传输 + 检出）
test.setTimeout(240_000)

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
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

async function deleteProjectsByPrefix(prefix: string) {
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as Array<{ id: string; name: string }>)) {
    if (p.name.startsWith(prefix)) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
}

test.beforeAll(async () => {
  await deleteProjectsByPrefix(PROJ_PREFIX)
  for (const dir of [SRC_DIR, ...CLONE_DIRS]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  // 源仓库：随机字节大提交体（不可压缩），克隆传输窗口拉长到十秒级供 UI 断言
  fs.mkdirSync(SRC_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: SRC_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: SRC_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: SRC_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: SRC_DIR })
  for (let i = 0; i < 8; i++) {
    fs.writeFileSync(path.join(SRC_DIR, `blob-${i}.bin`), crypto.randomBytes(6 * 1024 * 1024))
    git(SRC_DIR, ['add', '.'])
    git(SRC_DIR, ['commit', '-m', `c${i}`])
  }
})

test.afterAll(async () => {
  await deleteProjectsByPrefix(PROJ_PREFIX)
  for (const dir of [SRC_DIR, ...CLONE_DIRS]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
})

// 首页添加弹窗克隆签发：填表 → 提交 → 断言弹窗内进入克隆运行态（进度日志区出现）
async function startCloneViaAddDialog(page: Page, name: string, destDir: string) {
  await page.locator('.home-header').getByRole('button', { name: '添加项目' }).click()
  const dialog = page.locator('.n-modal').filter({ hasText: '添加项目' })
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await dialog.locator('.n-tabs-tab').filter({ hasText: '从 Git 克隆' }).click()
  await dialog.locator('input[placeholder*="https://github.com"]').fill(`file:///${serverPath(SRC_DIR).replace(/\\/g, '/')}`)
  await dialog.locator('input[placeholder*="克隆到哪个目录"]').fill(serverPath(destDir))
  await dialog.locator('input[placeholder*="留空自动从路径推断"]').fill(name)
  await dialog.locator('.n-dialog__action button').filter({ hasText: '添加项目' }).click()
  // 弹窗内克隆运行态：进度日志区替换表单（提交被接住、任务已受理）
  await expect(dialog.locator('.clone-log-area')).toBeVisible({ timeout: 10000 })
  return dialog
}

// 关闭添加弹窗（克隆转后台）：必须点 footer 动作区的「取消」——运行态内容区
// 也有同文案的取消克隆按钮（真取消任务），作用域区分
async function closeAddDialog(dialog: ReturnType<Page['locator']>) {
  await dialog.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
}

test('单任务：开克隆 → 关对话框 → 状态条出现且更新 → 点击重开进度视图 → 完成消失', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const name = `${PROJ_PREFIX}-1a`

  const dialog = await startCloneViaAddDialog(page, name, CLONE_DIRS[0]!)

  // 关对话框转后台：任务不受影响（弹窗运行态仍可关）
  await closeAddDialog(dialog)

  // 常驻状态条：条目出现（项目名 + 百分比随 WS 更新）
  const item = page.locator('[data-testid="clone-status-item"]')
  await expect(item).toBeVisible({ timeout: 10000 })
  await expect(item).toContainText(name)
  await expect(item).toContainText(/%$/)

  // 点击条目 → 重开 CloneModal 进度视图（按 taskId 幂等重连，快照补发）
  await item.click()
  const cloneModal = page.locator('.n-modal').filter({ hasText: '克隆远程仓库' })
  await expect(cloneModal).toBeVisible({ timeout: 5000 })
  await expect(cloneModal.locator('.clone-running')).toBeVisible()

  // 完成即条目移除（完成 toast 已有，不重复断言）；附加进度视图随终态收尾关闭
  await expect(item).toHaveCount(0, { timeout: 120000 })
  await expect(cloneModal).toBeHidden({ timeout: 10000 })

  // 克隆成功联动：项目注册进列表（卡片出现）
  await expect(page.locator('.home-grid').getByText(name)).toBeVisible({ timeout: 15000 })
})

test('多任务并列：首克隆运行中重开弹窗再启第二个，两条目并列、逐个消失', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const nameA = `${PROJ_PREFIX}-2a`
  const nameB = `${PROJ_PREFIX}-2b`

  await startCloneViaAddDialog(page, nameA, CLONE_DIRS[2]!)
  // 关弹窗（任务 A 转后台，状态条接棒）
  const dialog = page.locator('.n-modal').filter({ hasText: '添加项目' })
  await closeAddDialog(dialog)
  await expect(page.locator('[data-testid="clone-status-item"]')).toBeVisible({ timeout: 10000 })

  // 重开添加弹窗再启动第二个克隆：重开重置表单跟踪（孤儿转交状态条），
  // 条目 A 保留、条目 B 新增
  await startCloneViaAddDialog(page, nameB, CLONE_DIRS[3]!)
  const items = page.locator('[data-testid="clone-status-item"]')
  await expect(items.filter({ hasText: nameB })).toBeVisible({ timeout: 10000 })
  // 两条目并列展示（多任务同屏；窗口内轮询等待同帧态）
  await expect(async () => {
    expect(await items.count()).toBe(2)
  }).toPass({ timeout: 10000 })

  // 关掉第二个弹窗，两个任务各自完成后条目逐个消失
  await closeAddDialog(dialog)
  await expect(items).toHaveCount(0, { timeout: 180000 })
  await expect(page.locator('.home-grid').getByText(nameA)).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.home-grid').getByText(nameB)).toBeVisible({ timeout: 15000 })
})
