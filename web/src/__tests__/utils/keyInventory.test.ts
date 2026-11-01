import { describe, it, expect } from 'vitest'
import {
  findBindingConflicts, staticConflictsForCombo, STATIC_KEY_ENTRIES,
} from '@/utils/keyInventory'
import {
  canonicalCombo, KEYMAP_ACTION_ORDER, KEYMAP_DEFAULTS, useKeymapStore,
} from '@/stores/keymap'
import { useLockStore } from '@/stores/lock'
import { setActivePinia, createPinia } from 'pinia'
import { beforeEach } from 'vitest'
import zh from '@/locales/zh-CN'
import en from '@/locales/en-US'

// 静态键清单（P-20261003-106）：键位自定义保存时冲突扫描的数据源与扫描语义。
// 审计脚本 check-keybindings.mjs 另做清单↔实际注册双向对账（npm run check 门禁），
// 这里守运行时不变量与扫描方向。

/** locale 对象按点路径取值（keyInventory.labelKey 存在性校验用） */
function localeAt(pkg: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], pkg)
}

describe('STATIC_KEY_ENTRIES 清单不变量', () => {
  it('每条 combo 都是 canonicalCombo 幂等规范形', () => {
    for (const e of STATIC_KEY_ENTRIES) {
      expect(canonicalCombo(e.combo), e.combo).toBe(e.combo)
    }
  })

  it('无同作用域同键重复（跨作用域双条目合法，如 ctrl+f 编辑器查找+终端搜索）', () => {
    const seen = new Set<string>()
    for (const e of STATIC_KEY_ENTRIES) {
      const k = `${e.scope} ${e.combo}`
      expect(seen.has(k), k).toBe(false)
      seen.add(k)
    }
  })

  it('数量基线：editor 5（P-20261008-14 起编辑器自定义动作 Ctrl+S/Ctrl+Alt+B/Ctrl+K 移入 keymap 注册表，只剩 Monaco 内建与 F12 接管镜像）/ terminal 18（P-20261003-111 起终端单组合键移入注册表，只剩区间族）/ global 20（P-20261004-49 起 Ctrl+Alt+1-9 工作区预设直达入清单）/ approval 3（失明守卫，新增域键须同步镜像）', () => {
    const count = (scope: string) => STATIC_KEY_ENTRIES.filter(e => e.scope === scope).length
    expect(count('editor')).toBe(5)
    expect(count('terminal')).toBe(18)
    expect(count('global')).toBe(20)
    expect(count('approval')).toBe(3)
    expect(STATIC_KEY_ENTRIES).toHaveLength(46)
  })

  it('全部 labelKey 在 zh/en 双语包中存在（含 params 插值键）', () => {
    for (const e of STATIC_KEY_ENTRIES) {
      expect(localeAt(zh as unknown as Record<string, unknown>, e.labelKey), `zh ${e.labelKey}`).toBeTruthy()
      expect(localeAt(en as unknown as Record<string, unknown>, e.labelKey), `en ${e.labelKey}`).toBeTruthy()
    }
    for (const scope of ['editor', 'terminal', 'global']) {
      expect(localeAt(zh as unknown as Record<string, unknown>, `keymap.invScope.${scope}`)).toBeTruthy()
      expect(localeAt(en as unknown as Record<string, unknown>, `keymap.invScope.${scope}`)).toBeTruthy()
    }
  })

  it('默认键位与清单的既有同键交集 = 编辑器查找 ctrl+f（P-20261008-14 起编辑器自定义动作 ctrl+s/ctrl+alt+b/ctrl+k 移入 keymap 编辑器域注册表，由 store conflicts 域语义覆盖不再依赖静态清单；跨域同键由 conflicts 焦点域共存语义覆盖）', () => {
    const overlap = KEYMAP_ACTION_ORDER
      .map(id => KEYMAP_DEFAULTS[id])
      .filter(combo => staticConflictsForCombo(combo).length > 0)
    expect(overlap.sort()).toEqual(['ctrl+f'])
  })
})

describe('findBindingConflicts 保存时扫描', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('无冲突组合 → 空数组（直接保存路径）', () => {
    const store = useKeymapStore()
    expect(findBindingConflicts('quickOpen', 'ctrl+alt+p', store.combos, '')).toEqual([])
  })

  it('无效组合 → 空数组', () => {
    const store = useKeymapStore()
    expect(findBindingConflicts('quickOpen', 'shift', store.combos, '')).toEqual([])
    expect(findBindingConflicts('quickOpen', '', store.combos, '')).toEqual([])
  })

  it('撞注册表靠前动作 → 本动作被遮蔽（takesOver=false，other=对方）', () => {
    const store = useKeymapStore()
    // outline 注册序晚于 quickOpen，改绑到 ctrl+p 后按键时快速打开优先
    expect(findBindingConflicts('outline', 'ctrl+p', store.combos, '')).toEqual([
      { kind: 'action', other: 'quickOpen', takesOver: false },
    ])
  })

  it('撞注册表靠后动作 → 保存后对方被遮蔽（takesOver=true，「保存将覆盖」）', () => {
    const store = useKeymapStore()
    // quickOpen 注册序早于 outline，占用 ctrl+shift+o 后大纲不再响应
    expect(findBindingConflicts('quickOpen', 'ctrl+shift+o', store.combos, '')).toEqual([
      { kind: 'action', other: 'outline', takesOver: true },
    ])
  })

  it('与锁定快捷键撞键 → kind=lock', () => {
    const store = useKeymapStore()
    expect(findBindingConflicts('projectSearch', 'ctrl+shift+l', store.combos, 'ctrl+shift+l')).toEqual([
      { kind: 'lock' },
    ])
    // mac 形锁定键归并 ctrl 规范形后同样命中
    expect(findBindingConflicts('projectSearch', 'ctrl+shift+l', store.combos, 'meta+shift+l')).toEqual([
      { kind: 'lock' },
    ])
  })

  it('跨域撞键（P-20261008-14）：全局动作改绑到编辑器域键（ctrl+s=editorSave）→ focus 共存语义（编辑器聚焦时对方优先，静态清单条目已移入注册表）', () => {
    const store = useKeymapStore()
    const hits = findBindingConflicts('toggleSidebar', 'ctrl+s', store.combos, '')
    expect(hits).toEqual([
      { kind: 'action', other: 'editorSave', cross: 'focus' },
    ])
  })

  it('跨域撞键（P-20261008-14）：编辑器域动作改绑到 doc 级终端键 → focus 共存（非 takeover——编辑器聚焦时 Monaco 拦截优先，面板在场其余场景 doc 级生效，无遮蔽生死）', () => {
    const store = useKeymapStore()
    const hits = findBindingConflicts('editorBookmarkToggle', 'ctrl+shift+h', store.combos, '')
    expect(hits).toEqual([
      { kind: 'action', other: 'terminalHistory', cross: 'focus' },
    ])
  })

  it('撞静态清单：全局数字直达 ctrl+3 → takeover 语义（claimsCombo 让位，保存即接管）', () => {
    const store = useKeymapStore()
    const hits = findBindingConflicts('quickOpen', 'ctrl+3', store.combos, '')
    expect(hits).toEqual([
      { kind: 'static', entry: expect.objectContaining({ combo: 'ctrl+3', scope: 'global', semantics: 'takeover' }) },
    ])
  })

  it('跨域撞键（P-20261003-111）：全局动作改绑到 xterm 焦点域终端键 → focus 共存语义', () => {
    const store = useKeymapStore()
    const hits = findBindingConflicts('clipHistoryPaste', 'ctrl+shift+v', store.combos, '')
    // previewToggle 同域遮蔽 + terminalPaste 跨域 focus 共存（粘贴已入注册表，不再走静态清单）
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ kind: 'action', other: 'previewToggle', takesOver: false })
    expect(hits[1]).toMatchObject({ kind: 'action', other: 'terminalPaste', cross: 'focus' })
  })

  it('跨域撞键：全局动作改绑到 doc 级终端键 → takeover 语义（终端域优先，本动作被遮蔽）', () => {
    const store = useKeymapStore()
    const hits = findBindingConflicts('toggleSidebar', 'ctrl+shift+h', store.combos, '')
    expect(hits).toEqual([
      { kind: 'action', other: 'terminalHistory', takesOver: false, cross: 'takeover' },
    ])
  })

  it('跨域撞键：doc 级终端动作改绑到全局键位 → 本动作接管（takesOver=true + takeover）', () => {
    const store = useKeymapStore()
    const hits = findBindingConflicts('terminalHistory', 'ctrl+b', store.combos, '')
    expect(hits).toEqual([
      { kind: 'action', other: 'toggleSidebar', takesOver: true, cross: 'takeover' },
    ])
  })

  it('一键撞静态清单多条目并列返回：ctrl+f 同时撞终端搜索（注册表 focus 共存）与编辑器查找（清单）', () => {
    const store = useKeymapStore()
    const hits = findBindingConflicts('clipHistoryPaste', 'ctrl+f', store.combos, '')
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ kind: 'action', other: 'terminalSearch', cross: 'focus' })
    expect(hits[1]).toMatchObject({ kind: 'static', entry: expect.objectContaining({ combo: 'ctrl+f', scope: 'editor' }) })
  })

  it('终端域区间键仍在清单：Alt+1-9 / Ctrl+Shift+1-9 改绑动作到该键位警示 focus 共存', () => {
    const store = useKeymapStore()
    const hits = findBindingConflicts('toggleSidebar', 'alt+5', store.combos, '')
    expect(hits).toEqual([
      { kind: 'static', entry: expect.objectContaining({ combo: 'alt+5', scope: 'terminal', semantics: 'focus' }) },
    ])
  })

  it('跳过自身动作：改绑回自己当前键位不产生自冲突', () => {
    const store = useKeymapStore()
    expect(findBindingConflicts('quickOpen', 'ctrl+p', store.combos, '')).toEqual([])
  })

  it('改绑编辑器注册表键位与 store.conflicts 视角一致：saveAll → ctrl+s 跨域 focus 命中 editorSave（清单条目已移注册表，不再走 staticConflictsForCombo）', () => {
    const store = useKeymapStore()
    expect(staticConflictsForCombo(store.combos.saveAll)).toEqual([]) // 默认 ctrl+alt+s 不撞清单
    store.setBinding('saveAll', 'ctrl+s')
    expect(store.conflicts.saveAll).toEqual({ kind: 'action', other: 'editorSave', cross: 'focus' })
    expect(staticConflictsForCombo('ctrl+s')).toEqual([])
  })
})
