import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, nextTick } from 'vue'

// ── mock 边界：只隔离 safeStorage（Map 兜底语义同 utils/storage 的内存路径），
// 被测模块本体零外部依赖，直接真身跑 ──
const backing = vi.hoisted(() => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
  }
})

vi.mock('../utils/storage', () => ({
  safeStorage: backing,
}))

import { loadNotifyFilterPrefs, watchNotifyFilterPrefs } from './useNotifyFilterPrefs'

const KEYS = ['all', 'unread', 'snoozed', 'git', 'task', 'clone', 'system', 'error']
const RUNTIMES = ['claude', 'codex']

beforeEach(() => {
  backing.clear()
})

describe('loadNotifyFilterPrefs 过滤选择恢复（P-20261003-173）', () => {
  it('空存储 → 默认档（all + 全部项目 + 全部运行时）', () => {
    expect(loadNotifyFilterPrefs(KEYS, RUNTIMES)).toEqual({ filter: 'all', project: '', runtime: '' })
  })

  it('合法存档 → 原样恢复（分类页签 + 项目 id）', () => {
    backing.setItem('notify-filter', JSON.stringify({ filter: 'error', project: 'proj-a' }))
    expect(loadNotifyFilterPrefs(KEYS, RUNTIMES)).toEqual({ filter: 'error', project: 'proj-a', runtime: '' })
  })

  it('无效页签键（旧版本残留/手改）→ 回落 all，project 保留', () => {
    backing.setItem('notify-filter', JSON.stringify({ filter: 'bogus', project: 'proj-a' }))
    expect(loadNotifyFilterPrefs(KEYS, RUNTIMES)).toEqual({ filter: 'all', project: 'proj-a', runtime: '' })
  })

  it('字段缺失/类型不对 → 逐字段回落，不整档作废', () => {
    backing.setItem('notify-filter', JSON.stringify({ filter: 3, project: null }))
    expect(loadNotifyFilterPrefs(KEYS, RUNTIMES)).toEqual({ filter: 'all', project: '', runtime: '' })
    backing.setItem('notify-filter', JSON.stringify({ project: 'proj-b' }))
    expect(loadNotifyFilterPrefs(KEYS, RUNTIMES)).toEqual({ filter: 'all', project: 'proj-b', runtime: '' })
  })

  it('非 JSON / 非对象脏数据 → 默认档起步不抛错', () => {
    backing.setItem('notify-filter', '{not-json')
    expect(loadNotifyFilterPrefs(KEYS, RUNTIMES)).toEqual({ filter: 'all', project: '', runtime: '' })
    backing.setItem('notify-filter', JSON.stringify(['error', 'proj-a']))
    expect(loadNotifyFilterPrefs(KEYS, RUNTIMES)).toEqual({ filter: 'all', project: '', runtime: '' })
    backing.setItem('notify-filter', 'null')
    expect(loadNotifyFilterPrefs(KEYS, RUNTIMES)).toEqual({ filter: 'all', project: '', runtime: '' })
  })

  it('升级兼容：存档多出未知字段忽略不炸', () => {
    backing.setItem('notify-filter', JSON.stringify({ filter: 'git', project: '', extra: 1 }))
    expect(loadNotifyFilterPrefs(KEYS, RUNTIMES)).toEqual({ filter: 'git', project: '', runtime: '' })
  })
})

describe('loadNotifyFilterPrefs runtime 键（P-20261003-187，与页签同校验规则）', () => {
  it('存量载荷无 runtime 键（P-173 形态）→ 回落「全部运行时」，filter/project 不受影响', () => {
    backing.setItem('notify-filter', JSON.stringify({ filter: 'error', project: 'proj-a' }))
    expect(loadNotifyFilterPrefs(KEYS, RUNTIMES)).toEqual({ filter: 'error', project: 'proj-a', runtime: '' })
  })

  it('合法 runtime 存档 → 原样恢复；清单非空时无效键回落空', () => {
    backing.setItem('notify-filter', JSON.stringify({ filter: 'all', project: '', runtime: 'claude' }))
    expect(loadNotifyFilterPrefs(KEYS, RUNTIMES)).toEqual({ filter: 'all', project: '', runtime: 'claude' })
    backing.setItem('notify-filter', JSON.stringify({ filter: 'all', project: '', runtime: 'bogus' }))
    expect(loadNotifyFilterPrefs(KEYS, RUNTIMES)).toEqual({ filter: 'all', project: '', runtime: '' })
  })

  it('清单为空（加载早期条目未聚合）→ 仅结构校验，串值保留交对账 watch', () => {
    backing.setItem('notify-filter', JSON.stringify({ filter: 'all', project: '', runtime: 'codex' }))
    expect(loadNotifyFilterPrefs(KEYS, [])).toEqual({ filter: 'all', project: '', runtime: 'codex' })
    backing.setItem('notify-filter', JSON.stringify({ filter: 'all', project: '', runtime: 7 }))
    expect(loadNotifyFilterPrefs(KEYS, [])).toEqual({ filter: 'all', project: '', runtime: '' })
  })
})

describe('watchNotifyFilterPrefs 选择变更即写（P-20261003-173）', () => {
  it('任一维变更都写回持久层；初始恢复不回写（非 immediate）', async () => {
    const filter = ref<string>('all')
    const project = ref<string>('')
    const runtime = ref<string>('')
    watchNotifyFilterPrefs(filter, project, runtime)
    await nextTick()
    expect(backing.getItem('notify-filter')).toBeNull() // 启动恢复零写入

    filter.value = 'error'
    await nextTick()
    expect(backing.getItem('notify-filter')).toBe(JSON.stringify({ filter: 'error', project: '', runtime: '' }))

    project.value = 'proj-a'
    await nextTick()
    expect(backing.getItem('notify-filter')).toBe(JSON.stringify({ filter: 'error', project: 'proj-a', runtime: '' }))

    runtime.value = 'claude'
    await nextTick()
    expect(backing.getItem('notify-filter')).toBe(JSON.stringify({ filter: 'error', project: 'proj-a', runtime: 'claude' }))
  })

  it('对账回落（project/runtime 置空）同样落盘：陈旧选择不在下次启动复活', async () => {
    const filter = ref<string>('error')
    const project = ref<string>('proj-a')
    const runtime = ref<string>('claude')
    watchNotifyFilterPrefs(filter, project, runtime)
    project.value = '' // 模拟 projectOptions 对账 watch 的失效回落
    await nextTick()
    expect(backing.getItem('notify-filter')).toBe(JSON.stringify({ filter: 'error', project: '', runtime: 'claude' }))
    runtime.value = '' // runtimeOptions 对账回落同口径
    await nextTick()
    expect(backing.getItem('notify-filter')).toBe(JSON.stringify({ filter: 'error', project: '', runtime: '' }))
  })
})
