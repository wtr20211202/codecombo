import { describe, it, expect, vi, beforeEach } from 'vitest'

// naive-ui / vue-i18n 走一站式 mock 工厂（useBranchCheckout.test.ts 同款）：
// createDiscreteApi 的 message 即 messageMock 记录器，t=key 直通断言按 key
vi.mock('naive-ui', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockNaiveUi(await importOriginal()),
)
vi.mock('vue-i18n', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockVueI18n(await importOriginal()),
)

vi.mock('@/api/domains/git', () => ({
  stashApi: { list: vi.fn(), pop: vi.fn() },
}))
vi.mock('@/stores/theme', () => ({
  useThemeStore: () => ({ naiveTheme: null, naiveOverrides: null }),
}))
vi.mock('@/stores/project', () => ({
  useProjectStore: () => ({ currentProjectId: currentProjectId }),
}))

import { useStashRecover, parseStashRecoverPayload } from './useStashRecover'
import { stashApi } from '@/api/domains/git'
import { OPS_FILES_EXTERNAL_CHANGE } from '@/utils/opsEvents'
import { messageMock, resetNaiveRuntimeMocks } from '@/__tests__/mocks/naiveRuntime'

let currentProjectId = 'p1'
const fetchStatus = vi.fn()
vi.mock('@/stores/changes', () => ({
  useChangesStore: () => ({ fetchStatus }),
}))

const listFn = stashApi.list as ReturnType<typeof vi.fn>
const popFn = stashApi.pop as ReturnType<typeof vi.fn>

const PAYLOAD = JSON.stringify({ projectId: 'p1', branch: 'main', message: 'auto: checkout to feature' })

describe('parseStashRecoverPayload', () => {
  it('合法载荷：解出项目/分支/消息三键', () => {
    expect(parseStashRecoverPayload(PAYLOAD))
      .toEqual({ projectId: 'p1', branch: 'main', message: 'auto: checkout to feature' })
  })

  it('非法 JSON / 缺任一键 / 非字符串 → null（损坏通知不可恢复，不发无效请求）', () => {
    expect(parseStashRecoverPayload('not-json')).toBeNull()
    expect(parseStashRecoverPayload('{"branch":"main","message":"m"}')).toBeNull()
    expect(parseStashRecoverPayload('{"projectId":"p1","message":"m"}')).toBeNull()
    expect(parseStashRecoverPayload('{"projectId":"p1","branch":"main"}')).toBeNull()
    expect(parseStashRecoverPayload('{"projectId":"p1","branch":"","message":"m"}')).toBeNull()
    expect(parseStashRecoverPayload('{"projectId":1,"branch":"main","message":"m"}')).toBeNull()
    expect(parseStashRecoverPayload('')).toBeNull()
    expect(parseStashRecoverPayload('null')).toBeNull()
  })
})

describe('useStashRecover.recoverFromNotification', () => {
  beforeEach(() => {
    resetNaiveRuntimeMocks()
    listFn.mockReset()
    popFn.mockReset()
    fetchStatus.mockReset()
    currentProjectId = 'p1'
  })

  it('主链：按 branch+message 重定位条目并按当前栈位 pop，成功提示 + 外部变更广播 + 当前项目变更计数就地拉齐', async () => {
    // 落档时刻 index=0 的条目已被新入栈条目顶到 index=1——重定位必须取新栈位，
    // 且 P-20261003-264 起把列表下发的 hash 一并交给 pop（稳定寻址）
    listFn.mockResolvedValue({
      data: [
        { index: 0, message: 'newer manual stash', branch: 'main' },
        { index: 1, message: 'auto: checkout to feature', branch: 'main', hash: 'd'.repeat(40) },
      ],
    })
    popFn.mockResolvedValue({ data: 'ok' })
    const seen: string[] = []
    window.addEventListener(OPS_FILES_EXTERNAL_CHANGE, (e) => { seen.push(e.type) })

    const { recoverFromNotification } = useStashRecover()
    await recoverFromNotification(PAYLOAD)

    expect(listFn).toHaveBeenCalledWith('p1', { silent: true })
    expect(popFn).toHaveBeenCalledWith('p1', { index: 1, hash: 'd'.repeat(40) }, { silent: true })
    expect(messageMock.success).toHaveBeenCalledWith('git.autoStashRecoverDone:{"branch":"main"}')
    expect(seen).toEqual([OPS_FILES_EXTERNAL_CHANGE])
    expect(fetchStatus).toHaveBeenCalledWith('p1')
  })

  it('条目已不在（已被恢复/处置/旧服务端无 branch 字段）：如实提示，不动栈', async () => {
    listFn.mockResolvedValue({ data: [{ index: 0, message: 'other', branch: 'dev' }] })
    await useStashRecover().recoverFromNotification(PAYLOAD)
    expect(popFn).not.toHaveBeenCalled()
    expect(messageMock.info).toHaveBeenCalledWith('git.autoStashRecoverMissing')
  })

  it('pop 冲突：走 stashKept 同款 warning 语义（条目保留变更未丢），非拦截器错误 toast', async () => {
    listFn.mockResolvedValue({ data: [{ index: 0, message: 'auto: checkout to feature', branch: 'main' }] })
    popFn.mockRejectedValue(new Error('CONFLICT (content): Merge conflict in a.txt'))
    await useStashRecover().recoverFromNotification(PAYLOAD)
    expect(messageMock.warning).toHaveBeenCalledWith('git.autoStashRecoverConflict')
    expect(messageMock.success).not.toHaveBeenCalled()
  })

  it('损坏 payload：就地报错，零 API 调用', async () => {
    await useStashRecover().recoverFromNotification('not-json')
    expect(listFn).not.toHaveBeenCalled()
    expect(popFn).not.toHaveBeenCalled()
    expect(messageMock.error).toHaveBeenCalledWith('git.autoStashRecoverFailed')
  })

  it('非当前项目恢复：不拉变更计数（切回时自然重读）', async () => {
    currentProjectId = 'p2'
    listFn.mockResolvedValue({ data: [{ index: 0, message: 'auto: checkout to feature', branch: 'main' }] })
    popFn.mockResolvedValue({ data: 'ok' })
    await useStashRecover().recoverFromNotification(PAYLOAD)
    expect(popFn).toHaveBeenCalled()
    expect(fetchStatus).not.toHaveBeenCalled()
  })
})
