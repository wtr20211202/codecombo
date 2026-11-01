import { test, expect, type Page } from '@playwright/test'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * Claude 会话上下文压力徽标 E2E（P-20261002-58）：播种含 usage 元数据的活跃
 * transcript fixture，agent 侧栏 Claude 页签的活跃会话行出现余量徽标，档位
 * （弱化/黄/红）与估算百分比正确；无 usage 数据的活跃会话无徽标。
 *
 * 前置：simple-coding 已运行（含 /api/claude/sessions?withPressure=true）。
 *
 * 测试数据：写入真实 ~/.claude/projects/D--e2e-pressure-fixtures（与
 * claude-timeline.spec.ts 同款约定，标题带 [e2e-press-*] 标记）。与回放
 * spec 相反，这里刻意【不】回拨 mtime——保持新鲜才会被判活跃，活跃会话
 * 才携带压力估算。afterAll 精确删除 fixture 文件。
 *
 * 档位与用量（估算 = input+cache_creation+cache_read+output，÷200k 窗口）：
 *   low     60_000 → 30%（弱化）
 *   warn   170_000 → 85%（黄，title 建议 /compact）
 *   edge   180_000 → 90%（黄，余量恰 10%——P-141 低余量警示压线不亮）
 *   danger 195_000 → 97.5%（红，title 建议 /compact 或新会话）
 *
 * 低余量警示（P-20261003-141）：余量 <10%（严格小于）的行恒显「上下文将满」
 * 警示标且接力动作常显（活跃行本无接力入口，低余量是唯一例外——主动换代）；
 * 余量充足/压线行两标识均不出现。
 *
 * 拓扑说明：服务端直读其所在文件系统的 ~/.claude/projects，本用例仅在
 * 服务实例与测试同机的拓扑下可跑（与 claude-timeline.spec.ts 一致）。
 */

const FAKE_DIR_NAME = 'D--e2e-pressure-fixtures'
const FIXTURE_CWD_JSON = 'D:\\\\e2e-pressure-fixtures'
const createdFiles: string[] = []

/** usage 快照（token 计数） */
interface UsageTokens {
  input: number
  cc: number
  cr: number
  out: number
}

const FIXTURES: { id: string; marker: string; usage: UsageTokens | null; badge: string; tier: string }[] = [
  {
    id: 'e2e-press-low',
    marker: '[e2e-press-low]',
    usage: { input: 50000, cc: 8000, cr: 0, out: 2000 },
    badge: '≈30%',
    tier: 'is-low',
  },
  {
    id: 'e2e-press-warn',
    marker: '[e2e-press-warn]',
    usage: { input: 140000, cc: 0, cr: 28000, out: 2000 },
    badge: '≈85%',
    tier: 'is-warn',
  },
  {
    id: 'e2e-press-edge',
    marker: '[e2e-press-edge]',
    // 180k/200k = 恰 90.0%：余量恰 10%，P-141 低余量警示的严格小于边界
    //（<10% 才警示）——压线不警示
    usage: { input: 175000, cc: 3000, cr: 0, out: 2000 },
    badge: '≈90%',
    tier: 'is-warn',
  },
  {
    id: 'e2e-press-danger',
    marker: '[e2e-press-danger]',
    usage: { input: 185000, cc: 6000, cr: 2000, out: 2000 },
    badge: '≈98%', // 97.5% 四舍五入
    tier: 'is-danger',
  },
  {
    id: 'e2e-press-nousage',
    marker: '[e2e-press-nousage]',
    usage: null, // 无 usage 数据：活跃但徽标缺省（「无数据」≠「零压力」）
    badge: '',
    tier: '',
  },
]

/** 播种一条活跃会话 fixture：用户消息 + assistant usage 尾注（新鲜 mtime） */
function buildFixtures() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  for (const f of FIXTURES) {
    const at1 = new Date(now - 4 * 60_000).toISOString()
    const at2 = new Date(now - 2 * 60_000).toISOString()
    const usageJSON = f.usage
      ? `,"usage":{"input_tokens":${f.usage.input},"cache_creation_input_tokens":${f.usage.cc},"cache_read_input_tokens":${f.usage.cr},"output_tokens":${f.usage.out}}`
      : ''
    const lines = [
      `{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"${f.marker} 压力测试会话"},"timestamp":"${at1}","cwd":"${FIXTURE_CWD_JSON}"}`,
      `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]${usageJSON}},"timestamp":"${at2}"}`,
    ]
    const file = path.join(dir, `${f.id}.jsonl`)
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
    createdFiles.push(file)
  }
}

function cleanupFixtures() {
  if (process.env.SC_KEEP_FIXTURES) return // 调试用：保留 fixture
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* already gone */ }
  }
  try { fs.rmdirSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)) } catch { /* non-empty or gone */ }
}

/** 打开 agent 侧栏 Claude 页签（scope=global，与 claude-timeline.spec.ts 同款入口） */
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

test.describe('Claude 会话上下文压力徽标（P-20261002-58）', () => {
  test.beforeAll(() => {
    buildFixtures()
  })

  test.afterAll(() => {
    cleanupFixtures()
  })

  test('活跃会话行三档徽标：档位类与估算百分比正确', async ({ page }) => {
    const picker = await openClaudeTab(page)
    for (const f of FIXTURES.filter(x => x.usage)) {
      const row = picker.locator('.csp-row').filter({ hasText: f.marker })
      await expect(row).toBeVisible({ timeout: 8000 })
      const badge = row.locator('.csp-row-pressure')
      await expect(badge).toBeVisible()
      await expect(badge).toHaveClass(new RegExp(f.tier))
      // 徽标文本 ≈NN%（round 后）+ title 提示带 ≈NN% 与 /compact 建议（黄/红档）
      await expect(badge).toHaveText(f.badge)
      const title = await badge.getAttribute('title')
      expect(title).toContain(f.badge)
      if (f.tier !== 'is-low') {
        expect(title).toContain('/compact')
      }
      if (f.tier === 'is-danger') {
        expect(title).toContain('开启新会话')
      }
    }
  })

  test('无 usage 数据的活跃会话无徽标', async ({ page }) => {
    const picker = await openClaudeTab(page)
    const row = picker.locator('.csp-row').filter({ hasText: '[e2e-press-nousage]' })
    await expect(row).toBeVisible({ timeout: 8000 })
    // 该行仍是活跃会话（进行中徽标在），但无压力估算 → 徽标缺省
    await expect(row.locator('.csp-row-live')).toBeVisible()
    await expect(row.locator('.csp-row-pressure')).toHaveCount(0)
  })

  test('低余量警示（P-20261003-141）：余量<10% 警示标+接力动作出现，余量充足无标', async ({ page }) => {
    const picker = await openClaudeTab(page)

    // 危险档 97.5%（余量 2.5%）：「上下文将满」警示标出现（title 指向接力建议），
    // 同行接力动作常显——活跃行本无接力入口（is-lowctx 类即「低余量放开且常显」）
    const dangerRow = picker.locator('.csp-row').filter({ hasText: '[e2e-press-danger]' })
    await expect(dangerRow).toBeVisible({ timeout: 8000 })
    const lowctx = dangerRow.locator('[data-test="session-lowctx"]')
    await expect(lowctx).toBeVisible()
    await expect(lowctx).toHaveText('上下文将满')
    await expect(lowctx).toHaveAttribute('title', /不足 10%/)
    const relay = dangerRow.locator('[data-test="session-relay"]')
    await expect(relay).toHaveCount(1)
    await expect(relay).toHaveClass(/is-lowctx/)

    // 压线 90%（余量恰 10%）与充足 85%：警示标与接力入口均不出现
    //（严格小于语义 + 活跃行守卫不被误放开）
    for (const marker of ['[e2e-press-edge]', '[e2e-press-warn]']) {
      const row = picker.locator('.csp-row').filter({ hasText: marker })
      await expect(row).toBeVisible({ timeout: 8000 })
      await expect(row.locator('[data-test="session-lowctx"]')).toHaveCount(0)
      await expect(row.locator('[data-test="session-relay"]')).toHaveCount(0)
    }
  })

  test('警示阈值用户可调（P-20261006-33）：滑条调 20% → 低余量警示提前触发且跨重载持久', async ({ page }) => {
    const picker = await openClaudeTab(page)

    // 基线（出厂档 10%）：90% 压线行无警示——「提前触发」的对照面
    const edgeRow = picker.locator('.csp-row').filter({ hasText: '[e2e-press-edge]' })
    await expect(edgeRow).toBeVisible({ timeout: 8000 })
    await expect(edgeRow.locator('[data-test="session-lowctx"]')).toHaveCount(0)

    // 设置·通用·智能体分区滑条直写 20%（设备本地偏好 contextWarn store，即时生效）
    await page.locator('[data-testid="rail-settings"]').click()
    const modal = page.locator('.n-modal.settings-modal')
    await expect(modal).toBeVisible({ timeout: 3000 })
    await page.getByTestId('settings-nav-general').click()
    const thresholdRow = modal.locator('[data-testid="settings-context-warn-threshold"]')
    await expect(thresholdRow).toBeVisible()
    // 原生 range 滑条经 input 事件写 store（diff-font-size-follow 同款驱动姿势）
    await thresholdRow.locator('input[type="range"]').evaluate((el, v) => {
      const input = el as HTMLInputElement
      input.value = String(v)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }, 20)
    await expect(thresholdRow.locator('[data-testid="settings-context-warn-value"]')).toHaveText('20%')
    await modal.locator('.settings-close').click()
    await expect(modal).toHaveCount(0)

    // 警示提前触发：余量 10% 的压线行进警示（tip 随实际档位出数）、活跃行接力
    // 入口同口径放开；余量 15% 的 85% 行一并入警；余量 70% 的行不误伤
    await expect(edgeRow.locator('[data-test="session-lowctx"]')).toBeVisible()
    await expect(edgeRow.locator('[data-test="session-lowctx"]')).toHaveAttribute('title', /不足 20%/)
    await expect(edgeRow.locator('[data-test="session-relay"]')).toHaveCount(1)
    const warnRow = picker.locator('.csp-row').filter({ hasText: '[e2e-press-warn]' })
    await expect(warnRow.locator('[data-test="session-lowctx"]')).toBeVisible()
    const lowRow = picker.locator('.csp-row').filter({ hasText: '[e2e-press-low]' })
    await expect(lowRow.locator('[data-test="session-lowctx"]')).toHaveCount(0)

    // 设备本地持久：原页整页重载后阈值档仍生效（store 启动读 localStorage）。
    // 不重走首页卡片链——uiState 已记住 agent 终端浮层，重载后恢复在场会盖住
    // 项目卡（点击被拦截）；在位即直接复用，未恢复才走 rail 按钮链
    await gotoAndUnlock(page, page.url())
    const view2 = page.locator('.atv-root')
    if (!await view2.isVisible()) {
      await page.locator('.rail-btn[title="终端会话管理"]').click()
    }
    await expect(view2).toBeVisible({ timeout: 10000 })
    const picker2 = view2.locator('.csp-root')
    if (!await picker2.isVisible()) {
      await view2.locator('.ats-tab', { hasText: 'Claude' }).click()
    }
    await expect(picker2).toBeVisible({ timeout: 8000 })
    await expect(
      picker2.locator('.csp-row').filter({ hasText: '[e2e-press-edge]' }).locator('[data-test="session-lowctx"]'),
    ).toBeVisible()
  })
})
