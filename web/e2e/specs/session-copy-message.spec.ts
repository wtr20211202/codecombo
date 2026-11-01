import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, fixedLocale, waitForAppReady, setLockEnabled, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 回放单条消息复制 E2E（P-20261003-185）：时间线步骤 hover 浮现「复制本条内容」
 * 钮，该条以纯文本入剪贴板（P-44 渲染链单条口径剥格式）——选区复制受渲染结构
 * 干扰（选中含 meta 行/折叠块等 UI 元素），item 级复制是结论引用进笔记/文档的
 * 顺手出口。
 *   ① user 条目：剪贴板 = 正文原样（无 meta 行的种类标签/时刻等 UI 残留）；
 *      含 sca_ 令牌时按展示面同一防线复制遮蔽形态 ***（所见即所复制）
 *   ② tool 条目：工具名+输入摘要两行，无 markdown 装饰（P-44 单条口径剥格式）
 *   ③ assistant 结论条目：剪贴板 = 正文原样，可直接粘贴引用
 *
 * 前置：simple-coding 已运行。fixture 同机拓扑限定（服务端直读其所在文件系统的
 * ~/.claude/projects，session-deeplink.spec.ts 同款约定——4 步 transcript 标记
 * [e2e-scm]，utimes 控制在 activeWindow 5 分钟外，afterAll 精确删除）；弹层经
 * ?session= 深链直达（不开列表宿主，聚焦时间线本体）。
 */

const MARK = '[e2e-scm]'
const SESSION_ID = 'e2e-scm-a1b2c3d4-e5f6'
// 令牌含 sca_ 前缀（P-108 模式集 ①）：默认遮蔽视图下复制出口应得 *** 形态
const TOKEN = 'sca_e2escmT0k3nXy7Qw'
const USER_TEXT = `${MARK} 把 *星号* 与「引号」写进正文 ${TOKEN}`
const TOOL_INPUT = `echo hi-from-${MARK.replace(/[[\]]/g, '')}`
const ASSISTANT_TEXT = `${MARK} 结论：普通文本无装饰`

const FAKE_CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects', 'e2e-scm-fixtures')

/** 播种 fixture transcript：user → tool_use → tool_result → assistant 结论
 *  四步（时间正序，每步隔 1 分钟），行内 cwd 随意（内容复制不做项目反查） */
function seedTranscript() {
  fs.mkdirSync(FAKE_CLAUDE_DIR, { recursive: true })
  const file = path.join(FAKE_CLAUDE_DIR, `${SESSION_ID}.jsonl`)
  const cwd = path.join(os.tmpdir(), 'sc-e2e-scm-proj')
  const at = (i: number) => new Date(Date.now() - (20 - i) * 60_000).toISOString()
  const lines = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: USER_TEXT },
      timestamp: at(0), cwd, sessionId: SESSION_ID,
    }),
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: TOOL_INPUT } }] },
      timestamp: at(1), cwd, sessionId: SESSION_ID,
    }),
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok-output' }] },
      timestamp: at(2), cwd, sessionId: SESSION_ID,
    }),
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: ASSISTANT_TEXT }] },
      timestamp: at(3), cwd, sessionId: SESSION_ID,
    }),
  ]
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

/** 关掉锁定开关（服务端全局，跨用例持续）：后续深链 goto 走直连（session-deeplink
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

/** hover 目标步浮现复制钮 → 点击 → 断言 toast 与剪贴板内容。
 *  剪贴板回读换行归一：应用侧恒写 LF，Windows 的 Chromium 剪贴板 readText
 *  会把写入的 \n 规范化回 \r\n（OS 剪贴板层行为、应用侧不可控，search-copy-paths
 *  同款归一）——断言前剥 \r，与粘贴消费方语义一致 */
async function copyStepAndReadClipboard(page: Page, modal: ReturnType<Page['locator']>, idx: number): Promise<string> {
  const step = modal.locator(`.cstl-step[data-step="${idx}"]`)
  await step.hover()
  await step.locator('[data-test="timeline-copy-text"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '本条内容已复制' })).toBeVisible({ timeout: 5000 })
  const raw = await page.evaluate(() => navigator.clipboard.readText())
  return raw.replace(/\r/g, '')
}

test.describe('回放单条消息复制（P-20261003-185）', () => {
  test.beforeEach(async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await disableLock(page)
  })

  test('user 条目：剪贴板 = 正文原样（无 meta 行 UI 残留），令牌按遮蔽形态复制', async ({ page }) => {
    const modal = await openReplay(page)
    const text = await copyStepAndReadClipboard(page, modal, 0)
    // 逐字相等 = 无格式残留：种类标签/时刻/相对时间等 meta 行内容一律不在
    expect(text).toBe(`${MARK} 把 *星号* 与「引号」写进正文 ***`)
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('用户')
    // 展示面不因复制改变：步骤仍呈遮蔽形态
    await expect(modal.locator('.cstl-step[data-step="0"]')).toContainText('***')
  })

  test('tool 条目：工具名+输入摘要两行纯文本（无 markdown 装饰）', async ({ page }) => {
    const modal = await openReplay(page)
    const text = await copyStepAndReadClipboard(page, modal, 1)
    expect(text).toBe(`Bash\n${TOOL_INPUT}`)
    // 剥格式：P-44 渲染链的强调/行内码/emoji 装饰一律不进剪贴板
    expect(text).not.toContain('**')
    expect(text).not.toContain('`')
    expect(text).not.toContain('🔧')
  })

  test('assistant 结论条目：正文原样入剪贴板，可直接粘贴引用', async ({ page }) => {
    const modal = await openReplay(page)
    const text = await copyStepAndReadClipboard(page, modal, 3)
    expect(text).toBe(ASSISTANT_TEXT)
  })
})
