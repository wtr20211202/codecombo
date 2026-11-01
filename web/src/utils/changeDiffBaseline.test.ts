import { describe, expect, it } from 'vitest'
import { changeDiffBaseline, INDEX_REF } from './changeDiffBaseline'

// 基线分流纯判定（P-20261004-42）：staged=HEAD vs index、未暂存=index vs
// worktree、冲突维持 HEAD 合并 diff——键形态即行为契约（openDiffView 产出
// diff:<oldRef>:<newRef>:<path>，Breadcrumb 按 ref 字面量渲染）
describe('changeDiffBaseline', () => {
  it('已暂存行 → HEAD vs index（将提交的形态）', () => {
    expect(changeDiffBaseline({ staged: true, status: 'Modified' })).toEqual({
      oldRef: 'HEAD', newRef: INDEX_REF,
    })
    expect(changeDiffBaseline({ staged: true, status: 'Added' }).newRef).toBe('index')
  })

  it('未暂存行 → index vs worktree（剩余改动）', () => {
    expect(changeDiffBaseline({ staged: false, status: 'Modified' })).toEqual({
      oldRef: 'index',
    })
  })

  it('未跟踪行同走 index 基线（index 无条目即全新文件形态）', () => {
    expect(changeDiffBaseline({ staged: false, status: 'Untracked' })).toEqual({
      oldRef: 'index',
    })
  })

  it('冲突行维持 HEAD 合并 diff（index 无 stage-0，基线取数必空）', () => {
    expect(changeDiffBaseline({ staged: false, status: 'Unmerged' })).toEqual({
      oldRef: 'HEAD',
    })
  })
})
