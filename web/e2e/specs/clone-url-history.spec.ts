import { test, expect, type Page, type Locator } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 克隆 URL 历史（P-20261003-251）：换目录/重试再克隆同仓库不重打 URL。
 *   - 真实克隆一次 → 重开对话框聚焦 URL 输入框 → 历史下拉出现该 URL
 *   - 点选回填：URL 填入并走失焦同一条推断链（名称自动推断）
 *   - 含凭据 URL（https://user:pass@ 形态）提交不入历史（明文密钥不落
 *     localStorage）——同路径下非凭据 URL 照常入史作对照
 *   - 下拉尾部「清空历史」：持久层 + 内存态同清，再聚焦不再出现
 * 数据面断言直接读 localStorage `clone-url-history`（recordUrl 提交时写入，
 * 克隆成败不影响——搜索「发起时记录」同惯例）。凭据/非凭据对照 URL 均指向
 * .invalid 保留 TLD（DNS 快速失败、零外网依赖）。真实克隆源为本地 file:// 夹具
 * （clone-status-bar / clone-cancel 同款）。历史存 localStorage，每用例独立
 * context 天然隔离。
 */

const PROJ_PREFIX = 'e2e-url-history'
const SRC_DIR = path.join(os.tmpdir(), 'sc-e2e-url-history-src')
const DST_DIR = path.join(os.tmpdir(), 'sc-e2e-url-history-dst')
// 凭据/对照克隆的目标目录（DST_DIR 变体）：克隆失败的残留目录会让下一轮提交
// 被服务端「目标已存在非空」预检同步拒绝（无任务创建 → 运行态禁用窗口从未
// 出现，fulle2e run6/run7 实测），前后清理必须覆盖
const DST_CRED_DIR = `${DST_DIR}-cred`
const DST_PLAIN_DIR = `${DST_DIR}-plain`
const CLONE_DST_DIRS = [DST_DIR, DST_CRED_DIR, DST_PLAIN_DIR]
const CRED_URL = 'https://e2e-user:e2e-pass@no-such-host-sc.invalid/repo.git'
const PLAIN_URL = 'https://no-such-host-sc.invalid/other.git'

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

test.beforeAll(async () => {
  // 源仓库夹具：单提交小仓（真实克隆走 file:// 源）
  fs.rmSync(SRC_DIR, { recursive: true, force: true })
  for (const dir of CLONE_DST_DIRS) fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(SRC_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: SRC_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: SRC_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: SRC_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: SRC_DIR })
  fs.writeFileSync(path.join(SRC_DIR, 'README.md'), 'clone url history fixture\n')
  git(SRC_DIR, ['add', '.'])
  git(SRC_DIR, ['commit', '-m', 'init'])
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name.startsWith(PROJ_PREFIX)) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of CLONE_DST_DIRS) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
})

/** 打开「添加项目」弹窗并切到克隆 tab（clone-prefs-memory 同款入口） */
async function openCloneTab(page: Page): Promise<Locator> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.getByRole('button', { name: '添加项目' }).first().click()
  const modal = page.locator('.n-modal').filter({ hasText: '添加项目' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  await modal.locator('.n-tabs-tab').filter({ hasText: '从 Git 克隆' }).click()
  return modal
}

async function storedHistory(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem('clone-url-history'))
}

test('真实克隆一次 → 重开聚焦出历史下拉 → 回填 → 清空入口', async ({ page }) => {
  const url = `file:///${serverPath(SRC_DIR).replace(/\\/g, '/')}`
  const modal = await openCloneTab(page)

  // URL 失焦链：填目录时顺带触发名称/凭据预检（回填推断链的对照基准）
  await modal.locator('input[placeholder*="https://github.com"]').fill(url)
  await modal.locator('input[placeholder*="克隆到哪个目录"]').fill(serverPath(DST_DIR))
  await modal.locator('.n-dialog__action button').filter({ hasText: '添加项目' }).click()

  // 克隆成功：弹窗自动关闭 + 项目注册（提交时已入史）
  await expect(modal).toBeHidden({ timeout: 20000 })
  expect(await storedHistory(page)).toContain(url)

  // 重开（同 context，localStorage 保留）→ 切克隆 tab → 聚焦 URL 输入框
  const modal2 = await openCloneTab(page)
  const urlInput = modal2.locator('input[placeholder*="https://github.com"]')
  await urlInput.click()
  const dropdown = modal2.locator('[data-testid="clone-url-history"]')
  await expect(dropdown).toBeVisible({ timeout: 5000 })
  const item = dropdown.locator('[data-testid="clone-url-history-item-0"]')
  await expect(item).toHaveText(url)

  // 回填选中：URL 填入 + 走失焦推断链（名称自动取源目录末段）
  await item.click()
  await expect(urlInput).toHaveValue(url)
  await expect(modal2.locator('input[placeholder*="留空自动从路径推断"]')).toHaveValue('sc-e2e-url-history-src')
  // 点选后本轮聚焦内下拉收起
  await expect(dropdown).toBeHidden()

  // 清空入口：持久层 + 内存态同清，再聚焦不再出现
  await urlInput.click()
  await expect(dropdown).toBeVisible({ timeout: 5000 })
  await dropdown.locator('[data-testid="clone-url-history-clear"]').click()
  await expect(dropdown).toBeHidden()
  expect(await storedHistory(page)).toBeNull()
  await urlInput.click()
  await expect(dropdown).toHaveCount(0)
})

test('含凭据 URL（user:pass@）提交不入历史，非凭据对照照常入史', async ({ page }) => {
  const modal = await openCloneTab(page)
  // 文案无关定位：运行态按钮文案变「克隆中…」，按「添加项目」过滤会把禁用窗口
  // 排除在选择器之外（第一轮实测踩坑）；primary-type 在动作区唯一
  const positive = modal.locator('.n-dialog__action .n-button--primary-type')

  // 克隆任务终态信号（失败 toast 文案是 git 原始错误如「exit status 128」不固定）：
  // 运行态页脚按钮禁用 → 任务终态回调复位恢复可用。禁用观察与点击并发起跑——
  // .invalid DNS 快速失败时禁用窗口可能短于 click 的 actionability 往返，事后
  // 轮询会整窗错过（fulle2e run7 实测 + 本地 flaky 复现），瞬态断言须并发观察
  async function submitAndSettle() {
    await Promise.all([
      expect(positive).toBeDisabled({ timeout: 15000 }),
      positive.click(),
    ])
    await expect(positive).toBeEnabled({ timeout: 30000 })
  }

  // 凭据 URL 提交：克隆必失败（.invalid DNS 快速失败），但记录发生在提交时——
  // 入史与否由 recordUrl 判定，与克隆成败无关
  await modal.locator('input[placeholder*="https://github.com"]').fill(CRED_URL)
  await modal.locator('input[placeholder*="克隆到哪个目录"]').fill(serverPath(`${DST_DIR}-cred`))
  await positive.click()
  await submitAndSettle()

  // 非凭据对照（同样克隆失败）：提交时照常入史
  await modal.locator('input[placeholder*="https://github.com"]').fill(PLAIN_URL)
  await modal.locator('input[placeholder*="克隆到哪个目录"]').fill(serverPath(`${DST_DIR}-plain`))
  await positive.click()
  await submitAndSettle()

  // 数据面：凭据 URL 及其密钥零落盘，非凭据 URL 在案
  const stored = await storedHistory(page)
  expect(stored).not.toBeNull()
  expect(stored).not.toContain('e2e-user')
  expect(stored).not.toContain('e2e-pass')
  expect(stored).toContain(PLAIN_URL)

  // UI 面：聚焦出下拉，仅非凭据条目
  await modal.locator('input[placeholder*="https://github.com"]').click()
  const dropdown = modal.locator('[data-testid="clone-url-history"]')
  await expect(dropdown).toBeVisible({ timeout: 5000 })
  await expect(dropdown).toContainText(PLAIN_URL)
  await expect(dropdown).not.toContainText('e2e-pass')
})
