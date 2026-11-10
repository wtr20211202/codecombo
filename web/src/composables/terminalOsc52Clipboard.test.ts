import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import {
  attachOsc52Clipboard,
  hasOsc52ClipboardProof,
  getOsc52ClipboardFailure,
  markOsc52FailureShown,
  clearOsc52ClipboardFailure,
  OSC52_PROOF_CAP,
  OSC52_FAILURE_CAP,
  OSC52_FAILURE_TTL_MS,
} from './terminalOsc52Clipboard'

// OSC 52 写入接管测试（P-20261107-6）：桩 parser 捕获注册的 OSC handler，直接以
// OSC 数据串调用验证「写入 → copyText 降级链 → 成功才登记能力已证」与独占消费
// 约定（handler 恒返回 true）。copyText 隔离 mock：真实实现依赖 Pinia 剪贴板
// 历史 store 与浏览器剪贴板面，降级链本身由 utils/clipboard 测试覆盖
const { copyTextMock } = vi.hoisted(() => ({
  copyTextMock: vi.fn<(text: string) => Promise<boolean>>(),
}))
vi.mock('../utils/clipboard', () => ({ copyText: copyTextMock }))

type OscCallback = (data: string) => boolean | Promise<boolean>

function makeTermStub(): { term: Terminal; handlers: Map<number, OscCallback>; input: ReturnType<typeof vi.fn> } {
  const handlers = new Map<number, OscCallback>()
  // input 桩：读请求不回应的断言面（误回应会经 term.input 把剪贴板内容写回 PTY）
  const input = vi.fn()
  const term = {
    parser: {
      registerOscHandler: vi.fn((ident: number, cb: OscCallback) => {
        handlers.set(ident, cb)
        return { dispose: () => handlers.delete(ident) }
      }),
    },
    input,
  } as unknown as Terminal
  return { term, handlers, input }
}

// UTF-8 安全的 base64 编码（btoa 只认 Latin1：先按字节展开为 binary string）
function b64(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// copyText 异步落定后登记：等一轮宏任务让 then 回调跑完
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

// 簿记随会话 id 存活（模块级、无 reset 出口）：用例间以独立会话 id 隔离
let seq = 0
const nextId = () => `osc52-case-${++seq}`

beforeEach(() => {
  copyTextMock.mockReset()
  copyTextMock.mockResolvedValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('OSC 52 写入接管', () => {
  it('注册 ident=52 的 handler；sel=c 合法载荷 → copyText 收到 UTF-8 解码文本，成功即登记能力已证', async () => {
    const sid = nextId()
    const { term, handlers } = makeTermStub()
    attachOsc52Clipboard(sid, term)
    const osc52 = handlers.get(52)!
    expect(osc52).toBeTypeOf('function')
    expect(hasOsc52ClipboardProof(sid)).toBe(false)

    const result = osc52(`c;${b64('复制 hello ✓')}`)
    expect(result).toBe(true) // 独占消费
    expect(copyTextMock).toHaveBeenCalledWith('复制 hello ✓')
    await flush()
    expect(hasOsc52ClipboardProof(sid)).toBe(true)
  })

  it('copyText 降级链失败（非安全上下文且无手势等）→ 不登记，提示条照常', async () => {
    const sid = nextId()
    copyTextMock.mockResolvedValue(false)
    const { term, handlers } = makeTermStub()
    attachOsc52Clipboard(sid, term)

    expect(handlers.get(52)!(`c;${b64('x')}`)).toBe(true)
    await flush()
    expect(copyTextMock).toHaveBeenCalledTimes(1)
    expect(hasOsc52ClipboardProof(sid)).toBe(false)
  })

  it('sel 非 c（X11 primary）→ 消费不动作不登记（浏览器无 primary 写面）', async () => {
    const sid = nextId()
    const { term, handlers } = makeTermStub()
    attachOsc52Clipboard(sid, term)

    expect(handlers.get(52)!(`p;${b64('x')}`)).toBe(true)
    await flush()
    expect(copyTextMock).not.toHaveBeenCalled()
    expect(hasOsc52ClipboardProof(sid)).toBe(false)
  })

  it('读请求（pd=?）→ 消费不回应（只写不读：不经 term.input 把剪贴板写回 PTY）', async () => {
    const sid = nextId()
    const { term, handlers, input } = makeTermStub()
    attachOsc52Clipboard(sid, term)

    expect(handlers.get(52)!('c;?')).toBe(true)
    await flush()
    expect(input).not.toHaveBeenCalled()
    expect(copyTextMock).not.toHaveBeenCalled()
    expect(hasOsc52ClipboardProof(sid)).toBe(false)
  })

  it('畸形输入（无分号/空载荷/非法 base64）→ 消费不动作、不抛错', async () => {
    const sid = nextId()
    const { term, handlers } = makeTermStub()
    attachOsc52Clipboard(sid, term)
    const osc52 = handlers.get(52)!

    expect(osc52('c')).toBe(true)
    expect(osc52('c;')).toBe(true)
    expect(osc52('c;@@@not-base64@@@')).toBe(true)
    await flush()
    expect(copyTextMock).not.toHaveBeenCalled()
    expect(hasOsc52ClipboardProof(sid)).toBe(false)
  })

  it('粘性：登记后失败写入不翻转；同会话重挂（再 attach）不清——簿记随会话存活', async () => {
    const sid = nextId()
    const { term, handlers } = makeTermStub()
    attachOsc52Clipboard(sid, term)
    handlers.get(52)!(`c;${b64('a')}`)
    await flush()
    expect(hasOsc52ClipboardProof(sid)).toBe(true)

    copyTextMock.mockResolvedValue(false)
    handlers.get(52)!(`c;${b64('b')}`)
    await flush()
    expect(hasOsc52ClipboardProof(sid)).toBe(true)

    // LRU 驱逐/重见、终端会话管理面板交接等场景的 term 重建：新实例 attach
    // 不复位簿记（会话能力已证，提示条不得反复复现）
    const { term: remounted } = makeTermStub()
    attachOsc52Clipboard(sid, remounted)
    expect(hasOsc52ClipboardProof(sid)).toBe(true)
  })

  it('会话间隔离：A 会话登记不影响 B 会话', async () => {
    const a = nextId()
    const b = nextId()
    const t1 = makeTermStub()
    const t2 = makeTermStub()
    attachOsc52Clipboard(a, t1.term)
    attachOsc52Clipboard(b, t2.term)

    t1.handlers.get(52)!(`c;${b64('a')}`)
    await flush()
    expect(hasOsc52ClipboardProof(a)).toBe(true)
    expect(hasOsc52ClipboardProof(b)).toBe(false)
  })

  it('FIFO 上限：条目按插入序淘汰最早登记，未淘汰条目不受影响', async () => {
    const first = nextId()
    const keep = nextId()
    const fill: string[] = []
    // 阶段一：恰好填满上限（first + keep + fill = CAP），无淘汰
    for (let i = 0; i < OSC52_PROOF_CAP - 2; i++) fill.push(nextId())
    for (const sid of [first, keep, ...fill]) {
      const s = makeTermStub()
      attachOsc52Clipboard(sid, s.term)
      s.handlers.get(52)!(`c;${b64(sid)}`)
    }
    await flush()
    expect(hasOsc52ClipboardProof(first)).toBe(true)
    expect(hasOsc52ClipboardProof(keep)).toBe(true)

    // 阶段二：再登记一条触发淘汰：首键（first）出，last 进；中间条目不受影响
    const last = nextId()
    const s = makeTermStub()
    attachOsc52Clipboard(last, s.term)
    s.handlers.get(52)!(`c;${b64(last)}`)
    await flush()
    expect(hasOsc52ClipboardProof(first)).toBe(false)
    expect(hasOsc52ClipboardProof(keep)).toBe(true)
    expect(hasOsc52ClipboardProof(last)).toBe(true)
  })
})

describe('OSC 52 写失败兜底簿记（P-20261109-7 B）', () => {
  it('copyText 失败 → 同一 then(ok) 分叉登记失败条目（text 原文保留）；成功 → 不登记', async () => {
    const failId = nextId()
    copyTextMock.mockResolvedValue(false)
    const t1 = makeTermStub()
    attachOsc52Clipboard(failId, t1.term)
    t1.handlers.get(52)!(`c;${b64('secret-payload <b>x</b>')}`)
    await flush()
    const f = getOsc52ClipboardFailure(failId)
    expect(f).not.toBeNull()
    expect(f!.text).toBe('secret-payload <b>x</b>') // 原文，截断在展示层
    expect(f!.shownAt).toBeNull() // 未可见，30s 不起算
    expect(f!.failedAt).toBeGreaterThan(0)

    const okId = nextId()
    copyTextMock.mockResolvedValue(true)
    const t2 = makeTermStub()
    attachOsc52Clipboard(okId, t2.term)
    t2.handlers.get(52)!(`c;${b64('ok')}`)
    await flush()
    expect(getOsc52ClipboardFailure(okId)).toBeNull()
    expect(hasOsc52ClipboardProof(okId)).toBe(true)
  })

  it('重挂/重连重放幂等：同会话重复失败只刷新（单条、内容以最新为准），不叠条', async () => {
    const sid = nextId()
    copyTextMock.mockResolvedValue(false)
    const t1 = makeTermStub()
    attachOsc52Clipboard(sid, t1.term)
    t1.handlers.get(52)!(`c;${b64('first')}`)
    await flush()
    // 重挂：新 term 再 attach（重放历史 OSC 52 → handler 再跑）
    const t2 = makeTermStub()
    attachOsc52Clipboard(sid, t2.term)
    t2.handlers.get(52)!(`c;${b64('second')}`)
    await flush()
    const f = getOsc52ClipboardFailure(sid)
    expect(f).not.toBeNull()
    expect(f!.text).toBe('second')
    // 模块簿记无条数读数——以「首条内容被覆盖」断言刷新语义（若叠条会有两条，
    // Map 键控结构性排除叠条）
    expect(getOsc52ClipboardFailure(sid)).toBe(f)
  })

  it('30s TTL 起算 = pane 可见时刻：markOsc52FailureShown 首见落账且幂等；clear 清除', async () => {
    vi.useFakeTimers()
    try {
      const base = Date.now()
      vi.setSystemTime(base)
      const sid = nextId()
      copyTextMock.mockResolvedValue(false)
      const t1 = makeTermStub()
      attachOsc52Clipboard(sid, t1.term)
      t1.handlers.get(52)!(`c;${b64('x')}`)
      await vi.runAllTimersAsync() // flush then 回调（fake timers 下 flush 不适用）

      // 后台失败 → 首见（切回可见）时才起算；重复调用不重置（不续期）
      vi.setSystemTime(base + 20_000)
      expect(markOsc52FailureShown(sid)).toBe(true)
      expect(getOsc52ClipboardFailure(sid)!.shownAt).toBe(base + 20_000)
      expect(markOsc52FailureShown(sid)).toBe(false)
      vi.setSystemTime(base + 20_000 + OSC52_FAILURE_TTL_MS)
      expect(markOsc52FailureShown(sid)).toBe(false) // 过期后不再落账
      clearOsc52ClipboardFailure(sid)
      expect(getOsc52ClipboardFailure(sid)).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('失败 FIFO 上限：失败条目按插入序淘汰最早者（与 proof 簿记互不影响）', async () => {
    copyTextMock.mockResolvedValue(false)
    const first = nextId()
    const keep = nextId()
    const fill: string[] = []
    for (let i = 0; i < OSC52_FAILURE_CAP - 2; i++) fill.push(nextId())
    for (const sid of [first, keep, ...fill]) {
      const s = makeTermStub()
      attachOsc52Clipboard(sid, s.term)
      s.handlers.get(52)!(`c;${b64(sid)}`)
    }
    await flush()
    expect(getOsc52ClipboardFailure(first)).not.toBeNull()
    const last = nextId()
    const s = makeTermStub()
    attachOsc52Clipboard(last, s.term)
    s.handlers.get(52)!(`c;${b64(last)}`)
    await flush()
    expect(getOsc52ClipboardFailure(first)).toBeNull() // 最早失败条目被淘汰
    expect(getOsc52ClipboardFailure(keep)).not.toBeNull()
    expect(getOsc52ClipboardFailure(last)).not.toBeNull()
  })

  it('失败条目不登记 proof；成功 proof 不产生失败条目——两簿记正交', async () => {
    const sid = nextId()
    copyTextMock.mockResolvedValue(false)
    const t1 = makeTermStub()
    attachOsc52Clipboard(sid, t1.term)
    t1.handlers.get(52)!(`c;${b64('x')}`)
    await flush()
    expect(hasOsc52ClipboardProof(sid)).toBe(false)
    expect(getOsc52ClipboardFailure(sid)).not.toBeNull()
  })
})
