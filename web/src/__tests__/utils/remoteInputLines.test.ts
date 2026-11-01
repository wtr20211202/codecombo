import { describe, expect, it } from 'vitest'
import {
  REMOTE_INPUT_LINE_MAX,
  feedRemoteInputChunk,
  newRemoteInputBuffer,
} from '../../utils/remoteInputLines'

/**
 * 输入域行缓冲纯函数单测（P-20261005-188）：回车分条、粘贴多行切分、
 * 补全前字面形态、退格/放弃行、超长污染、噪声启发、ESC 序列跳过。
 */
describe('feedRemoteInputChunk', () => {
  it('回车分条提交：逐字符键入以 \\r 提交一行', () => {
    const buf = newRemoteInputBuffer()
    expect(feedRemoteInputChunk(buf, 'kubectl get pods')).toEqual([])
    expect(buf.line).toBe('kubectl get pods')
    expect(feedRemoteInputChunk(buf, '\r')).toEqual(['kubectl get pods'])
    expect(buf.line).toBe('')
  })

  it('粘贴多行逐条切分：bracketed-paste 包裹内的 \\r 逐条出列', () => {
    const buf = newRemoteInputBuffer()
    const pasted = '\x1b[200~docker ps\r\ndocker compose up -d\r\x1b[201~'
    expect(feedRemoteInputChunk(buf, pasted)).toEqual(['docker ps', 'docker compose up -d'])
    expect(buf.line).toBe('')
  })

  it('空行（连续回车）与纯空白行不产生条目', () => {
    const buf = newRemoteInputBuffer()
    expect(feedRemoteInputChunk(buf, '\r\r\n   \r')).toEqual([])
  })

  it('Tab 补全不改字面：记录补全前形态', () => {
    const buf = newRemoteInputBuffer()
    feedRemoteInputChunk(buf, 'git che\t')
    expect(buf.line).toBe('git che')
    expect(feedRemoteInputChunk(buf, 'ckout\r')).toEqual(['git checkout'])
  })

  it('退格删除末字符；Ctrl+C/Ctrl+U 放弃本行不提交', () => {
    const buf = newRemoteInputBuffer()
    feedRemoteInputChunk(buf, 'git stastus')
    feedRemoteInputChunk(buf, '\x7f\x7f')
    expect(buf.line).toBe('git stast')
    feedRemoteInputChunk(buf, 'us\r')
    // Ctrl+C 清掉本行，其后键入的 next 无回车不提交、驻留缓冲
    expect(feedRemoteInputChunk(buf, 'rm -rf /\x03next')).toEqual([])
    expect(buf.line).toBe('next')
  })

  it('超长行污染：达 8KB 上限后回车不提交、下一行恢复', () => {
    const buf = newRemoteInputBuffer()
    const long = 'a'.repeat(REMOTE_INPUT_LINE_MAX)
    expect(feedRemoteInputChunk(buf, long)).toEqual([])
    expect(buf.poisoned).toBe(true)
    expect(feedRemoteInputChunk(buf, '\r')).toEqual([]) // 污染行回车静默丢弃
    expect(buf.poisoned).toBe(false)
    expect(feedRemoteInputChunk(buf, 'echo ok\r')).toEqual(['echo ok'])
  })

  it('噪声启发：控制字节（含 ESC 序列）占比过半的长 chunk 整块丢弃', () => {
    const buf = newRemoteInputBuffer()
    feedRemoteInputChunk(buf, 'vim ')
    // 方向键 mash：ESC 序列整体计入控制字节，占比 > 50%
    const mash = '\x1b[A\x1b[B\x1b[C\x1b[D\x1b[A\x1b[B\x1b[C\x1b[Dx'
    expect(feedRemoteInputChunk(buf, mash)).toEqual([])
    expect(buf.line).toBe('vim ') // 已缓冲行不受噪声 chunk 影响
  })

  it('正常粘贴带零星 ESC 序列不误伤：占比远低于阈值照常采集', () => {
    const buf = newRemoteInputBuffer()
    const paste = '\x1b[200~systemctl status nginx\x1b[201~\r'
    expect(feedRemoteInputChunk(buf, paste)).toEqual(['systemctl status nginx'])
  })

  it('ESC 序列整段跳过：方向键（CSI 与 SS3 形态）不污染字面缓冲', () => {
    const buf = newRemoteInputBuffer()
    feedRemoteInputChunk(buf, '\x1b[A\x1bODecho hi\x1b[200~')
    expect(buf.line).toBe('echo hi')
    expect(feedRemoteInputChunk(buf, '\r')).toEqual(['echo hi'])
  })

  it('跨 chunk 行缓冲累积：多包一次到达与分散到达等价', () => {
    const whole = newRemoteInputBuffer()
    expect(feedRemoteInputChunk(whole, 'echo one\recho two\r')).toEqual(['echo one', 'echo two'])
    const split = newRemoteInputBuffer()
    expect(feedRemoteInputChunk(split, 'echo on')).toEqual([])
    expect(feedRemoteInputChunk(split, 'e\recho two\r')).toEqual(['echo one', 'echo two'])
  })

  it('无回车不记：半截缓冲随调用丢弃（诚实「提交的输入行」语义）', () => {
    const buf = newRemoteInputBuffer()
    feedRemoteInputChunk(buf, 'docker ')
    // 会话关闭 dispose 后缓冲即弃——feed 不再被调用，无条目产生
    expect(buf.line).toBe('docker ')
  })
})
