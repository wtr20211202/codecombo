import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pickElectionWinner, executeFrontendEffect, resetOpsAtomElectionForTest, ELECTION_COLLECT_MS, VISIBLE_BIAS_MS } from './opsAtomElection'

// 同浏览器标签选举（P-20261117-4）单测：竞选裁决的确定性是「浏览器级一次
// 效应」的根——所有标签对同一候选集必须算出同一 winner（首版重采样
// own-claim at 导致裁决分裂双执行，实测在案——单测钉 tie-break 与跨标签
// 一致性）。执行面（executeFrontendEffect 三条仲裁路径）在本文件覆盖：
// BroadcastChannel 主路径用 jsdom 真 channel（同进程跨 channel 实例互达，
// 不回送发布者自身的规范语义同样成立）；Web Locks 回退与「两者皆无」分支
// 以全局桩覆盖（jsdom 无 navigator.locks，与老浏览器形态一致）。

beforeEach(() => {
  resetOpsAtomElectionForTest()
})

afterEach(() => {
  resetOpsAtomElectionForTest()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('pickElectionWinner', () => {
  it('at 升序决定 winner（先到先得）', () => {
    const winner = pickElectionWinner([
      { id: 'tab-b', at: 200 },
      { id: 'tab-a', at: 100 },
      { id: 'tab-c', at: 300 },
    ])
    expect(winner?.id).toBe('tab-a')
  })

  it('at 平局按 id 字典序（跨标签可复现的确定性 tie-break：同毫秒主张的常态形态）', () => {
    // 两个标签对「同一对同刻主张」必须算出同一 winner——数组序相反亦然
    //（实锚：首版各标签自见主张在后，数组序不同即 winner 分裂双执行）
    const a = pickElectionWinner([
      { id: 'tab-8emsnz', at: 2608 },
      { id: 'tab-e777y1', at: 2608 },
    ])
    const b = pickElectionWinner([
      { id: 'tab-e777y1', at: 2608 },
      { id: 'tab-8emsnz', at: 2608 },
    ])
    expect(a?.id).toBe('tab-8emsnz')
    expect(b?.id).toBe('tab-8emsnz')
    expect(a?.id).toBe(b?.id)
  })

  it('空候选集返回 null（无人主张不执行，防御边界）', () => {
    expect(pickElectionWinner([])).toBeNull()
  })

  it('单候选即 winner（单标签常态快路径）', () => {
    expect(pickElectionWinner([{ id: 'tab-solo', at: 1 }])?.id).toBe('tab-solo')
  })
})

describe('选举窗常量', () => {
  it('收集窗与可见标签让先窗都在用户不可感量级（效应即时性不受损）', () => {
    expect(ELECTION_COLLECT_MS).toBeLessThanOrEqual(200)
    expect(VISIBLE_BIAS_MS).toBeLessThanOrEqual(300)
  })
})

describe('executeFrontendEffect 仲裁路径', () => {
  it('BroadcastChannel 主路径：单标签独主张即 winner，run 执行恰一次', async () => {
    // jsdom 真 BroadcastChannel：claim 收集窗内本标签只有显式补记的 own 主张
    //（channel 不回送发布者自身）→ winner=self → 执行
    const runs: number[] = []
    const won = await executeFrontendEffect(() => { runs.push(1) })
    expect(won).toBe(true)
    expect(runs).toHaveLength(1)
  }, 5000)

  it('BroadcastChannel 主路径：对方标签以更小 at 主张 → 本标签输选举静默跳过', async () => {
    // 模拟另一标签：收到本标签 claim 后立即回发一条更早的主张——
    // 确定性 tie-break（at 升序）裁决对方为 winner，本标签不得执行
    const rival = new BroadcastChannel('sc-ops-atom-election')
    let rivalSawClaim = false
    rival.addEventListener('message', (ev) => {
      const m = ev.data as { kind?: string } | null
      if (m?.kind === 'claim' && !rivalSawClaim) {
        rivalSawClaim = true
        rival.postMessage({ kind: 'claim', id: 'tab-rival-earlier', at: 1 })
      }
    })
    const runs: number[] = []
    const won = await executeFrontendEffect(() => { runs.push(1) })
    rival.close()
    expect(rivalSawClaim, '对方标签应收到本标签主张（互达前提）').toBe(true)
    expect(won).toBe(false)
    expect(runs).toHaveLength(0)
  }, 5000)

  it('Web Locks 回退：无 BroadcastChannel 且锁 grant → 本标签执行', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    // jsdom 无 navigator.locks（与无该 API 的旧浏览器同形态）——桩 grant：
    // request(ifAvailable) 立即以锁句柄回调，锁随 run 完成释放
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_name: string, _opts: unknown, cb: (lock: object) => Promise<void> | void) =>
          Promise.resolve(cb({ name: _name })),
      },
    })
    const runs: number[] = []
    const won = await executeFrontendEffect(() => { runs.push(1) })
    delete (navigator as unknown as { locks?: unknown }).locks
    expect(won).toBe(true)
    expect(runs).toHaveLength(1)
  }, 5000)

  it('Web Locks 回退：锁被他标签持有（ifAvailable 未取得）→ 静默跳过', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_name: string, _opts: unknown, cb: (lock: object | null) => void) => {
          cb(null) // 他标签在持：ifAvailable 语义回调 null
          return Promise.resolve()
        },
      },
    })
    const runs: number[] = []
    const won = await executeFrontendEffect(() => { runs.push(1) })
    delete (navigator as unknown as { locks?: unknown }).locks
    expect(won).toBe(false)
    expect(runs).toHaveLength(0)
  }, 5000)

  it('两皆无（无 BroadcastChannel 无 navigator.locks 的极老环境）→ 直接执行不丢效应', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    // navigator.locks 本就 undefined（jsdom）——best-effort 直执行分支
    const runs: number[] = []
    const won = await executeFrontendEffect(() => { runs.push(1) })
    expect(won).toBe(true)
    expect(runs).toHaveLength(1)
  }, 5000)

  it('hidden 标签让先 VISIBLE_BIAS_MS 后仍执行（前台抢跑窗口内本标签延后主张）', async () => {
    // hidden 分支在两条仲裁路径内都位于能力探测之后——走 Web Locks 路径
    //（stub grant）才能触达；延后等待 VISIBLE_BIAS_MS 后照常执行不丢效应
    vi.stubGlobal('BroadcastChannel', undefined)
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: {
        request: (_name: string, _opts: unknown, cb: (lock: object) => Promise<void> | void) =>
          Promise.resolve(cb({ name: _name })),
      },
    })
    const spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
    const runs: number[] = []
    const won = await executeFrontendEffect(() => { runs.push(1) })
    delete (navigator as unknown as { locks?: unknown }).locks
    expect(spy).toHaveBeenCalled()
    expect(won).toBe(true)
    expect(runs).toHaveLength(1)
  }, 5000)
})
