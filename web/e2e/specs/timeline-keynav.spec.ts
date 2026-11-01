import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, fixedLocale, waitForAppReady, setLockEnabled, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 回放时间线键盘导航 E2E（P-20261003-224）：导航三件（P-89 搜索 / P-132 进度条 /
 * P-185 复制）的键盘化补全——
 *   ① ↑↓ 移动 roving 高亮（is-nav，FileTreeView 键盘导航同款）：首按从视口中线
 *      条目起步、到边即停；Enter 复制该轮（P-185 链，剪贴板 = 遮蔽视图纯文本）；
 *   ② / 直达搜索框（VS Code 列表同款惯例）；搜索框内 / 是普通字符（INPUT 守卫）；
 *   ③ 「仅命中」下 roving 域 = 命中集：↑↓ 只在命中内移动（P-182 renderList 域）。
 *
 * 前置：simple-coding 已运行。fixture 同机拓扑限定（服务端直读其所在文件系统的
 * ~/.claude/projects，session-copy-message.spec.ts 同款约定——4 步 transcript
 * 标记 [e2e-kn]，utimes 控制在 activeWindow 5 分钟外，afterAll 精确删除）；弹层经
 * ?session= 深链直达（不开列表宿主，聚焦时间线本体）。
 */

const MARK = '[e2e-kn]'
const SESSION_ID = 'e2e-kn-b3c4d5e6-f7a8'
const STEP_TEXTS = [
  `${MARK} 键盘步骤 0 alpha`,
  `${MARK} 键盘步骤 1 beta`,
  `${MARK} 键盘步骤 2 gamma`,
  `${MARK} 键盘步骤 3 beta 两处命中用`,
]

const FAKE_CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects', 'e2e-kn-fixtures')

/** 播种 fixture transcript：4 条 user 步（时间正序，每步隔 1 分钟） */
function seedTranscript() {
  fs.mkdirSync(FAKE_CLAUDE_DIR, { recursive: true })
  const file = path.join(FAKE_CLAUDE_DIR, `${SESSION_ID}.jsonl`)
  const cwd = path.join(os.tmpdir(), 'sc-e2e-kn-proj')
  const lines = [`{"type":"last-prompt","sessionId":"${SESSION_ID}"}`]
  STEP_TEXTS.forEach((text, i) => {
    const at = new Date(Date.now() - (20 - i) * 60_000).toISOString()
    lines.push(JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: text },
      timestamp: at, cwd, sessionId: SESSION_ID,
    }))
  })
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  // mtime 留 10 分钟余量：落在服务端 activeWindow(5 分钟) 外
  const mt = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, mt, mt)
}

test.beforeAll(() => {
  // 残留 fixture 先清（前次异常中断的兜底），再播种本轮
  try { fs.unlinkSync(path.join(FAKE_CLAUDE_DIR, `${SESSION_ID}.jsonl`)) } catch { /* gone */ }
  seedTranscript()
})

test.afterAll(() => {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  try { fs.unlinkSync(path.join(FAKE_CLAUDE_DIR, `${SESSION_ID}.jsonl`)) } catch { /* gone */ }
  try { fs.rmdirSync(FAKE_CLAUDE_DIR) } catch { /* non-empty or gone */ }
})

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 关掉锁定开关（服务端全局，跨用例持续）：后续深链 goto 走直连（session-copy-message
 *  同款规避——gotoAndUnlock 的 ~5s 遮罩轮询拖慢每条用例） */
async function disableLock(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await setLockEnabled(page, false)
}

async function openReplay(page: Page) {
  await page.goto(`${API_BASE}/project?session=${SESSION_ID}`)
  await waitForAppReady(page)
  const modal = page.locator('.n-modal .cstl-root')
  await expect(modal).toBeVisible({ timeout: 20000 })
  await expect(modal.locator('.cstl-step')).toHaveCount(4, { timeout: 10000 })
  return modal
}

test.describe('回放时间线键盘导航（P-20261003-224）', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await disableLock(page)
  })

  test('↑↓ 移动 roving 高亮（首按从当前条目起步、到边即停），Enter 复制该轮入剪贴板', async ({ page }) => {
    const modal = await openReplay(page)
    const list = modal.locator('.cstl-list')
    await list.focus()

    // 首按 ↓：从视口中线条目（可见Idx 0）起步——高亮落在首条
    await page.keyboard.press('ArrowDown')
    const nav = modal.locator('.cstl-step.is-nav')
    await expect(nav).toHaveCount(1)
    await expect(nav).toContainText('键盘步骤 0')

    // ↓ 下移 / ↑ 回移：高亮随键位移
    await page.keyboard.press('ArrowDown')
    await expect(modal.locator('.cstl-step.is-nav')).toContainText('键盘步骤 1')
    await page.keyboard.press('ArrowUp')
    await expect(modal.locator('.cstl-step.is-nav')).toContainText('键盘步骤 0')

    // Enter 复制当前高亮轮（P-185 链）：toast + 剪贴板 = 正文纯文本。
    // 剪贴板回读剥 \r（Windows Chromium 剪贴板层把 \n 规范化回 \r\n，应用侧不可控）
    await page.keyboard.press('Enter')
    await expect(page.locator('.n-message').filter({ hasText: '本条内容已复制' })).toBeVisible({ timeout: 5000 })
    const raw = await page.evaluate(() => navigator.clipboard.readText())
    expect(raw.replace(/\r/g, '')).toBe(STEP_TEXTS[0])

    // 到边即停：首条再 ↑ 不动（无 is-nav 漂移）
    await page.keyboard.press('ArrowUp')
    await expect(modal.locator('.cstl-step.is-nav')).toContainText('键盘步骤 0')

    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })

  test('/ 直达搜索框；搜索框内 / 是普通字符（INPUT 守卫）', async ({ page }) => {
    const modal = await openReplay(page)
    const input = modal.locator('[data-test="timeline-search-input"] input')

    await modal.locator('.cstl-list').focus()
    await page.keyboard.press('/')
    await expect(input).toBeFocused()

    // 焦点在输入框内：/ 不被导航接管，作为字符进入查询词
    await page.keyboard.press('/')
    await expect(input).toHaveValue('/')

    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })

  test('「仅命中」下 ↑↓ 只在命中集内移动（roving 域 = renderList）', async ({ page }) => {
    const modal = await openReplay(page)
    const input = modal.locator('[data-test="timeline-search-input"] input')
    const list = modal.locator('.cstl-list')

    // beta 命中 step1 / step3 两处；「仅命中」后渲染域只剩这两条
    await input.fill('beta')
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveText('2 处命中')
    await modal.locator('[data-test="timeline-search-hits-only"]').click()
    await expect(modal.locator('.cstl-step')).toHaveCount(2)

    await list.focus()
    await page.keyboard.press('ArrowDown')
    await expect(modal.locator('.cstl-step.is-nav')).toContainText('键盘步骤 1')
    await page.keyboard.press('ArrowDown')
    await expect(modal.locator('.cstl-step.is-nav')).toContainText('键盘步骤 3')
    // 域末再 ↓：钳住不回绕（数百条级列表回绕会整屏跳变）
    await page.keyboard.press('ArrowDown')
    await expect(modal.locator('.cstl-step.is-nav')).toContainText('键盘步骤 3')

    await page.locator('.n-modal .n-base-close').first().click()
    await expect(modal).toHaveCount(0)
  })
})
