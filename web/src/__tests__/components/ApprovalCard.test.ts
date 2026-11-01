import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ApprovalCard from '../../components/agent/ApprovalCard.vue'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { OPS_LOCATE_IN_TREE, OPS_OPEN_FILE_AT, type LocateInTreeDetail, type OpenFileAtDetail } from '../../utils/opsEvents'
import type { ApprovalRecord } from '../../api/domains/opsconfirm'

// 单卡结构断言（P-20261003-87 拆分守护）：ApprovalCard 自 ApprovalCards 拆出
// 是纯重构零行为变化——本测试钉住拆分后的卡内渲染结构（类名/testid/按钮族/
// target 形态分支/理由行事件上报/target 点击事件桥），后续单卡改动若破坏既有
// e2e 依赖的选择器契约，这里先红。文案走 setup.ts 真实 zh 文案直译。
const decideMock = vi.hoisted(() => vi.fn())
const jumpMock = vi.hoisted(() => vi.fn())
vi.mock('../../composables/useApprovalActions', () => ({
  useApprovalActions: () => ({
    agentLabel: (a?: string) => a || 'Unknown',
    decide: decideMock,
    jumpToSession: jumpMock,
    resolveReplayTarget: vi.fn(async () => null),
  }),
}))

const statusMock = vi.hoisted(() => vi.fn())
const filePolicyMock = vi.hoisted(() => vi.fn())
vi.mock('../../api/client', () => ({
  projectApi: { status: statusMock, filePolicy: filePolicyMock },
}))

const copyTextMock = vi.hoisted(() => vi.fn())
vi.mock('../../utils/clipboard', () => ({ copyText: copyTextMock }))

vi.mock('../../stores/project', () => ({
  useProjectStore: () => ({ currentProjectId: 'proj-1' }),
}))

// 先问发起者（P-20261006-50）的 broadcast-write 出口：terminal 域全量 mock（同
// TerminalBroadcastResultPanel.test.ts 惯例——域模块只留被测方法，store 侧用例
// 不触 API 调用路径不受影响）
const broadcastMock = vi.hoisted(() => vi.fn())
vi.mock('../../api/domains/terminal', () => ({
  terminalApi: { broadcastWrite: broadcastMock },
}))

// 同类历史弱行（P-20261005-173）的取数出口：opsconfirm 域 mock（卡挂载即查
// historyForOp，不 mock 会打真实 axios；list 其余消费方沿用原实现不背锅）
const historyListMock = vi.hoisted(() => vi.fn())
vi.mock('../../api/domains/opsconfirm', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../api/domains/opsconfirm')
  const api = actual.opsConfirmApi as Record<string, unknown>
  return { ...actual, opsConfirmApi: { ...api, list: historyListMock } }
})

// useMessage 依赖 NMessageProvider 注入（jsdom 无 provider 会抛错）；稳定句柄
// 供提问发送链的成功/失败提示断言
const msgMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
}))
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual('naive-ui')
  return {
    ...(actual as object),
    useMessage: () => msgMocks,
  }
})

const record = (over: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id: 'sc_ap_1',
  op: 'bash',
  agent: 'claude',
  target: 'git push origin main',
  detail: 'force push?',
  status: 'pending',
  ...over,
})

/** 微任务冲刷：点击链 mock 即时 resolve，数跳微任务即落定 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

function mountCard(over: Partial<ApprovalRecord> = {}, denyOpen = false) {
  return mount(ApprovalCard, {
    props: { record: record(over), denyOpen, denyReason: '' },
  })
}

function buttonByText(w: ReturnType<typeof mount>, label: string) {
  return w.findAll('button').find(b => b.text().trim() === label)
}

const events: CustomEvent<OpenFileAtDetail>[] = []
const onOpsOpenFileAt = (e: Event): void => { events.push(e as CustomEvent<OpenFileAtDetail>) }

// 树定位事件（P-20261003-201 目录 target 点击改派出口）与开文件事件分流收集
const locateEvents: CustomEvent<LocateInTreeDetail>[] = []
const onOpsLocateInTree = (e: Event): void => { locateEvents.push(e as CustomEvent<LocateInTreeDetail>) }

beforeEach(() => {
  decideMock.mockReset()
  jumpMock.mockReset()
  statusMock.mockReset()
  filePolicyMock.mockReset()
  copyTextMock.mockReset()
  broadcastMock.mockReset()
  historyListMock.mockReset()
  // 同类历史默认空清单：存量用例（无历史形态）不受弱行在场影响
  historyListMock.mockResolvedValue({ data: [] })
  msgMocks.success.mockReset()
  msgMocks.error.mockReset()
  msgMocks.warning.mockReset()
  msgMocks.info.mockReset()
  events.length = 0
  locateEvents.length = 0
  window.addEventListener(OPS_OPEN_FILE_AT, onOpsOpenFileAt)
  window.addEventListener(OPS_LOCATE_IN_TREE, onOpsLocateInTree)
})

afterEach(() => {
  window.removeEventListener(OPS_OPEN_FILE_AT, onOpsOpenFileAt)
  window.removeEventListener(OPS_LOCATE_IN_TREE, onOpsLocateInTree)
})

describe('ApprovalCard 单卡结构（P-20261003-87 拆分守护）', () => {
  it('卡内结构完整：头部门按钮/op/detail/三按钮裁决，无 sessionId 不渲染跳转/回放', () => {
    const w = mountCard()
    expect(w.find('.aprv-card').exists()).toBe(true)
    expect(w.find('.aprv-title').text()).toBe('智能体请求确认')
    expect(w.find('.aprv-agent').text()).toBe('claude')
    expect(w.find('.aprv-op').text()).toContain('bash')
    expect(w.find('.aprv-detail').text()).toBe('force push?')
    expect(buttonByText(w, '拒绝')).toBeTruthy()
    expect(buttonByText(w, '完全允许')).toBeTruthy()
    expect(buttonByText(w, '允许一次')).toBeTruthy()
    expect(buttonByText(w, '查看过程实况')).toBeTruthy()
    // 无 sessionId：跳转/回放两门按钮退场
    expect(w.find('[data-test="aprv-replay"]').exists()).toBe(false)
    // target 命令形（含空白）保持纯文本，无可点态
    expect(w.find('[data-test="aprv-target-link"]').exists()).toBe(false)
    expect(w.find('.aprv-target').text()).toBe('git push origin main')
  })

  it('路径形态 target 渲染可点态；点击走探测链派 OPS_OPEN_FILE_AT（无差异→开文件）', async () => {
    statusMock.mockResolvedValue({ data: [] })
    filePolicyMock.mockResolvedValue({ data: {} })
    const w = mountCard({ target: 'src/app.ts' })
    const link = w.find('[data-test="aprv-target-link"]')
    expect(link.exists()).toBe(true)
    expect(link.text()).toBe('src/app.ts')
    await link.trigger('click')
    await flush()
    expect(events).toHaveLength(1)
    expect(events[0]!.detail).toEqual({ path: 'src/app.ts', projectId: 'proj-1', diffVsHead: false })
    // 干净文件：存在性探测（filePolicy）参与
    expect(statusMock).toHaveBeenCalledWith('proj-1', { silent: true })
    expect(filePolicyMock).toHaveBeenCalled()
  })

  it('长路径 target 展示中段省略（P-20261003-231）：卡面前 20+…+后 24，title 全量', () => {
    const long = 'src/features/approval/components/approvalCards/sections/ApprovalCard.vue'
    const w = mountCard({ target: long })
    const link = w.find('[data-test="aprv-target-link"]')
    expect(link.text()).toBe(long.slice(0, 20) + '…' + long.slice(-24))
    // 全量在 tooltip：title 恒为完整路径（悬停核对出口）；点击链仍用原值
    expect(link.attributes('title')).toBe(long)
  })

  it('有未提交差异的 target 点击直开差异视图（diffVsHead=true，跳过存在性探测）', async () => {
    statusMock.mockResolvedValue({ data: [{ path: 'src/app.ts', status: 'Modified' }] })
    const w = mountCard({ target: 'src/app.ts' })
    await w.find('[data-test="aprv-target-link"]').trigger('click')
    await flush()
    expect(events).toHaveLength(1)
    expect(events[0]!.detail).toEqual({ path: 'src/app.ts', projectId: 'proj-1', diffVsHead: true })
    expect(filePolicyMock).not.toHaveBeenCalled()
  })

  it('目录 target（filePolicy 400「path is a directory」）点击派 OPS_LOCATE_IN_TREE 树定位（P-20261003-201）', async () => {
    statusMock.mockResolvedValue({ data: [] })
    // 服务端 GetFilePolicy 对已存在目录的专属 400（server/api/files/file.go），
    // 拦截器包装为 AppError（status/rawMessage）——这里以同构对象模拟
    filePolicyMock.mockRejectedValue({ status: 400, rawMessage: 'path is a directory' })
    const w = mountCard({ op: 'mkdir', target: 'src\\components' })
    await w.find('[data-test="aprv-target-link"]').trigger('click')
    await flush()
    // 树定位出口：path 归一正斜杠（LocateInTreeDetail 契约），diffVsHead 无谓
    expect(locateEvents).toHaveLength(1)
    expect(locateEvents[0]!.detail).toEqual({ path: 'src/components', projectId: 'proj-1' })
    // 不落开文件链：目录开文件必落空，两事件互斥
    expect(events).toHaveLength(0)
  })

  it('filePolicy 404（将新建路径）点击落空静默：不开文件也不树定位', async () => {
    statusMock.mockResolvedValue({ data: [] })
    filePolicyMock.mockRejectedValue({ status: 404, rawMessage: 'file not found' })
    const w = mountCard({ target: 'docs/future.md' })
    await w.find('[data-test="aprv-target-link"]').trigger('click')
    await flush()
    expect(events).toHaveLength(0)
    expect(locateEvents).toHaveLength(0)
  })

  it('sessionId 在场渲染回放门按钮，点击上报 open-replay；跳转按钮上报宿主', async () => {
    const w = mountCard({ sessionId: 'term-1' })
    expect(w.find('[data-test="aprv-replay"]').exists()).toBe(true)
    await w.find('[data-test="aprv-replay"]').trigger('click')
    expect(w.emitted('open-replay')).toHaveLength(1)
  })

  it('理由行：默认收起；denyOpen 展开后点拒绝/确认/取消/Enter/Esc 事件上报宿主', async () => {
    const w = mountCard({}, false)
    expect(w.find('[data-test="aprv-deny-input"]').exists()).toBe(false)

    // 点拒绝 → 上报 open-deny（开闭归宿主）
    await buttonByText(w, '拒绝')!.trigger('click')
    expect(w.emitted('open-deny')).toHaveLength(1)

    // 宿主置 denyOpen=true → 输入行展开
    await w.setProps({ denyOpen: true, denyReason: '' })
    expect(w.find('[data-test="aprv-deny-input"]').exists()).toBe(true)
    expect(w.find('[data-test="aprv-deny-confirm"]').exists()).toBe(true)
    expect(w.find('[data-test="aprv-deny-cancel"]').exists()).toBe(true)

    // 输入 → 理由文本经 update:denyReason 回传宿主（宿主单开状态持有）
    await w.find('[data-test="aprv-deny-input"] input').setValue('换个方案')
    expect(w.emitted('update:denyReason')?.at(-1)).toEqual(['换个方案'])

    // 确认/取消按钮事件上报
    await w.find('[data-test="aprv-deny-confirm"]').trigger('click')
    expect(w.emitted('confirm-deny')).toHaveLength(1)
    await w.find('[data-test="aprv-deny-cancel"]').trigger('click')
    expect(w.emitted('close-deny')).toHaveLength(1)

    // Enter 确认 / Esc 收起（IME 合成中的 Enter 放行不上报）
    const input = w.find('[data-test="aprv-deny-input"] input')
    await input.trigger('keydown', { key: 'Enter' })
    expect(w.emitted('confirm-deny')).toHaveLength(2)
    await input.trigger('keydown', { key: 'Escape' })
    expect(w.emitted('close-deny')).toHaveLength(2)
    await input.trigger('keydown', { key: 'Enter', isComposing: true })
    expect(w.emitted('confirm-deny')).toHaveLength(2)
  })

  it('命令式入口：showAllowAlwaysConfirm / focusDenyInput 暴露给宿主且可安全调用', () => {
    const w = mountCard()
    const vm = w.vm as unknown as {
      showAllowAlwaysConfirm: () => void
      focusDenyInput: () => void
    }
    expect(typeof vm.showAllowAlwaysConfirm).toBe('function')
    expect(typeof vm.focusDenyInput).toBe('function')
    // jsdom 无真实 Popconfirm 交互面：鸭子判定下安全 no-op 不抛错
    expect(() => vm.showAllowAlwaysConfirm()).not.toThrow()
    expect(() => vm.focusDenyInput()).not.toThrow()
  })

  it('允许一次点击直连 decide（与本卡渲染解耦，裁决链在 useApprovalActions）', async () => {
    const w = mountCard()
    await buttonByText(w, '允许一次')!.trigger('click')
    expect(decideMock).toHaveBeenCalledWith('sc_ap_1', true)
  })
})

// impact 结构化徽标行（P-20261003-319）：kind 徽标+summary+filesCount 置顶速读，
// detail 散文折叠为次级；无 impact 老卡不受影响（第一段 describe 已钉住原结构）
describe('ApprovalCard impact 徽标行（P-20261003-319）', () => {
  it('impact 卡：徽标行渲染 kind 标签/summary/filesCount，命令清单逐条呈现', () => {
    const w = mountCard({
      impact: {
        kind: 'delete',
        summary: '将删除 12 个文件',
        filesCount: 12,
        commands: ['git branch -D feature/x', 'git push origin --delete feature/x'],
      },
    })
    const badge = w.find('[data-test="aprv-impact"]')
    expect(badge.exists()).toBe(true)
    expect(w.find('.aprv-impact-kind').attributes('data-kind')).toBe('delete')
    // kind 标签走真实 zh 文案（setup.ts 直译）
    expect(badge.text()).toContain('删除')
    expect(w.find('[data-test="aprv-impact-summary"]').text()).toBe('将删除 12 个文件')
    expect(w.find('[data-test="aprv-impact-count"]').text()).toContain('12')
    const cmds = w.findAll('[data-test="aprv-impact-cmds"] code')
    expect(cmds).toHaveLength(2)
    expect(cmds[0]!.text()).toBe('git branch -D feature/x')
    // filesCount 缺省不渲染计数芯片
    const noCount = mountCard({ impact: { kind: 'other', summary: 'misc risky op' } })
    expect(noCount.find('[data-test="aprv-impact-count"]').exists()).toBe(false)
  })

  it('impact 卡 detail 折叠为次级：默认收起，点「详情」展开', async () => {
    const w = mountCard({
      detail: '一段很长很长很长的散文说明',
      impact: { kind: 'reset', summary: '回退 main 三个提交' },
    })
    // 默认收起：detail 本体不在场，折叠开关在
    expect(w.find('[data-test="aprv-detail"]').exists()).toBe(false)
    expect(w.find('[data-test="aprv-detail-fold"]').exists()).toBe(true)
    await w.find('[data-test="aprv-detail-fold"]').trigger('click')
    // 展开后 detail 在场、开关退场
    expect(w.find('[data-test="aprv-detail"]').text()).toBe('一段很长很长很长的散文说明')
    expect(w.find('[data-test="aprv-detail-fold"]').exists()).toBe(false)
  })

  it('无 impact 老卡：无徽标行，detail 原样全显（零破坏对照面）', () => {
    const w = mountCard({ detail: '散文 detail 原样' })
    expect(w.find('[data-test="aprv-impact"]').exists()).toBe(false)
    expect(w.find('[data-test="aprv-impact-cmds"]').exists()).toBe(false)
    expect(w.find('[data-test="aprv-detail-fold"]').exists()).toBe(false)
    expect(w.find('[data-test="aprv-detail"]').text()).toBe('散文 detail 原样')
  })

  it('无 detail 的 impact 卡不渲染折叠开关（开关只随 detail 在场）', () => {
    const w = mountCard({ detail: '', impact: { kind: 'deploy', summary: '重新部署生产' } })
    expect(w.find('[data-test="aprv-impact"]').exists()).toBe(true)
    expect(w.find('[data-test="aprv-detail-fold"]').exists()).toBe(false)
  })
})

// detail 长文本三行钳制（P-20261003-258）：长 detail（显式 >3 行或 >120 字符）
// 默认钳 ~3 行（clamp 类纯视觉截断，文本恒全量在 DOM）+「展开全部」解钳；
// 短 detail 不钳不显钮呈现零变化；与 P-319 impact 折叠叠加（「详情」展开后再钳）
describe('ApprovalCard 长 detail 三行钳制（P-20261003-258）', () => {
  it('多行长 detail 默认钳制：clamp 类+展开钮在场，点展开解钳（不回折）', async () => {
    const long = Array.from({ length: 6 }, (_, i) => `输出行 ${i + 1}`).join('\n')
    const w = mountCard({ detail: long })
    expect(w.find('[data-test="aprv-detail"]').classes()).toContain('aprv-detail--clamp')
    const expand = w.find('[data-test="aprv-detail-expand"]')
    expect(expand.exists()).toBe(true)
    // 文案走真实 zh 文案（setup.ts 直译）
    expect(expand.text()).toBe('展开全部')
    await expand.trigger('click')
    // 解钳：类移除、开关退场（展开后不回折）；全文仍在元素内
    expect(w.find('[data-test="aprv-detail"]').classes()).not.toContain('aprv-detail--clamp')
    expect(w.find('[data-test="aprv-detail-expand"]').exists()).toBe(false)
    expect(w.find('[data-test="aprv-detail"]').text()).toBe(long)
  })

  it('超长单行 detail（>120 字符）同样判长钳制（折行后溢出三行）', () => {
    const w = mountCard({ detail: 'x'.repeat(121) })
    expect(w.find('[data-test="aprv-detail"]').classes()).toContain('aprv-detail--clamp')
    expect(w.find('[data-test="aprv-detail-expand"]').exists()).toBe(true)
  })

  it('短 detail（恰 3 行且不超长）不钳不显钮：原样呈现零变化', () => {
    const w = mountCard({ detail: '一行说明\n两行说明\n三行说明' })
    expect(w.find('[data-test="aprv-detail"]').classes()).not.toContain('aprv-detail--clamp')
    expect(w.find('[data-test="aprv-detail-expand"]').exists()).toBe(false)
    expect(w.find('[data-test="aprv-detail"]').text()).toBe('一行说明\n两行说明\n三行说明')
  })

  it('impact 卡叠加：P-319「详情」展开后长 detail 仍钳 3 行，再点「展开全部」解钳', async () => {
    const long = Array.from({ length: 8 }, (_, i) => `build step ${i + 1}`).join('\n')
    const w = mountCard({ detail: long, impact: { kind: 'other', summary: '有 impact 的长 detail 卡' } })
    // P-319：默认整段收起（无钳制态可言）
    expect(w.find('[data-test="aprv-detail"]').exists()).toBe(false)
    await w.find('[data-test="aprv-detail-fold"]').trigger('click')
    // 展开后进入 P-258 钳制态，两段开关各司其职
    expect(w.find('[data-test="aprv-detail"]').classes()).toContain('aprv-detail--clamp')
    expect(w.find('[data-test="aprv-detail-expand"]').exists()).toBe(true)
    await w.find('[data-test="aprv-detail-expand"]').trigger('click')
    expect(w.find('[data-test="aprv-detail"]').classes()).not.toContain('aprv-detail--clamp')
    expect(w.find('[data-test="aprv-detail-expand"]').exists()).toBe(false)
  })

  it('threshold 边界：>3 行判长、恰 3 行判短；>120 字符判长、恰 120 判短', () => {
    const threeLines = 'a\nb\nc'
    expect(mountCard({ detail: threeLines }).find('[data-test="aprv-detail-expand"]').exists()).toBe(false)
    const fourLines = 'a\nb\nc\nd'
    expect(mountCard({ detail: fourLines }).find('[data-test="aprv-detail-expand"]').exists()).toBe(true)
    const exact = 'x'.repeat(120)
    expect(mountCard({ detail: exact }).find('[data-test="aprv-detail-expand"]').exists()).toBe(false)
    const over = 'x'.repeat(121)
    expect(mountCard({ detail: over }).find('[data-test="aprv-detail-expand"]').exists()).toBe(true)
  })
})

// op+target 一键复制（P-20261003-81）：op 行尾小钮复制拼合命令语境（转述出口），
// 与 target 点击正交（点复制不开文件/差异视图）
describe('ApprovalCard op+target 一键复制（P-20261003-81）', () => {
  it('op 行尾渲染复制小钮，tooltip 接 i18n（approval.copyCommand）', () => {
    const w = mountCard()
    const btn = w.find('[data-test="aprv-copy"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('title')).toBe('复制完整命令（op + target）')
  })

  it('命令形 target：点复制 copyText 收 op+target 拼合（MonitorView 同款格式），不触发探测链', async () => {
    copyTextMock.mockResolvedValue(true)
    const w = mountCard()
    await w.find('[data-test="aprv-copy"]').trigger('click')
    await flush()
    expect(copyTextMock).toHaveBeenCalledWith('bash git push origin main')
    // 与 target 点击正交：复制不派 OPS_OPEN_FILE_AT、不发探测请求
    expect(events).toHaveLength(0)
    expect(statusMock).not.toHaveBeenCalled()
    expect(filePolicyMock).not.toHaveBeenCalled()
  })

  it('路径形 target：点复制收 op+「路径」（trim 后），不派 OPS_OPEN_FILE_AT（与可点态互不干扰）', async () => {
    copyTextMock.mockResolvedValue(true)
    const w = mountCard({ target: '  src/app.ts  ' })
    await w.find('[data-test="aprv-copy"]').trigger('click')
    await flush()
    expect(copyTextMock).toHaveBeenCalledWith('bash src/app.ts')
    expect(events).toHaveLength(0)
  })

  it('无 target：只复制 op（拼合退化为单一 op 文本）', async () => {
    copyTextMock.mockResolvedValue(true)
    const w = mountCard({ target: '' })
    await w.find('[data-test="aprv-copy"]').trigger('click')
    await flush()
    expect(copyTextMock).toHaveBeenCalledWith('bash')
  })
})

// 卡头会话名归属（P-20261003-161）：agent 标签旁附发起会话名——store 查名 /
// 已关闭未知降显尾 8 位截断 id / 无 sessionId 不渲染。terminal-sessions store
// 用真实实现（setup.ts 全局 fresh pinia，用例内直接种会话数据进同名 active 实例）
describe('ApprovalCard 卡头会话名归属（P-20261003-161）', () => {
  it('发起会话在列表：卡头显会话名芯片（title 留全 id 供核对）', () => {
    useTerminalSessionsStore().sessions.push({
      id: 'term-1001', name: '修复登录', kind: 'agent', projectId: '', path: '', createdAt: '',
    })
    const w = mountCard({ sessionId: 'term-1001' })
    const chip = w.find('[data-test="aprv-session"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('修复登录')
    expect(chip.attributes('title')).toBe('term-1001')
  })

  it('已关闭/未知会话：降显尾 8 位截断 id（区分位在 term-<UnixNano> 尾部纳秒）', () => {
    const goneId = 'term-1728123456789000000'
    const w = mountCard({ sessionId: goneId })
    const chip = w.find('[data-test="aprv-session"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toBe('…' + goneId.slice(-8))
    expect(chip.text()).not.toBe(goneId)
  })

  it('短 id（≤8 位）不截断原样显示', () => {
    const w = mountCard({ sessionId: 'term-1' })
    expect(w.find('[data-test="aprv-session"]').text()).toBe('term-1')
  })

  it('无 sessionId：不渲染会话名芯片（与跳转/回放按钮同门控）', () => {
    const w = mountCard()
    expect(w.find('[data-test="aprv-session"]').exists()).toBe(false)
  })

  it('响应式跟随：挂载时列表未加载显截断 id，store 对账到会话名即换名', async () => {
    const w = mountCard({ sessionId: 'term-2002' })
    expect(w.find('[data-test="aprv-session"]').text()).toBe('…' + 'term-2002'.slice(-8))
    useTerminalSessionsStore().sessions.push({
      id: 'term-2002', name: '值班巡检', kind: 'agent', projectId: '', path: '', createdAt: '',
    })
    await nextTick()
    expect(w.find('[data-test="aprv-session"]').text()).toBe('值班巡检')
  })
})

describe('ApprovalCard 合并审批「+N 同型待批」（P-20261006-26）', () => {
  const mergedRecord = (over: Partial<ApprovalRecord> = {}): Partial<ApprovalRecord> => ({
    merged: [
      { id: 'sc_ap_m1', target: '/api/projects/p1/push', createdAt: '2026-10-13T10:00:01Z' },
      { id: 'sc_ap_m2', target: '/api/projects/p2/push', createdAt: '2026-10-13T10:00:02Z' },
    ],
    ...over,
  })

  it('无挂起队列（merged 缺省）：不渲染徽标与展开清单（老卡零变化）', () => {
    const w = mountCard()
    expect(w.find('[data-test="aprv-merged"]').exists()).toBe(false)
  })

  it('徽标渲染 +N 计数，默认折叠不显清单；展开逐条 op+target，再点收起', async () => {
    const w = mountCard(mergedRecord())
    const toggle = w.find('[data-test="aprv-merged-toggle"]')
    expect(toggle.exists()).toBe(true)
    expect(toggle.text()).toContain('+2')
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(w.find('[data-test="aprv-merged-list"]').exists()).toBe(false)

    await toggle.trigger('click')
    expect(toggle.attributes('aria-expanded')).toBe('true')
    const list = w.findAll('[data-test="aprv-merged-list"] li')
    expect(list).toHaveLength(2)
    // 逐条 op+target 可见（细控不丢）：op 与主卡同型，target 全量在 title
    expect(list[0].text()).toContain('bash')
    expect(list[0].find('.aprv-merged-target').attributes('title')).toBe('/api/projects/p1/push')

    await toggle.trigger('click')
    expect(w.find('[data-test="aprv-merged-list"]').exists()).toBe(false)
  })

  it('merged 空数组：不渲染徽标（与缺省同口径）', () => {
    const w = mountCard(mergedRecord({ merged: [] }))
    expect(w.find('[data-test="aprv-merged"]').exists()).toBe(false)
  })
})

// 先问发起者（P-20261006-50）：pending 态裁决前对话入口——按钮门控（无
// sessionId 不渲染 / 会话已关闭/未知禁用降级，P-161 存活性同源判据）/ 展开预置
// 模板（op+approvalId 内联在输入框所见文本里，所见即所发）/ 确认 broadcast-write
// （文本+\r）成功后收行并 jumpToSession / 失败保留原文可重试 / Enter 发送、
// Esc 收起。terminal-sessions store 用真实实现（同 P-161 describe 种会话数据）
describe('ApprovalCard 先问发起者（P-20261006-50）', () => {
  const pushSession = (id: string): void => {
    useTerminalSessionsStore().sessions.push({
      id, name: '提问目标会话', kind: 'agent', projectId: '', path: '', createdAt: '',
    })
  }

  it('无 sessionId：不渲染先问按钮（与跳转/回放同门控）', () => {
    const w = mountCard()
    expect(w.find('[data-test="aprv-ask"]').exists()).toBe(false)
  })

  it('会话不在列（已关闭/未知）：按钮禁用且 title 说明缘由（不哑禁）', () => {
    const w = mountCard({ sessionId: 'term-ask-gone' })
    const btn = w.find('[data-test="aprv-ask"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toBe('发起会话已结束，无法提问')
  })

  it('会话在列：按钮可用，点击展开输入行并预置模板（op+approvalId 所见即所发）', async () => {
    pushSession('term-ask-open')
    const w = mountCard({ sessionId: 'term-ask-open' })
    const btn = w.find('[data-test="aprv-ask"]')
    expect(btn.attributes('disabled')).toBeUndefined()
    expect(btn.attributes('title')).toBe('裁决前先向发起会话提问：问题将输入到该会话，发送后自动跳转过去')
    await btn.trigger('click')
    const input = w.find('[data-test="aprv-ask-input"] input')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('关于 bash（审批 sc_ap_1）：')
  })

  it('点发送：broadcastWrite 收 [sessionId]+文本\\r，成功后行收起并 jumpToSession', async () => {
    broadcastMock.mockResolvedValue({ data: { written: 1, missing: [], failed: [] } })
    pushSession('term-ask-send')
    const w = mountCard({ sessionId: 'term-ask-send' })
    await w.find('[data-test="aprv-ask"]').trigger('click')
    await w.find('[data-test="aprv-ask-input"] input').setValue('关于 bash（审批 sc_ap_1）：为什么要删？')
    await w.find('[data-test="aprv-ask-send"]').trigger('click')
    await flush()
    expect(broadcastMock).toHaveBeenCalledTimes(1)
    expect(broadcastMock).toHaveBeenCalledWith(['term-ask-send'], '关于 bash（审批 sc_ap_1）：为什么要删？\r')
    // 发送成功：输入行收起 + 自动走 P-2 跳转链 + 成功提示
    expect(w.find('[data-test="aprv-ask-input"]').exists()).toBe(false)
    expect(jumpMock).toHaveBeenCalledWith('term-ask-send')
    expect(msgMocks.success).toHaveBeenCalledTimes(1)
    // 审批未被提问动作裁决（decide 不经此链）
    expect(decideMock).not.toHaveBeenCalled()
  })

  it('Enter 确认发送 / Esc 收起不发送；IME 合成中 Enter 放行不上报', async () => {
    broadcastMock.mockResolvedValue({ data: { written: 1, missing: [], failed: [] } })
    pushSession('term-ask-key')
    const w = mountCard({ sessionId: 'term-ask-key' })
    await w.find('[data-test="aprv-ask"]').trigger('click')
    const input = w.find('[data-test="aprv-ask-input"] input')

    // Esc 收起：不发送，行退场
    await input.trigger('keydown', { key: 'Escape' })
    expect(w.find('[data-test="aprv-ask-input"]').exists()).toBe(false)
    expect(broadcastMock).not.toHaveBeenCalled()

    // 再展开 → Enter 发送
    await w.find('[data-test="aprv-ask"]').trigger('click')
    await w.find('[data-test="aprv-ask-input"] input').trigger('keydown', { key: 'Enter' })
    await flush()
    expect(broadcastMock).toHaveBeenCalledTimes(1)

    // IME 合成中的 Enter 是候选确认，放行不发送（与理由行同款守卫）
    await w.find('[data-test="aprv-ask"]').trigger('click')
    await w.find('[data-test="aprv-ask-input"] input').trigger('keydown', { key: 'Enter', isComposing: true })
    expect(broadcastMock).toHaveBeenCalledTimes(1)
  })

  it('空文本发送钮禁用（无内容的回车是 agent 输入流噪音）', async () => {
    pushSession('term-ask-empty')
    const w = mountCard({ sessionId: 'term-ask-empty' })
    await w.find('[data-test="aprv-ask"]').trigger('click')
    // 预置模板在场 = 非空可发送；清空后发送钮禁用
    expect(w.find('[data-test="aprv-ask-send"]').attributes('disabled')).toBeUndefined()
    await w.find('[data-test="aprv-ask-input"] input').setValue('')
    expect(w.find('[data-test="aprv-ask-send"]').attributes('disabled')).toBeDefined()
  })

  it('written=0（发送间隙会话消亡）：警示提示，输入行保留原文且不跳转', async () => {
    broadcastMock.mockResolvedValue({ data: { written: 0, missing: [], failed: [] } })
    pushSession('term-ask-zero')
    const w = mountCard({ sessionId: 'term-ask-zero' })
    await w.find('[data-test="aprv-ask"]').trigger('click')
    await w.find('[data-test="aprv-ask-input"] input').setValue('关于 bash（审批 sc_ap_1）：还在吗')
    await w.find('[data-test="aprv-ask-send"]').trigger('click')
    await flush()
    expect(msgMocks.warning).toHaveBeenCalledTimes(1)
    expect(w.find('[data-test="aprv-ask-input"]').exists()).toBe(true)
    expect((w.find('[data-test="aprv-ask-input"] input').element as HTMLInputElement).value).toBe('关于 bash（审批 sc_ap_1）：还在吗')
    expect(jumpMock).not.toHaveBeenCalled()
  })

  it('请求异常：错误提示，输入行保留原文可修正重试', async () => {
    broadcastMock.mockRejectedValue(new Error('network down'))
    pushSession('term-ask-err')
    const w = mountCard({ sessionId: 'term-ask-err' })
    await w.find('[data-test="aprv-ask"]').trigger('click')
    await w.find('[data-test="aprv-ask-input"] input').setValue('关于 bash（审批 sc_ap_1）：原因')
    await w.find('[data-test="aprv-ask-send"]').trigger('click')
    await flush()
    expect(msgMocks.error).toHaveBeenCalledTimes(1)
    expect(w.find('[data-test="aprv-ask-input"]').exists()).toBe(true)
    expect(jumpMock).not.toHaveBeenCalled()
  })
})

// 同类历史弱行（P-20261005-173）：挂载即查同 op 已裁决记录（historyForOp 完整串
// 精确匹配，服务端钳 3）——有历史渲染 toggle 弱行（默认收起、展开状态点+相对
// 时间+会话名摘要）；零历史/拉取失败不渲染（无锚不加行、增强信息不弹错）
describe('ApprovalCard 同类历史弱行（P-20261005-173）', () => {
  const histRecord = (over: Partial<ApprovalRecord>): ApprovalRecord => ({
    id: 'sc_ap_h1', op: 'bash', status: 'allowed',
    resolvedAt: new Date(Date.now() - 5.5 * 60_000).toISOString(), // 5 分钟前（远离分钟边界防抖）
    ...over,
  })

  it('挂载即查：list 收 historyForOp=本卡 op（完整串精确匹配的数据面契约）', async () => {
    mountCard({ op: 'reset --hard' })
    await flush()
    expect(historyListMock).toHaveBeenCalledWith({ historyForOp: 'reset --hard' })
  })

  it('有历史：toggle 显计数默认收起，展开清单条目状态点+相对时间+会话名，再点收起', async () => {
    useTerminalSessionsStore().sessions.push({
      id: 'term-h1', name: '昨晚的会话', kind: 'agent', projectId: '', path: '', createdAt: '',
    })
    historyListMock.mockResolvedValue({
      data: [
        histRecord({ id: 'sc_ap_h2', status: 'denied', sessionId: 'term-gone-1728123456789000000' }),
        histRecord({ id: 'sc_ap_h1', status: 'allowed', sessionId: 'term-h1' }),
      ],
    })
    const goneId = 'term-gone-1728123456789000000'
    const w = mountCard()
    // 拉取落定前不渲染（无锚不加行的中间态不闪行）
    expect(w.find('[data-test="aprv-history"]').exists()).toBe(false)
    await flush()
    const row = w.find('[data-test="aprv-history"]')
    expect(row.exists()).toBe(true)
    const toggle = w.find('[data-test="aprv-history-toggle"]')
    expect(toggle.text()).toContain('同类历史（2）')
    expect(toggle.text()).not.toContain('已允许') // 只计数不预展内容
    expect(toggle.attributes('aria-expanded')).toBe('false')
    expect(w.find('[data-test="aprv-history-list"]').exists()).toBe(false)

    await toggle.trigger('click')
    const items = w.findAll('[data-test="aprv-history-list"] li')
    expect(items).toHaveLength(2)
    // 状态点非颜色通道：data-status + title 结果词（复用「最近裁决」键）
    expect(items[0].attributes('data-status')).toBe('denied')
    expect(items[0].find('.aprv-history-dot').attributes('data-status')).toBe('denied')
    expect(items[0].find('.aprv-history-dot').attributes('title')).toBe('已拒绝')
    expect(items[1].find('.aprv-history-dot').attributes('data-status')).toBe('allowed')
    expect(items[1].find('.aprv-history-dot').attributes('title')).toBe('已允许')
    // 相对时间（agentTerminal.activity* 族真实文案，5.5 分钟前 → 5 分钟前）
    expect(items[0].find('.aprv-history-time').text()).toBe('5 分钟前')
    // 会话名摘要：在列显名、已关闭/未知降显尾 8 位截断 id（P-161 同判据）
    expect(items[1].find('.aprv-history-session').text()).toBe('昨晚的会话')
    expect(items[0].find('.aprv-history-session').text()).toBe('…' + goneId.slice(-8))

    await toggle.trigger('click')
    expect(w.find('[data-test="aprv-history-list"]').exists()).toBe(false)
  })

  it('零历史：弱行不渲染（无锚不加行，卡面退化为既有形态）', async () => {
    const w = mountCard()
    await flush()
    expect(w.find('[data-test="aprv-history"]').exists()).toBe(false)
  })

  it('拉取失败：静默降级弱行退场（增强信息不弹错，裁决面不受影响）', async () => {
    historyListMock.mockRejectedValue(new Error('network down'))
    const w = mountCard()
    await flush()
    expect(w.find('[data-test="aprv-history"]').exists()).toBe(false)
    expect(msgMocks.error).not.toHaveBeenCalled()
  })

  it('响应式跟随：拉取后 terminal-sessions 对账到会话名，条目摘要换名', async () => {
    historyListMock.mockResolvedValue({
      data: [histRecord({ id: 'sc_ap_h3', sessionId: 'term-h3' })],
    })
    const w = mountCard()
    await flush()
    await w.find('[data-test="aprv-history-toggle"]').trigger('click')
    expect(w.find('.aprv-history-session').text()).toBe('term-h3')
    useTerminalSessionsStore().sessions.push({
      id: 'term-h3', name: '改名后的会话', kind: 'agent', projectId: '', path: '', createdAt: '',
    })
    await nextTick()
    expect(w.find('.aprv-history-session').text()).toBe('改名后的会话')
  })
})
