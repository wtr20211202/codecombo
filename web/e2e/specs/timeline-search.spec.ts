import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 回放时间线内搜索 E2E（P-20261002-81）：回放弹层头部搜索框对已加载条目
 * （正文/工具名/输入摘要）子串过滤——命中计数徽标（大小写不敏感）、
 * Enter/Shift+Enter 命中间循环跳转（工具输入命中自动展开折叠块）、
 * 「仅命中」紧凑模式（隐藏未命中步骤 + 零命中空态 + 清空退出）。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions/:id/timeline）。
 *
 * 测试数据：播种一条 10 步 fixture transcript 到真实 ~/.claude/projects
 *（与 claude-timeline.spec.ts 同款约定——标题带 [e2e-ts] 标记，utimes 控制
 * 在 activeWindow(5 分钟) 之外避免被判「进行中」），afterAll 精确删除。
 * 关键词分两组：zebra-unicorn 命中 user 正文 + 工具输入；QUARK-42 命中
 * 工具输入 + result 摘要（验证跳转游标在多命中间移动与折叠块自动展开）。
 * 末步正文含括号字面（(revert），供正则开关用例（P-20261003-196）的非法
 * 正则降级字面命中。回放链路只读，不创建终端会话。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与既有 claude-timeline.spec.ts 一致）。
 */

const MARK = '[e2e-ts]'
const FAKE_DIR_NAME = 'D--e2e-ts-fixtures'
const SESSION_ID = 'e2e-ts-b2c3d4e5-f6a7'
// 10 步 < 首屏 limit(50)：全部条目一屏加载完，搜索即对全部条目生效
const createdFiles: string[] = []

/** 播种 fixture transcript：user/assistant/tool/result 混合 10 步（时间正序） */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  const at = (i: number) => new Date(Date.now() - (20 - i) * 60_000).toISOString()
  const lines: string[] = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
    // 步骤 0：user 正文命中 zebra-unicorn
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} 把 zebra-unicorn 主题换成 coral"},"timestamp":"${at(0)}","cwd":"D:\\\\e2e-ts-fixtures"}`,
    // 步骤 1：assistant 纯文本（不命中）
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"好的，我先看一下当前主题配置"}]},"timestamp":"${at(1)}"}`,
    // 步骤 2：tool_use 输入摘要命中 zebra-unicorn；步骤 3：assistant 文本
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"themes/zebra-unicorn.json"}},{"type":"text","text":"改好了，请确认"}]},"timestamp":"${at(2)}"}`,
    // 步骤 4：tool_result（不命中）
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]},"timestamp":"${at(3)}"}`,
    // 步骤 5：user 正文（不命中搜索词）
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${MARK} 剩余 token 预算是多少"},"timestamp":"${at(4)}","cwd":"D:\\\\e2e-ts-fixtures"}`,
    // 步骤 6：tool_use 输入摘要命中 QUARK-42；步骤 7：assistant 文本
    `{"parentUuid":null,"isSidechain":false,"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"echo QUARK-42 budget"}},{"type":"text","text":"预算查询结果如下"}]},"timestamp":"${at(5)}"}`,
    // 步骤 8：tool_result 摘要命中 QUARK-42
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"QUARK-42 budget remaining"}]},"timestamp":"${at(6)}"}`,
    // 步骤 9：正文含括号字面（P-20261003-196 非法正则「(revert」降级字面的命中目标）
    `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"回滚 (revert) 上一次发布"},"timestamp":"${at(7)}","cwd":"D:\\\\e2e-ts-fixtures"}`,
  ]
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  // mtime/收尾部留 10 分钟余量：落在服务端 activeWindow(5 分钟) 外，行可交互
  const old = new Date(Date.now() - 10 * 60_000)
  fs.utimesSync(file, old, old)
  createdFiles.push(file)
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

async function openClaudeTab(page: Page) {
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.ats-tab', { hasText: 'Claude' }).click()
  const picker = view.locator('.csp-root')
  await expect(picker).toBeVisible({ timeout: 8000 })
  return picker
}

/** 打开 fixture 会话的回放弹层，断言 10 步全部就位后返回弹层 */
async function openReplay(page: Page) {
  const picker = await openClaudeTab(page)
  const searchResp = page.waitForResponse(r => r.url().includes('/claude/sessions') && r.url().includes('q='))
  await picker.locator('input').fill(MARK)
  await searchResp
  const row = picker.locator('.csp-row').filter({ hasText: MARK }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.hover()
  await row.locator('.csp-row-replay').click()
  const modal = page.locator('.n-modal .cstl-root')
  await expect(modal).toBeVisible({ timeout: 10000 })
  await expect(modal.locator('.cstl-step')).toHaveCount(10, { timeout: 15000 })
  return modal
}

test.describe('回放时间线内搜索（P-20261002-81）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('命中计数徽标：子串大小写不敏感，未命中步骤默认保持可见', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplay(page)
    const input = modal.locator('[data-test="timeline-search-input"] input')

    // 无查询词：徽标隐藏
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveCount(0)

    // user 正文（步骤 0）+ 工具输入摘要（步骤 2）两处命中，大小写不敏感
    await input.fill('ZEBRA-UNICORN')
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveText('2 处命中')
    await expect(modal.locator('.cstl-step.is-hit')).toHaveCount(2)
    // 默认全量展示（只高亮不过滤）
    await expect(modal.locator('.cstl-step')).toHaveCount(10)
  })

  test('Enter/Shift+Enter 命中间循环跳转：工具输入命中自动展开折叠块', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplay(page)
    const input = modal.locator('[data-test="timeline-search-input"] input')

    // QUARK-42 两处命中：步骤 6（工具输入摘要）+ 步骤 8（result 摘要）
    await input.fill('QUARK-42')
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveText('2 处命中')
    await expect(modal.locator('.cstl-input-pre')).toHaveCount(0) // 工具输入默认折叠

    // 第一处命中：步骤 6 的工具输入折叠块自动展开
    await input.press('Enter')
    await expect(modal.locator('.cstl-step[data-step="6"]')).toHaveClass(/is-hit-cur/)
    await expect(modal.locator('.cstl-input-pre')).toHaveCount(1)
    await expect(modal.locator('.cstl-input-pre')).toContainText('echo QUARK-42 budget')

    // 第二处命中：步骤 8
    await input.press('Enter')
    await expect(modal.locator('.cstl-step[data-step="8"]')).toHaveClass(/is-hit-cur/)

    // Shift+Enter 回退；首处命中继续回退循环到最后一处
    await input.press('Shift+Enter')
    await expect(modal.locator('.cstl-step[data-step="6"]')).toHaveClass(/is-hit-cur/)
    await input.press('Shift+Enter')
    await expect(modal.locator('.cstl-step[data-step="8"]')).toHaveClass(/is-hit-cur/)
  })

  test('「仅命中」紧凑模式：隐藏未命中步骤 + 零命中空态 + 清空自动退出', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplay(page)
    const input = modal.locator('[data-test="timeline-search-input"] input')
    const onlyBtn = modal.locator('[data-test="timeline-search-hits-only"]')

    await input.fill('zebra-unicorn')
    await onlyBtn.click()
    await expect(modal.locator('.cstl-step')).toHaveCount(2) // 未命中步骤全部隐藏
    await expect(modal.locator('.cstl-step.is-hit')).toHaveCount(2)
    await expect(onlyBtn).toHaveClass(/is-on/)

    // 零命中 + 仅命中 → 空态文案
    await input.fill('no-such-keyword')
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveText('0 处命中')
    await expect(modal.locator('.cstl-state')).toContainText('没有命中的步骤')

    // 清空查询：恢复全量，紧凑模式自动退出
    await input.fill('')
    await expect(modal.locator('.cstl-step')).toHaveCount(10)
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveCount(0)
    await expect(onlyBtn).not.toHaveClass(/is-on/)
  })

  test('正则开关（P-20261003-196）：开=模式一步命中，非法正则降级字面+提示，关=字面', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openReplay(page)
    const input = modal.locator('[data-test="timeline-search-input"] input')
    const regexBtn = modal.locator('[data-test="timeline-search-regex"]')

    // 关（默认字面）：「zebra|QUARK」按普通子串找 → 0 命中
    await input.fill('zebra|QUARK')
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveText('0 处命中')

    // 开：交替模式一次命中 4 步（user 正文 / 工具输入 / result 摘要各据其位）
    await regexBtn.click()
    await expect(regexBtn).toHaveClass(/is-on/)
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveText('4 处命中')
    await expect(modal.locator('.cstl-step.is-hit')).toHaveCount(4)

    // 非法正则：「(revert」未闭合组 → 降级字面命中步骤 9 + 就地警示徽标
    await input.fill('(revert')
    await expect(modal.locator('[data-test="timeline-search-regex-invalid"]')).toBeVisible()
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveText('1 处命中')

    // 关：回字面，「zebra.*coral」元字符失效 0 命中（合法查询提示本就不在场）；
    // 再开：同一查询按正则命中步骤 0
    await regexBtn.click()
    await input.fill('zebra.*coral')
    await expect(modal.locator('[data-test="timeline-search-regex-invalid"]')).toHaveCount(0)
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveText('0 处命中')
    await regexBtn.click()
    await expect(modal.locator('[data-test="timeline-search-hits"]')).toHaveText('1 处命中')
  })
})
