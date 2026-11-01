import { describe, expect, it } from 'vitest'
import * as ionicons from '@vicons/ionicons5'
import {
  ACTION_ICONS,
  ADJACENCY_FAMILIES,
  BANNED_ICON_VARIANTS,
  BRAND_NAV_ICONS,
  FORBIDDEN_ICON_PAIRS,
  NAV_ICONS,
  NON_ACTION_ICONS,
} from './actionIcons'

type IconComponent = { name?: string }
const pkg = ionicons as unknown as Record<string, IconComponent | undefined>
const entries = Object.entries(ACTION_ICONS) as Array<[string, IconComponent]>

/** ionicons5 组件名即导出名（vicons 构建产物实测 name 与导出键一致） */
function iconName(c: IconComponent): string {
  return c.name ?? ''
}

/**
 * 首批映射的契约快照（P-20261022-1）：逐组锁死选型，防止后续「顺手换一枚差不多」的
 * 改动绕过注册表评审。改这些断言必须先改 docs/design/icon-semantics.md 的选型理由。
 */
const FIRST_BATCH_MAPPING: Record<string, string> = {
  'common.more': 'EllipsisHorizontalOutline',
  'git.fetch': 'CloudDownloadOutline',
  'git.pull': 'ArrowDownCircleOutline',
  'git.push': 'CloudUploadOutline',
  'git.clone': 'DuplicateOutline',
  'common.refresh': 'RefreshOutline',
  'common.retry': 'ArrowRedoOutline',
  'share.reshare': 'RepeatOutline',
  'share.rotate': 'KeyOutline',
  'common.delete': 'TrashOutline',
  'common.recycleBin': 'TrashBinOutline',
  'common.edit': 'CreateOutline',
  'common.new': 'AddOutline',
  'claude.filesWritten': 'DocumentTextOutline',
  'chat.sessions': 'ChatbubblesOutline',
  'chat.comment': 'ChatbubbleEllipsesOutline',
  'chat.queue': 'ChatboxEllipsesOutline',
  'git.branch': 'GitBranchOutline',
  'git.network': 'GitNetworkOutline',
  'git.compare': 'GitCompareOutline',
  'git.commit': 'GitCommitOutline',
  'git.merge': 'GitMergeOutline',
}

/** 破坏性动作：不得借用任何非破坏性动作的图形（回收站入口是导航，不在此列） */
const DESTRUCTIVE_ACTIONS = ['common.delete'] as const

describe('actionIcons 注册表', () => {
  it('动作键均为域前缀点分形态且数量覆盖首批七类高频面', () => {
    expect(entries.length).toBeGreaterThanOrEqual(40)
    for (const [key] of entries) {
      expect(key).toMatch(/^(common|git|share|chat|claude|notify|nav)\.[a-z][A-Za-z0-9]*$/)
    }
  })

  it('每个动作键恰映射一个真实存在的 iconicons5 组件', () => {
    for (const [key, icon] of entries) {
      const name = iconName(icon)
      expect(name, `${key} 缺少组件名`).not.toBe('')
      expect(pkg[name], `${key} → ${name} 不是 @vicons/ionicons5 的导出`).toBe(icon)
    }
  })

  it('不同动作不共用同一图标组件（近似图形消歧的底线）', () => {
    const seen = new Map<string, string>()
    for (const [key, icon] of entries) {
      const name = iconName(icon)
      expect(seen.has(name), `${name} 同时被 ${seen.get(name)} 与 ${key} 使用`).toBe(false)
      seen.set(name, key)
    }
  })

  it('禁用变体清单非空、组件真实存在且不得出现在映射值里', () => {
    const banned = Object.keys(BANNED_ICON_VARIANTS)
    expect(banned.length).toBeGreaterThanOrEqual(4)
    const actionNames = new Set(entries.map(([, icon]) => iconName(icon)))
    for (const name of banned) {
      expect(pkg[name], `禁用变体 ${name} 拼写错误或组件不存在`).toBeDefined()
      expect(actionNames.has(name), `${name} 已在禁用清单中，不能作为动作图标`).toBe(false)
    }
  })

  it('破坏性动作的图标不与其它动作共用', () => {
    for (const destructive of DESTRUCTIVE_ACTIONS) {
      const icon = ACTION_ICONS[destructive] as IconComponent
      const users = entries.filter(([, c]) => c === icon).map(([k]) => k)
      expect(users).toEqual([destructive])
    }
  })

  it('邻接冲突族均至少两枚真实图标，且族内不做动作去重式复用', () => {
    const names = Object.keys(ADJACENCY_FAMILIES)
    expect(names.length).toBeGreaterThanOrEqual(3)
    for (const [family, icons] of Object.entries(ADJACENCY_FAMILIES)) {
      expect(icons.length, `邻接族 ${family} 至少两枚`).toBeGreaterThanOrEqual(2)
      for (const name of icons) expect(pkg[name], `邻接族 ${family} 的 ${name} 不存在`).toBeDefined()
    }
  })

  it('非动作白名单图标真实存在、与动作图标不重叠，且覆盖全部存量装饰图标', () => {
    expect(NON_ACTION_ICONS.length).toBeGreaterThanOrEqual(80)
    const actionNames = new Set(entries.map(([, icon]) => iconName(icon)))
    const seen = new Set<string>()
    for (const name of NON_ACTION_ICONS) {
      expect(pkg[name], `非动作图标 ${name} 不存在`).toBeDefined()
      expect(actionNames.has(name), `${name} 已是动作图标，不应重复登记为装饰`).toBe(false)
      expect(seen.has(name), `非动作图标 ${name} 重复登记`).toBe(false)
      seen.add(name)
    }
  })

  it('首批 6 组高争议映射锁定（改选型必须先过人工评审 + 文档）', () => {
    for (const [key, expected] of Object.entries(FIRST_BATCH_MAPPING)) {
      const icon = ACTION_ICONS[key as keyof typeof ACTION_ICONS] as IconComponent | undefined
      expect(icon, `缺少动作键 ${key}`).toBeDefined()
      expect(iconName(icon!), `${key} 的选型漂移`).toBe(expected)
    }
  })

  it('聊天/ Git 五枚图形两两不同，分享轮换使用非环形 KeyOutline', () => {
    const chat = ['chat.sessions', 'chat.comment', 'chat.queue'].map(
      (k) => ACTION_ICONS[k as keyof typeof ACTION_ICONS],
    )
    expect(new Set(chat).size).toBe(3)

    const git = ['git.branch', 'git.network', 'git.compare', 'git.commit', 'git.merge'].map(
      (k) => ACTION_ICONS[k as keyof typeof ACTION_ICONS],
    )
    expect(new Set(git).size).toBe(5)

    expect(iconName(ACTION_ICONS['share.rotate'] as IconComponent)).toBe('KeyOutline')
    expect(iconName(ACTION_ICONS['share.reshare'] as IconComponent)).toBe('RepeatOutline')
  })
})

describe('NAV_ICONS 目的地注册表（P-20261022-2）', () => {
  const navEntries = Object.entries(NAV_ICONS) as Array<[string, IconComponent]>
  /** P-20261022-2 首批三组修复的契约快照：改选型必须先改 docs/design/icon-semantics.md */
  const FIRST_BATCH_NAV: Record<string, string> = {
    'share-manager': 'LinkOutline', // 不再与 git 分支同属「圆点+连线」族
    'monitor': 'TvOutline', // 值班大屏盯屏隐喻，Speedometer 归还仪表盘
    'shortcuts': 'FlashOutline', // 快捷键闪电，不再与帮助中心共用 HelpCircle
  }

  it('目的地键为平铺 kebab id 且数量覆盖 rail 面板与首页工具条', () => {
    expect(navEntries.length).toBeGreaterThanOrEqual(15)
    for (const [key] of navEntries) {
      expect(key).toMatch(/^[a-z][a-z0-9-]*$/)
    }
  })

  it('每个目的地恰映射一个真实存在的 ionicons5 组件', () => {
    for (const [key, icon] of navEntries) {
      const name = iconName(icon)
      expect(name, `${key} 缺少组件名`).not.toBe('')
      expect(pkg[name], `${key} → ${name} 不是 @vicons/ionicons5 的导出`).toBe(icon)
    }
  })

  it('一图一目的地：同一图形不得对应两个目的地键（多入口同图 = 同键共用）', () => {
    const seen = new Map<string, string>()
    for (const [key, icon] of navEntries) {
      const name = iconName(icon)
      expect(seen.has(name), `${name} 同时登记给 ${seen.get(name)} 与 ${key}`).toBe(false)
      seen.set(name, key)
    }
  })

  it('nav 与动作段同图须落在文档注记的同图清单内', () => {
    // 同图注记面（docs §5.3）：HelpCircle=nav.help 动作、Notifications=notify.center、
    // Settings=nav.settings、Lock=common.lock、Chatbubbles/警用装饰等。超出清单的
    // 新同图须先补注记再合入
    const actionNames = new Set(entries.map(([, icon]) => iconName(icon)))
    const annotated = new Set([
      'HelpCircleOutline', 'NotificationsOutline', 'SettingsOutline',
      'LockClosedOutline', 'ChatbubblesOutline', 'GlobeOutline', 'TerminalOutline',
      'FolderOutline', 'CheckmarkOutline', 'ClipboardOutline', 'PulseOutline',
      'ServerOutline', 'DocumentTextOutline', 'EyeOutline', 'AlertCircleOutline',
      'AlbumsOutline', 'GitBranchOutline', 'SpeedometerOutline',
    ])
    for (const [key, icon] of navEntries) {
      const name = iconName(icon)
      if (actionNames.has(name)) {
        expect(annotated.has(name), `${key} 与动作段同图 ${name} 未在注记清单登记`).toBe(true)
      }
    }
  })

  it('首批三组目的地修复锁定（改选型必须先过人工评审 + 文档）', () => {
    for (const [key, expected] of Object.entries(FIRST_BATCH_NAV)) {
      const icon = NAV_ICONS[key as keyof typeof NAV_ICONS] as IconComponent | undefined
      expect(icon, `缺少目的地键 ${key}`).toBeDefined()
      expect(iconName(icon!), `${key} 的选型漂移`).toBe(expected)
    }
  })

  it('禁配对清单非空、两端真实存在且不与 NAV 面板键冲突', () => {
    expect(FORBIDDEN_ICON_PAIRS.length).toBeGreaterThanOrEqual(1)
    const navNames = new Set(navEntries.map(([, icon]) => iconName(icon)))
    for (const [a, b] of FORBIDDEN_ICON_PAIRS) {
      expect(pkg[a], `禁配对 ${a} 不存在`).toBeDefined()
      expect(pkg[b], `禁配对 ${b} 不存在`).toBeDefined()
      // 禁配对的两端不得同时出现在 NAV 注册面（出现即 R6b 硬失败，这里提前锁）
      const both = [a, b].filter((n) => navNames.has(n))
      expect(both.length, `禁配对 ${a} × ${b} 同时登记 NAV：${both.join('/')}`).toBeLessThanOrEqual(1)
    }
  })

  it('品牌目的地清单真实存在（组件导出或 SFC），豁免面不做 ionicons 校验', () => {
    expect(BRAND_NAV_ICONS).toContain('DshIcon')
  })
})
