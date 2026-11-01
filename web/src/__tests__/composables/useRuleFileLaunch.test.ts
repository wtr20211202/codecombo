import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── useRuleFileLaunch（P-20261006-43）决策面单测：命令面板 edit-rule:<name>
// 两级语义——存在（探测）文件深链进编辑器 / 缺失确认后模板创建并打开。
// 重依赖整链 mock（useProjectRules / router / project·locale store /
// confirmDialog / i18n.global——执行动作发生在面板分发回调，非 setup 上下文），
// 只验决策与接线。ref 替身用裸 { value } 对象：决策面只做读写，不需要响应式 ──

const {
  scanMock, statusesRef, createFromTemplateMock,
  pushMock, currentProjectIdRef, confirmMock,
} = vi.hoisted(() => ({
  scanMock: vi.fn(),
  statusesRef: { value: {} as Record<string, string> },
  createFromTemplateMock: vi.fn(),
  pushMock: vi.fn(),
  currentProjectIdRef: { value: 'p1' },
  confirmMock: vi.fn(),
}))

vi.mock('../../composables/useProjectRules', () => ({
  useProjectRules: () => ({
    statuses: statusesRef,
    scanning: { value: false },
    scan: scanMock,
    createFromTemplate: createFromTemplateMock,
  }),
}))

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
}))

vi.mock('../../stores/project', () => ({
  useProjectStore: () => ({ currentProjectId: currentProjectIdRef.value }),
}))

vi.mock('../../stores/locale', () => ({
  useLocaleStore: () => ({ currentLocale: 'zh-CN' }),
}))

vi.mock('../../composables/useDialog', () => ({
  confirmDialog: confirmMock,
}))

vi.mock('../../i18n', () => ({
  default: { global: { t: (k: string) => k } },
}))

import { isProjectRuleFile, useRuleFileLaunch } from '../../composables/useRuleFileLaunch'

const message = { success: vi.fn(), info: vi.fn(), error: vi.fn() }

beforeEach(() => {
  scanMock.mockReset().mockImplementation(async () => {
    statusesRef.value = { 'CLAUDE.md': 'exists', 'AGENTS.md': 'missing', '.cursorrules': 'missing' }
  })
  statusesRef.value = {}
  createFromTemplateMock.mockReset().mockResolvedValue('created')
  pushMock.mockReset()
  currentProjectIdRef.value = 'p1'
  confirmMock.mockReset().mockResolvedValue(true)
  message.success.mockReset()
  message.info.mockReset()
  message.error.mockReset()
})

describe('runRuleFileCommand', () => {
  it('已存在：不经确认直接文件深链进编辑器（project 携当前项目 id）', async () => {
    const { runRuleFileCommand } = useRuleFileLaunch(message as never)
    await runRuleFileCommand('CLAUDE.md')
    expect(scanMock).toHaveBeenCalledWith('p1')
    expect(confirmMock).not.toHaveBeenCalled()
    expect(createFromTemplateMock).not.toHaveBeenCalled()
    expect(pushMock).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith({
      path: '/project',
      query: { file: 'CLAUDE.md', project: 'p1' },
    })
  })

  it('缺失 + 确认：从模板创建（locale 跟随界面）成功反馈后进编辑器', async () => {
    const { runRuleFileCommand } = useRuleFileLaunch(message as never)
    await runRuleFileCommand('AGENTS.md')
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(createFromTemplateMock).toHaveBeenCalledWith('p1', 'AGENTS.md', 'zh-CN')
    expect(message.success).toHaveBeenCalledTimes(1)
    expect(pushMock).toHaveBeenCalledWith({
      path: '/project',
      query: { file: 'AGENTS.md', project: 'p1' },
    })
  })

  it('缺失 + 取消确认：不创建不深链', async () => {
    confirmMock.mockResolvedValue(false)
    const { runRuleFileCommand } = useRuleFileLaunch(message as never)
    await runRuleFileCommand('AGENTS.md')
    expect(createFromTemplateMock).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('创建撞 409（并发已建）：exists 收场不报错，仍进编辑器', async () => {
    createFromTemplateMock.mockResolvedValue('exists')
    const { runRuleFileCommand } = useRuleFileLaunch(message as never)
    await runRuleFileCommand('.cursorrules')
    expect(message.info).toHaveBeenCalledTimes(1)
    expect(message.success).not.toHaveBeenCalled()
    expect(pushMock).toHaveBeenCalledTimes(1)
  })

  it('创建失败：拦截器已 toast，本链无叠加反馈、不深链', async () => {
    createFromTemplateMock.mockResolvedValue('failed')
    const { runRuleFileCommand } = useRuleFileLaunch(message as never)
    await runRuleFileCommand('AGENTS.md')
    expect(message.success).not.toHaveBeenCalled()
    expect(message.info).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('清单外文件名（陈旧注册/手工构造）：拒绝执行，零探测零深链', async () => {
    const { runRuleFileCommand } = useRuleFileLaunch(message as never)
    await runRuleFileCommand('../../etc/passwd')
    expect(scanMock).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
  })

  it('无当前项目：纯防御不执行（命令按条件注册，此处兜底）', async () => {
    currentProjectIdRef.value = ''
    const { runRuleFileCommand } = useRuleFileLaunch(message as never)
    await runRuleFileCommand('CLAUDE.md')
    expect(scanMock).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()
  })
})

describe('isProjectRuleFile', () => {
  it('清单内三文件为真、其余为假（单一事实源 projectRuleTemplates）', () => {
    expect(isProjectRuleFile('CLAUDE.md')).toBe(true)
    expect(isProjectRuleFile('AGENTS.md')).toBe(true)
    expect(isProjectRuleFile('.cursorrules')).toBe(true)
    expect(isProjectRuleFile('claude.md')).toBe(false) // 大小写敏感
    expect(isProjectRuleFile('README.md')).toBe(false)
  })
})
