import { describe, expect, it } from 'vitest'
import { gitHintToastAction } from '../../utils/gitFailHint'

/**
 * git 失败恢复 hint → 行动化提示映射（P-20261005-194）：kind 枚举全覆盖 +
 * 越界 kind / 缺 projectId 门控 / 零降级约定。纯函数无 i18n 实例，断言键名而非文案。
 */
describe('gitHintToastAction', () => {
  it('non-fast-forward → 先拉取按钮（需 projectId）', () => {
    const a = gitHintToastAction({ kind: 'non-fast-forward' }, 'p1')
    expect(a?.reasonKey).toBe('git.hint.nonFastForward')
    expect(a?.button?.run).toBe('pull')
    expect(a?.button?.labelKey).toBe('git.hint.actionPull')
  })

  it('non-fast-forward 缺 projectId → 无动作（裸 toast 零降级）', () => {
    expect(gitHintToastAction({ kind: 'non-fast-forward' }, undefined)).toBeNull()
    expect(gitHintToastAction({ kind: 'non-fast-forward' }, '')).toBeNull()
  })

  it('conflict → 冲突视图按钮（复用 git.conflictOpen 文案）', () => {
    const a = gitHintToastAction({ kind: 'conflict' }, 'p1')
    expect(a?.reasonKey).toBe('git.hint.conflict')
    expect(a?.button?.run).toBe('conflict')
    expect(a?.button?.labelKey).toBe('git.conflictOpen')
  })

  it('authentication → 打开凭据设置按钮（不依赖 projectId）', () => {
    const a = gitHintToastAction({ kind: 'authentication' }, undefined)
    expect(a?.reasonKey).toBe('git.hint.authentication')
    expect(a?.button?.run).toBe('credentials')
    expect(a?.button?.labelKey).toBe('git.hint.actionCredentials')
  })

  it('diverged → 只给指引不给按钮（合并/变基二选不替用户决策）', () => {
    const a = gitHintToastAction({ kind: 'diverged' }, 'p1')
    expect(a?.reasonKey).toBe('git.hint.diverged')
    expect(a?.button).toBeUndefined()
  })

  it('lock → 指引携锁路径，detail 缺失回退相对名', () => {
    const withPath = gitHintToastAction({ kind: 'lock', detail: '/repo/.git/index.lock' }, 'p1')
    expect(withPath?.reasonParams).toEqual({ path: '/repo/.git/index.lock' })
    expect(withPath?.button).toBeUndefined()
    expect(gitHintToastAction({ kind: 'lock' }, 'p1')?.reasonParams).toEqual({ path: '.git/index.lock' })
  })

  it('无既定 UI 动作的 kind → null（裸 toast 零降级）', () => {
    expect(gitHintToastAction({ kind: 'network' }, 'p1')).toBeNull()
    expect(gitHintToastAction({ kind: 'hook-rejected' }, 'p1')).toBeNull()
    expect(gitHintToastAction({ kind: 'dubious-ownership' }, 'p1')).toBeNull()
  })

  it('hint 缺省/越界 → null', () => {
    expect(gitHintToastAction(undefined, 'p1')).toBeNull()
    expect(gitHintToastAction(null, 'p1')).toBeNull()
    expect(gitHintToastAction({}, 'p1')).toBeNull()
    expect(gitHintToastAction({ kind: 'something-else' }, 'p1')).toBeNull()
  })
})
