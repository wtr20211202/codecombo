import { describe, expect, it } from 'vitest'
import {
  SETTINGS_CONTROL_ANCHORS,
  SETTINGS_TAB_ICONS,
  SETTINGS_TAB_KEYS,
  SETTINGS_TAB_LABEL_KEYS,
  settingsAnchorWords,
  settingsKeywordKey,
} from './settingsSearch'

describe('设置分区注册表', () => {
  it('每个分区都有标题词条与图标（SettingsModal 左栏与命令面板共用的派生源）', () => {
    for (const tab of SETTINGS_TAB_KEYS) {
      // security 在 settingsTabs 下无独立词条，标题走 settings.securityTitle（源码表既定例外）
      const want = tab === 'security' ? 'settings.securityTitle' : `settingsTabs.${tab}`
      expect(SETTINGS_TAB_LABEL_KEYS[tab], tab).toBe(want)
      expect(SETTINGS_TAB_ICONS[tab], tab).toBeTruthy()
    }
  })

  it('关键词词条 key 与分区键一致（locale 侧按同键对齐）', () => {
    for (const tab of SETTINGS_TAB_KEYS) {
      expect(settingsKeywordKey(tab)).toBe(`settingsSearch.keywords.${tab}`)
    }
  })
})

describe('SETTINGS_CONTROL_ANCHORS', () => {
  it('锚点词并入分区 haystack：空格连接全部 match 词', () => {
    const words = settingsAnchorWords('general')
    expect(words).toContain('审批模式 approval mode')
    expect(words).toContain('项目规则 project rules CLAUDE.md AGENTS.md cursorrules')
    // 未配锚点的分区返回空串（haystack 拼接无害）
    expect(settingsAnchorWords('about')).toBe('')
  })

  it('controlId 不重复（同 testid 指向多行会让滚动定位歧义）', () => {
    const ids = Object.values(SETTINGS_CONTROL_ANCHORS)
      .flatMap(entries => (entries ?? []).map(a => a.controlId))
    expect(new Set(ids).size).toBe(ids.length)
  })
})
