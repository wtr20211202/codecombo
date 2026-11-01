import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppError } from '@/api/error-types'

// rebaseApi mock：open 走 getTodo（拦截器解包后的 { data, onto } 形态）、
// execute 走 interactive（可注入 409 携 remoteBranches / 普通错误）
const getTodoMock = vi.fn()
const interactiveMock = vi.fn()
vi.mock('@/api/client', () => ({
  rebaseApi: {
    getTodo: (...args: unknown[]) => getTodoMock(...args),
    interactive: (...args: unknown[]) => interactiveMock(...args),
  },
}))

import {
  executeRebasePlan,
  firstLine,
  moveRebaseStep,
  rebaseEditorPreview,
  rebaseEditorValidationError,
  REBASE_EDITOR_MAX_STEPS,
  useRebaseEditor,
  type RebaseEditorStep,
} from '@/composables/useRebaseEditor'
import type { RebaseStep } from '@/api/domains/git'

function mkStep(partial: Partial<RebaseEditorStep>): RebaseEditorStep {
  return { hash: 'h', msg: 'm', action: 'pick', newMessage: '', ...partial }
}

/** 409 AppError 形态（拦截器会把 response.data 挂到 data 字段） */
function pushedError(branches: string[]): AppError {
  return {
    status: 409,
    data: { remoteBranches: branches },
    userMessage: 'pushed',
  } as unknown as AppError
}

describe('rebaseEditorValidationError', () => {
  it('空列表 / 全 drop / squash 首位 / reword 空消息分别报对应错误', () => {
    expect(rebaseEditorValidationError([])).toBe('rebase.editor.errorEmpty')
    expect(rebaseEditorValidationError([
      mkStep({ action: 'drop' }),
    ])).toBe('rebase.editor.errorAllDropped')
    expect(rebaseEditorValidationError([
      mkStep({ action: 'squash' }),
      mkStep({ action: 'pick' }),
    ])).toBe('rebase.editor.errorSquashFirst')
    expect(rebaseEditorValidationError([
      mkStep({ action: 'pick' }),
      mkStep({ action: 'reword', newMessage: '   ' }),
    ])).toBe('rebase.editor.errorRewordEmpty')
  })

  it('合法计划返回 null（drop 首条合法，首位是 pick/reword）', () => {
    expect(rebaseEditorValidationError([
      mkStep({ action: 'drop' }),
      mkStep({ action: 'reword', newMessage: 'x' }),
    ])).toBeNull()
  })
})

describe('rebaseEditorPreview', () => {
  it('squash 并入上一条、reword 取新消息、drop 摘出', () => {
    const { rows, dropped } = rebaseEditorPreview([
      mkStep({ hash: 'a', msg: 'a1\nbody', action: 'pick' }),
      mkStep({ hash: 'b', msg: 'b1', action: 'squash' }),
      mkStep({ hash: 'c', msg: 'c1', action: 'reword', newMessage: 'c-fixed' }),
      mkStep({ hash: 'd', msg: 'd1', action: 'drop' }),
    ])
    expect(rows).toEqual([
      { hash: 'a', subject: 'a1', squashed: ['b1'] },
      { hash: 'c', subject: 'c-fixed', squashed: [] },
    ])
    expect(dropped).toEqual(['d1'])
  })

  it('squash 链按序累积到同一行', () => {
    const { rows } = rebaseEditorPreview([
      mkStep({ hash: 'a', msg: 'a', action: 'pick' }),
      mkStep({ hash: 'b', msg: 'b', action: 'squash' }),
      mkStep({ hash: 'c', msg: 'c', action: 'squash' }),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].squashed).toEqual(['b', 'c'])
  })
})

describe('moveRebaseStep', () => {
  it('相邻交换；越界为幂等空操作', () => {
    const steps = [mkStep({ hash: '1' }), mkStep({ hash: '2' }), mkStep({ hash: '3' })]
    moveRebaseStep(steps, 0, -1) // 越界上移：不变
    expect(steps.map(s => s.hash)).toEqual(['1', '2', '3'])
    moveRebaseStep(steps, 0, 1)
    expect(steps.map(s => s.hash)).toEqual(['2', '1', '3'])
    moveRebaseStep(steps, 2, 1) // 越界下移：不变
    expect(steps.map(s => s.hash)).toEqual(['2', '1', '3'])
  })
})

describe('firstLine', () => {
  it('取首行并去空白；空串安全', () => {
    expect(firstLine('a\nb')).toBe('a')
    expect(firstLine('  x  ')).toBe('x')
    expect(firstLine('')).toBe('')
  })
})

describe('useRebaseEditor.open', () => {
  beforeEach(() => {
    getTodoMock.mockReset()
    interactiveMock.mockReset()
  })

  it('加载区间并回填 onto（服务端换算后的基准）', async () => {
    getTodoMock.mockResolvedValue({
      data: [
        { action: 'pick', hash: 'aaa', msg: 'b' },
        { action: 'pick', hash: 'bbb', msg: 'c' },
      ] satisfies RebaseStep[],
      onto: 'parent-hash',
    })
    const editor = useRebaseEditor()
    await editor.open('p1', 'target-hash')
    expect(getTodoMock).toHaveBeenCalledWith('p1', '', 'target-hash')
    expect(editor.show.value).toBe(true)
    expect(editor.onto.value).toBe('parent-hash')
    expect(editor.steps.value).toHaveLength(2)
    expect(editor.steps.value[0]).toMatchObject({ hash: 'aaa', action: 'pick' })
  })

  it('getTodo 失败：空列表不抛错（拦截器已提示）', async () => {
    getTodoMock.mockRejectedValue(new Error('boom'))
    const editor = useRebaseEditor()
    await editor.open('p1', 't')
    expect(editor.steps.value).toEqual([])
    expect(editor.loading.value).toBe(false)
  })

  it('setAction 切到 reword 预填原消息', async () => {
    getTodoMock.mockResolvedValue({ data: [{ action: 'pick', hash: 'a', msg: 'orig' }], onto: 'o' })
    const editor = useRebaseEditor()
    await editor.open('p1', 't')
    editor.setAction(0, 'reword')
    expect(editor.steps.value[0].action).toBe('reword')
    expect(editor.steps.value[0].newMessage).toBe('orig')
  })
})

describe('executeRebasePlan', () => {
  beforeEach(() => {
    getTodoMock.mockReset()
    interactiveMock.mockReset()
  })

  it('成功：reword 携带 newMessage，drop 行随计划提交（服务端核对覆盖），首次调用 silent', async () => {
    interactiveMock.mockResolvedValue({})
    const steps = [
      mkStep({ hash: 'h1', msg: 'a', action: 'reword', newMessage: '  new msg  ' }),
      mkStep({ hash: 'h2', msg: 'b', action: 'drop' }),
    ]
    const result = await executeRebasePlan('p1', 'onto1', steps, false)
    expect(result.ok).toBe(true)
    expect(interactiveMock).toHaveBeenCalledWith(
      'p1', 'onto1',
      [
        { action: 'reword', hash: 'h1', msg: 'a', newMessage: 'new msg' },
        { action: 'drop', hash: 'h2', msg: 'b' },
      ],
      false,
      { silent: true },
    )
  })

  it('409 携影响面：返回 pushed + 分支列表', async () => {
    interactiveMock.mockRejectedValue(pushedError(['origin/main']))
    const result = await executeRebasePlan('p1', 'o', [mkStep({ hash: 'h1' })], false)
    expect(result.ok).toBe(false)
    expect(result.pushed).toBe(true)
    expect(result.remoteBranches).toEqual(['origin/main'])
  })

  it('普通失败：返回 userMessage（拦截器映射文案）供组件展示', async () => {
    interactiveMock.mockRejectedValue({ status: 500, userMessage: '整理失败' })
    const result = await executeRebasePlan('p1', 'o', [mkStep({ hash: 'h1' })], false)
    expect(result.ok).toBe(false)
    expect(result.pushed).toBeUndefined()
    expect(result.userMessage).toBe('整理失败')
  })
})

describe('REBASE_EDITOR_MAX_STEPS', () => {
  it('与服务端 git.MaxRebasePlanSteps 同值（20）', () => {
    expect(REBASE_EDITOR_MAX_STEPS).toBe(20)
  })
})
