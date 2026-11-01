import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useReportArchiveStore } from './reportArchive'

// 日报历史面板可见性/下钻聚焦（P-20261004-96）：纯会话内 UI 态（不落盘），
// 锁动作语义——聚焦以 seq 递增为变化信号（同日重发也要生效）、普通打开清残留
beforeEach(() => {
  setActivePinia(createPinia())
})

describe('reportArchive 日报历史面板状态（P-20261004-96）', () => {
  it('初始态：面板关、无聚焦', () => {
    const store = useReportArchiveStore()
    expect(store.open).toBe(false)
    expect(store.focusDate).toBe('')
    expect(store.focusSeq).toBe(0)
  })

  it('openLatest：打开且清聚焦（普通打开选最新日语义）', () => {
    const store = useReportArchiveStore()
    store.openAt('2026-10-01')
    store.openLatest()
    expect(store.open).toBe(true)
    expect(store.focusDate).toBe('')
  })

  it('openAt：记录聚焦日期并递增代', () => {
    const store = useReportArchiveStore()
    store.openAt('2026-10-01')
    expect(store.open).toBe(true)
    expect(store.focusDate).toBe('2026-10-01')
    expect(store.focusSeq).toBe(1)
  })

  it('openAt 同日重发也递增代（seq 是变化信号，日期比较会误判没变）', () => {
    const store = useReportArchiveStore()
    store.openAt('2026-10-01')
    store.openAt('2026-10-01')
    expect(store.focusDate).toBe('2026-10-01')
    expect(store.focusSeq).toBe(2)
  })

  it('openAt 空日期忽略（防御非法格子数据）', () => {
    const store = useReportArchiveStore()
    store.openAt('')
    expect(store.open).toBe(false)
    expect(store.focusDate).toBe('')
    expect(store.focusSeq).toBe(0)
  })

  it('面板已开时 openAt 换日：open 保持、聚焦换新', () => {
    const store = useReportArchiveStore()
    store.openAt('2026-10-01')
    store.openAt('2026-10-02')
    expect(store.open).toBe(true)
    expect(store.focusDate).toBe('2026-10-02')
    expect(store.focusSeq).toBe(2)
  })
})
