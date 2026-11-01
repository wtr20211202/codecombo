import { describe, expect, it } from 'vitest'
import {
  createOscEventSink,
  createOscFrameReassembler,
  createWebglContextLossHandler,
  findDFrameBoundaries,
  normalizeOsc7Path,
  parseOsc7Cwd,
  parseOscEvents,
  scanCommandHead,
  splitPendingTail,
  stripOSC133,
  type OscEvent,
} from './useTerminalSession'

// 构造一帧 OSC 133 序列字节：ESC ] 133 ; <payload> BEL
function oscFrame(payload: string): Uint8Array {
  return new TextEncoder().encode(`\x1b]133;${payload}\x07`)
}

// 构造一帧 OSC 7 cwd 上报字节：ESC ] 7 ; <payload> <BEL 或 ST 终止>
function osc7Frame(url: string, term: '\x07' | '\x1b\\' = '\x07'): Uint8Array {
  return new TextEncoder().encode(`\x1b]7;${url}${term}`)
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}

function b64(s: string): string {
  // btoa 仅支持 Latin1：先把字符串按 UTF-8 字节展开为 binary string 再编码（无 Node Buffer 依赖）
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

// 重组器喂入并把多段合并为旧形态（write 合并 + events 拉平），复用既有断言
type Reassembler = ReturnType<typeof createOscFrameReassembler>
function pushChunk(re: Reassembler, chunk: Uint8Array): { write: string; events: OscEvent[]; segmentCount: number } {
  const { segments } = re.push(chunk)
  let written = ''
  const events: OscEvent[] = []
  for (const seg of segments) {
    written += new TextDecoder().decode(seg.write)
    events.push(...seg.events)
  }
  return { write: written, events, segmentCount: segments.length }
}

describe('parseOscEvents', () => {
  it('解析 C/D/E/A 四类帧（含中文命令 base64 解码）', () => {
    const data = concat(
      new TextEncoder().encode('output\r\n'),
      oscFrame('C'),
      oscFrame(`E;${b64('echo 你好世界')}`),
      oscFrame('D;0;1234'),
      oscFrame('A'),
    )
    const events = parseOscEvents(data)
    expect(events).toEqual([
      { type: 'C' },
      { type: 'E', command: 'echo 你好世界' },
      { type: 'D', exitCode: 0, durationMs: 1234 },
      { type: 'A' },
    ])
  })

  it('解析非零退出码与多位时长', () => {
    const events = parseOscEvents(oscFrame('D;127;98765'))
    expect(events).toEqual([{ type: 'D', exitCode: 127, durationMs: 98765 }])
  })

  it('坏 base64 的 E 帧跳过，不影响其余帧', () => {
    const data = concat(
      oscFrame('C'),
      oscFrame('E;!!!not-base64!!!'),
      oscFrame('D;1;50'),
    )
    const events = parseOscEvents(data)
    expect(events).toEqual([
      { type: 'C' },
      { type: 'D', exitCode: 1, durationMs: 50 },
    ])
  })

  it('空命令 E 帧不产生事件', () => {
    expect(parseOscEvents(oscFrame(`E;${b64('')}`))).toEqual([])
  })

  it('R 帧（服务端附着重放边界哨兵）解析为独立事件', () => {
    const data = concat(
      oscFrame('D;2;100'),
      new TextEncoder().encode('\x1b]133;R\x07'),
      oscFrame('C'),
    )
    const events = parseOscEvents(data)
    expect(events).toEqual([
      { type: 'D', exitCode: 2, durationMs: 100 },
      { type: 'R' },
      { type: 'C' },
    ])
  })

  it('G 帧（P-20261005-233 断档元信息）解析 earliestAt/serverNowAt 双参数', () => {
    const events = parseOscEvents(
      concat(
        new TextEncoder().encode('\x1b]133;G;1739000000000;1739000000010\x07'),
        oscFrame('C'),
      ),
    )
    expect(events).toEqual([
      { type: 'G', earliestAt: 1739000000000, serverNowAt: 1739000000010 },
      { type: 'C' },
    ])
  })

  it('G 帧参数缺失/非法按 0 处理（0 不会大于任何锚点，天然退化为不标记）', () => {
    expect(parseOscEvents(new TextEncoder().encode('\x1b]133;G\x07'))).toEqual([
      { type: 'G', earliestAt: 0, serverNowAt: 0 },
    ])
    expect(parseOscEvents(new TextEncoder().encode('\x1b]133;G;abc;def\x07'))).toEqual([
      { type: 'G', earliestAt: 0, serverNowAt: 0 },
    ])
  })

  it('无帧数据返回空数组', () => {
    expect(parseOscEvents(new TextEncoder().encode('plain text'))).toEqual([])
  })
})

describe('stripOSC133', () => {
  it('混合 C/D/E 帧剥离，保留普通文本', () => {
    const data = concat(
      new TextEncoder().encode('before\r\n'),
      oscFrame('C'),
      oscFrame(`E;${b64('echo hi')}`),
      new TextEncoder().encode('hi\r\n'),
      oscFrame('D;0;10'),
      oscFrame('A'),
      new TextEncoder().encode('after'),
    )
    const stripped = new TextDecoder().decode(stripOSC133(data))
    expect(stripped).toBe('before\r\nhi\r\nafter')
  })

  it('多字节 UTF-8 字符与帧交错剥离后字节完整', () => {
    const data = concat(
      new TextEncoder().encode('中文输出\r\n'),
      oscFrame('C'),
      new TextEncoder().encode(' emoji 🎉 完成\r\n'),
      oscFrame('D;0;5'),
    )
    const stripped = new TextDecoder().decode(stripOSC133(data))
    expect(stripped).toBe('中文输出\r\n emoji 🎉 完成\r\n')
  })

  it('尾随不完整帧（无 BEL 终止）一并剥离', () => {
    const partial = new TextEncoder().encode('\x1b]133;E;YWJj') // 无 \x07
    const data = concat(new TextEncoder().encode('ok'), partial)
    const stripped = new TextDecoder().decode(stripOSC133(data))
    expect(stripped).toBe('ok')
  })

  it('无帧数据原样返回（同一引用）', () => {
    const data = new TextEncoder().encode('nothing to strip')
    expect(stripOSC133(data)).toBe(data)
  })
})

describe('splitPendingTail', () => {
  it('尾部完整帧（有 BEL）不暂存', () => {
    const buf = concat(new TextEncoder().encode('text'), oscFrame('C'))
    const { head, tail } = splitPendingTail(buf)
    expect(head).toBe(buf)
    expect(tail.length).toBe(0)
  })

  it('尾部 E 帧 payload 未终结 → 整帧暂存', () => {
    const headPart = concat(new TextEncoder().encode('out\r\n'), oscFrame('C'))
    const eTail = new TextEncoder().encode('\x1b]133;E;YWJj') // 无 BEL
    const buf = concat(headPart, eTail)
    const { head, tail } = splitPendingTail(buf)
    expect(new TextDecoder().decode(head)).toBe('out\r\n\x1b]133;C\x07')
    expect(new TextDecoder().decode(tail)).toBe('\x1b]133;E;YWJj')
  })

  it('帧头被截在 message 边界（1..5 字节前缀）→ 暂存', () => {
    for (const cut of ['\x1b', '\x1b]', '\x1b]1', '\x1b]13', '\x1b]133']) {
      const buf = concat(new TextEncoder().encode('text'), new TextEncoder().encode(cut))
      const { head, tail } = splitPendingTail(buf)
      expect(new TextDecoder().decode(head)).toBe('text')
      expect(new TextDecoder().decode(tail)).toBe(cut)
    }
  })

  it('非 133 的转义序列（CSI / OSC 0）分叉 → 不暂存（xterm 流式解析器兜底）', () => {
    for (const seq of ['\x1b[2J', '\x1b[0;title']) {
      const buf = concat(new TextEncoder().encode('text'), new TextEncoder().encode(seq))
      const { head, tail } = splitPendingTail(buf)
      expect(head).toBe(buf)
      expect(tail.length).toBe(0)
    }
  })

  it('无 ESC 数据不暂存', () => {
    const buf = new TextEncoder().encode('中文纯文本 🎉')
    const { head, tail } = splitPendingTail(buf)
    expect(head).toBe(buf)
    expect(tail.length).toBe(0)
  })
})

describe('findDFrameBoundaries', () => {
  it('无 D 帧（纯文本 / 仅 C/E 帧）返回空', () => {
    expect(findDFrameBoundaries(new TextEncoder().encode('plain text\r\n'))).toEqual([])
    const data = concat(oscFrame('C'), oscFrame(`E;${b64('ls')}`))
    expect(findDFrameBoundaries(data)).toEqual([])
  })

  it('单条 D 帧返回 BEL 后边界；多条 D 帧返回全部边界', () => {
    const d1 = oscFrame('D;1;10')
    const d2 = oscFrame('D;0;20')
    expect(findDFrameBoundaries(concat(new TextEncoder().encode('out'), d1)))
      .toEqual([new TextEncoder().encode('out').length + d1.length])
    const bounds = findDFrameBoundaries(concat(d1, new TextEncoder().encode('mid'), d2))
    expect(bounds).toEqual([d1.length, d1.length + 3 + d2.length])
  })

  it('C/E 帧在 D 帧之前被整帧跳过，边界只认 D', () => {
    const data = concat(oscFrame('C'), oscFrame(`E;${b64('false')}`), oscFrame('D;1;5'))
    const cLen = oscFrame('C').length
    const eLen = oscFrame(`E;${b64('false')}`).length
    expect(findDFrameBoundaries(data)).toEqual([cLen + eLen + oscFrame('D;1;5').length])
  })

  it('尾部未终结的 D 帧（无 BEL）不产生边界', () => {
    const partial = new TextEncoder().encode('\x1b]133;D;1;5') // 无 \x07
    const data = concat(new TextEncoder().encode('ok'), partial)
    expect(findDFrameBoundaries(data)).toEqual([])
  })
})

describe('createOscFrameReassembler', () => {
  it('E 帧拆 3 条 message：无乱码写入、事件完整、pending 清空', () => {
    // 模拟 readLoop 4096 分片：完整输出流 = 文本 + C 帧 + 大 E 帧（base64 后约 6.7KB）+ 文本，
    // 按固定 1000 字节切 message，切点必然落进 E 帧内部
    const stream = concat(
      new TextEncoder().encode('start\r\n'),
      oscFrame('C'),
      oscFrame(`E;${b64('echo ' + 'x'.repeat(5000))}`),
      new TextEncoder().encode('done\r\n'),
    )
    const chunks: Uint8Array[] = []
    for (let off = 0; off < stream.length; off += 1000) {
      chunks.push(stream.subarray(off, Math.min(off + 1000, stream.length)))
    }

    const re = createOscFrameReassembler()
    const writes: string[] = []
    const events: ReturnType<typeof parseOscEvents> = []
    for (const chunk of chunks) {
      const r = pushChunk(re, chunk)
      writes.push(r.write)
      events.push(...r.events)
    }

    // 写入合并后为干净输出（无 base64 乱码段），帧事件完整解析（命令文本无损还原）
    expect(writes.join('')).toBe('start\r\ndone\r\n')
    expect(events).toEqual([
      { type: 'C' },
      { type: 'E', command: 'echo ' + 'x'.repeat(5000) },
    ])
    // pending 清空：最后一条 message 后再推新数据，无残留拼接
    const final = pushChunk(re, new TextEncoder().encode('tail-ok'))
    expect(final.write).toBe('tail-ok')
    expect(final.events).toEqual([])
  })

  it('中文命令 E 帧分片（UTF-8 字节级拼接）还原无损', () => {
    const stream = concat(
      oscFrame('C'),
      oscFrame(`E;${b64('echo 你好世界 🎉'.repeat(200))}`),
      oscFrame('D;0;42'),
    )
    const cmd = 'echo 你好世界 🎉'.repeat(200)
    // 拆 3 条：帧头+部分 / 中段 / 尾段（切点落在 base64 内部任意字节）
    const third = Math.floor(stream.length / 3)
    const chunks = [
      stream.subarray(0, third),
      stream.subarray(third, third * 2),
      stream.subarray(third * 2),
    ]

    const re = createOscFrameReassembler()
    const events: ReturnType<typeof parseOscEvents> = []
    let written = ''
    for (const chunk of chunks) {
      const r = pushChunk(re, chunk)
      written += r.write
      events.push(...r.events)
    }

    expect(written).toBe('') // 全部字节都属于帧，无内容写入
    expect(events).toEqual([
      { type: 'C' },
      { type: 'E', command: cmd },
      { type: 'D', exitCode: 0, durationMs: 42 },
    ])
  })

  it('帧头跨 message（message 尾只有 ESC）拼接后正确解析', () => {
    const enc = new TextEncoder()
    const re = createOscFrameReassembler()

    const r1 = pushChunk(re, concat(enc.encode('text'), enc.encode('\x1b'))) // 尾部孤立 ESC
    expect(r1.write).toBe('text')

    const r2 = pushChunk(re, enc.encode(']133;C\x07rest'))
    expect(r2.write).toBe('rest')
    expect(r2.events).toEqual([{ type: 'C' }])
  })

  it('同 message 两条 D 帧：切成两段（各自带 D），事件顺序与写入内容对齐', () => {
    const enc = new TextEncoder()
    const re = createOscFrameReassembler()
    // 模拟快速连续命令：out1 + D1(fail) + out2 + D2(fail) 同一条 message
    const { segments } = re.push(concat(
      enc.encode('out1\r\n'),
      oscFrame('D;1;10'),
      enc.encode('out2\r\n'),
      oscFrame('D;2;20'),
    ))
    expect(segments).toHaveLength(2)
    expect(new TextDecoder().decode(segments[0]!.write)).toBe('out1\r\n')
    expect(segments[0]!.events).toEqual([{ type: 'D', exitCode: 1, durationMs: 10 }])
    expect(new TextDecoder().decode(segments[1]!.write)).toBe('out2\r\n')
    expect(segments[1]!.events).toEqual([{ type: 'D', exitCode: 2, durationMs: 20 }])
  })

  it('D 帧跨 message：pending 拼接完成后的 D 帧同样被切出', () => {
    const enc = new TextEncoder()
    const re = createOscFrameReassembler()
    // M1 尾部是半个 D 帧；M2 完成它并追加第二条命令的 D 帧
    const dFrame = oscFrame('D;1;7')
    const half = Math.floor(dFrame.length / 2)
    const r1 = pushChunk(re, concat(enc.encode('err\r\n'), dFrame.subarray(0, half)))
    expect(r1.events).toEqual([])
    const { segments } = re.push(concat(dFrame.subarray(half), enc.encode('more'), oscFrame('D;3;9')))
    expect(segments).toHaveLength(2)
    expect(segments[0]!.events).toEqual([{ type: 'D', exitCode: 1, durationMs: 7 }])
    expect(new TextDecoder().decode(segments[1]!.write)).toBe('more')
    expect(segments[1]!.events).toEqual([{ type: 'D', exitCode: 3, durationMs: 9 }])
  })

  it('reset 丢弃半帧缓冲', () => {
    const enc = new TextEncoder()
    const re = createOscFrameReassembler()
    re.push(enc.encode('\x1b]133;E;YWJj')) // 半帧入 pending
    re.reset()
    // reset 后下条数据不与旧半帧拼接（]j 与新文本原样写出）
    const r = pushChunk(re, enc.encode('new-data'))
    expect(r.write).toBe('new-data')
    expect(r.events).toEqual([])
  })

  it('超 64KB 异常流兜底：丢弃 pending 降级处理', () => {
    const enc = new TextEncoder()
    const re = createOscFrameReassembler()
    // 灌入 64KB+ 的半帧（无 BEL）触发上限
    re.push(enc.encode('\x1b]133;E;'))
    re.push(new Uint8Array(64 * 1024).fill(0x61)) // 'a' * 64KB，无 BEL
    // 上限触发后 pending 被丢弃：后续数据按无缓冲语义处理
    const r = pushChunk(re, enc.encode('clean'))
    expect(r.write).toBe('clean')
    expect(r.events).toEqual([])
  })
})

describe('createWebglContextLossHandler', () => {
  it('上下文丢失回调触发 addon dispose + 提示，顺序为先降级后告知', () => {
    const calls: string[] = []
    const onContextLoss = createWebglContextLossHandler({
      dispose: () => calls.push('dispose'),
      notify: () => calls.push('notify'),
    })
    onContextLoss()
    expect(calls).toEqual(['dispose', 'notify'])
  })

  it('同一会话重复派发（webglcontextlost 可能多次触发）：dispose 与提示都只执行一次', () => {
    let disposeCount = 0
    let notifyCount = 0
    const onContextLoss = createWebglContextLossHandler({
      dispose: () => disposeCount++,
      notify: () => notifyCount++,
    })
    onContextLoss()
    onContextLoss()
    onContextLoss()
    expect(disposeCount).toBe(1)
    expect(notifyCount).toBe(1)
  })
})

describe('createOscEventSink', () => {
  it('重放门禁盖章：R 哨兵前的 C/D 标记 replayed，之后的为活动事件', () => {
    const hooked: OscEvent[] = []
    const sink = createOscEventSink({ sessionId: 's1', oscHook: (ev) => hooked.push(ev) })
    // R 哨兵前的重放段：C/D 均盖章 replayed
    sink.processEvents([
      { type: 'C' },
      { type: 'D', exitCode: 0, durationMs: 5 },
    ])
    // R 哨兵开启门禁后的活动段
    sink.processEvents([
      { type: 'R' },
      { type: 'C' },
      { type: 'D', exitCode: 0, durationMs: 7 },
    ])
    expect(hooked).toEqual([
      { type: 'C', replayed: true },
      { type: 'D', exitCode: 0, durationMs: 5, replayed: true, command: undefined },
      { type: 'C', replayed: false },
      { type: 'D', exitCode: 0, durationMs: 7, replayed: false, command: undefined },
    ])
  })

  it('盖章写回原始事件对象：写入链按 seg.events 过滤非重放 C/D 做行号记账', () => {
    const sink = createOscEventSink({ sessionId: 's2' })
    const events: OscEvent[] = [{ type: 'C' }, { type: 'D', exitCode: 0, durationMs: 1 }]
    sink.processEvents(events)
    // processEvents 就地盖章：调用方持有的同一段事件对象带上了重放语义
    expect(events.map((ev) => ev.replayed)).toEqual([true, true])
    // 重关门禁（重连重放前调用）：后续事件重新视为重放
    sink.processEvents([{ type: 'R' }])
    const live: OscEvent[] = [{ type: 'C' }]
    sink.processEvents(live)
    expect(live[0]!.replayed).toBe(false)
  })

  it('closeHistoryGate 重关：每次连接（含重连）后重放段重新盖章 replayed', () => {
    const hooked: OscEvent[] = []
    const sink = createOscEventSink({ sessionId: 's3', oscHook: (ev) => hooked.push(ev) })
    sink.processEvents([{ type: 'R' }, { type: 'D', exitCode: 0, durationMs: 1 }])
    sink.closeHistoryGate() // 重连：scrollback 重放前重关门禁
    sink.processEvents([{ type: 'D', exitCode: 0, durationMs: 2 }])
    expect(hooked[1]).toMatchObject({ type: 'D', replayed: true })
  })
})

// ── OSC 7 cwd 上报（P-20261004-59）：解析 / 盘符折算 / 半帧重组 ──
describe('normalizeOsc7Path', () => {
  it('file URL 剥 scheme 与 host，POSIX 路径原样', () => {
    expect(normalizeOsc7Path('file://myhost/home/u/sub')).toBe('/home/u/sub')
    expect(normalizeOsc7Path('file:///home/u/root')).toBe('/home/u/root')
  })

  it('Windows 盘符形态 /C:/... 折算为 C:/...（统一正斜杠口径）', () => {
    expect(normalizeOsc7Path('file://myhost/C:/Users/u/sub')).toBe('C:/Users/u/sub')
    expect(normalizeOsc7Path('file:///d:/work')).toBe('d:/work')
  })

  it('百分号解码：空格消歧；非法编码序列（裸 %）保留原样不弃帧', () => {
    expect(normalizeOsc7Path('file://h/a%20b/c')).toBe('/a b/c')
    expect(normalizeOsc7Path('file://h/100%x')).toBe('/100%x')
  })

  it('? # 越界内容截断', () => {
    expect(normalizeOsc7Path('file://h/a?x=1')).toBe('/a')
    expect(normalizeOsc7Path('file://h/a#frag')).toBe('/a')
  })

  it('非 file URL / 无路径段返回 null（弃帧）', () => {
    expect(normalizeOsc7Path('not-a-file-url')).toBeNull()
    expect(normalizeOsc7Path('file://hostonly')).toBeNull()
    expect(normalizeOsc7Path('file://h/')).toBe('/')
  })
})

describe('parseOsc7Cwd', () => {
  it('BEL 终止帧解出 cwd', () => {
    const data = concat(new TextEncoder().encode('out\r\n'), osc7Frame('file://h/home/u/sub'))
    expect(parseOsc7Cwd(data)).toBe('/home/u/sub')
  })

  it('ST 终止帧（第三方集成惯例）同样识别', () => {
    expect(parseOsc7Cwd(osc7Frame('file://h/home/st', '\x1b\\'))).toBe('/home/st')
  })

  it('同 chunk 多帧取最近一帧（快速连续 cd）', () => {
    const data = concat(osc7Frame('file://h/first'), new TextEncoder().encode(' mid '), osc7Frame('file://h/second'))
    expect(parseOsc7Cwd(data)).toBe('/second')
  })

  it('无帧 / 非 file 载荷返回 null', () => {
    expect(parseOsc7Cwd(new TextEncoder().encode('plain text'))).toBeNull()
    expect(parseOsc7Cwd(osc7Frame('garbage'))).toBeNull()
    expect(parseOsc7Cwd(concat(oscFrame('C'), oscFrame('D;0;1')))).toBeNull()
  })

  it('tmux DCS passthrough 包装形态（bash/zsh 在 $TMUX 内）照常寻中', () => {
    const wrapped = new TextEncoder().encode('\x1bPtmux;\x1b\x1b]7;file://h/home/u/tmux\x07\x1b\\')
    expect(parseOsc7Cwd(wrapped)).toBe('/home/u/tmux')
  })
})

describe('splitPendingTail × OSC 7', () => {
  it('尾部完整 7 号帧（有 BEL）不暂存', () => {
    const buf = concat(new TextEncoder().encode('text'), osc7Frame('file://h/x'))
    const { head, tail } = splitPendingTail(buf)
    expect(head).toBe(buf)
    expect(tail.length).toBe(0)
  })

  it('7 号帧 payload 未终结 → 整帧暂存', () => {
    const buf = concat(oscFrame('C'), new TextEncoder().encode('\x1b]7;file://h/home')) // 无终止
    const { head, tail } = splitPendingTail(buf)
    expect(new TextDecoder().decode(head)).toBe('\x1b]133;C\x07')
    expect(new TextDecoder().decode(tail)).toBe('\x1b]7;file://h/home')
  })

  it('7 号帧头被截在 message 边界（1..3 字节前缀）→ 暂存', () => {
    for (const cut of ['\x1b', '\x1b]', '\x1b]7']) {
      const buf = concat(new TextEncoder().encode('text'), new TextEncoder().encode(cut))
      const { head, tail } = splitPendingTail(buf)
      expect(new TextDecoder().decode(head)).toBe('text')
      expect(new TextDecoder().decode(tail)).toBe(cut)
    }
  })
})

describe('createOscFrameReassembler × OSC 7', () => {
  it('cwd 帧跨 message 分片：拼接后解出 cwd，写入流不含 133 残留', () => {
    const stream = concat(
      new TextEncoder().encode('hello\r\n'),
      oscFrame('D;0;5'),
      osc7Frame('file://h/home/u/split'),
    )
    const cut = stream.length - 6 // 切点落在 7 号帧内部
    const re = createOscFrameReassembler()
    const r1 = pushChunk(re, stream.subarray(0, cut))
    expect(r1.events).toEqual([{ type: 'D', exitCode: 0, durationMs: 5 }])
    const r2 = pushChunk(re, stream.subarray(cut))
    expect(r2.events).toEqual([])
    expect(r2.write).toBe('\u001b]7;file://h/home/u/split\u0007') // OSC 7 帧字节随流写入（xterm 静默消费不渲染）
    expect(parseOsc7Cwd(concat(new TextEncoder().encode(r1.write), new TextEncoder().encode(r2.write)))).toBe('/home/u/split')
  })

  it('reset 丢弃半帧缓冲：重连重放前旧 cwd 残帧不污染新流', () => {
    const re = createOscFrameReassembler()
    pushChunk(re, new TextEncoder().encode('\x1b]7;file://h/stale'))
    re.reset()
    const r = pushChunk(re, osc7Frame('file://h/fresh'))
    expect(parseOsc7Cwd(new TextEncoder().encode(r.write))).toBe('/fresh')
  })
})

// ── 命令回显头扫描（P-20261006-37）：reanchorCommandStart 与重放失败恢复共用
// 的内容重锚原语——「光标读数不可信」的 buffer 上按命令文本重找回显行。
// 严格命中 = head 前一字符紧邻提示符字符（cmd.exe 形态 `D:\proj>dir` 无空格）；
// PowerShell/bash 的 `> cmd`（提示符后有空格）天然走宽松兜底，防误锚由
// 「fallback 只记首个 + 结果仅向下生效（reanchor）」承担 ──
describe('scanCommandHead', () => {
  function fakeBuffer(lines: string[]) {
    return (i: number) => {
      const text = lines[i]
      return text === undefined ? undefined : { translateToString: () => text }
    }
  }

  it('严格命中：head 前一字符紧邻提示符字符（cmd.exe 无空格形态）', () => {
    const lines = ['', 'Windows PowerShell', 'D:/proj>go test ./...', 'ok']
    expect(scanCommandHead(fakeBuffer(lines), 'go test ./...', 3, 60)).toEqual({ row: 2, col: 8 })
  })

  it('严格命中优先于宽松命中：输出正文里的同文行不劫持（更近的宽松行让位于提示符形态行）', () => {
    const lines = ['go test ./... passed', 'some output', 'D:/proj>go test ./...']
    expect(scanCommandHead(fakeBuffer(lines), 'go test ./...', 2, 60)).toEqual({ row: 2, col: 8 })
  })

  it('无严格命中回退宽松命中（行内任意位置的首个命中——PS> 提示符带空格形态）', () => {
    const lines = ['output mentions go test ./... inside', 'PS> tail']
    expect(scanCommandHead(fakeBuffer(lines), 'go test ./...', 1, 60)).toEqual({ row: 0, col: 16 })
  })

  it('找不到（命令被裁出窗/无同文）返回 null', () => {
    const lines = ['PS> ', 'unrelated']
    expect(scanCommandHead(fakeBuffer(lines), 'go test ./...', 1, 60)).toBeNull()
  })

  it('扫描窗钳制：fromLine 上方 maxRows 行之外的命中不可见', () => {
    const lines = ['D:/proj>go test ./...']
    const deep: string[] = [...Array.from({ length: 80 }, (_, i) => `filler ${i}`), 'PS> tail']
    expect(scanCommandHead(fakeBuffer(lines), 'go test ./...', 0, 60)).toEqual({ row: 0, col: 8 })
    expect(scanCommandHead(fakeBuffer(deep), 'go test ./...', 80, 60)).toBeNull()
  })

  it('头片段自长到短尝试：折行把长片段劈开时长片段 miss 短片段命中', () => {
    // 命令 'go test ./... -run TestXyz' 的 24/16 字符片段超出回显行实际内容
    // （折行劈开），10 字符片段仍整行可寻
    const lines = ['D:/proj>go test ./...']
    expect(scanCommandHead(fakeBuffer(lines), 'go test ./... -run TestXyz', 0, 60)).toEqual({ row: 0, col: 8 })
  })
})
