import { describe, expect, it } from 'vitest'
import { nextTick, ref } from 'vue'
import { useBatchSelect } from './useBatchSelect'
import type { NotificationItem } from '../api/client'

// 多选批量操作选择状态机（P-20261003-281）：纯逻辑直测——不涉 API/i18n，
// items 用本地 ref 替身模拟 store.items 的整表替换语义
function item(id: string, read = false): NotificationItem {
  return { id, type: 'info', category: 'system', title: id, time: '2026-01-01T00:00:00Z', read }
}

function setup(ids: string[]) {
  const items = ref(ids.map(id => item(id)))
  const active = ref(true)
  const sel = useBatchSelect(items, active)
  return { items, active, ...sel }
}

describe('useBatchSelect 多选选择状态机（P-20261003-281）', () => {
  it('toggle：单条加入/移除', () => {
    const s = setup(['a', 'b'])
    s.toggle('a')
    expect(s.isSelected('a')).toBe(true)
    expect(s.isSelected('b')).toBe(false)
    s.toggle('a')
    expect(s.isSelected('a')).toBe(false)
  })

  it('toggleMany：部分选中 → 补选全组；全组选中 → 全组取消', () => {
    const s = setup(['a', 'b', 'c'])
    s.toggle('a')
    // 部分选中再点 = 补选（收敛到全选）
    s.toggleMany(['a', 'b'])
    expect(s.stateOf(['a', 'b', 'c'])).toBe('some')
    s.toggleMany(['a', 'b', 'c'])
    expect(s.stateOf(['a', 'b', 'c'])).toBe('all')
    // 全选中再点 = 全组取消
    s.toggleMany(['a', 'b', 'c'])
    expect(s.stateOf(['a', 'b', 'c'])).toBe('none')
  })

  it('toggleMany：空 id 列表为 no-op（空列表视图点全选不报错不变更）', () => {
    const s = setup(['a'])
    s.toggle('a')
    s.toggleMany([])
    expect(s.stateOf(['a'])).toBe('all')
  })

  it('stateOf 三态：all / some / none；空组恒 none', () => {
    const s = setup(['a', 'b'])
    expect(s.stateOf(['a', 'b'])).toBe('none')
    s.toggle('a')
    expect(s.stateOf(['a', 'b'])).toBe('some')
    s.toggle('b')
    expect(s.stateOf(['a', 'b'])).toBe('all')
    expect(s.stateOf([])).toBe('none')
  })

  it('items 整表替换：消失条目的选中 id 被剪除，在册保留', async () => {
    const s = setup(['a', 'b', 'c'])
    s.toggle('a')
    s.toggle('b')
    // 模拟 dismissMany 后 store.items 整表替换（b 被删）
    s.items.value = [item('a'), item('c')]
    await nextTick()
    expect(s.isSelected('a')).toBe(true)
    expect(s.isSelected('b')).toBe(false)
  })

  it('零选中时 items 替换不对账（快速路径，不重建 Set）', async () => {
    const s = setup(['a'])
    s.items.value = []
    await nextTick()
    expect(s.selectedIds.value.size).toBe(0)
  })

  it('active 置 false（退出多选/面板关闭）即清空选择', async () => {
    const s = setup(['a', 'b'])
    s.toggle('a')
    s.toggle('b')
    expect(s.selectedIds.value.size).toBe(2)
    s.active.value = false
    await nextTick()
    expect(s.selectedIds.value.size).toBe(0)
    // 重进多选：从空选择起步
    s.active.value = true
    await nextTick()
    expect(s.isSelected('a')).toBe(false)
  })

  it('与过滤正交：选中集不随 items 内容变化丢失（已读置位不触发剪除）', async () => {
    const s = setup(['a', 'b'])
    s.toggle('a')
    // 模拟 markRead：原位改 read 位（不换 id）
    s.items.value = [item('a', true), item('b')]
    await nextTick()
    expect(s.isSelected('a')).toBe(true)
  })
})
