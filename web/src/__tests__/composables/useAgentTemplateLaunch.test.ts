import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── useAgentTemplateLaunch（P-20261005-10）决策面单测：命令面板 template:<tid>
// 两级语义——占位符全解析直达建会话+激活 / 上下文缺失降级对话框预填。
// 重依赖整链 mock（useAgentTerminal / 模板单例 / nav 信标 / project store /
// i18n.global——执行动作发生在面板分发回调，非 setup 上下文），只验决策与接线。
// ref 替身用裸 { value } 对象：决策面只做读写，不需要响应式 ──

const { createMock, refreshMock, openMock, templatesRef, loadMock, activeFileRef } = vi.hoisted(() => ({
  createMock: vi.fn(),
  refreshMock: vi.fn(),
  openMock: vi.fn(),
  templatesRef: { value: [] as { id: string; name: string; prompt: string }[] },
  loadMock: vi.fn(),
  activeFileRef: { value: '' },
}))

vi.mock('../../composables/useAgentTerminal', () => ({
  useAgentTerminal: () => ({
    create: createMock,
    refresh: refreshMock,
    open: openMock,
    activeId: { value: '' },
  }),
}))

vi.mock('../../composables/useAgentTaskTemplates', () => ({
  useAgentTaskTemplates: () => ({
    templates: templatesRef,
    load: loadMock,
  }),
}))

vi.mock('../../composables/useEditorNavHistory', () => ({
  useEditorNavHistory: () => ({ activeFilePath: activeFileRef }),
}))

vi.mock('../../stores/project', () => ({
  useProjectStore: () => ({
    currentProject: { currentBranch: 'feat/x', path: '/repo' },
  }),
}))

vi.mock('../../i18n', () => ({
  default: { global: { t: (k: string) => k } },
}))

import {
  consumeTemplateDialogRequest,
  useAgentTemplateLaunch,
} from '../../composables/useAgentTemplateLaunch'

const message = { success: vi.fn(), error: vi.fn() }

beforeEach(() => {
  createMock.mockReset().mockResolvedValue(null)
  refreshMock.mockReset().mockResolvedValue(true)
  openMock.mockReset().mockResolvedValue(undefined)
  loadMock.mockReset().mockResolvedValue(undefined)
  templatesRef.value = []
  activeFileRef.value = ''
  message.success.mockReset()
  message.error.mockReset()
  consumeTemplateDialogRequest() // 清掉前序用例可能积压的降级意图
})

describe('runTemplateCommand', () => {
  it('占位符全解析：直达建会话（launchArgs=解析后全文）并激活 docked，成功反馈', async () => {
    templatesRef.value = [{ id: 'tpl-a', name: '审查', prompt: '审查 {file}（分支 {branch}，目录 {dir}）' }]
    activeFileRef.value = 'src/app.ts'
    createMock.mockResolvedValue({ id: 't1', name: '审查 src/app.ts…', runtime: 'claude' })
    const { runTemplateCommand } = useAgentTemplateLaunch(message as never)
    await runTemplateCommand('tpl-a')
    expect(createMock).toHaveBeenCalledTimes(1)
    const [runtime, opts] = createMock.mock.calls[0]!
    expect(runtime).toBeUndefined() // runtime 不携带 = 服务端按设置默认解析
    expect(opts).toEqual({ launchArgs: '审查 src/app.ts（分支 feat/x，目录 /repo）' })
    expect(refreshMock).toHaveBeenCalledTimes(1)
    expect(openMock).toHaveBeenCalledWith('docked')
    expect(message.success).toHaveBeenCalledTimes(1)
    // 未走降级：无对话框请求积压
    expect(consumeTemplateDialogRequest()).toBeNull()
  })

  it('上下文缺失（{file} 无激活文件）：不建会话，降级对话框请求携模板 id', async () => {
    templatesRef.value = [{ id: 'tpl-a', name: '审查', prompt: '审查 {file}' }]
    const { runTemplateCommand } = useAgentTemplateLaunch(message as never)
    await runTemplateCommand('tpl-a')
    expect(createMock).not.toHaveBeenCalled()
    // 降级出口经 requestTemplateDialog 拉起 docked 管理页（对话框宿主）
    expect(openMock).toHaveBeenCalledWith('docked')
    expect(consumeTemplateDialogRequest()).toBe('tpl-a')
    expect(consumeTemplateDialogRequest()).toBeNull() // 消费即清，不二次重放
  })

  it('清单里没有该模板：刷新一次仍无 → 退回通用新建对话框（空模板 id 预填）', async () => {
    const { runTemplateCommand } = useAgentTemplateLaunch(message as never)
    await runTemplateCommand('tpl-gone')
    expect(loadMock).toHaveBeenCalledTimes(1)
    expect(createMock).not.toHaveBeenCalled()
    expect(consumeTemplateDialogRequest()).toBe('')
  })

  it('创建失败（服务端拒绝）：错误反馈，不展开管理页', async () => {
    templatesRef.value = [{ id: 'tpl-a', name: '审查', prompt: '直接开工' }]
    createMock.mockResolvedValue(null)
    const { runTemplateCommand } = useAgentTemplateLaunch(message as never)
    await runTemplateCommand('tpl-a')
    expect(message.error).toHaveBeenCalledTimes(1)
    expect(openMock).not.toHaveBeenCalled()
  })
})
