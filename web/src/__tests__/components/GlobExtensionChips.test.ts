import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import GlobExtensionChips from '../../components/search/GlobExtensionChips.vue'

// 扩展名快选 chips 单测（P-20261003-148）：组件无自有状态（pattern 由宿主
// glob 输入持有），只断言两个纯契约——「pattern → 高亮派生」（双向联动的
// 读方向）与「点击 → 回写 payload」（写方向）；i18n 走 setup.ts 全局直译
// mock，tooltip 断言真实 zh 文案
const EXTENSIONS = ['ts', 'md', 'json', 'go'] as const

function mountChips(pattern = '') {
  return mount(GlobExtensionChips, { props: { pattern } })
}

function chip(w: ReturnType<typeof mountChips>, ext: string) {
  return w.find(`[data-testid="ps-ext-chip-${ext}"]`)
}

describe('GlobExtensionChips', () => {
  it('渲染 4 个高频扩展名 chip，空 pattern 时全部不亮', () => {
    const w = mountChips('')
    for (const e of EXTENSIONS) {
      expect(chip(w, e).exists()).toBe(true)
      expect(chip(w, e).text()).toBe(`.${e}`)
      expect(chip(w, e).attributes('aria-pressed')).toBe('false')
    }
  })

  it('双向联动（读）：pattern=*.md 精确等值 → 仅 .md 亮；手改成自定义 glob → 全灭', async () => {
    const w = mountChips('*.md')
    expect(chip(w, 'md').attributes('aria-pressed')).toBe('true')
    expect(chip(w, 'md').classes()).toContain('is-active')
    expect(chip(w, 'ts').attributes('aria-pressed')).toBe('false')
    // 手改 glob（宿主 v-model 回传）偏离 chip 形态 → 高亮熄灭，不猜语义
    await w.setProps({ pattern: 'packages/**' })
    for (const e of EXTENSIONS) {
      expect(chip(w, e).attributes('aria-pressed')).toBe('false')
    }
    // 改回 *.ts → .ts 重新点亮（glob 框是唯一事实源）
    await w.setProps({ pattern: '*.ts' })
    expect(chip(w, 'ts').attributes('aria-pressed')).toBe('true')
    expect(chip(w, 'md').attributes('aria-pressed')).toBe('false')
  })

  it('点击回写（写）：点 chip emit update:pattern=*.ext；再点已亮 chip 清空', async () => {
    const w = mountChips('')
    await chip(w, 'md').trigger('click')
    expect(w.emitted()['update:pattern']).toEqual([['*.md']])
    // 再点 = 清除过滤（回「不过滤」）
    await w.setProps({ pattern: '*.md' })
    await chip(w, 'md').trigger('click')
    expect(w.emitted()['update:pattern']).toEqual([['*.md'], ['']])
  })

  it('单选覆盖：已亮 .md 时点 .go → 直接换预填 *.go（不做多 chip 布尔组合）', async () => {
    const w = mountChips('*.md')
    await chip(w, 'go').trigger('click')
    expect(w.emitted()['update:pattern']).toEqual([['*.go']])
  })

  it('Enter 键激活不冒泡：焦点在 chip 上按 Enter 触发本 chip 而非卡片级「打开活动匹配」', async () => {
    const w = mountChips('')
    await chip(w, 'json').trigger('keydown', { key: 'Enter' })
    expect(w.emitted()['update:pattern']).toEqual([['*.json']])
  })

  it('tooltip 双语走 i18n：未亮=限定为 *.ext，已亮=清除（含当前 glob）', () => {
    const w = mountChips('')
    expect(chip(w, 'md').attributes('title')).toBe('文件过滤限定为 *.md')
    const active = mountChips('*.md')
    expect(chip(active, 'md').attributes('title')).toBe('清除扩展名过滤（当前 *.md）')
  })
})
