import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  EXPECTED_TOKENS,
  parseTokenDefinitions,
  scanText,
  validateTokens,
} from '../../scripts/check-design-tokens.mjs'

/**
 * 设计令牌三轴契约（P-20261019-8）：
 *   - main.css 的 :root 必须提供圆角/间距/字重三轴令牌且数值不漂移；
 *   - 首批高频面（Git 面板/设置/活动栏/顶栏/状态栏）的样式段不得再出现
 *     可令牌化的 on-scale 字面量（4/8/12/16px、400/500/600）——新增样式
 *     漏用 token 会在这里变红，而不是等视觉审计发现；
 *   - 扫描器分类口径（on-scale / micro / off-scale / 注释忽略）用合成用例锁定。
 */

const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const HOT_FILES = [
  'src/views/git/GitPanel.vue',
  'src/views/git/commit-panel.css',
  'src/views/git/commits-panel.css',
  'src/components/git/BranchCapsule.vue',
  'src/components/git/GitBranchesSection.vue',
  'src/components/git/GitRemotesSection.vue',
  'src/components/git/GitWorktreesSection.vue',
  'src/components/settings/settings-modal.css',
  'src/components/settings/security-settings.css',
  'src/components/settings/AppearanceSettings.vue',
  'src/components/settings/TerminalSettings.vue',
  'src/components/layout/ActivityBar.vue',
  'src/components/layout/TopBar.vue',
  'src/components/layout/StatusBar.vue',
]

function read(rel: string): string {
  return fs.readFileSync(path.join(WEB_ROOT, rel), 'utf-8')
}

describe('设计令牌定义（main.css :root）', () => {
  it('圆角 4/6/10、间距 4/8/12/16、字重 400/500/600 全部存在且数值精确', () => {
    const defs = parseTokenDefinitions(read('src/assets/main.css'))
    expect(validateTokens(defs)).toEqual([])
    expect(defs).toEqual(EXPECTED_TOKENS)
  })
})

describe('高频面令牌消费', () => {
  it('Git 面板/设置/活动栏/顶栏/状态栏均引用三轴令牌', () => {
    const all = HOT_FILES.map(read).join('\n')
    for (const token of [
      '--radius-sm',
      '--radius-md',
      '--radius-lg',
      '--space-1',
      '--space-2',
      '--space-3',
      '--space-4',
      '--fw-medium',
      '--fw-semibold',
    ]) {
      expect(all, `高频面未消费 ${token}`).toContain(`var(${token})`)
    }
  })

  it('高频面不再残留可令牌化的 on-scale 字面量（4/8/12/16px、400/500/600）', () => {
    const leftovers = HOT_FILES.flatMap((rel) =>
      scanText(read(rel), rel).filter((h) => h.kind === 'on-scale'),
    )
    expect(
      leftovers,
      `以下位置应改用 var(--radius-*/--space-*/--fw-*)：\n${
        leftovers.map((h) => `${h.rel}:${h.line} ${h.prop}: ${h.value}`).join('\n')
      }`,
    ).toEqual([])
  })

  it('核心容器计算值锚点源码就位（设置弹窗/Git 侧栏/顶栏按钮组/活动栏）', () => {
    const settings = read('src/components/settings/settings-modal.css')
    expect(settings).toMatch(/\.settings-card\s*{[^}]*border-radius:\s*var\(--radius-lg\)/)
    expect(settings).toMatch(/\.settings-footer\s*{[^}]*gap:\s*var\(--space-2\)/)

    const git = read('src/views/git/GitPanel.vue')
    expect(git).toMatch(/\.sidebar-header\s*{[^}]*padding:\s*0 var\(--space-2\)/)
    expect(git).toMatch(/\.sidebar-toggle\s*{[^}]*border-radius:\s*var\(--radius-sm\)/)

    const topBar = read('src/components/layout/TopBar.vue')
    expect(topBar).toMatch(/\.header-btn-group\s*{[^}]*border-radius:\s*var\(--radius-md\)/)

    const rail = read('src/components/layout/ActivityBar.vue')
    expect(rail).toMatch(/\.rail-bottom\s*{[^}]*padding:\s*var\(--space-2\) 0 var\(--space-3\)/)
  })
})

describe('扫描器分类口径', () => {
  it('on-scale / micro / off-scale / 注释忽略 / 非目标属性', () => {
    const hits = scanText(`<style>
      .a { border-radius: 4px; padding: 4px 8px; font-weight: 600; }
      .b { border-radius: 50%; }
      .c { gap: 2px; }
      .d { border-radius: 8px; padding: 6px 10px; font-weight: 700; }
      /* .e { border-radius: 8px; } */
      .f { width: 6px; height: 4px; }
    </style>`)
    const count = (kind: string) => hits.filter((h) => h.kind === kind).length
    expect(count('on-scale')).toBe(4) // radius 4px / padding 4px+8px / fw 600
    expect(count('micro')).toBe(1) // gap 2px
    expect(count('shape')).toBe(1) // border-radius 50%
    expect(count('off-scale')).toBe(4) // radius 8px / padding 6px+10px / fw 700
    expect(hits.some((h) => h.prop === 'width' || h.prop === 'height')).toBe(false)
  })
})
