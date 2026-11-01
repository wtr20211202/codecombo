import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器字符串内路径补全 E2E（P-20261003-107）：
 *   1. 字符串内输 ./（/ 触发字符）→ 补全列表含真实文件与目录钻取项 → 逐级
 *      选中插入相对路径（src/ → utils/ → HE 大小写不敏感模糊命中 helpers.ts），
 *      终态 import 路径完整落进字符串
 *   2. 代码区空行输 /（无引号上下文）不误弹：建议组件保持隐藏
 *   3. 口语字符串（导航段非真实目录）输 / 不误弹：建议组件保持隐藏
 * 触发从严是提案核心约束——用例 2/3 是防噪声回归锚。
 *   4. 绝对宿主路径二阶段（P-20261005-232）：敲项目根绝对路径（服务端形态
 *      正斜杠化——同机 win 为盘符形态 / 跨拓扑或 WSL 为 posix 形态）→ 剥根
 *      映射逐级钻取，选中回填 / 项目根相对形态；盘符拓扑加验反斜杠双形态
 *      （\ 触发字符）；界外绝对路径（盘符/posix 各按拓扑）如实不响应。
 * 自备临时仓库，afterAll 清理（项目/仓库/ui-state）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-path-completion')
const PROJ = 'e2e-path-completion'
const MAIN_FILE = 'main.ts'
// 光标落点：行尾开引号，字符串内路径从这里开始敲
const MAIN_CONTENT = "import { helper } from '\n"

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function registerProject(): Promise<void> {
  const res = await api('POST', '/api/projects', { name: PROJ, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(res.status)
}

async function cleanupProject(): Promise<void> {
  const list = await api('GET', '/api/projects')
  for (const p of ((list.json?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await api('DELETE', `/api/projects/${p.id}`)
  }
}

async function cleanupRepo(): Promise<void> {
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
}

/** 侧栏文件树打开文件（rail 关着时先点开；同 editor-snippets 的重试形态） */
async function openFile(page: Page, name: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: name }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: name }).first().click()
  await expect(page.locator('.editor-tab', { hasText: name })).toBeVisible({ timeout: 8000 })
}

/** 焦点进编辑器第 1 行行尾（MAIN_CONTENT 的开引号后）：view-lines 容器比单行
 *  文本高，直接点容器中心会落到文本下方（光标到文档尾）——先点容器拿焦点，
 *  再 Ctrl+Home 回文档首行 + End 到行尾，与点击落点解耦 */
async function focusEditorAtLineEnd(page: Page): Promise<void> {
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('helper', { timeout: 8000 })
  await page.locator('.monaco-editor .view-lines').first().click()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('End')
}

/** 建议面板里标签精确等于 text 的行（Monaco 模糊高亮会把 label 切进多个 span，
 *  用 .label-name 文本内容 + 锚定正则匹配；排除 TS worker 等其他 provider 的
 *  同前缀条目，点选不依赖排序） */
function suggestRow(page: Page, label: string) {
  return page.locator('.suggest-widget .monaco-list-row').filter({
    has: page.locator('.label-name', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  })
}

test.beforeAll(async () => {
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await unlockRes.json()) as { token?: string }).token || ''

  await cleanupProject()
  await cleanupRepo()
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, MAIN_FILE), MAIN_CONTENT)
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), '# demo\n')
  fs.mkdirSync(path.join(REPO_DIR, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, 'docs', 'guide.md'), '# guide\n')
  fs.mkdirSync(path.join(REPO_DIR, 'src', 'utils', 'nested'), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'utils', 'helpers.ts'), "export function helper() {\n  return 'helper'\n}\n")
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'utils', 'nested', 'deep.ts'), 'export const deep = 1\n')
  execFileSync('git', ['add', '.'], { cwd: REPO_DIR })
  execFileSync('git', ['commit', '-m', 'root: 路径补全夹具'], { cwd: REPO_DIR })
  await registerProject()
})

test.afterAll(async () => {
  await cleanupProject()
  await cleanupRepo()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: JSON.stringify({ local: null }),
  })
})

test('字符串内输 ./ 弹补全：真实文件+目录钻取，逐级选中插入相对路径', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openFile(page, MAIN_FILE)
  await focusEditorAtLineEnd(page)

  // 敲 ./ → / 触发字符命中 provider，基准=main.ts 所在目录（项目根）
  await page.keyboard.type('./')
  await expect(page.locator('.suggest-widget')).toBeVisible({ timeout: 8000 })
  await expect(suggestRow(page, 'src/')).toBeVisible({ timeout: 8000 })
  await expect(suggestRow(page, 'README.md')).toBeVisible()

  // 过滤后点选目录钻取项 src/ → 落定后尾 / 再触发即下一级
  await page.keyboard.type('sr')
  await expect(suggestRow(page, 'src/')).toBeVisible({ timeout: 5000 })
  await suggestRow(page, 'src/').click()
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText("./src/", { timeout: 5000 })

  // Ctrl+Space 再触发 → src 的子目录 utils/（文件清单合成的钻取项）
  await page.keyboard.press('Control+Space')
  await expect(suggestRow(page, 'utils/')).toBeVisible({ timeout: 8000 })
  await page.keyboard.type('ti')
  await suggestRow(page, 'utils/').click()
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('./src/utils/', { timeout: 5000 })

  // 大小写不敏感模糊过滤：HE 命中 helpers.ts，点选插入 → 完整相对路径落定
  // （开引号是文件自带、闭引号从未敲过，路径后无引号属预期形态）
  await page.keyboard.press('Control+Space')
  await expect(suggestRow(page, 'helpers.ts')).toBeVisible({ timeout: 8000 })
  await page.keyboard.type('HE')
  await suggestRow(page, 'helpers.ts').click()
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('./src/utils/helpers.ts', { timeout: 5000 })
})

test('绝对路径形态触发补全：剥项目根映射逐级钻取回填相对形态；界外不响应', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openFile(page, MAIN_FILE)
  await focusEditorAtLineEnd(page)

  // 项目根的服务端形态正斜杠化（serverPath 已按拓扑翻译：同机 win=盘符形态，
  // 跨拓扑/WSL=posix 形态）；盘符形态压小写盘符验证大小写不敏感匹配
  const absRoot = serverPath(REPO_DIR).replace(/\\/g, '/')
  const driveForm = /^[A-Za-z]:\//.test(absRoot)
  const typedRoot = driveForm ? absRoot[0]!.toLowerCase() + absRoot.slice(1) : absRoot

  // 文档末另起一行落开引号（补全引号上下文前提），再敲绝对路径：中途的 / 逐个
  // 触发 provider（根前缀未齐=零条目），根+尾 / 齐了才出条目
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(`"${typedRoot}/src/`)
  await expect(page.locator('.suggest-widget')).toBeVisible({ timeout: 8000 })
  await suggestRow(page, 'utils/').click()
  // 整段绝对前缀替换回填 / 项目根相对形态（绝对形态仅作输入匹配键）
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('"/src/utils/', { timeout: 5000 })

  // 回填后尾 / 走既有 / 项目根相对链续钻：HE 模糊命中 helpers.ts 落定
  await page.keyboard.press('Control+Space')
  await page.keyboard.type('HE')
  await suggestRow(page, 'helpers.ts').click()
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('"/src/utils/helpers.ts', { timeout: 5000 })

  // 反斜杠双形态（盘符拓扑专属形态）：\ 触发字符 + 反斜杠路径逐级命中
  if (driveForm) {
    await page.keyboard.press('Control+End')
    await page.keyboard.press('Enter')
    await page.keyboard.type(`"${serverPath(REPO_DIR).replace(/\//g, '\\')}\\docs\\`)
    await expect(page.locator('.suggest-widget')).toBeVisible({ timeout: 8000 })
    await suggestRow(page, 'guide.md').click()
    await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('"/docs/guide.md', { timeout: 5000 })
  }

  // 界外绝对路径：引号+路径意图成立但未命中项目根 → 如实零条目不响应
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(driveForm ? '"C:\\Windows\\' : '"/etc/')
  await page.waitForTimeout(1500)
  await expect(page.locator('.suggest-widget')).not.toBeVisible()
})

test('代码区空行输 / 不误弹（无引号上下文零条目）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openFile(page, MAIN_FILE)
  await focusEditorAtLineEnd(page)

  // 文档末尾另起空行，首个击键就是 / ——无词字符不会拉起词建议，隔离本 provider 的判定
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.press('/')
  await page.waitForTimeout(1500)
  await expect(page.locator('.suggest-widget')).not.toBeVisible()
})

test('口语字符串输 / 不误弹（导航段非真实目录零条目）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openFile(page, MAIN_FILE)
  await focusEditorAtLineEnd(page)

  // 新行起一句口语再输 /：引号上下文成立但 hello world 不是清单里的真实目录
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('"hello world /')
  await page.waitForTimeout(1500)
  await expect(page.locator('.suggest-widget')).not.toBeVisible()
})
