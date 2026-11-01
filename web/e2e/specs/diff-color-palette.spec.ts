import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * diff 色板档 E2E（P-20261006-5）：设置·外观「diff 色板」标准（红绿）/色弱友好
 * （蓝橙，deuteranopia-safe）两档对 diff 视图的生效链。色值断言走 DOM 实测
 * computed backgroundColor 的通道优势（蓝档 b 通道最大 / 绿档 g 最大 / 暖档 r
 * 最大），不碰像素内幕，且对深浅主题均成立（六主题各自适配蓝橙值）：
 *   ① 反应式路径（主流程）：Monaco DiffEditor 标准档绿/红 → 设置切色弱档即时
 *      换蓝/橙（applyMonacoTheme watch 重广播，无需重开标签）→ 文本 diff 视图
 *      （DiffViewer，git 面板行内嵌 diff）同旅程随档换色 → 切回标准恢复红绿；
 *   ② 初装路径：localStorage font-settings 预置 diffPalette:colorblind → 打开
 *      即蓝橙（font store load → theme apply → Monaco 注入全链启动期生效）。
 * 夹具 = 三态一行改写：c1(old-03) → c2(new-03)（Monaco 走提交 diff，有增有删）
 * → 工作区改写 new-03-v2（文本路径走工作区 diff，同样有增有删）。
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diff-color-palette')
const PROJ = 'e2e-diff-color-palette'
const FILE = 'colors.txt'
const OLD_LINE = 'line-03-old'
const C2_LINE = 'line-03-new'
const WT_LINE = 'line-03-new-v2'

const C1_CONTENT = ['line-01', 'line-02', OLD_LINE, 'line-04', 'line-05', ''].join('\n')

function contentWith(line3: string): string {
  return ['line-01', 'line-02', line3, 'line-04', 'line-05', ''].join('\n')
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''
let c2 = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // Windows 服务端 git 也不 smudge，与 Linux 视图一致
  git(REPO_DIR, ['config', 'user.name', 'e2e'])
  git(REPO_DIR, ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), C1_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: baseline'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), contentWith(C2_LINE))
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: rewrite line 3'])
  c2 = git(REPO_DIR, ['rev-parse', 'HEAD'])
  // 工作区再改写同一行（未暂存）：文本 diff 路径的 -new-03/+new-03-v2 双色样本
  fs.writeFileSync(path.join(REPO_DIR, FILE), contentWith(WT_LINE))

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

// ── 色值读取与断言（通道优势，不碰像素内幕；对深浅主题两档色值均成立） ──

type RGB = [number, number, number]

// rgba() 与 color(srgb r g b / a) 双格式解析（Chromium 对 color-mix 结果序列化
// 为 color(srgb …)）；透明（alpha=0）返回 null 交由轮询重试。解析器以字面内联进
// 各 evaluate 回调——Playwright 回调整体序列化过墙，闭包/动态构造（new Function
// 的 return 后随源码换行会触发 ASI 退化成 return undefined）都不可靠

/** 读取选择器命中元素的首个非透明背景色（Monaco 语义色带元素） */
async function firstNonTransparentBg(page: import('@playwright/test').Page, selector: string): Promise<RGB | null> {
  return page.evaluate((sel) => {
    const parse = (bg: string): [number, number, number] | null => {
      let m = bg.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/)
      if (m) {
        if (m[4] !== undefined && Number(m[4]) === 0) return null
        return [Number(m[1])!, Number(m[2])!, Number(m[3])!]
      }
      m = bg.match(/color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)/)
      if (m) {
        if (m[4] !== undefined && Number(m[4]) === 0) return null
        return [Number(m[1])! * 255, Number(m[2])! * 255, Number(m[3])! * 255]
      }
      return null
    }
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const rgb = parse(getComputedStyle(el as Element).backgroundColor)
      if (rgb) return rgb
    }
    return null
  }, selector)
}

/** 读取单个元素自身的背景色（文本 diff 行，color-mix 行内样式） */
async function elementBg(page: import('@playwright/test').Page, locator: import('@playwright/test').Locator): Promise<RGB | null> {
  return locator.evaluate((el) => {
    const parse = (bg: string): [number, number, number] | null => {
      let m = bg.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/)
      if (m) {
        if (m[4] !== undefined && Number(m[4]) === 0) return null
        return [Number(m[1])!, Number(m[2])!, Number(m[3])!]
      }
      m = bg.match(/color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)/)
      if (m) {
        if (m[4] !== undefined && Number(m[4]) === 0) return null
        return [Number(m[1])! * 255, Number(m[2])! * 255, Number(m[3])! * 255]
      }
      return null
    }
    return parse(getComputedStyle(el).backgroundColor)
  })
}

/** 轮询直到色值就位且满足通道断言（主题广播/DOM 装帧异步收敛，读数必须重试） */
async function expectColor(
  what: string,
  read: () => Promise<RGB | null>,
  check: (rgb: RGB) => void,
) {
  await expect.poll(async () => {
    const rgb = await read()
    if (!rgb) return 'pending'
    try {
      check(rgb)
      return 'ok'
    } catch {
      return `${rgb.join(',')}`
    }
  }, { message: what, timeout: 5000 }).toBe('ok')
}

function expectBlue(rgb: RGB, what: string) {
  expect(rgb[2], `${what} 应蓝通道最大（色弱档 added=蓝）`).toBeGreaterThan(rgb[0])
  expect(rgb[2], `${what} 应蓝通道最大（色弱档 added=蓝）`).toBeGreaterThan(rgb[1])
}
function expectGreen(rgb: RGB, what: string) {
  expect(rgb[1], `${what} 应绿通道最大（标准档 added=绿）`).toBeGreaterThan(rgb[0])
  expect(rgb[1], `${what} 应绿通道最大（标准档 added=绿）`).toBeGreaterThan(rgb[2])
}
function expectWarm(rgb: RGB, what: string) {
  expect(rgb[0], `${what} 应红通道最大（removed=红/橙同为暖色主导）`).toBeGreaterThan(rgb[1])
  expect(rgb[0], `${what} 应红通道最大（removed=红/橙同为暖色主导）`).toBeGreaterThan(rgb[2])
}

/** Monaco diff 行语义色带选择器：并排走 .line-inserted/.line-deleted 整行层，
 *  行内视图走 .line-insert/.line-delete——两形态并集，命中哪个都源自同档色对 */
const MONACO_INSERT_SEL = '.monaco-diff-editor .line-insert, .monaco-diff-editor .line-inserted'
const MONACO_DELETE_SEL = '.monaco-diff-editor .line-delete, .monaco-diff-editor .line-deleted'

// ── 页面驱动 ──

/** 进项目并展开底部 Git 面板（rail 是 toggle，按提交可见性收敛） */
async function enterAndOpenLog(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-item').first()).toBeVisible()
}

/** 选中 c2（点 meta 行，消息区单击是展开 body）→ 返回右侧变更文件节点 */
async function selectChangeCommit(page: import('@playwright/test').Page) {
  await page.locator('.commit-item').filter({ hasText: c2.slice(0, 8) }).first().locator('.commit-meta').click()
  const node = page.locator('.commits-right .diff-node')
    .filter({ has: page.locator('.diff-status') })
    .filter({ hasText: FILE })
    .first()
  await expect(node).toBeVisible({ timeout: 5000 })
  return node
}

/** 右键节点 →「查看此次变更」→ DiffEditor 标签挂载 */
async function openDiffEditor(page: import('@playwright/test').Page, node: import('@playwright/test').Locator) {
  await node.click({ button: 'right' })
  const changeDiff = page.locator('.n-dropdown-menu').getByText('查看此次变更', { exact: true })
  await expect(changeDiff).toBeVisible({ timeout: 3000 })
  await changeDiff.click()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })
  // 变更内容就位（行级色带随行渲染，先等行可见再取色）
  await expect(page.locator('.monaco-diff-editor').getByText(C2_LINE).first()).toBeVisible({ timeout: 10000 })
}

/** 打开设置·外观并切 diff 色板档（radio 直写 store 即时生效） */
async function setDiffPalette(page: import('@playwright/test').Page, optionText: string) {
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  const group = page.locator('[data-testid="settings-diff-palette"]')
  await expect(group).toBeVisible({ timeout: 3000 })
  await group.locator('.n-radio-button').filter({ hasText: optionText }).click()
}

/** 展开工作区变更树目标文件的行内嵌 diff（DiffViewer 文本路径）。
 *  注意面板拓扑：变更树（.commit-panel/.cp-node）只挂侧栏（sideView==='changes'，
 *  rail 的「提交」钮 rail-changes，见 usePanelLayout showCommitInSidebar——底部
 *  「变更」tab 已退役，commitLocation 恒 'sidebar'）；rail-git 是底部 Git 面板
 *  （提交日志 .commit-item/选中提交右侧 .diff-node），不载变更树——上轮两轮
 *  确定性失败（.cp-node 10s 不现）根因即点错了 rail 入口 */
async function openInlineDiff(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-changes"]').click()
    await page.waitForTimeout(600)
  }
  const row = page.locator('.cp-node').filter({ hasText: FILE }).first()
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.locator('.cp-expand-chevron').click()
  const embed = page.locator('[data-testid="cp-inline-diff"]')
  await expect(embed).toBeVisible()
  await expect(embed.locator('.diff-line').filter({ hasText: WT_LINE }).first()).toBeVisible({ timeout: 10000 })
  return embed
}

test('切色弱档：Monaco 与文本 diff 即时换蓝橙，切回标准恢复红绿', async ({ page }) => {
  await enterAndOpenLog(page)
  const node = await selectChangeCommit(page)
  await openDiffEditor(page, node)

  // 标准档基线：Monaco 新增绿主导 / 删除暖色主导（Playwright 默认浅色主题）
  await expectColor('Monaco inserted 标准档绿主导', () => firstNonTransparentBg(page, MONACO_INSERT_SEL), (rgb) => expectGreen(rgb, 'Monaco inserted 标准档'))
  await expectColor('Monaco deleted 标准档暖色主导', () => firstNonTransparentBg(page, MONACO_DELETE_SEL), (rgb) => expectWarm(rgb, 'Monaco deleted 标准档'))

  // 设置·外观切「色弱友好」：已打开的 diff 标签即时换装（watch 重广播主题）
  await setDiffPalette(page, '色弱友好')
  // 档位生效锚点：html data 属性随 font store apply 翻转
  await expect(page.locator('html')).toHaveAttribute('data-diff-palette', 'colorblind')
  await expectColor('Monaco inserted 色弱档蓝主导', () => firstNonTransparentBg(page, MONACO_INSERT_SEL), (rgb) => expectBlue(rgb, 'Monaco inserted 色弱档'))
  await expectColor('Monaco deleted 色弱档橙主导', () => firstNonTransparentBg(page, MONACO_DELETE_SEL), (rgb) => expectWarm(rgb, 'Monaco deleted 色弱档'))

  // 文本 diff 路径同旅程随档：工作区行内嵌 diff 的 add/del 行底色换蓝橙
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
  const embed = await openInlineDiff(page)
  // del 行用尾锚正则定位：C2_LINE 是 WT_LINE 的前缀子串，裸 hasText 会双命中
  const addRow = embed.locator('.diff-line').filter({ hasText: WT_LINE }).first()
  const delRow = embed.locator('.diff-line').filter({ hasText: new RegExp(`${C2_LINE}$`) }).first()
  await expect(delRow).toBeVisible()
  await expectColor('文本 diff add 行色弱档蓝主导', () => elementBg(page, addRow), (rgb) => expectBlue(rgb, '文本 diff add 行色弱档'))
  await expectColor('文本 diff del 行色弱档橙主导', () => elementBg(page, delRow), (rgb) => expectWarm(rgb, '文本 diff del 行色弱档'))

  // 切回标准档恢复红绿（可逆，同一挂载实例内）
  await setDiffPalette(page, '标准')
  await expect(page.locator('html')).toHaveAttribute('data-diff-palette', 'standard')
  await expectColor('文本 diff add 行恢复标准档绿主导', () => elementBg(page, addRow), (rgb) => expectGreen(rgb, '文本 diff add 行恢复标准档'))
})

test('初装路径：font-settings 预置色弱档 → Monaco diff 打开即蓝橙', async ({ page }) => {
  // store load 合并消毒：只覆写 diffPalette，其余段走默认（word-wrap 初装路径同款）
  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.setItem('font-settings', JSON.stringify({ diffPalette: 'colorblind' }))
  })
  await enterAndOpenLog(page)
  const node = await selectChangeCommit(page)
  await openDiffEditor(page, node)

  await expect(page.locator('html')).toHaveAttribute('data-diff-palette', 'colorblind')
  await expectColor('初装色弱档 Monaco inserted 蓝主导', () => firstNonTransparentBg(page, MONACO_INSERT_SEL), (rgb) => expectBlue(rgb, '初装色弱档 Monaco inserted'))
  await expectColor('初装色弱档 Monaco deleted 橙主导', () => firstNonTransparentBg(page, MONACO_DELETE_SEL), (rgb) => expectWarm(rgb, '初装色弱档 Monaco deleted'))
})
