import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useGitLockRecoveryStore } from './gitLockRecovery'

// index.lock 遗留锁修复条状态（P-20261002-150）：report/clear 的记录与清除语义。
// 纯内存 store，无外部依赖，无需 mock
describe('gitLockRecovery store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('report 记录项目与时间戳，覆盖刷新', () => {
    const s = useGitLockRecoveryStore()
    expect(s.projectId).toBe('')
    expect(s.at).toBe(0)
    s.report('p1')
    expect(s.projectId).toBe('p1')
    expect(s.at).toBeGreaterThan(0)
    // 同锁反复失败：覆盖刷新而非堆积
    s.report('p1')
    s.report('p2')
    expect(s.projectId).toBe('p2')
  })

  it('clear 无参清除当前记录；带 id 仅清除匹配项目', () => {
    const s = useGitLockRecoveryStore()
    s.report('p1')
    // 清理 B 项目不得误清 A 项目的提示
    s.clear('other')
    expect(s.projectId).toBe('p1')
    s.clear('p1')
    expect(s.projectId).toBe('')
    expect(s.at).toBe(0)
    // 空记录上重复清除幂等
    s.clear()
    expect(s.projectId).toBe('')
  })
})
