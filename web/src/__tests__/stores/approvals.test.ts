import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useApprovalsStore, APPROVAL_RECENT_LIMIT } from '@/stores/approvals'
import { opsConfirmApi } from '@/api/domains/opsconfirm'
import { settingsApi } from '@/api/domains/system'
import type { ApprovalRecord } from '@/api/domains/opsconfirm'

vi.mock('@/api/domains/opsconfirm', () => ({
  opsConfirmApi: { resolve: vi.fn(), list: vi.fn() },
}))

vi.mock('@/api/domains/system', () => ({
  settingsApi: { get: vi.fn() },
}))

function rec(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return { id: 'op-1', op: 'write_file', status: 'pending', ...overrides }
}

describe('approvalsStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('初始 pending 表为空', () => {
    const store = useApprovalsStore()
    expect(store.pending).toEqual({})
    expect(store.pendingList).toEqual([])
    expect(store.pendingCount).toBe(0)
  })

  it('upsert pending 记录入表并驱动 getter', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a', op: 'run_shell' }))
    store.upsert(rec({ id: 'b', op: 'write_file' }))
    expect(store.pendingCount).toBe(2)
    expect(store.pendingList.map(r => r.id)).toEqual(['a', 'b'])
    expect(store.pending.a?.op).toBe('run_shell')
  })

  it('upsert 同 id 重入覆盖旧记录（不产生重复卡片）', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a', detail: '旧详情' }))
    store.upsert(rec({ id: 'a', detail: '新详情' }))
    expect(store.pendingCount).toBe(1)
    expect(store.pending.a?.detail).toBe('新详情')
  })

  it('upsert 非 pending 状态即清账（approval.resolved 广播回流，多标签页一致）', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a' }))
    store.upsert(rec({ id: 'b' }))
    store.upsert(rec({ id: 'a', status: 'allowed' }))
    store.upsert(rec({ id: 'b', status: 'denied' }))
    expect(store.pendingCount).toBe(0)
  })

  it('upsert 无 id 的事件直接忽略', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: '' }))
    store.upsert(undefined as unknown as ApprovalRecord)
    expect(store.pendingCount).toBe(0)
  })

  it('pendingSessionIds 收敛 pending 记录的 sessionId（P-20261003-198 静默标特化归属源）', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a', sessionId: 'term-1' }))
    store.upsert(rec({ id: 'b', sessionId: 'term-2' }))
    store.upsert(rec({ id: 'c', sessionId: 'term-1' })) // 同会话多审批去重
    store.upsert(rec({ id: 'd' })) // 老记录无 sessionId 不进集合
    expect(store.pendingSessionIds.has('term-1')).toBe(true)
    expect(store.pendingSessionIds.has('term-2')).toBe(true)
    expect(store.pendingSessionIds.has('term-3')).toBe(false)
    expect(store.pendingSessionIds.size).toBe(2)
    // 裁决清账后归属同步消失
    store.markResolved('a')
    expect(store.pendingSessionIds.has('term-1')).toBe(true)
    store.markResolved('c')
    expect(store.pendingSessionIds.has('term-1')).toBe(false)
  })

  it('markResolved 移除对应 pending；未知 id 静默', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a' }))
    store.markResolved('a', 'denied')
    store.markResolved('ghost', 'allowed')
    expect(store.pendingCount).toBe(0)
  })

  it('resolve 调裁决 API（默认 always=false），成功后本地即清', async () => {
    vi.mocked(opsConfirmApi.resolve).mockResolvedValue({} as Awaited<ReturnType<typeof opsConfirmApi.resolve>>)
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a' }))
    await store.resolve('a', true)
    expect(opsConfirmApi.resolve).toHaveBeenCalledWith('a', true, false, '', '')
    expect(store.pendingCount).toBe(0)
  })

  it('resolve 透传拒绝与 always（永久档）语义', async () => {
    vi.mocked(opsConfirmApi.resolve).mockResolvedValue({} as Awaited<ReturnType<typeof opsConfirmApi.resolve>>)
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'b' }))
    await store.resolve('b', false, true)
    expect(opsConfirmApi.resolve).toHaveBeenCalledWith('b', false, true, '', '')
    expect(store.pendingCount).toBe(0)
  })

  // ---- 拒绝理由回传（P-20261003-21）：resolve 透传 reason（仅 deny 语义）----

  it('resolve 透传拒绝理由（P-20261003-21）', async () => {
    vi.mocked(opsConfirmApi.resolve).mockResolvedValue({} as Awaited<ReturnType<typeof opsConfirmApi.resolve>>)
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'c' }))
    await store.resolve('c', false, false, '别动 .env，改用环境变量')
    expect(opsConfirmApi.resolve).toHaveBeenCalledWith('c', false, false, '别动 .env，改用环境变量', '')
    expect(store.pendingCount).toBe(0)
  })

  it('resolve API 失败时卡片保留（广播回流兜底清账）', async () => {
    vi.mocked(opsConfirmApi.resolve).mockRejectedValue(new Error('network down'))
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a' }))
    await expect(store.resolve('a', true)).rejects.toThrow('network down')
    expect(store.pendingCount).toBe(1)
  })

  // ---- 全局审批模式镜像（P-20261002-126：放行徽标 ApprovalModeBadge 依据）----

  it('初始 mode 恒 ask（首查未回按保守态渲染：不亮徽标、卡片照常弹）', () => {
    const store = useApprovalsStore()
    expect(store.mode).toBe('ask')
    expect(store.allowAll).toBe(false)
  })

  it('refreshMode 读 agentApprovalMode=allow 镜像为放行态', async () => {
    vi.mocked(settingsApi.get).mockResolvedValue({ data: { agentApprovalMode: 'allow' } } as Awaited<ReturnType<typeof settingsApi.get>>)
    const store = useApprovalsStore()
    await store.refreshMode()
    expect(settingsApi.get).toHaveBeenCalledWith({ silent: true })
    expect(store.mode).toBe('allow')
    expect(store.allowAll).toBe(true)
  })

  it('refreshMode 读 ask/缺字段归一 ask', async () => {
    vi.mocked(settingsApi.get).mockResolvedValue({ data: { agentApprovalMode: 'ask' } } as Awaited<ReturnType<typeof settingsApi.get>>)
    const store = useApprovalsStore()
    await store.refreshMode()
    expect(store.mode).toBe('ask')

    vi.mocked(settingsApi.get).mockResolvedValue({ data: {} } as Awaited<ReturnType<typeof settingsApi.get>>)
    store.mode = 'allow'
    await store.refreshMode()
    expect(store.mode).toBe('ask')
  })

  it('refreshMode 失败静默保原值（镜像短暂陈旧可容忍，不弹错）', async () => {
    vi.mocked(settingsApi.get).mockRejectedValue(new Error('backend down'))
    const store = useApprovalsStore()
    store.mode = 'allow'
    await store.refreshMode()
    expect(store.mode).toBe('allow')
  })

  it('resolve(allow, always) 成功后本地同帧镜像 mode=allow（徽标即时亮起，不等广播）', async () => {
    vi.mocked(opsConfirmApi.resolve).mockResolvedValue({} as Awaited<ReturnType<typeof opsConfirmApi.resolve>>)
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a' }))
    await store.resolve('a', true, true)
    expect(store.mode).toBe('allow')
    expect(store.pendingCount).toBe(0)
  })

  it('resolve 失败不镜像 mode（后端未落盘）；允许一次/拒绝不改模式', async () => {
    vi.mocked(opsConfirmApi.resolve).mockRejectedValue(new Error('network down'))
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a' }))
    await expect(store.resolve('a', true, true)).rejects.toThrow('network down')
    expect(store.mode).toBe('ask')

    vi.mocked(opsConfirmApi.resolve).mockResolvedValue({} as Awaited<ReturnType<typeof opsConfirmApi.resolve>>)
    await store.resolve('a', true, false)
    expect(store.mode).toBe('ask')
  })

  // ---- 放行时限档位镜像（P-20261003-316）：四档 mode/expiresAt/sessionCount ----

  it('refreshMode 镜像会话级/24h 档位与到期时刻/会话数；未知值归一 ask', async () => {
    const store = useApprovalsStore()
    vi.mocked(settingsApi.get).mockResolvedValue({
      data: { agentApprovalMode: 'allow-24h', agentApprovalExpiresAt: '2026-10-06T12:00:00Z', agentApprovalSessions: 2 },
    } as Awaited<ReturnType<typeof settingsApi.get>>)
    await store.refreshMode()
    expect(store.mode).toBe('allow-24h')
    expect(store.expiresAt).toBe('2026-10-06T12:00:00Z')
    expect(store.sessionCount).toBe(2)
    expect(store.allowActive).toBe(true)
    expect(store.allowAll).toBe(false)

    vi.mocked(settingsApi.get).mockResolvedValue({
      data: { agentApprovalMode: 'allow-session', agentApprovalSessions: 1 },
    } as Awaited<ReturnType<typeof settingsApi.get>>)
    await store.refreshMode()
    expect(store.mode).toBe('allow-session')
    expect(store.allowActive).toBe(true)

    vi.mocked(settingsApi.get).mockResolvedValue({ data: { agentApprovalMode: 'bogus' } } as Awaited<ReturnType<typeof settingsApi.get>>)
    await store.refreshMode()
    expect(store.mode).toBe('ask')
    expect(store.allowActive).toBe(false)
  })

  it('resolve horizon 三选一：档位同帧镜像（24h 带到期起算）；会话计数不本地自增、就地拉镜像取服务端真值', async () => {
    vi.mocked(opsConfirmApi.resolve).mockResolvedValue({} as Awaited<ReturnType<typeof opsConfirmApi.resolve>>)
    vi.mocked(settingsApi.get).mockResolvedValue({
      data: { agentApprovalMode: 'allow-session', agentApprovalSessions: 1 },
    } as Awaited<ReturnType<typeof settingsApi.get>>)
    const store = useApprovalsStore()

    await store.resolve('a', true, false, '', 'session')
    expect(store.mode).toBe('allow-session')
    expect(store.expiresAt).toBe('')
    // 会话计数不本地 +1：settings.changed 广播在服务端授予之后发出，本页收到
    // 广播触发的 refreshMode 已读服务端真值，再叠加自增即双计（run14 徽标
    // 「2 个会话」vs 服务端 1 实证）。resolve 就地拉镜像，计数收敛到服务端
    // 真值（=1）而非自增伪值（=2）
    await vi.waitFor(() => expect(store.sessionCount).toBe(1))
    expect(settingsApi.get).toHaveBeenCalledWith({ silent: true })

    await store.resolve('b', true, false, '', '24h')
    expect(store.mode).toBe('allow-24h')
    expect(new Date(store.expiresAt).getTime()).toBeGreaterThan(Date.now())

    await store.resolve('c', true, false, '', 'always')
    expect(store.mode).toBe('allow')
    expect(store.expiresAt).toBe('')
    expect(opsConfirmApi.resolve).toHaveBeenLastCalledWith('c', true, false, '', 'always')
  })

  it('resolve session 与广播镜像乱序不双计（run14 回归）：镜像先落 1，裁决后计数仍 1', async () => {
    vi.mocked(opsConfirmApi.resolve).mockResolvedValue({} as Awaited<ReturnType<typeof opsConfirmApi.resolve>>)
    vi.mocked(settingsApi.get).mockResolvedValue({
      data: { agentApprovalMode: 'allow-session', agentApprovalSessions: 1 },
    } as Awaited<ReturnType<typeof settingsApi.get>>)
    const store = useApprovalsStore()
    // 模拟竞态败序：settings.changed 广播触发的 refreshMode 先于本地裁决收尾落地
    //（读到含本次授予的服务端真值 1），随后 resolve 的就地镜像再拉一次——
    // 两路同读真值幂等收敛，计数恒 1 不会变 2
    await store.refreshMode()
    expect(store.sessionCount).toBe(1)

    await store.resolve('a', true, false, '', 'session')
    // 宏任务冲刷：resolve 内 void refreshMode 的镜像 GET 落地后再断言
    await new Promise(r => setTimeout(r, 0))
    expect(settingsApi.get).toHaveBeenCalledTimes(2)
    expect(store.sessionCount).toBe(1)
  })

  // ---- 最近裁决就近回看（P-20261003-226）：resolved 记录留存 recent ----

  it('初始 recent 为空', () => {
    const store = useApprovalsStore()
    expect(store.recent).toEqual([])
  })

  it('resolve 成功后就地入账 recent（op/target 从本地 pending 记录取，带终态与时刻）', async () => {
    vi.mocked(opsConfirmApi.resolve).mockResolvedValue({} as Awaited<ReturnType<typeof opsConfirmApi.resolve>>)
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a', op: 'reset --hard', target: 'main' }))
    const before = Date.now()
    await store.resolve('a', true)
    expect(store.pendingCount).toBe(0)
    expect(store.recent).toHaveLength(1)
    expect(store.recent[0]).toMatchObject({ id: 'a', op: 'reset --hard', target: 'main', status: 'allowed' })
    expect(new Date(store.recent[0]!.resolvedAt!).getTime()).toBeGreaterThanOrEqual(before)

    store.upsert(rec({ id: 'b', op: 'rm -rf x' }))
    await store.resolve('b', false, false, '别删')
    expect(store.recent.map(r => r.id)).toEqual(['b', 'a'])
    expect(store.recent[0]).toMatchObject({ id: 'b', status: 'denied' })
  })

  it('resolve API 失败不入账 recent（裁决未生效）', async () => {
    vi.mocked(opsConfirmApi.resolve).mockRejectedValue(new Error('network down'))
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a' }))
    await expect(store.resolve('a', true)).rejects.toThrow('network down')
    expect(store.recent).toHaveLength(0)
  })

  it('他页裁决回流（markResolved 广播）就地入账 recent，广播终态词优先', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a', op: 'git push -f', status: 'pending' }))
    store.markResolved('a', 'denied')
    expect(store.pendingCount).toBe(0)
    expect(store.recent).toHaveLength(1)
    expect(store.recent[0]).toMatchObject({ id: 'a', op: 'git push -f', status: 'denied' })
  })

  it('markResolved 本地无记录（规则 deny 从未见卡）不入账——宁缺勿错，seed 重建补齐', () => {
    const store = useApprovalsStore()
    store.markResolved('ghost', 'denied')
    expect(store.recent).toHaveLength(0)
  })

  it('upsert 完整 resolved 记录（seed 回放路径）：清账；本地无 pending 不就地虚构 recent（权威重建在 seedPending）', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a', status: 'allowed', resolvedAt: '2026-10-07T01:00:00Z' }))
    expect(store.pendingCount).toBe(0)
    expect(store.recent).toHaveLength(0)
  })

  it('pushRecent 同 id 去重（双广播/重放幂等）', () => {
    const store = useApprovalsStore()
    store.upsert(rec({ id: 'a', detail: '第一次' }))
    store.markResolved('a', 'allowed')
    // 同 id 再回流（另一标签页广播迟到）：不产生重复条目，新形态覆盖
    store.upsert(rec({ id: 'a', detail: '第二次' }))
    store.markResolved('a', 'allowed')
    const entries = store.recent.filter(r => r.id === 'a')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.detail).toBe('第二次')
  })

  it('seedPending 同一列表响应顺带重建 recent（resolved 新→旧，pending 不入）', async () => {
    vi.mocked(opsConfirmApi.list).mockResolvedValue({
      data: [
        rec({ id: 'p1', status: 'pending' }),
        rec({ id: 'r1', status: 'allowed', resolvedAt: '2026-10-07T03:00:00Z' }),
        rec({ id: 'r2', status: 'denied', resolvedAt: '2026-10-07T05:00:00Z' }),
        rec({ id: 'r3', status: 'allowed', resolvedAt: '2026-10-07T04:00:00Z' }),
      ],
    } as Awaited<ReturnType<typeof opsConfirmApi.list>>)
    const store = useApprovalsStore()
    await store.seedPending()
    expect(store.pendingCount).toBe(1)
    expect(store.recent.map(r => r.id)).toEqual(['r2', 'r3', 'r1'])
  })

  it('seedPending recent 上限截断保最新（APPROVAL_RECENT_LIMIT 条）', async () => {
    const many = Array.from({ length: APPROVAL_RECENT_LIMIT + 5 }, (_, i) =>
      rec({ id: `r${i}`, status: 'allowed', resolvedAt: new Date(2026, 9, 1, 0, 0, i).toISOString() }))
    vi.mocked(opsConfirmApi.list).mockResolvedValue({ data: many } as Awaited<ReturnType<typeof opsConfirmApi.list>>)
    const store = useApprovalsStore()
    await store.seedPending()
    expect(store.recent).toHaveLength(APPROVAL_RECENT_LIMIT)
    // 最新 10 条在列（r5..r14），更早的 r0..r4 截掉
    expect(store.recent[0]?.id).toBe(`r${APPROVAL_RECENT_LIMIT + 4}`)
    expect(store.recent.at(-1)?.id).toBe('r5')
  })

  it('seedPending 无参调用（P-20261003-254 默认全量兼容形态：pending 全量 + resolved 重建双消费）', async () => {
    vi.mocked(opsConfirmApi.list).mockResolvedValue({ data: [] } as Awaited<ReturnType<typeof opsConfirmApi.list>>)
    const store = useApprovalsStore()
    await store.seedPending()
    // 锁定「不传 status/limit」契约：本 seed 是 P-226 recent 权威重建源，需要
    // 完整 resolved 集——若改成 status=pending 单态拉取，recent 会被每次 seed 清空
    expect(opsConfirmApi.list).toHaveBeenCalledWith()
  })
})
