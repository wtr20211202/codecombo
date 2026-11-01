import { describe, it, expect } from 'vitest'
import {
  SETTINGS_TRANSFER_VERSION, buildSettingsExportPayload, parseSettingsImport,
  sectionItems, countSectionDiffs, sanitizeFontPayload,
} from './settingsTransfer'
import { FONT_SETTINGS_KEY, AUTOSAVE_DELAY_MIN, AUTOSAVE_DELAY_MAX } from '../stores/font'
import { KEYMAP_OVERRIDES_STORAGE_KEY } from '../stores/keymap'
import { LOCALE_STORAGE_KEY } from '../stores/locale-constants'
import { THEME_SETTINGS_KEY } from '../stores/theme'
import { DND_STORAGE_KEY } from '../stores/dnd'

// 设置导出/导入纯函数族（P-20261005-4）：白名单聚合、版本硬门禁、分节投影
// 与差异摘要、font 载荷消毒——应用侧走各 store setter，此处守纯函数口径。

function reader(table: Record<string, string>) {
  return (key: string) => table[key] ?? null
}

describe('buildSettingsExportPayload — 白名单聚合', () => {
  it('逐键枚举白名单键；白名单外的键（令牌/凭据类）绝不入包', () => {
    const table: Record<string, string> = {
      [FONT_SETTINGS_KEY]: JSON.stringify({ sizes: { base: 17 }, editor: { tabSize: 2 }, uiFont: 'system' }),
      [KEYMAP_OVERRIDES_STORAGE_KEY]: JSON.stringify({ closeTab: 'ctrl+alt+w' }),
      [LOCALE_STORAGE_KEY]: 'en-US',
      [THEME_SETTINGS_KEY]: 'dracula',
      [DND_STORAGE_KEY]: JSON.stringify({ enabled: true, start: '22:00', end: '08:00', except: ['approval'] }),
      // 敏感键（不在白名单）：必须被无视
      'sc.unlockToken': 'secret-token',
      'some-credential': 'hunter2',
    }
    const payload = buildSettingsExportPayload(reader(table))
    expect(payload.scSettings).toBe(SETTINGS_TRANSFER_VERSION)
    expect(payload.version).toBe(SETTINGS_TRANSFER_VERSION)
    expect(payload.exportedAt).toBeTruthy()
    expect(Object.keys(payload.sections).sort()).toEqual(['font', 'keymap', 'locale', 'notify', 'theme'])
    expect((payload.sections.locale as string)).toBe('en-US')
    expect((payload.sections.theme as string)).toBe('dracula')
    expect((payload.sections.notify as Record<string, unknown>).dnd).toEqual({
      enabled: true, start: '22:00', end: '08:00', except: ['approval'],
    })
    // 整包序列化不出现敏感值
    expect(JSON.stringify(payload)).not.toContain('secret-token')
    expect(JSON.stringify(payload)).not.toContain('hunter2')
  })

  it('缺失键 = 默认值不入包；通知三开关的 0/1 哨兵解析为布尔；全默认导出 sections 为空', () => {
    const payload = buildSettingsExportPayload(reader({}))
    expect(Object.keys(payload.sections)).toHaveLength(0)

    const withSound = buildSettingsExportPayload(reader({ 'notify-sound': '0', 'notify-simple': '1' }))
    expect(withSound.sections.notify).toEqual({ sound: false, simple: true })
  })
})

describe('parseSettingsImport — 格式与版本门禁', () => {
  const valid = { scSettings: 1, version: 1, exportedAt: '2026-10-05T00:00:00Z', sections: { font: { sizes: { base: 17 } } } }

  it('非对象/缺标记/缺 sections → format', () => {
    expect(parseSettingsImport(null).ok).toBe(false)
    expect(parseSettingsImport('x').ok).toBe(false)
    expect(parseSettingsImport([valid]).ok).toBe(false)
    expect(parseSettingsImport({ version: 1, sections: {} }).ok).toBe(false)
    expect(parseSettingsImport({ scSettings: 1, version: 1 }).ok).toBe(false)
  })

  it('未知版本拒绝（version 门禁）', () => {
    const r = parseSettingsImport({ ...valid, version: 99 })
    expect(r).toEqual({ ok: false, reason: 'version' })
    expect(parseSettingsImport({ ...valid, version: 0 }).ok).toBe(false)
  })

  it('合法载荷：未知分节剥除，只留白名单分节', () => {
    const r = parseSettingsImport({
      ...valid,
      sections: { font: { sizes: { base: 17 } }, mystery: { a: 1 }, theme: 'light', bogus: null },
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(Object.keys(r.sections)).toEqual(['font', 'theme'])
      expect(r.exportedAt).toBe('2026-10-05T00:00:00Z')
    }
  })
})

describe('sanitizeFontPayload — font 节消毒', () => {
  it('字号钳制 [10,32] 取整；非有限数丢弃', () => {
    const s = sanitizeFontPayload({ sizes: { base: 5, editor: 19.6, terminal: 'x', diff: 200 } })
    expect(s.sizes).toEqual({ base: 10, editor: 20, diff: 32 })
  })

  it('editor 字段逐项类型/值域消毒：布尔收布尔、枚举收值域内、延时钳制', () => {
    const s = sanitizeFontPayload({
      editor: {
        tabSize: 2, insertSpaces: 'yes', minimap: false, stickyScroll: 1,
        wordWrap: 'on', renderWhitespace: 'bogus', autoSave: 'afterDelay',
        autoSaveDelayMs: 5, formatOnSave: true, gitStatusTabs: false,
        lineHeightMultiplier: 2.0,
        bracketColor: false,
      },
    })
    expect(s.editor.tabSize).toBe(2)
    expect(s.editor.insertSpaces).toBeUndefined()
    expect(s.editor.minimap).toBe(false)
    expect(s.editor.stickyScroll).toBeUndefined()
    expect(s.editor.wordWrap).toBe('on')
    expect(s.editor.renderWhitespace).toBeUndefined()
    expect(s.editor.autoSave).toBe('afterDelay')
    expect(s.editor.autoSaveDelayMs).toBe(AUTOSAVE_DELAY_MIN)
    expect(s.editor.formatOnSave).toBe(true)
    expect(s.editor.gitStatusTabs).toBe(false)
    expect(s.editor.lineHeightMultiplier).toBe(2)
    expect(s.editor.bracketColor).toBe(false)
    expect(sanitizeFontPayload({ editor: { autoSaveDelayMs: 99999 } }).editor.autoSaveDelayMs).toBe(AUTOSAVE_DELAY_MAX)
  })

  it('行高倍率只收合法档位：档位外/非数丢弃', () => {
    expect(sanitizeFontPayload({ editor: { lineHeightMultiplier: 1.5 } }).editor.lineHeightMultiplier).toBe(1.5)
    expect(sanitizeFontPayload({ editor: { lineHeightMultiplier: 9.9 } }).editor.lineHeightMultiplier).toBeUndefined()
    expect(sanitizeFontPayload({ editor: { lineHeightMultiplier: 'big' } }).editor.lineHeightMultiplier).toBeUndefined()
  })

  it('uiFont/terminalLigatures 只收合法枚举；非对象入参返回空载荷', () => {
    expect(sanitizeFontPayload({ uiFont: 'system', terminalLigatures: 'off' }).uiFont).toBe('system')
    expect(sanitizeFontPayload({ uiFont: 'comic' }).uiFont).toBeUndefined()
    expect(sanitizeFontPayload('x')).toEqual({ sizes: {}, editor: {} })
  })

  it('monoFontName 消毒入包；空值/非法类型剥除不触碰本机值（P-20261005-227）', () => {
    expect(sanitizeFontPayload({ monoFontName: "  'Fira'; Code\" " }).monoFontName).toBe('Fira Code')
    // 空串 = 内置栈缺省 → 剥除（导入端保持本机已设名字不被覆盖）
    expect(sanitizeFontPayload({ monoFontName: '' }).monoFontName).toBeUndefined()
    expect(sanitizeFontPayload({ monoFontName: 42 }).monoFontName).toBeUndefined()
    // 投影侧同名入条
    const items = sectionItems('font', { monoFontName: 'Fira Code' })
    expect(items.monoFontName).toBe('Fira Code')
  })

  it('diffPalette 只收合法枚举；值域外剥除不触碰本机值（P-20261006-5）', () => {
    expect(sanitizeFontPayload({ diffPalette: 'colorblind' }).diffPalette).toBe('colorblind')
    expect(sanitizeFontPayload({ diffPalette: 'standard' }).diffPalette).toBe('standard')
    expect(sanitizeFontPayload({ diffPalette: 'grayscale' }).diffPalette).toBeUndefined()
    expect(sanitizeFontPayload({}).diffPalette).toBeUndefined()
    const items = sectionItems('font', { diffPalette: 'colorblind' })
    expect(items.diffPalette).toBe('colorblind')
  })
})

describe('sectionItems / countSectionDiffs — 预览条数与差异摘要', () => {
  it('font 投影：合法项扁平化，非法项不计数', () => {
    const items = sectionItems('font', {
      sizes: { base: 17, sidebar: 3 },
      editor: { tabSize: 2, minimap: false, wordWrap: 'bogus' },
      uiFont: 'system', terminalLigatures: 'weird',
    })
    expect(items['sizes.base']).toBe(17)
    expect(items['sizes.sidebar']).toBe(10)
    expect(items['editor.tabSize']).toBe(2)
    expect(items['editor.minimap']).toBe(false)
    expect(items['editor.wordWrap']).toBeUndefined()
    expect(items.uiFont).toBe('system')
    expect(items.terminalLigatures).toBeUndefined()
  })

  it('keymap 投影：未知动作/保留键/空组合不计数（与 readOverrides 同口径）', () => {
    const items = sectionItems('keymap', {
      closeTab: 'ctrl+alt+w', sneakyAction: 'ctrl+g', terminalClosePane: 'ctrl+t',
      toggleSidebar: '',
    })
    expect(items).toEqual({ closeTab: 'ctrl+alt+w' })
  })

  it('locale/theme 投影：字符串才成项', () => {
    expect(sectionItems('locale', 'en-US')).toEqual({ locale: 'en-US' })
    expect(sectionItems('locale', 42)).toEqual({})
    expect(sectionItems('theme', 'light')).toEqual({ theme: 'light' })
  })

  it('notify 投影：except 数组序列化比较；布尔三开关', () => {
    const items = sectionItems('notify', {
      dnd: { enabled: true, start: '22:00', end: '08:00', except: ['approval'], exceptError: false },
      sound: false, simple: true,
    })
    expect(items).toEqual({
      'dnd.enabled': true, 'dnd.start': '22:00', 'dnd.end': '08:00',
      'dnd.except': JSON.stringify(['approval']), 'dnd.exceptError': false,
      sound: false, simple: true,
    })
  })

  it('投影负形状：非对象值/字段缺失/类型不符不产出项', () => {
    // 非对象入参 → 空投影
    expect(sectionItems('keymap', null)).toEqual({})
    expect(sectionItems('keymap', 7)).toEqual({})
    expect(sectionItems('notify', 'x')).toEqual({})
    expect(sectionItems('theme', 42)).toEqual({})
    // dnd 形状不符（数组/缺字段）与三开关非布尔：全部跳过
    expect(sectionItems('notify', {
      dnd: ['bad'], sound: 'yes', simple: 1, scrollRead: null,
    })).toEqual({})
    // dnd 对象但字段残缺：enabled 按在场即归一布尔（与 dnd.set 同口径），其余只收形状合法项
    expect(sectionItems('notify', { dnd: { enabled: 'yes', except: 'bad', end: '07:00' } }))
      .toEqual({ 'dnd.enabled': false, 'dnd.end': '07:00' })
  })

  it('差异计数：值不等/本机缺失计一项，全同零差异', () => {
    const incoming = { 'sizes.base': 17, 'editor.tabSize': 2, uiFont: 'system' }
    expect(countSectionDiffs(incoming, { 'sizes.base': 17, 'editor.tabSize': 4, uiFont: 'system' })).toBe(1)
    expect(countSectionDiffs(incoming, {})).toBe(3)
    expect(countSectionDiffs(incoming, incoming)).toBe(0)
  })
})
