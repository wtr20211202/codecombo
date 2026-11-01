import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { fixedLocale, waitForAppReady, unlockIfNeeded, DEFAULT_PASSWORD } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 高危命令影响面预检（P-20261005-191）E2E：
 *   1. 粘贴 rm -rf 高危命令 → 影响面确认卡（动态计数 = 目录内文件数）→
 *      「仍要粘贴」入终端 → 回车真删（落盘面实证）→ 同型命令（rm-recursive
 *      模式族）本会话白名单放行不再弹卡（目标有真实影响，排除零影响降级假绿）
 *   2. 取消 → 命令不落终端（字节未写 PTY）
 *   3. 干净 git 树上 git reset --hard：动态计数为 0 → 降级灰提示不弹卡
 *      （误报治理面）；设置开关关闭 → 完全不预检（有真实影响的目标照常直落）
 * 前置（spec 内自备）：临时项目（git init + 基线提交做干净树）+ 高危目标夹具；
 *   剪贴板走 Chromium 权限授予（paste-threshold 同款）
 */

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-cmd-preview'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-cmd-preview')
// 夹具目标（beforeAll 全量重建，确定性）：卡面动态计数断言面 / 白名单放行面 /
// 取消面 / 开关关闭面——后三者都必须有真实影响（计数 > 0），
// 否则零影响降级分支会让「不弹卡」断言假绿
const DANGER_DIR = 'sc-danger-target'
const WHITELIST_DIR = 'sc-danger-keep2'
const CANCEL_CMD = 'shred -u sc-cancel.txt'
const TOGGLE_CMD = 'rm -rf sc-toggle-target'

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) await api('DELETE', `/api/projects/${oldProj.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)

  // git init + 基线提交：干净树基线（用例 3 的零影响降级分支需要真 git 仓库）
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: REPO_DIR,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
    stdio: 'pipe',
  })
  git(['init', '-q'])
  fs.writeFileSync(path.join(REPO_DIR, 'base.txt'), 'base\n')
  git(['add', '.'])
  git(['commit', '-q', '-m', 'init'])

  // 高危目标夹具：目录各带标记文件（动态计数 > 0 的断言面）
  fs.mkdirSync(path.join(REPO_DIR, DANGER_DIR), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, DANGER_DIR, 'a.txt'), 'aa')
  fs.writeFileSync(path.join(REPO_DIR, DANGER_DIR, 'b.txt'), 'bb')
  fs.mkdirSync(path.join(REPO_DIR, WHITELIST_DIR), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, WHITELIST_DIR, 'keep.txt'), 'k')
  fs.writeFileSync(path.join(REPO_DIR, 'sc-cancel.txt'), 'c')
  fs.mkdirSync(path.join(REPO_DIR, 'sc-toggle-target'), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, 'sc-toggle-target', 't.txt'), 't')

  // 用例间设置开关复位开（用例 3 关闭后 afterAll 兜底复原）
  await api('PUT', '/api/settings', { terminalPastePrecheckEnabled: true })
})

test.afterAll(async () => {
  // 开关复原（默认开），防污染同实例其他 spec
  await api('PUT', '/api/settings', { terminalPastePrecheckEnabled: true })
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

async function switchProject(page: Page, name: string) {
  await page.locator('.header-project-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: name }).first().click()
}

async function openFreshTerminal(page: Page) {
  const panel = page.locator('.bottom-panel')
  const ensureOpen = async () => {
    if (!(await panel.isVisible().catch(() => false))) {
      await page.locator('.rail-btn[title="终端"]').click()
    }
    await expect(panel).toBeVisible({ timeout: 5000 })
  }
  await ensureOpen()
  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
  await ensureOpen()
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText(serverIsLinux ? /[#$] / : 'PS ', { timeout: 20000 })
  return xterm
}

// 右键终端 → 菜单「粘贴」（pasteFromClipboard → onData 收口，闸门锚点）
async function pasteViaContextMenu(page: Page, xterm: ReturnType<Page['locator']>, text: string) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text)
  await xterm.click({ button: 'right' })
  const menu = page.locator('.term-context-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.term-context-item').filter({ hasText: '粘贴' }).first().click()
}

async function gotoProjectTerminal(page: Page) {
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  return openFreshTerminal(page)
}

test('粘贴 rm -rf：影响面卡含动态计数，确认后执行，同型命令白名单放行', async ({ page }) => {
  test.setTimeout(180000)
  const xterm = await gotoProjectTerminal(page)

  await pasteViaContextMenu(page, xterm, `rm -rf ${DANGER_DIR}`)

  // 影响面卡：标题 + rm 命中 + 动态计数（目录内 2 个标记文件）
  const dialog = page.locator('.n-dialog').filter({ hasText: '高危命令影响面预览' })
  await expect(dialog).toBeVisible({ timeout: 10000 })
  const body = dialog.locator('[data-testid="terminal-cmd-preview-body"]')
  await expect(body).toContainText('递归/强制删除')
  await expect(body).toContainText(`rm -rf ${DANGER_DIR}`)
  await expect(body).toContainText('2 个文件')
  await expect(body.locator('[data-testid="cmd-preview-match-rm-recursive"]')).toBeVisible()

  // 确认 → 命令落输入行（stripTrailingNewline 默认开，不自动执行）→ 回车执行
  await dialog.locator('.n-dialog__action button').filter({ hasText: '仍要粘贴' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(xterm).toContainText(`rm -rf ${DANGER_DIR}`, { timeout: 10000 })
  await page.keyboard.press('Enter')
  // 真删实证（Linux bash 侧）：Windows PowerShell 下 `rm -rf` 参数形态非法
  //（rm 是 Remove-Item 别名，无 -f 短旗标），命令仍被 shell 处理但删不动目录
  //——门禁的 Linux 分支（提案验证档 quick）承担执行面实证，金态 Windows 只
  // 断言闸门链（卡面计数/确认落行）
  if (serverIsLinux) {
    await expect.poll(() => fs.existsSync(path.join(REPO_DIR, DANGER_DIR)), { timeout: 10000 }).toBe(false)
  }

  // 同型命令（同 rm-recursive 模式族）本会话白名单：目标有真实影响仍不弹卡
  //（keep2 目录带 1 个文件，计数 > 0，排除零影响降级分支假绿）
  await pasteViaContextMenu(page, xterm, `rm -rf ${WHITELIST_DIR}`)
  await expect(page.locator('.n-dialog').filter({ hasText: '高危命令影响面预览' })).toHaveCount(0)
  await expect(xterm).toContainText(`rm -rf ${WHITELIST_DIR}`, { timeout: 10000 })
})

test('粘贴高危命令取消：命令不落终端', async ({ page }) => {
  test.setTimeout(120000)
  const xterm = await gotoProjectTerminal(page)

  await pasteViaContextMenu(page, xterm, CANCEL_CMD)

  const dialog = page.locator('.n-dialog').filter({ hasText: '高危命令影响面预览' })
  await expect(dialog).toBeVisible({ timeout: 10000 })
  await expect(dialog).toContainText('内容覆写销毁')
  await dialog.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(dialog).toHaveCount(0)
  // 取消 = 字节未写 PTY：等一拍后终端无命令痕迹
  await page.waitForTimeout(1000)
  await expect(xterm).not.toContainText('shred')
})

test('干净树上 git reset --hard：零影响降级灰提示不弹卡；开关关闭完全不预检', async ({ page }) => {
  test.setTimeout(180000)
  const xterm = await gotoProjectTerminal(page)

  // 干净树基线：reset --hard 动态计数 dirty=0 → 灰提示放行（不弹卡）
  await pasteViaContextMenu(page, xterm, 'git reset --hard')
  const dialog = page.locator('.n-dialog').filter({ hasText: '高危命令影响面预览' })
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.n-message').filter({ hasText: '影响面为 0' }).first()).toBeVisible({ timeout: 10000 })
  await expect(xterm).toContainText('git reset --hard', { timeout: 10000 })

  // 开关关闭：经 API 落盘（settings.changed 广播本页缓存失效；重载兜底竞态）。
  // 目标带真实影响（计数 > 0）——若预检仍在会弹卡，不弹卡即证明预检已关
  const toggleRes = await api('PUT', '/api/settings', { terminalPastePrecheckEnabled: false })
  expect([200, 204]).toContain(toggleRes.status)
  await page.reload()
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm2 = await openFreshTerminal(page)

  await pasteViaContextMenu(page, xterm2, TOGGLE_CMD)
  await expect(page.locator('.n-dialog').filter({ hasText: '高危命令影响面预览' })).toHaveCount(0)
  await expect(xterm2).toContainText(TOGGLE_CMD, { timeout: 10000 })
})
