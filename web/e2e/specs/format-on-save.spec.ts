import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 保存时格式化开关 E2E（P-20261003-83，files.formatOnSave）：
 *   ① 开关开启：改乱缩进的 JSON 保存（Ctrl+S）→ 磁盘落的是格式化后的规整缩进
 *      （保存链前置「格式化文档」action，格式化 → 冲突检测 → 保存叠加序）；
 *   ② 开关关闭（默认，存量行为不变）：改乱 JSON 保存 → 磁盘原样（不格式化）；
 *   ③ 开关开启 + 不支持格式化的语言（plaintext）：静默跳过格式化直接保存
 *      （Monaco 内建 formatter 覆盖面有限非全语言承诺，保存路径不被阻塞）。
 * 全部保存链（P-20261004-139，Ctrl+Alt+S 亦前置格式化）：
 *   ④ 开关开启 + 分屏双组各一乱缩进 JSON 脏文件 → Ctrl+Alt+S → 两文件磁盘均
 *      规整化（saveAllFiles 串行链保存前查格式化注册表，注册表由可见编辑器
 *      挂载期反向注册）；
 *   ⑤ 开关开启 + 同组后台 tab 脏 JSON → Ctrl+Alt+S → 活跃文件规整化、后台
 *      文件原样落盘（格式化动作只对可见编辑器承诺：后台标签无在册实现，
 *      与单文件链同口径）。
 * 自备临时仓库，afterAll 清理（含 uiState 复位）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-format-on-save')
const PROJ = 'e2e-format-on-save'
// 两个用例各自独占一个 JSON 文件：开关开启用例会把磁盘文件格式化掉，
// 共用文件会让「关闭档=原样」断言继承前者的落盘结果（用例间磁盘耦合假阴/假阳）
const JSON_ON_FILE = 'messy-format-on.json'
const JSON_OFF_FILE = 'messy-format-off.json'
const TXT_FILE = 'notes.txt'
// 全部保存链用例（P-20261004-139）：同样按用例独占文件防磁盘耦合
const SAVE_ALL_SPLIT_A = 'messy-saveall-split-a.json'
const SAVE_ALL_SPLIT_B = 'messy-saveall-split-b.json'
const SAVE_ALL_BG_FORMATTED = 'messy-saveall-bg-active.json'
const SAVE_ALL_BG_VERBATIM = 'messy-saveall-bg-hidden.json'
// 单行紧凑 + 歪缩进：格式化后必然变多行 4 空格缩进（编辑器默认 tabSize=4/insertSpaces）
const MESSY_JSON = '{"alpha": 1,   "beta":[1,2],  "gamma":{"delta":true}}'
const FORMATTED_MARK = '\n    "alpha": 1,'
const TXT_ORIGINAL = 'plain text keeps its   odd   spacing\n'
const TXT_APPEND = 'appended-plain'

function filePath(file: string): string {
  return path.join(REPO_DIR, file)
}

function diskContent(file: string): string {
  return fs.readFileSync(filePath(file), 'utf8')
}

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

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  fs.writeFileSync(filePath(JSON_ON_FILE), MESSY_JSON)
  fs.writeFileSync(filePath(JSON_OFF_FILE), MESSY_JSON)
  fs.writeFileSync(filePath(TXT_FILE), TXT_ORIGINAL)
  fs.writeFileSync(filePath(SAVE_ALL_SPLIT_A), MESSY_JSON)
  fs.writeFileSync(filePath(SAVE_ALL_SPLIT_B), MESSY_JSON)
  fs.writeFileSync(filePath(SAVE_ALL_BG_FORMATTED), MESSY_JSON)
  fs.writeFileSync(filePath(SAVE_ALL_BG_VERBATIM), MESSY_JSON)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 保存时格式化基线'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 经文件树点击打开文件（幂等：已开只会被激活）；rail 面板未展开时先点开 */
async function treeOpenFile(page: import('@playwright/test').Page, file: string) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: file }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: file }).first().click()
}

/** 打开项目并经文件树打开目标文件（幂等：已开只会被激活） */
async function openProjectAndFile(page: import('@playwright/test').Page, file: string, marker: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await treeOpenFile(page, file)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(marker, { timeout: 8000 })
}

/** 打开设置 → 外观分区，勾选「保存时格式化」开关（直写 font-settings 即时生效） */
async function enableFormatOnSave(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  // 分区语义锚点（P-20261002-151）：不再依赖导航序下标
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  const row = page.locator('[data-testid="settings-format-on-save"]')
  await expect(row).toBeVisible({ timeout: 3000 })
  await row.locator('.n-checkbox').click()
  // 开关写入 font-settings 即时生效（编辑器行为类选项直写 store）
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('font-settings') || '{}'))
  expect((saved as { editor?: { formatOnSave?: boolean } }).editor?.formatOnSave).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
}

test('开关开启：改乱 JSON 保存后磁盘为规整缩进（格式化前置保存链）', async ({ page }) => {
  await openProjectAndFile(page, JSON_ON_FILE, '"alpha"')
  await enableFormatOnSave(page)

  await page.locator('.monaco-editor').click()
  // Monaco 语言贡献懒加载：provider 注册完成前的格式化是 no-op（= 不支持语言语义），
  // 等一拍再首轮保存，仍以重按兜底（重复保存幂等）防懒加载竞态假阴
  await page.waitForTimeout(1000)
  for (let i = 0; i < 5; i++) {
    if (diskContent(JSON_ON_FILE).includes(FORMATTED_MARK)) break
    await page.keyboard.press('Control+s')
    await page.waitForTimeout(800)
  }

  // 磁盘 = 格式化后的多行 4 空格缩进（默认 tabSize=4/insertSpaces），而非原始单行
  expect(diskContent(JSON_ON_FILE)).toContain(FORMATTED_MARK)
  expect(diskContent(JSON_ON_FILE)).not.toBe(MESSY_JSON)
  // 编辑器视图同步展示格式化结果（格式化经 updateContent 落 openFiles 对象后再保存）
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('"beta"', { timeout: 5000 })
})

test('开关关闭（默认）：改乱 JSON 保存后磁盘原样（存量行为不变）', async ({ page }) => {
  // 全新浏览器上下文 localStorage 为空 = 默认关，无需设置操作
  await openProjectAndFile(page, JSON_OFF_FILE, '"alpha"')

  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+s')
  // 保存照常落盘（等「已保存」写请求完成：磁盘含内容即已写）
  await expect.poll(() => diskContent(JSON_OFF_FILE), { timeout: 8000 }).toContain('"gamma"')

  // 但内容原样：歪缩进/单行未被格式化（磁盘字节级等于原始内容）
  expect(diskContent(JSON_OFF_FILE)).toBe(MESSY_JSON)
})

test('开关开启 + 不支持格式化的语言：静默跳过直接保存（不阻塞保存路径）', async ({ page }) => {
  await openProjectAndFile(page, TXT_FILE, 'odd   spacing')
  await enableFormatOnSave(page)

  // plaintext 无 formatter：键入追加后保存应原样落盘（不格式化、不报错）
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(TXT_APPEND)
  await page.keyboard.press('Control+s')
  await expect.poll(() => diskContent(TXT_FILE), { timeout: 8000 }).toContain(TXT_APPEND)

  // 原文空格逐字保留（无 formatter = 不动内容），保存成功无错误提示
  expect(diskContent(TXT_FILE)).toBe(TXT_ORIGINAL + TXT_APPEND)
  await expect(page.locator('.n-message').filter({ hasText: '失败' })).toHaveCount(0)
})

/** Monaco JSON 语言贡献懒加载：provider 注册完成前的格式化是 no-op。单文件
 *  Ctrl+S 链保存动作无条件执行（干净文件也重存），可重复按压兜底；全部保存链
 *  只处理脏文件，格式化 no-op 落盘后文件回净态、重按无效——预热必须独立完成，
 *  不能依赖保存全部链自身重试。预热本身走单文件链（在指定编辑器上重按 Ctrl+S
 *  直到磁盘规整化），结束时 provider 确认就绪 */
async function prewarmJsonFormatter(page: import('@playwright/test').Page, editorLoc: string, file: string) {
  await page.locator(editorLoc).click()
  await page.waitForTimeout(1000)
  for (let i = 0; i < 5; i++) {
    if (diskContent(file).includes(FORMATTED_MARK)) break
    await page.keyboard.press('Control+s')
    await page.waitForTimeout(800)
  }
  expect(diskContent(file)).toContain(FORMATTED_MARK)
}

/** 在指定窗格活跃编辑器的文首/文尾插入单个空格制造脏编辑：空格是 JSON 合法
 *  空白，脏位成立且文档仍可被 formatter 正常解析重排 */
async function dirtyBySpace(page: import('@playwright/test').Page, pane: string, at: 'start' | 'end') {
  await page.locator(`${pane} .monaco-editor .view-lines`).click()
  await page.keyboard.press(at === 'start' ? 'Control+Home' : 'Control+End')
  await page.keyboard.type(' ')
}

test('全部保存链（P-20261004-139）：开关开 + 分屏双组各一脏 JSON → Ctrl+Alt+S 两文件均规整化', async ({ page }) => {
  // 打开 A、B 两个乱缩进 JSON（同入主组），开档后开开关
  await openProjectAndFile(page, SAVE_ALL_SPLIT_A, '"alpha"')
  await treeOpenFile(page, SAVE_ALL_SPLIT_B)
  await enableFormatOnSave(page)

  // B 开进分屏组（标签右键「在右侧分屏打开」，save-all.spec 同链；共享对象
  // 两组成签）
  await page.locator('.pane-primary .editor-tab', { hasText: SAVE_ALL_SPLIT_B }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在右侧分屏打开' }).click()
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText('"beta"', { timeout: 8000 })

  // provider 预热走单文件链（分屏组 B 上重按 Ctrl+S）；结束后 B 已格式化净态
  await prewarmJsonFormatter(page, '.pane-split .monaco-editor .view-lines', SAVE_ALL_SPLIT_B)

  // 主组切回 A 弄脏（A 全程未经单文件链，其磁盘规整化即全部保存链格式化的直接
  // 证据）；分屏组 B 再弄脏（预热后已净态，脏位才有资格进保存清单）
  await page.locator('.pane-primary .editor-tab', { hasText: SAVE_ALL_SPLIT_A }).click()
  await dirtyBySpace(page, '.pane-primary', 'end')
  await dirtyBySpace(page, '.pane-split', 'end')

  // Ctrl+Alt+S 全部保存：双组脏文件保存前各自查表格式化再落盘
  await page.keyboard.press('Control+Alt+s')
  await expect(page.locator('.n-message').filter({ hasText: '已保存 2 个文件' })).toBeVisible({ timeout: 8000 })

  for (const f of [SAVE_ALL_SPLIT_A, SAVE_ALL_SPLIT_B]) {
    await expect.poll(() => diskContent(f), { timeout: 8000 }).toContain(FORMATTED_MARK)
    expect(diskContent(f)).not.toBe(MESSY_JSON)
  }
})

test('全部保存链边界（P-20261004-139）：同组后台 tab 脏文件原样落盘（格式化只对可见编辑器承诺）', async ({ page }) => {
  // V（后台将原样落盘）先开、F（活跃将被格式化）后开——后开者持有可见编辑器
  await openProjectAndFile(page, SAVE_ALL_BG_VERBATIM, '"alpha"')
  await treeOpenFile(page, SAVE_ALL_BG_FORMATTED)
  await enableFormatOnSave(page)

  // provider 预热（活跃文件 F 上重按 Ctrl+S）；结束后 F 已格式化净态
  await prewarmJsonFormatter(page, '.pane-primary .monaco-editor .view-lines', SAVE_ALL_BG_FORMATTED)

  // F 再弄脏（重获进清单资格）；切后台文件 V 弄脏（文首空格，字节可断言），
  // 再切回 F——V 回到后台：无可见编辑器 = 注册表无实现
  await dirtyBySpace(page, '.pane-primary', 'end')
  await page.locator('.pane-primary .editor-tab', { hasText: SAVE_ALL_BG_VERBATIM }).click()
  await dirtyBySpace(page, '.pane-primary', 'start')
  await page.locator('.pane-primary .editor-tab', { hasText: SAVE_ALL_BG_FORMATTED }).click()

  // Ctrl+Alt+S：F（可见宿主）保存前格式化，V（后台）查表 no-op 原样落盘
  await page.keyboard.press('Control+Alt+s')
  await expect(page.locator('.n-message').filter({ hasText: '已保存 2 个文件' })).toBeVisible({ timeout: 8000 })

  await expect.poll(() => diskContent(SAVE_ALL_BG_FORMATTED), { timeout: 8000 }).toContain(FORMATTED_MARK)
  // 后台文件字节级原样 = 原始乱缩进 + 首部脏编辑空格，无格式化痕迹
  expect(diskContent(SAVE_ALL_BG_VERBATIM)).toBe(' ' + MESSY_JSON)
})
