import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器 Git 快捷操作 E2E：
 *   1. 全角标点（，不再被 Monaco「歧义字符」黄框标记（unicodeHighlight.ambiguousCharacters=false）
 *   2. Blame 按钮：点击后按行注入 blame 注释（回归：后端 lineNo 与前端 line 字段错位曾静默无效果）
 *   3. 文件历史弹窗：commit 列表 + 该文件 diff
 *   4. 对比分支：选 ref 后展示「ref → HEAD」的本文件 diff + 「当前分支 ← ref」方向标注（P-20261003-222）
 * 自备临时仓库（两提交 + feature 分支指回第一提交，保证对比必有差异），afterAll 清理
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-git')
const PROJ_NAME = 'e2e-editor-git'
const FILE = 'notes.md'
const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

let projectId = ''

// 固定参数列表调用 git（无 shell 拼接），身份用 -c 内联避免依赖本机 git 配置
function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = (await unlockRes.json()).token || ''
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  const stale = await (await fetch(BASE + '/api/projects', { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致

  // 提交 1：含全角标点的 v1 内容
  fs.writeFileSync(path.join(REPO_DIR, FILE), `# 测试（中文标题）\n\n第一行，包含全角标点。\n`)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: add notes'])
  // feature 分支指回提交 1；main 继续前进到提交 2（对比 feature → HEAD 必有差异）
  git(REPO_DIR, ['branch', 'feature'])
  fs.appendFileSync(path.join(REPO_DIR, FILE), '\n第二行：v2 追加内容。\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: append line'])

  const res = await fetch(BASE + '/api/projects', {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
})

test.afterAll(async () => {
  if (!projectId) return
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = (await unlockRes.json()).token || ''
  await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

async function openFile(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  // 重置持久化布局：uiState 是服务端全局状态，前序 spec 的面板开关
  // （panel-registry/lock 等）经布局恢复污染进入流程——侧栏视图非文件树
  // 时搜索按钮不可达，toggle 循环救不回。重置后 reload 重读干净布局
  await page.evaluate(async () => {
    // 页内同源 fetch 自动携带 HttpOnly 锁 cookie（P-20261019-2 起无头可带）
    // local: null = 清空整个命名空间（服务端浅合并语义下，传对象只会与旧值
    // 合并、清不掉——commit-amend 存的 sideView=commit 曾借此穿越清理）
    await fetch('/api/ui-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local: null }),
    })
  })
  await page.reload()
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——先保证面板打开；
  // 工具栏会因轮询重渲染导致元素瞬时失效，点击一律带重试
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.tree-action-btn[title="搜索文件"]').isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="项目文件"], .rail-btn[aria-label="项目文件"]').click()
    await page.waitForTimeout(800)
  }
  if (process.env.E2E_DEBUG) {
    const dump = await page.evaluate(() => ({
      url: location.pathname,
      rail: [...document.querySelectorAll('.rail-btn')].map(e => e.title || e.getAttribute('aria-label')),
      hasTreeToolbar: !!document.querySelector('.tree-action-btn'),
      sideViews: [...document.querySelectorAll('[class*="side-"]')].map(e => e.className).slice(0, 4),
    }))
    console.log('[openFile-dump]', JSON.stringify(dump))
    await page.screenshot({ path: 'test-results/openfile-debug.png' })
  }
  const clickRetry = async (loc: import('@playwright/test').Locator, timeout = 2000, attempts = 8) => {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try { await loc.click({ timeout }); return } catch (err) { lastErr = err; await page.waitForTimeout(300) }
    }
    throw lastErr
  }
  await clickRetry(page.locator('.tree-action-btn[title="搜索文件"]'))
  // 等树完成首次加载：commit-amend 先行时布局恢复竞态会让树 spinner 长存、
  // 整表反复重渲染——此时点击结果条目永远「不稳定」。就绪判定 = 加载指示
  // 消失且首个条目可见（而非盲目固定等待）
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await page.locator('.file-tree .item-name').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  const searchInput = page.locator('.tree-search input')
  await searchInput.waitFor({ state: 'attached', timeout: 30000 }).catch(() => {})
  await clickRetry(searchInput)
  await searchInput.fill(FILE)
  await expect(page.getByText('notes.md').first()).toBeVisible({ timeout: 30000 })
  if (process.env.E2E_DEBUG) {
    // 诊断采样：记录 3 秒窗口内文件树的节点增删（定位重渲染循环的来源）
    const churn = await page.evaluate(() => {
      return new Promise<any[]>(resolve => {
        const samples: any[] = []
        const root = document.querySelector('.file-tree') || document.body
        const mo = new MutationObserver(muts => {
          for (const mu of muts) {
            const cls = (n: Node) =>
              n.nodeType === 1
                ? ((n as HTMLElement).className || n.nodeName).toString().slice(0, 40)
                : `#${n.nodeName}`
            const rem = Array.from(mu.removedNodes).map(cls)
            const add = Array.from(mu.addedNodes).map(cls)
            if (rem.length || add.length) samples.push({ target: (mu.target as HTMLElement).className?.toString?.().slice(0, 30), rem, add })
          }
        })
        mo.observe(root, { childList: true, subtree: true })
        setTimeout(() => { mo.disconnect(); resolve(samples.slice(0, 30)) }, 3000)
      })
    })
    console.log('[tree-churn]', JSON.stringify(churn))
  }
  await clickRetry(page.getByText('notes.md').first(), 2000, 10)
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20000 })
}

test('全角标点不再出现歧义字符黄框', async ({ page }) => {
  await openFile(page)
  // md 默认分屏（源码半屏含 monaco）；Monaco 对歧义字符的标记 span 类名含 unicode-highlight
  await expect(page.locator('.monaco-editor .unicode-highlight')).toHaveCount(0, { timeout: 10000 })
})

test('Blame 按钮：点击后行内注入 blame 注释', async ({ page }) => {
  await openFile(page)
  const blameBtn = page.locator('.blame-toggle-btn')
  await expect(blameBtn).toBeVisible()
  await blameBtn.click()
  // 后端返回 lineNo + 日期/摘要；前端成功注入（曾因字段错位 line=0 全部静默丢弃）
  await expect(page.locator('.monaco-editor .blame-author-0').first()).toBeVisible({ timeout: 10000 })
})

test('文件历史弹窗：commit 列表可选并展示 diff', async ({ page }) => {
  await openFile(page)
  await page.locator('.ega-anchor button').filter({ hasText: '历史' }).click()
  const modal = page.locator('.n-modal').filter({ hasText: `文件历史：${FILE}` })
  await expect(modal).toBeVisible({ timeout: 5000 })
  // 两个提交都在列表里
  await expect(modal.getByText('c1: add notes')).toBeVisible({ timeout: 10000 })
  await expect(modal.getByText('c2: append line')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden()
})

test('对比分支：选 feature → HEAD 展示本文件差异', async ({ page }) => {
  await openFile(page)
  await page.locator('.ega-anchor button').filter({ hasText: '对比' }).click()
  const modal = page.locator('.n-modal').filter({ hasText: `对比：${FILE}` })
  await expect(modal).toBeVisible({ timeout: 5000 })
  // 打开下拉（refs 异步加载完成后再点，避免空菜单竞态），选中 feature 分支后自动发起对比
  await modal.locator('.n-base-selection').first().click()
  const featureOption = page.locator('.n-base-select-menu .n-base-select-option').filter({ hasText: 'feature' })
  await expect(featureOption).toBeVisible({ timeout: 10000 })
  await featureOption.click()
  // feature 指向 c1，HEAD 在 c2：追加行应出现在 diff 中
  await expect(modal.locator('.crm-diff')).toBeVisible({ timeout: 10000 })
  await expect(modal.getByText('第二行：v2 追加内容')).toBeVisible({ timeout: 10000 })

  // 方向标注（P-20261003-222）：「<当前分支> ← feature」明示合入方向，
  // tooltip 重申「将 feature 合入 <当前分支>」与分支右键合并确认同向
  const baseBranch = git(REPO_DIR, ['branch', '--show-current']).trim()
  const direction = modal.locator('.crm-direction')
  await expect(direction).toBeVisible()
  await expect(direction.locator('.crm-dir-base')).toHaveText(baseBranch)
  await expect(direction.locator('.crm-dir-source')).toHaveText('feature')
  // title 是整句说明，取属性原文做包含断言（toHaveAttribute 对正则做全值匹配）
  expect(await direction.getAttribute('title')).toContain(`将 feature 合入 ${baseBranch}`)
})
