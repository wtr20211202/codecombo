import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import RunbookPanel from '../../components/terminal/RunbookPanel.vue'
import { runbookApi, type Runbook } from '../../api/client'
import { useRunbookDraftStore } from '../../stores/runbookDraft'
import { useI18n } from '../../composables/useI18n'

const { t } = useI18n()

// 运行书面板组件测试（P-20261004-17 全书去重参数表单 + P-20261005-3 录制草稿预填）：
// mock runbookApi 与 useMessage，i18n 走 setup.ts 的真实文案直译。
// 核验：多步共享同名参数只收一个输入行、确认后两步命令均被替换、
// 无参运行书不经表单直发、取消不发车、同名值并入后逐步发送预填；
// 录制草稿在位即预填新建表单（标题/步骤/失败标注）+ 入库前警示条 + 消费清位。

const listMock = vi.hoisted(() => vi.fn())
// mock domains/system（而非 client 聚合面）：面板与 useRunbookFleet 双消费方
// 必须拿到同一个 mock 实例——client 的 `export *` re-export 随域模块替换
vi.mock('../../api/domains/system', () => ({
  runbookApi: {
    list: listMock,
    create: vi.fn(),
    update: vi.fn(async () => ({ data: {} })),
    remove: vi.fn(async () => ({})),
    fleetRun: vi.fn(),
    fleetAbort: vi.fn(),
    fleetRetry: vi.fn(),
  },
}))

// 舰队运行（P-20261005-147）依赖面：终端域 scrollback（点格回看）与远程域
// 候选聚合（进面板补拉）在组件测试里静态 mock，不发真网络
vi.mock('../../api/domains/terminal', () => ({
  terminalApi: {
    scrollback: vi.fn(async () => new ArrayBuffer(0)),
  },
}))
vi.mock('../../api/domains/remote', () => ({
  remoteHostApi: {
    listAllTerminals: vi.fn(async () => ({ data: [] })),
  },
}))

// useMessage 依赖 NMessageProvider 注入（jsdom 无 provider 会抛错）
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual('naive-ui')
  return {
    ...(actual as object),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  }
})

const book = (id: string, title: string, commands: string[]): Runbook => ({
  id,
  title,
  steps: commands.map(command => ({ command })),
  createdAt: '2026-10-04T00:00:00Z',
  updatedAt: '2026-10-04T00:00:00Z',
})

/** 微任务冲刷：fetch mock 即时 resolve，挂载后的列表加载数跳微任务即落定 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const mounted: ReturnType<typeof mount>[] = []

async function mountPanel(books: Runbook[], tabs: Array<{ id: string; name: string }> = []) {
  listMock.mockResolvedValue({ data: books })
  const w = mount(RunbookPanel, { props: { runState: null, tabs } })
  mounted.push(w)
  await flush()
  return w
}

/** 打开指定运行书进入步骤视图 */
async function openBook(w: ReturnType<typeof mount>, title: string) {
  const item = w.findAll('.runbook-item').find(n => n.text().includes(title))
  expect(item, `runbook ${title} listed`).toBeTruthy()
  await item!.trigger('click')
  await flush()
}

function findButton(w: ReturnType<typeof mount>, scope: string, label: string) {
  return w.find(scope).findAll('button').find(b => b.text().trim() === label)
}

beforeEach(() => {
  listMock.mockReset()
  mounted.splice(0)
})

describe('RunbookPanel 全书去重参数表单（P-20261004-17）', () => {
  it('两步同含 {branch}：运行弹一次表单只问一个 branch，确认后两步均替换', async () => {
    const w = await mountPanel([book('rb1', '带参书', ['echo A-{branch}', 'echo B-{branch}'])])
    await openBook(w, '带参书')

    // 运行 → 不直接发车，先展开全书参数表单
    await findButton(w, '.runbook-steps-actions', '运行')!.trigger('click')
    const form = w.find('.runbook-runparams')
    expect(form.exists()).toBe(true)
    // 去重：同名参数只问一次（一行）
    expect(w.findAll('.runbook-runparams .runbook-param-row')).toHaveLength(1)
    expect(w.emitted('run')).toBeUndefined()

    await form.find('input').setValue('feature/x')
    await findButton(w, '.runbook-runparams', '填参运行')!.trigger('click')
    await flush()

    const run = w.emitted('run')
    expect(run).toHaveLength(1)
    const payload = run![0]![0] as { commands: string[]; fromIndex: number }
    expect(payload.commands).toEqual(['echo A-feature/x', 'echo B-feature/x'])
    expect(payload.fromIndex).toBe(0)
    // 确认后表单收起
    expect(w.find('.runbook-runparams').exists()).toBe(false)
  })

  it('两步不同参数：表单收两行分别填写；取消不发车', async () => {
    const w = await mountPanel([book('rb2', '双参书', ['echo {branch}', 'cd {dir}'])])
    await openBook(w, '双参书')

    await findButton(w, '.runbook-steps-actions', '运行')!.trigger('click')
    expect(w.findAll('.runbook-runparams .runbook-param-row')).toHaveLength(2)

    await w.find('.runbook-runparams').findAll('button').find(b => b.text().trim() === '取消')!.trigger('click')
    expect(w.find('.runbook-runparams').exists()).toBe(false)
    expect(w.emitted('run')).toBeUndefined()
  })

  it('无参运行书：运行不经表单直接发车', async () => {
    const w = await mountPanel([book('rb3', '无参书', ['echo one', 'echo two'])])
    await openBook(w, '无参书')

    await findButton(w, '.runbook-steps-actions', '运行')!.trigger('click')
    await flush()

    expect(w.find('.runbook-runparams').exists()).toBe(false)
    const run = w.emitted('run')
    expect(run).toHaveLength(1)
    expect((run![0]![0] as { commands: string[] }).commands).toEqual(['echo one', 'echo two'])
  })

  it('表单值并入共享记录：逐步发送的同名参数预填，替换后插入', async () => {
    const w = await mountPanel([book('rb4', '混用书', ['git checkout {branch}', 'echo done-{branch}'])])
    await openBook(w, '混用书')

    // 全书表单填 branch 确认（并入共享 paramValues 并发车）
    await findButton(w, '.runbook-steps-actions', '运行')!.trigger('click')
    await w.find('.runbook-runparams input').setValue('main')
    await findButton(w, '.runbook-runparams', '填参运行')!.trigger('click')
    await flush()
    expect(w.emitted('run')).toHaveLength(1)

    // 逐步发送第 1 步：展开内联填值区时 branch 预填全书值，直接「填好发送」
    const steps = w.findAll('.runbook-step')
    await steps[0]!.find('button').trigger('click')
    await flush()
    const inline = w.find('.runbook-params input')
    expect((inline.element as HTMLInputElement).value).toBe('main')
    await findButton(w, '.runbook-step', '填好发送')!.trigger('click')

    const insert = w.emitted('insert')
    expect(insert).toHaveLength(1)
    expect(insert![0]![0]).toBe('git checkout main')
  })
})

// 录制一键转运行书（P-20261005-3）：runbookDraft store 暂存的草稿预填新建表单
describe('RunbookPanel 录制草稿预填（P-20261005-3）', () => {
  it('草稿在位即预填新建表单：标题/步骤/失败标注 + 警示条 + 消费清位；确认走既有保存链', async () => {
    const draftStore = useRunbookDraftStore()
    draftStore.pending = {
      title: '2026-10-10 会话操作',
      onFailure: 'continue',
      steps: [
        { command: 'echo one' },
        { command: 'echo two', description: '录制时失败（exit 1）' },
      ],
      fromRecording: true,
    }
    const w = await mountPanel([])

    // 草稿消费即进新建表单（面板默认列表视图）
    const form = w.find('.runbook-form')
    expect(form.exists()).toBe(true)
    // 来源录制 → 入库前检查命令原文警示条（运行书为车道 1 明文存储）
    expect(form.find('.runbook-form-caution').exists()).toBe(true)
    expect(form.find('.runbook-form-caution').text()).toBe(t('runbook.draftCaution'))
    // 标题预填（可改）；说明缺省空
    const inputs = form.findAll('input')
    expect((inputs[0]!.element as HTMLInputElement).value).toBe('2026-10-10 会话操作')
    // 两步命令照录，失败步描述带「录制时失败」标注
    const stepRows = form.findAll('.runbook-form-step')
    expect(stepRows).toHaveLength(2)
    expect((stepRows[0]!.find('textarea').element as HTMLTextAreaElement).value).toBe('echo one')
    expect((stepRows[1]!.find('textarea').element as HTMLTextAreaElement).value).toBe('echo two')
    expect((stepRows[1]!.find('input').element as HTMLInputElement).value).toBe(t('recording.runbookFailNote', { code: 1 }))
    // 消费清位：重复挂载不二次预填旧草稿
    expect(draftStore.pending).toBeNull()

    // 确认落库：走既有 saveBook 链（onFailure 沿草稿 continue，失败标注随步骤入库）
    vi.mocked(runbookApi.create).mockResolvedValueOnce({ data: {} })
    await findButton(w, '.runbook-form-actions', '保存')!.trigger('click')
    await flush()
    expect(runbookApi.create).toHaveBeenCalledWith({
      title: '2026-10-10 会话操作',
      description: undefined,
      onFailure: 'continue',
      steps: [
        { command: 'echo one', description: undefined },
        { command: 'echo two', description: '录制时失败（exit 1）' },
      ],
    })
  })

  it('非录制来源草稿（fromRecording 缺省）不出现警示条', async () => {
    const draftStore = useRunbookDraftStore()
    draftStore.pending = {
      title: '普通草稿',
      onFailure: 'stop',
      steps: [{ command: 'echo x' }],
    }
    const w = await mountPanel([])

    expect(w.find('.runbook-form').exists()).toBe(true)
    expect(w.find('.runbook-form-caution').exists()).toBe(false)
    expect((w.find('.runbook-form input').element as HTMLInputElement).value).toBe('普通草稿')
  })
})

// ── 舰队运行（P-20261005-147）：目标多选 + 矩阵 + 中止/重试的组件面 ──
// 矩阵是 task.progress 事件驱动的合并态：组件测试派发 window 事件（与
// useOpsChannel 分发同形）驱动，API mock 供发车响应快照
import { OPS_TASK_PROGRESS } from '../../utils/opsEvents'

const fleetBook = book('rb-fleet', '舰队部署书', ['echo pull', 'echo build'])

function dispatchFleetProgress(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(OPS_TASK_PROGRESS, { detail }))
}

/** 勾选舰队目标组里的第 N 个本机终端候选（走真实 NCheckbox 点击链） */
async function checkLocalTarget(w: ReturnType<typeof mount>, index: number) {
  const box = w.findAll('.runbook-fleet-group .n-checkbox')[index]
  expect(box, `local target checkbox #${index}`).toBeTruthy()
  await box!.trigger('click')
  await flush()
}

describe('RunbookPanel 舰队运行（P-20261005-147）', () => {
  it('舰队展开→零目标发车被拦（warning 不发请求）→勾选后发车，响应快照落矩阵', async () => {
    const w = await mountPanel([fleetBook], [{ id: 't-a', name: 'shell 一号' }])
    await openBook(w, '舰队部署书')

    // 展开舰队区（本机候选组出现）
    await w.find('[data-testid="rb-fleet-toggle"]').trigger('click')
    await flush()
    expect(w.find('[data-testid="rb-fleet-launch"]').exists()).toBe(true)

    // 零目标：拦下，不发 fleetRun
    await w.find('[data-testid="rb-fleet-launch"]').trigger('click')
    await flush()
    expect(vi.mocked(runbookApi.fleetRun).mock.calls.length).toBe(0)

    // 勾一个目标后发车
    vi.mocked(runbookApi.fleetRun).mockResolvedValueOnce({
      data: {
        runId: 'frb_1', bookId: 'rb-fleet', title: '舰队部署书',
        targetIds: ['t-a', 't-b'], onFailure: 'stop', status: 'failed',
        steps: [
          { index: 0, command: 'echo pull', status: 'done', targets: [
            { id: 't-a', status: 'done', exitCode: 0 },
            { id: 't-b', status: 'done', exitCode: 0 },
          ] },
          { index: 1, command: 'echo build', status: 'failed', targets: [
            { id: 't-a', status: 'done', exitCode: 0 },
            { id: 't-b', status: 'failed', exitCode: 7 },
          ] },
        ],
      },
    } as never)
    await checkLocalTarget(w, 0)
    await w.find('[data-testid="rb-fleet-launch"]').trigger('click')
    await flush()

    expect(runbookApi.fleetRun).toHaveBeenCalledWith('rb-fleet', expect.objectContaining({
      targetIds: ['t-a'],
      onFailure: 'continue',
    }))
    // 响应快照落矩阵：failed 格可见 + 重试按钮在位（failed 可重试）
    expect(w.find('[data-testid="rb-fleet-matrix"]').exists()).toBe(true)
    expect(w.find('[data-testid="rb-fleet-matrix"]').text()).toContain('7')
    expect(w.find('[data-testid="rb-fleet-retry-1-t-b"]').exists()).toBe(true)
    expect(w.find('[data-testid="rb-fleet-abort"]').exists()).toBe(false) // 终态无中止钮
  })

  it('task.progress 事件驱动：start 建骨架（running 徽标+中止钮）、step 增量出重试钮', async () => {
    const w = await mountPanel([fleetBook], [{ id: 't-a', name: 'shell 一号' }])
    await openBook(w, '舰队部署书')
    await w.find('[data-testid="rb-fleet-toggle"]').trigger('click')
    await flush()

    vi.mocked(runbookApi.fleetRun).mockReturnValue(new Promise(() => { /* 挂起不响应——占位期 */ }))
    await checkLocalTarget(w, 0)
    await w.find('[data-testid="rb-fleet-launch"]').trigger('click')
    await flush()

    // 服务端 start 事件先于响应到达：骨架落地 + running 徽标
    dispatchFleetProgress({
      runId: 'frb_9', bookId: 'rb-fleet', status: 'running', task: 't',
      fleet: { phase: 'start', stepIndex: -1, stepTotal: 2, targetIds: ['t-a', 't-b'], stepNames: ['拉取', '构建'] },
    })
    await flush()
    expect(w.find('[data-testid="rb-fleet-status"]').text()).toContain('运行中')
    expect(w.find('[data-testid="rb-fleet-abort"]').exists()).toBe(true)

    // step 增量：t-b 第 2 步失败 → 该格出重试钮
    dispatchFleetProgress({
      runId: 'frb_9', bookId: 'rb-fleet', status: 'running', task: 't',
      fleet: { phase: 'step', stepIndex: 1, stepTotal: 2, targetIds: ['t-a', 't-b'], results: [
        { id: 't-a', status: 'done', exitCode: 0 },
        { id: 't-b', status: 'failed', exitCode: 7 },
      ] },
    })
    await flush()
    expect(w.find('[data-testid="rb-fleet-retry-1-t-b"]').exists()).toBe(true)

    // 中止：服务端终态快照回填
    vi.mocked(runbookApi.fleetAbort).mockResolvedValueOnce({
      data: {
        runId: 'frb_9', bookId: 'rb-fleet', title: '舰队部署书',
        targetIds: ['t-a', 't-b'], onFailure: 'stop', status: 'aborted',
        steps: [
          { index: 0, command: 'echo pull', status: 'done', targets: [{ id: 't-a', status: 'done', exitCode: 0 }, { id: 't-b', status: 'done', exitCode: 0 }] },
          { index: 1, command: 'echo build', status: 'aborted', targets: [{ id: 't-a', status: 'aborted' }, { id: 't-b', status: 'aborted' }] },
        ],
      },
    } as never)
    await w.find('[data-testid="rb-fleet-abort"]').trigger('click')
    await flush()
    expect(runbookApi.fleetAbort).toHaveBeenCalledWith('rb-fleet', 'frb_9', { silent: true })
    expect(w.find('[data-testid="rb-fleet-status"]').text()).toContain('已中止')
  })

  it('无确认信号格（noSignal）与超时格以标注符号呈现（诚实边界可视），done 格无重试钮', async () => {
    const w = await mountPanel([fleetBook], [{ id: 't-a', name: 'shell 一号' }])
    await openBook(w, '舰队部署书')
    await w.find('[data-testid="rb-fleet-toggle"]').trigger('click')
    await flush()

    vi.mocked(runbookApi.fleetRun).mockResolvedValueOnce({
      data: {
        runId: 'frb_2', bookId: 'rb-fleet', title: '舰队部署书',
        targetIds: ['t-bare', 't-slow'], onFailure: 'continue', status: 'completed',
        steps: [
          { index: 0, command: 'echo x', status: 'done', targets: [
            { id: 't-bare', status: 'done', noSignal: true },
            { id: 't-slow', status: 'done', timedOut: true },
          ] },
        ],
      },
    } as never)
    await checkLocalTarget(w, 0)
    await w.find('[data-testid="rb-fleet-launch"]').trigger('click')
    await flush()

    const matrix = w.find('[data-testid="rb-fleet-matrix"]')
    expect(matrix.text()).toContain('◌') // 无确认信号
    expect(matrix.text()).toContain('⏱') // 超时视为完成
    // 终态 completed 无重试钮（done 格不可重试）
    expect(w.find('[data-testid="rb-fleet-matrix"] .runbook-fleet-retry').exists()).toBe(false)
  })
})
