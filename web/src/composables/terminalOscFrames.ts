// OSC 133（shell integration）帧处理：纯函数 + 跨 message 重组器。
// 自 useTerminalSession 原样搬运（P-20261002-27 巨型组件拆分第二批），
// 语义与实现保持不变——消费方经 useTerminalSession 的 re-export 兼容导入。
// 模块级纯函数，测试直接覆盖（useTerminalSession.test.ts）。
// P-20261004-59 起 OSC 7（cwd 上报）解析与半帧重组同住本文件：与 133 同为
// shell 集成伴生序列、同字节流同汇入点，拆开会造成两处 pending 语义漂移。

// OSC 133（shell integration）事件外抛契约：
// - C：命令开始
// - D：命令结束（exitCode / durationMs 来自序列参数，语义同旧 onCommandFinish；
//   command 为最近一次 E 事件解码的整行命令文本，无 E 时缺省）
// - E：命令文本（整行命令 base64 编码回传，shell 侧超长截断 8KB）
// - R：附着重放边界（服务端注入，非 shell 产出）——边界前的 D 来自缓冲重放，
//   replayed 标记置真；命令历史/长任务通知等「记账」语义的消费者必须跳过
// - A：提示符开始（shell prompt 函数产出）——「复制上一条命令输出」据此感知
//   「下一条提示符已渲染」（P-20261002-56 活动尾兜底的提示符排除，见
//   useTerminalSession.bumpCommandPromptGen）；消费在写入路径按段检查，
//   sink 不外抛
// - G：断档元信息（P-20261005-233，服务端注入非 shell 产出）——重连重放字节
//   之前发送，earliestAt=现存缓冲最早行时间（unix ms）、serverNowAt=服务端
//   发送时刻（unix ms，前端校准两端时钟差）。tmux 后端不发（capture-pane 无
//   逐行时间语义）；消费在写入路径按段检查（判得淘汰缺口即插标记行），sink
//   不外抛
export interface OscEvent {
  type: 'C' | 'D' | 'E' | 'R' | 'A' | 'G'
  exitCode?: number
  durationMs?: number
  command?: string
  replayed?: boolean
  earliestAt?: number
  serverNowAt?: number
}

// 模块级解码器复用——parseOscEvents 每帧解码复用同一实例
const sharedDecoder = new TextDecoder('utf-8', { fatal: false })

// base64 → bytes：atob 返回 latin1 字符串，charCodeAt 逐字符还原字节值
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// 字节级剥离 OSC 133（shell integration）序列：ESC ] 133 ; <params> BEL
// 用字节扫描实现，避免 TextDecoder/TextEncoder 在不完整 UTF-8 边界的字符替换问题
// （模块级纯函数，由 processShellIntegration 使用、测试直接覆盖）
export function stripOSC133(data: Uint8Array): Uint8Array {
  const ESC = 0x1b
  const BRA = 0x5d // ]
  const BEL = 0x07
  const N = data.length
  // 第一遍扫描：统计需要剥离的字节数，决定是否需要新建数组
  let stripBytes = 0
  let i = 0
  while (i < N) {
    if (
      data[i] === ESC &&
      i + 5 < N &&
      data[i + 1] === BRA &&
      data[i + 2] === 0x31 &&
      data[i + 3] === 0x33 &&
      data[i + 4] === 0x33 &&
      data[i + 5] === 0x3b /* ; */
    ) {
      // 命中 \x1b]133; 跳过参数直到 BEL 或下一个 ESC（兜底防止无 BEL 时无限跳过）
      let j = i + 6
      while (j < N && data[j] !== BEL && data[j] !== ESC) j++
      if (j < N && data[j] === BEL) j++ // 跳过 BEL
      stripBytes += j - i
      i = j
    } else {
      i++
    }
  }
  if (stripBytes === 0) return data
  // 第二遍：构建剥离后的数组
  const out = new Uint8Array(N - stripBytes)
  let outIdx = 0
  i = 0
  while (i < N) {
    if (
      data[i] === ESC &&
      i + 5 < N &&
      data[i + 1] === BRA &&
      data[i + 2] === 0x31 &&
      data[i + 3] === 0x33 &&
      data[i + 4] === 0x33 &&
      data[i + 5] === 0x3b
    ) {
      let j = i + 6
      while (j < N && data[j] !== BEL && data[j] !== ESC) j++
      if (j < N && data[j] === BEL) j++
      i = j
    } else {
      out[outIdx++] = data[i]!
      i++
    }
  }
  return out
}

// 解析字节流中的全部 OSC 133 事件（模块级纯函数，供 processShellIntegration 与测试共用）：
// - C：命令开始
// - D;<exitCode>;<durationMs>：命令结束
// - E;<base64>：命令文本（base64 解码失败的单帧跳过，不影响其余事件）
export function parseOscEvents(data: Uint8Array): OscEvent[] {
  const text = sharedDecoder.decode(data)
  // eslint-disable-next-line no-control-regex -- OSC 终止符本身就是控制字符（BEL/ESC），必须按字面匹配
  const oscRe = /\x1b\]133;([A-Za-z])(?:;([^\x07\x1b]*))?\x07/g
  const events: OscEvent[] = []
  let m: RegExpExecArray | null
  while ((m = oscRe.exec(text)) !== null) {
    const type = m[1] || ''
    if (type === 'C') {
      events.push({ type: 'C' })
    } else if (type === 'D') {
      const parts = (m[2] || '').split(';')
      events.push({
        type: 'D',
        exitCode: parseInt(parts[0] || '0', 10) || 0,
        durationMs: parseInt(parts[1] || '0', 10) || 0,
      })
    } else if (type === 'E') {
      try {
        const command = sharedDecoder.decode(base64ToBytes((m[2] || '').trim()))
        if (command) events.push({ type: 'E', command })
      } catch {
        // 单帧 base64 损坏（传输截断等）：跳过，不中断其余帧解析
      }
    } else if (type === 'R') {
      events.push({ type: 'R' })
    } else if (type === 'A') {
      events.push({ type: 'A' })
    } else if (type === 'G') {
      // 断档元信息（P-20261005-233）：参数形如 "<earliestMs>;<serverNowMs>"。
      // 数值解析失败按 0 处理——0 不会大于任何比对锚点，天然退化为「不标记」
      const parts = (m[2] || '').split(';')
      events.push({
        type: 'G',
        earliestAt: parseInt(parts[0] || '0', 10) || 0,
        serverNowAt: parseInt(parts[1] || '0', 10) || 0,
      })
    }
  }
  return events
}

const EMPTY_BYTES = new Uint8Array(0)

// OSC 133 帧头字节序列：ESC ] 1 3 3 ;
const OSC133_HEADER = [0x1b, 0x5d, 0x31, 0x33, 0x33, 0x3b] as const
// OSC 7 帧头字节序列（P-20261004-59 cwd 上报）：ESC ] 7 ;
// 半帧重组与 133 同路——cwd 帧体积小但 PTY 4KB 分片边界可能切在任意位置
const OSC7_HEADER = [0x1b, 0x5d, 0x37, 0x3b] as const
// 待重组帧头集合：splitPendingTail 对每个头部做前缀匹配（任一命中即暂存）
const OSC_HEADERS = [OSC133_HEADER, OSC7_HEADER]

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

// 拆分尾部「可能不完整的 OSC 帧起始段」（133 / 7 双头识别）：head 立即处理
// （parse + strip + 写 xterm），tail 暂存待下一条 WS message 拼接（字节级，
// pending 切在多字节 UTF-8 中间也安全——拼接按原始字节还原，不经过字符串编解码）。
// 判定规则（p = 最后一个 ESC 的位置，p 之后无 BEL 才可能是未终结帧）：
// - p 起匹配任一已知帧头前缀且恰好截在 message 结尾（帧头本身不完整）→ tail
// - 帧头完整（ESC]133; / ESC]7;）且 payload 到结尾无 BEL → tail
// - p 起与全部帧头分叉（ESC[ CSI / OSC 0 等未知序列）→ 不暂存，xterm 自身
//   流式解析器兜底
export function splitPendingTail(buf: Uint8Array): { head: Uint8Array; tail: Uint8Array } {
  const BEL = 0x07
  const N = buf.length
  // 找最后一个 ESC
  let p = -1
  for (let i = N - 1; i >= 0; i--) {
    if (buf[i] === 0x1b) {
      p = i
      break
    }
  }
  if (p === -1) return { head: buf, tail: EMPTY_BYTES }
  // p 之后已有 BEL：p 起的帧已终结，无未完成段
  for (let j = p + 1; j < N; j++) {
    if (buf[j] === BEL) return { head: buf, tail: EMPTY_BYTES }
  }
  // 任一已知帧头：完整（payload 未终结）或前缀恰截在 message 结尾 → 暂存
  for (const header of OSC_HEADERS) {
    let k = 0
    while (k < header.length && p + k < N && buf[p + k] === header[k]) k++
    if (k === header.length || p + k === N) {
      return { head: buf.subarray(0, p), tail: buf.subarray(p) }
    }
  }
  // 已与全部帧头分叉：未知序列，交给 xterm 自身解析
  return { head: buf, tail: EMPTY_BYTES }
}

// 在完整帧字节流中定位全部 D 帧结束边界（BEL 后一字节）：供按 D 帧分段写入。
// 同一条 message 含多条 D 帧时（快速连续命令 / 粘贴命令块场景），逐段「写入 xterm →
// 抓取失败输出 → 外抛事件」才能保证事件顺序与抓取区间精确。只认完整帧（payload 后
// 有 BEL）；扫到帧 payload 内不会出现的 ESC 视为未终结帧，其后无更多完整帧。
// 非 D 帧（C/E）整帧跳过，防止帧 payload 内字节被误认为帧头。
export function findDFrameBoundaries(data: Uint8Array): number[] {
  const BEL = 0x07
  const bounds: number[] = []
  const N = data.length
  let i = 0
  while (i < N) {
    if (
      data[i] === 0x1b &&
      i + 6 < N &&
      data[i + 1] === 0x5d && // ]
      data[i + 2] === 0x31 &&
      data[i + 3] === 0x33 &&
      data[i + 4] === 0x33 &&
      data[i + 5] === 0x3b && /* ; */
      data[i + 6] === 0x44 /* D */
    ) {
      let j = i + 7
      while (j < N && data[j] !== BEL && data[j] !== 0x1b) j++
      if (j < N && data[j] === BEL) {
        bounds.push(j + 1)
        i = j + 1
        continue
      }
      break // 未终结帧（跨 message 半帧由重组器 pending 处理）
    }
    i++
  }
  return bounds
}

// pending 上限兜底：正常 E 帧上限约 11KB（8192 字节 base64 编码后），64KB 覆盖异常富余；
// 异常流超限时放弃缓冲直接处理当前 chunk（此时已无法保证帧完整性，按无 pending 语义降级）
const MAX_OSC_PENDING = 64 * 1024

// 单个写入段：按 D 帧边界切分后的最小处理单元——段内至多一个 D 帧且位于段尾，
// 宿主逐段「解析事件 → 写入 xterm → 抓取失败输出」即可精确对齐每条命令的输出区间
export interface OscWriteSegment {
  // 本段可写入 xterm 的干净数据（OSC 序列已剥离）
  write: Uint8Array
  // 本段解析出的完整帧事件
  events: OscEvent[]
}

// OSC 133 帧跨 message 重组器：服务端 readLoop 以 4096 字节分片读取 PTY，
// >3KB 的 E 帧必然跨 WS message——分片后半段无帧头，若逐条独立处理会被当普通
// 文本写入 xterm（base64 乱码）且不入历史。本重组器把尾部未完成帧暂存拼接后再解析。
export interface OscFrameReassembler {
  // 喂入一条 message 的字节：返回按 D 帧边界切分的写入段（段序 = 字节序；
  // 跨 message 完成的 D 帧在拼接后的 head 内同样被切出）
  push(data: Uint8Array): { segments: OscWriteSegment[] }
  // 丢弃未完成帧缓冲（重连 scrollback 重放前调用，防旧半帧污染重放流）
  reset(): void
}

export function createOscFrameReassembler(): OscFrameReassembler {
  let pending: Uint8Array | null = null
  return {
    push(data: Uint8Array): { segments: OscWriteSegment[] } {
      if (pending && pending.length + data.length > MAX_OSC_PENDING) {
        // 异常流兜底：丢弃 pending，当前 chunk 按无缓冲语义处理
        pending = null
      }
      const buf = pending ? concatBytes(pending, data) : data
      const { head, tail } = splitPendingTail(buf)
      pending = tail.length > 0 ? tail : null
      // 按 D 帧边界分段（段边界落在帧 BEL 之后，多字节 UTF-8 不可能跨界）
      const bounds = findDFrameBoundaries(head)
      const segments: OscWriteSegment[] = []
      let start = 0
      for (const end of bounds) {
        segments.push({
          write: stripOSC133(head.subarray(start, end)),
          events: parseOscEvents(head.subarray(start, end)),
        })
        start = end
      }
      // 末段：D 帧边界全在末尾时无剩余字节，仅整条消息无任何段时补空段
      if (start < head.length || segments.length === 0) {
        segments.push({
          write: stripOSC133(head.subarray(start)),
          events: parseOscEvents(head.subarray(start)),
        })
      }
      return { segments }
    },
    reset(): void {
      pending = null
    },
  }
}

// ── OSC 7 cwd 上报解析（P-20261004-59）──
// shell 集成伴生协议：提示符前 shell 发 \x1b]7;file://<host><path>BEL（第三方
// 集成惯用 ST 终止，一并识别）。会话 cwd 从「创建时快照」变实时——四个 cwd
// 消费位（文件链接相对路径解析 / 文件树定位 / 目录驻留徽标 / 复制会话）的
// 共同解锁件。旁挂语义：帧字节原样随流写 xterm（xterm 对未知 OSC 序列静默
// 消费，不渲染），本函数只读取。

// osc7Re 匹配单个 OSC 7 帧：BEL 与 ST（ESC \）双终止符；payload 内不允许
// 再出现 ESC/BEL（与 133 帧解析同守卫）
// eslint-disable-next-line no-control-regex -- OSC 终止符本身就是控制字符（BEL/ESC），必须按字面匹配
const osc7Re = /\x1b\]7;([^\x07\x1b]*)(?:\x07|\x1b\\)/g

/** file URL 载荷 → 本机路径（正斜杠口径）：剥 scheme 与 host、百分号解码、
 *  Windows 盘符形态 /C:/... 折算为 C:/...。消费方（resolveAgainstCwd /
 *  isPathUnderPath / toProjectRelative）全链路接受双分隔符，统一正斜杠最中立。
 *  非 file URL 载荷返回 null（弃帧） */
export function normalizeOsc7Path(payload: string): string | null {
  if (!payload.startsWith('file://')) return null
  const rest = payload.slice('file://'.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return null
  let p = rest.slice(slash)
  // file URL 语义上 ? # 是 query/fragment 分隔符，路径内出现即为越界内容
  const q = p.search(/[?#]/)
  if (q >= 0) p = p.slice(0, q)
  try {
    p = decodeURIComponent(p)
  } catch {
    // 裸 % 等非法编码序列：保留原样（不能因个别字节弃整条路径）
  }
  if (!p || p.length > 4096) return null
  const drive = p.match(/^\/([A-Za-z]:)(\/[\s\S]*)?$/)
  if (drive) return drive[1]! + (drive[2] ?? '')
  return p
}

/** 解析字节流中的 OSC 7 cwd 上报，返回最近一帧的本机路径（同 chunk 多帧=
 *  快速连续 cd，最新生效）；无帧返回 null。与 parseOscEvents 同模块级解码器
 *  复用；调用点在写入段循环（seg.write 已剥离 133、OSC 7 字节完整在位） */
export function parseOsc7Cwd(data: Uint8Array): string | null {
  const text = sharedDecoder.decode(data)
  let last: string | null = null
  osc7Re.lastIndex = 0
  for (let m = osc7Re.exec(text); m !== null; m = osc7Re.exec(text)) {
    const dir = normalizeOsc7Path(m[1] ?? '')
    if (dir) last = dir
  }
  return last
}

// ── 事件语义管线（自 useTerminalSession 原样搬运）──
// 消费 parseOscEvents 产出的事件，决定哪些外抛给宿主（oscHook）、以什么顺序外抛：
// 命令时间戳记账 / 最近命令附带 / 附着重放门禁 / 失败 D 延后到写入后外抛。
export interface OscEventSinkOptions {
  // 会话标识：命令记账按会话隔离
  sessionId: string
  // 解析出的事件外抛——tab 运行状态与长任务通知由宿主（TerminalView）处理
  oscHook?: (event: OscEvent, sessionId: string) => void
}

export interface OscEventSink {
  // 处理一段已解析出的 shell integration（OSC 133）事件：C/D/E 分发 + 失败 D 延后外抛。
  // 必须在 writeChain 内按段序调用——每段至多一个 D 帧，单槽 pendingFailureD 即精确安全
  processEvents(events: OscEvent[]): void
  // 重连 scrollback 重放前重关门禁：重放段里的 D 事件在本次连接内重新视为重放
  closeHistoryGate(): void
  // 取走待外抛的失败 D 事件（宿主在本段写入 xterm 之后取出外抛，用后即清）
  takePendingFailure(): { event: OscEvent; command: string | undefined } | null
}

export function createOscEventSink(opts: OscEventSinkOptions): OscEventSink {
  const { sessionId } = opts

  // 命令时间戳：sessionId -> 开始时间（ms）。用于长任务时长判定
  const cmdStartTs = new Map<string, number>()

  // 会话最近命令文本：sessionId -> E 事件解码的整行命令。
  // D 事件（命令结束）到达时取出附带给宿主（命令历史上报需要），用后即删防跨命令残留
  const lastCommands = new Map<string, string>()

  // 附着重放门禁（服务端 133;R 哨兵开启）：重连/重挂载时服务端先重放字节缓冲，
  // 其中的 D 帧是历史命令的结束事件——不门控会让命令历史每次附着都重复记账。
  // 每次连接（含重连）都重新关闭，由重放后的 R 哨兵开启
  let historyGateOpen = false

  // 待外抛的失败 D 事件：延后到本条消息写入 xterm 之后处理（见 enqueueWriteMessage）——
  // 命令输出与 D 序列常同一条 WS 消息，parse 时宿主回调尚不能读到完整输出
  let pendingFailureD: { event: OscEvent; command: string | undefined } | null = null

  // tab 状态（running / lastExitCode）、长任务通知与命令历史上报由宿主经 oscHook 处理
  function processEvents(events: OscEvent[]): void {
    for (const ev of events) {
      if (ev.type === 'R') {
        // 附着重放边界：其后解析的 D 才是「活」命令结束
        historyGateOpen = true
        continue
      }
      // 盖章重放语义回原始事件对象（C/D/E 一致）：写入链按「非重放的 C/D」做输出
      // 区间行号记账（复制上一条命令输出），重放段的边界不得污染记账
      ev.replayed = !historyGateOpen
      if (ev.type === 'C') {
        cmdStartTs.set(sessionId, Date.now())
        opts.oscHook?.(ev, sessionId)
      } else if (ev.type === 'E') {
        if (ev.command) lastCommands.set(sessionId, ev.command)
        opts.oscHook?.(ev, sessionId)
      } else if (ev.type === 'D') {
        cmdStartTs.delete(sessionId)
        const command = lastCommands.get(sessionId)
        lastCommands.delete(sessionId)
        // 盖章回原始事件对象（同 replayed 口径）：写入链的 recordCommandEndLine
        // 需要命令文本做 tmux 滞后帧的内容锚定，且失败 D 走延后外抛、成功 D 走
        // 即时分发，两条路都在本分支之后才消费 seg.events 原始对象
        ev.command = command
        const replayed = ev.replayed === true
        if ((ev.exitCode ?? 0) !== 0) {
          // 失败命令：延后到本段写入后再外抛（保证宿主回调时输出已写入 xterm）
          pendingFailureD = { event: { ...ev, command, replayed }, command }
        } else {
          opts.oscHook?.({ ...ev, command, replayed }, sessionId)
        }
      }
    }
  }

  return {
    processEvents,
    closeHistoryGate(): void {
      historyGateOpen = false
    },
    takePendingFailure() {
      const pending = pendingFailureD
      pendingFailureD = null
      return pending
    },
  }
}
