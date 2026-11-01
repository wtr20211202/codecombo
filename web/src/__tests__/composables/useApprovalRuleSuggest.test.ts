import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  pendingRulePrefill,
  requestApprovalRulePrefill,
  resetApprovalRuleSuggestForTest,
  useApprovalRuleSuggest,
} from '@/composables/useApprovalRuleSuggest'
import { opsConfirmApi } from '@/api/domains/opsconfirm'
import { settingsApi } from '@/api/domains/system'
import { safeStorage } from '@/utils/storage'
import { OPEN_SETTINGS_EVENT } from '@/utils/openSettings'
import { APPROVAL_SUGGEST_SHOWN_KEY } from '@/utils/approvalPattern'
import type { ApprovalRecord } from '@/api/domains/opsconfirm'

// 审批模式自学习建议（P-20261006-28）composable 单测：数据面拉取/建议门
// （pending → 检测 → 节流 → 暂不）/节流落账/预填通道。API 双源 mock，
// 存储走真实 safeStorage（每例清键防串扰）

vi.mock('@/api/domains/opsconfirm', () => ({
  opsConfirmApi: { list: vi.fn() },
}))
vi.mock('@/api/domains/system', () => ({
  settingsApi: { get: vi.fn() },
}))

const listMock = vi.mocked(opsConfirmApi.list)
const settingsGetMock = vi.mocked(settingsApi.get)

// 检测窗与节流窗都相对 now（composable 内 suggestionFor 用 Date.now）：夹具时刻
// 必须按真实时钟构造，写死历史日期会随时间滑出 +7 天窗变成日期炸弹
// （固定 2026-10-13 在 2026-10-20 起全量单测必红）
const NOW = Date.now()

/** 造人工允许记录（间隔 1h，远超自动落库分界；daysAgo 相对 NOW） */
function allowRecord(op: string, daysAgo: number, over: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const resolvedAt = new Date(NOW - daysAgo * 24 * 3600 * 1000).toISOString()
  return {
    id: `sc_ap_${op}-${daysAgo}-${Math.random().toString(36).slice(2, 8)}`,
    op,
    status: 'allowed',
    ruleHit: '',
    createdAt: new Date(Date.parse(resolvedAt) - 3600 * 1000).toISOString(),
    resolvedAt,
    ...over,
  }
}

function pendingRecord(op: string): ApprovalRecord {
  return { id: 'sc_ap_pending', op, status: 'pending', createdAt: new Date(NOW).toISOString() }
}

/** 三连允许的默认检测源 */
function threeAllows(op: string): ApprovalRecord[] {
  return [1, 2, 3].map(i => allowRecord(`${op} #${i}`, 1))
}

function mockSources(list: ApprovalRecord[], rules: unknown[] = []): void {
  listMock.mockResolvedValue({ data: list } as never)
  settingsGetMock.mockResolvedValue({ data: { agentApprovalRules: rules } } as never)
}

async function refreshWithData(list: ApprovalRecord[], rules: unknown[] = []): Promise<void> {
  mockSources(list, rules)
  await useApprovalRuleSuggest().refresh()
}

// 固定时钟（2026-10-20 门禁实败修复）：用例的检测窗用 NOW 造数，但
// useApprovalRuleSuggest.suggestionFor/markShown 读真实 Date.now()——不钉
// 系统时间时用例只在 NOW 后 7 天内成立（2026-10-20 起三天前造的记录越窗，
// 4 例全红）。fake timers 只钉时钟不驱动定时器；异步 api mock 走微任务，
// await 链不受影响
beforeEach(() => {
  // 固定系统时钟到 NOW（门禁验证的测试时钟修复）：composable 的检测用真实
  // Date.now() 算 7 天窗，只固定夹具记录时间会让用例随真实日期漂移——NOW
  // 距今超过 7 天后全部记录出窗，整组断言假红。fake timers 让夹具与判定
  // 同源；产品代码零改动（测试时钟纪律，非产品行为）。
  vi.useFakeTimers({ now: NOW })
  resetApprovalRuleSuggestForTest()
  safeStorage.removeItem(APPROVAL_SUGGEST_SHOWN_KEY)
  listMock.mockReset()
  settingsGetMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('suggestionFor 三道门', () => {
  it('近窗手动允许达阈值且无规则覆盖 → 建议（pending op 只取前缀）', async () => {
    await refreshWithData(threeAllows('git push'))
    const { suggestionFor } = useApprovalRuleSuggest()
    expect(suggestionFor([pendingRecord('git push origin release/v4')]))
      .toEqual({ pattern: 'git push', count: 3 })
  })

  it('非 pending 记录不参与检测（裁决态记录不是建议宿主）', async () => {
    await refreshWithData(threeAllows('git push'))
    const { suggestionFor } = useApprovalRuleSuggest()
    expect(suggestionFor([allowRecord('git push origin v4', 0)])).toBeNull()
  })

  it('任一规则 opPattern 覆盖 → 不建议；「暂不」→ 会话内不再建议', async () => {
    await refreshWithData(threeAllows('git push'), [{ opPattern: 'git push', effect: 'ask' }])
    const { suggestionFor, dismiss } = useApprovalRuleSuggest()
    expect(suggestionFor([pendingRecord('git push origin v4')])).toBeNull()

    // 覆盖判定独立于暂不：无规则 + 暂不 → null
    await refreshWithData(threeAllows('git pull'))
    dismiss('git pull')
    expect(suggestionFor([pendingRecord('git pull origin main')])).toBeNull()
  })

  it('节流（含跨会话形态：存储预置）→ 不建议', async () => {
    await refreshWithData(threeAllows('git fetch'))
    safeStorage.setItem(APPROVAL_SUGGEST_SHOWN_KEY, JSON.stringify({
      'git fetch': new Date(NOW).toISOString(),
    }))
    resetApprovalRuleSuggestForTest() // 重载模块态（重开页面语义），存储保留
    const { suggestionFor } = useApprovalRuleSuggest()
    expect(suggestionFor([pendingRecord('git fetch --prune')])).toBeNull()
  })

  it('空堆 / 检测源为空 → null（不出空建议）', async () => {
    await refreshWithData([])
    const { suggestionFor } = useApprovalRuleSuggest()
    expect(suggestionFor([])).toBeNull()
    expect(suggestionFor([pendingRecord('git push origin v1')])).toBeNull()
  })
})

describe('markShown 节流落账', () => {
  it('写存储单键 JSON；同会话重算不自我隐藏（读侧快照不随落账翻新），重载后生效节流', async () => {
    await refreshWithData(threeAllows('git push'))
    const { suggestionFor, markShown } = useApprovalRuleSuggest()
    expect(suggestionFor([pendingRecord('git push origin v4')])).not.toBeNull()

    markShown('git push')
    const raw = safeStorage.getItem(APPROVAL_SUGGEST_SHOWN_KEY)
    expect(raw).toBeTruthy()
    expect(Object.keys(JSON.parse(raw!))).toEqual(['git push'])

    // 同会话任何触发重算的变更（seedPending 重入/WS 重播/refresh 再完成）
    // 都不得把「本集刚展示过」误判成「7 天内已建议」而自我隐藏——e2e 重试态
    // 实测踩坑（bar 闪现即逝）；节流的生效点是下一次加载
    expect(suggestionFor([pendingRecord('git push origin v4')])).not.toBeNull()

    // 重开页面语义（模块态复位、存储保留）：本集展示过的模式被 7 天节流抑制
    resetApprovalRuleSuggestForTest()
    const { suggestionFor: reloaded } = useApprovalRuleSuggest()
    expect(reloaded([pendingRecord('git push origin v4')])).toBeNull()
  })

  it('同会话多模式多次落账互不覆盖（写侧累积面与读侧快照合并落存储）', async () => {
    await refreshWithData(threeAllows('git push'))
    const { markShown } = useApprovalRuleSuggest()
    markShown('git push')
    markShown('git pull')
    const parsed = JSON.parse(safeStorage.getItem(APPROVAL_SUGGEST_SHOWN_KEY)!)
    expect(Object.keys(parsed).sort()).toEqual(['git pull', 'git push'])
  })
})

describe('refresh 检测源拉取', () => {
  it('双源就位：allowed 列表 + settings 规则表', async () => {
    await refreshWithData(threeAllows('git push'), [{ opPattern: 'x', effect: 'deny' }])
    expect(listMock).toHaveBeenCalledWith({ status: 'allowed', limit: 500 })
    expect(settingsGetMock).toHaveBeenCalledWith({ silent: true })
  })

  it('拉取失败保旧值（建议静默缺席，不弹错）', async () => {
    await refreshWithData(threeAllows('git push'))
    listMock.mockRejectedValue(new Error('network down'))
    settingsGetMock.mockRejectedValue(new Error('network down'))
    const { refresh, suggestionFor } = useApprovalRuleSuggest()
    await refresh()
    expect(suggestionFor([pendingRecord('git push origin v4')])).toEqual({ pattern: 'git push', count: 3 })
  })

  it('并发刷新旧响应不覆写（序号守门，后到者胜）', async () => {
    let releaseFirst!: (v: unknown) => void
    listMock.mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve }))
    settingsGetMock.mockResolvedValue({ data: { agentApprovalRules: [] } } as never)
    const { refresh } = useApprovalRuleSuggest()
    const first = refresh()
    // 第二次刷新（新数据）先于第一次返回
    mockSources(threeAllows('git push'))
    const second = refresh()
    await second
    releaseFirst({ data: [] })
    await first
    const { suggestionFor } = useApprovalRuleSuggest()
    expect(suggestionFor([pendingRecord('git push origin v4')])).toEqual({ pattern: 'git push', count: 3 })
  })
})

describe('规则预填通道', () => {
  it('requestApprovalRulePrefill：落模块级 ref + 派发设置直达事件（security）', () => {
    const dispatched: Event[] = []
    const spy = vi.spyOn(window, 'dispatchEvent').mockImplementation((e) => {
      dispatched.push(e)
      return true
    })
    try {
      requestApprovalRulePrefill('git push')
      expect(pendingRulePrefill.value).toEqual({ opPattern: 'git push', effect: 'allow' })
      const evt = dispatched.find(e => e.type === OPEN_SETTINGS_EVENT) as CustomEvent<string> | undefined
      expect(evt?.detail).toBe('security')
    } finally {
      spy.mockRestore()
    }
  })
})
