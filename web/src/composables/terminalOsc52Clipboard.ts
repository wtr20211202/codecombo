import { reactive } from 'vue'
import type { Terminal } from '@xterm/xterm'
import { copyText } from '../utils/clipboard'

// ============== OSC 52 剪贴板写入接管（P-20261107-6） ==============
// claude code 等应用的「应用内复制」经 OSC 52 转义序列直接写终端侧剪贴板
// （ESC ] 52 ; <sel> ; <base64> BEL/ST；claude code 2.1.x 实勘：setClipboard
// 恒发该序列，tmux 内另包 DCS passthrough）。写入成功 = 应用自复制能力已证，
// 此时鼠标接管提示条（Shift 拖选教育，terminalMouseModeHint）是误扰——复制
// 本就可用、无需 Shift 旁路——提示条据此做会话级粘性抑制（TerminalPane）。
//
// 为何自接 handler 而非沿用 @xterm/addon-clipboard（已卸载）：
//   ①ClipboardAddon 写路径（navigator.clipboard.writeText）无成功/失败回调
//     可观察，「能力已证」信号拿不到；
//   ②其写路径无降级——HTTP 非 localhost（局域网 IP 访问，isSecureContext=false）
//     下 navigator.clipboard 不存在，OSC 52 静默哑写。「本机正常、其他机器复制
//     失效」的环境差异与安全上下文分布吻合（健壮性红线·剪贴板条同一根因）。
//   本 handler 走 utils/clipboard.copyText 降级链（红线同款），成功才记账。
//
// 替换语义对账（ClipboardAddon → 本 handler，均恒返回 true 独占消费——协议
// 处理权在此，同一 term 不得再挂第二个 OSC 52 handler，否则双写）：
//   写（sel=c）→ copyText 降级链，成功即登记能力已证；
//   写（sel 非 c，如 X11 primary 的 p）→ 消费不动作不登记：浏览器无 primary
//     selection 写面，应用自以为复制了而系统剪贴板并无内容，提示条继续教育
//     才是诚实行为；
//   读（pd=?）→ 消费不回应：只写不读的安全默认（kitty 同款，防 PTY 内程序把
//     终端当剪贴板读取预言机；原 addon 的读回应随让位移除，产品无消费方）；
//   空载荷/非法 base64 → 消费不动作（清剪贴板语义在浏览器无对应写面）。
//
// 重放边界（刻意不设防，ClipboardAddon 时代同款边界）：附着/重连的 scrollback
// 字节重放会原样重放历史 OSC 52 → handler 再次执行 → 旧内容重写进剪贴板。
// 曾按「oscSink 重放门禁」（133;R 哨兵）做短路，e2e 实测推翻：R 哨兵只有本地
// 终端 WS 注入（server/api/terminal/ws_attach.go），远程主机终端 WS
// （server/api/remote/remotehost_terminal.go）从不发送 → 门禁在远程链路恒关，
// 短路探针把远程终端的全部活输出误判为重放、OSC 52 整体失效（提示条抑制
// 全哑）。根治需远程链路补发 R 哨兵（服务端协议面变更，牵动远程 C/D 记账
// 全栈激活，超出本提案范围）。当前边界：重挂/重连会把会话历史里最近一次
// OSC 52 复制的内容重写回剪贴板——与被替换的 ClipboardAddon 行为完全一致
// （其无任何重放设防），非本次引入的回归；用户重新复制一次即自愈。

const OSC52_IDENT = 52

// base64 → UTF-8 文本：atob 出 binary string 后按字节展开经 TextDecoder 还原
// （中文/emoji 等多字节内容不乱码）。atob 只认标准 base64，非法输入抛错按
// 空串返回——由调用方按「无可写内容」处理
function decodeOsc52Payload(b64: string): string {
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

// 会话级「OSC 52 写入成功」簿记（反应式，TerminalPane 提示条计算属性内读取
// 可追踪；值恒 true，只增不翻转）。粘性语义：一次成功即本会话恒抑制。
// 生命周期 = 会话 id 在本页的存活期，刻意**不随 xterm 实例清理**（区别于
// terminalMouseModeHint 的模式簿记——那是具体 term 的屏态，本簿记是应用能力）：
// 同一会话的 term 会因重连 reset、LRU 驱逐/重见、底部终端 ↔ 终端会话管理面板
// 交接（挂起占位卡/恢复）多次重建，任一重建清簿记都会让提示条在能力早已证明
// 的会话里反复复现（评审修订点 2 要防的形态）。session id 随机唯一不复用，
// 不跨会话串扰；条目数按 FIFO 上限淘汰最早登记者防页面长寿命下无界增长——
// 上限远超单页会话量级，淘汰代价仅是该会话提示条可能再现一次。写入频次 =
// 应用复制动作频次（人手级），无热路径开销
export const OSC52_PROOF_CAP = 256
const osc52ProvenMap = reactive(new Map<string, true>())

function markOsc52Proof(sessionId: string): void {
  if (osc52ProvenMap.has(sessionId)) return
  if (osc52ProvenMap.size >= OSC52_PROOF_CAP) {
    // Map 保插入序：首键即最早登记
    const oldest = osc52ProvenMap.keys().next().value
    if (oldest !== undefined) osc52ProvenMap.delete(oldest)
  }
  osc52ProvenMap.set(sessionId, true)
}

/** 本会话是否已有应用经 OSC 52 成功写入剪贴板（提示条粘性抑制依据） */
export function hasOsc52ClipboardProof(sessionId: string): boolean {
  return osc52ProvenMap.get(sessionId) === true
}

/**
 * 注册 OSC 52 写入 handler（connect 调用，先于 WS 建立——重放/活输出字节到达
 * 前已在位；handler 随 term.dispose 消亡，能力簿记按会话保留，见 osc52ProvenMap 注）。
 */
export function attachOsc52Clipboard(sessionId: string, term: Terminal): void {
  term.parser.registerOscHandler(OSC52_IDENT, (data) => {
    // data = "<sel>;<pd>"：sel=c 系统剪贴板 / p primary 等，pd=base64 或 '?'（读请求）
    const semi = data.indexOf(';')
    if (semi === -1) return true
    const sel = data.slice(0, semi)
    const pd = data.slice(semi + 1)
    if (sel !== 'c' || pd === '?') return true
    const text = decodeOsc52Payload(pd)
    if (!text) return true
    // 写入异步落定，handler 同步返回不阻塞解析（无回应序列需要保序）；
    // copyText 降级链失败（非安全上下文且无用户手势等）不登记——复制确实
    // 没生效，提示条照常教育 Shift 旁路
    void copyText(text).then((ok) => {
      if (ok) markOsc52Proof(sessionId)
    })
    return true
  })
}
