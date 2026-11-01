import { describe, it, expect } from 'vitest'
import {
  expandSnippetVars,
  formatSnippetDate,
  formatSnippetTime,
  referencesClipboard,
} from './snippetVars'

// 片段变量最小子集替换矩阵（P-20261006-1）：时钟/剪贴板注入，纯函数直测

const NOW = new Date(2026, 9, 14, 9, 5) // 2026-10-14 09:05 本地时区

describe('formatSnippetDate / formatSnippetTime', () => {
  it('固定 YYYY-MM-DD / HH:mm 最小格式令牌（个位补零）', () => {
    expect(formatSnippetDate(NOW)).toBe('2026-10-14')
    expect(formatSnippetTime(NOW)).toBe('09:05')
  })
})

describe('expandSnippetVars：日期/时间', () => {
  it('${DATE} / $DATE 括号与裸名两拼法等价', () => {
    expect(expandSnippetVars('deploy-${DATE}.log', { now: NOW }).text).toBe('deploy-2026-10-14.log')
    expect(expandSnippetVars('deploy-$DATE.log', { now: NOW }).text).toBe('deploy-2026-10-14.log')
  })

  it('${TIME} / $TIME', () => {
    expect(expandSnippetVars('at ${TIME}', { now: NOW }).text).toBe('at 09:05')
    expect(expandSnippetVars('at $TIME', { now: NOW }).text).toBe('at 09:05')
  })

  it('缺省时钟取当前时刻（冒烟，不锚具体值）', () => {
    const r = expandSnippetVars('${DATE} ${TIME}')
    expect(r.text).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe('expandSnippetVars：剪贴板', () => {
  it('referencesClipboard 门卫：含变量才 true（无变量插入不触碰剪贴板权限面）', () => {
    expect(referencesClipboard('echo ${CLIPBOARD}')).toBe(true)
    expect(referencesClipboard('echo $CLIPBOARD')).toBe(true)
    expect(referencesClipboard('echo plain')).toBe(false)
    expect(referencesClipboard('echo ${DATE} $0')).toBe(false)
  })

  it('有剪贴板文本替换', () => {
    const r = expandSnippetVars('echo ${CLIPBOARD}', { clipboardText: 'hello' })
    expect(r.text).toBe('echo hello')
    expect(r.clipboardMissing).toBe(false)
  })

  it('未提供（读取失败）原样保留 + clipboardMissing 兜底标记', () => {
    const r = expandSnippetVars('echo ${CLIPBOARD}')
    expect(r.text).toBe('echo ${CLIPBOARD}')
    expect(r.clipboardMissing).toBe(true)
  })

  it('裸名 $CLIPBOARD 同样支持，且 $CLIPBOARDS 整名不识别整段保留（最大吞名不截胡）', () => {
    expect(expandSnippetVars('x=$CLIPBOARD;', { clipboardText: 'v' }).text).toBe('x=v;')
    expect(expandSnippetVars('x=$CLIPBOARDS;', { clipboardText: 'v' }).text).toBe('x=$CLIPBOARDS;')
    expect(expandSnippetVars('x=$CLIPBOARDS;').clipboardMissing).toBe(false)
  })
})

describe('expandSnippetVars：$0 光标终位', () => {
  it('编辑器域剔除 $0 并记 UTF-16 偏移', () => {
    const r = expandSnippetVars('const a = [$0];')
    expect(r.text).toBe('const a = [];')
    expect(r.cursorOffset).toBe(11)
  })

  it('${0} 括号拼法同义', () => {
    const r = expandSnippetVars('a ${0} b')
    expect(r.text).toBe('a  b')
    expect(r.cursorOffset).toBe(2)
  })

  it('多次 $0 以末次出现为终位（VS Code final cursor 语义）', () => {
    const r = expandSnippetVars('$0-$0')
    expect(r.text).toBe('-')
    expect(r.cursorOffset).toBe(1)
  })

  it('终端域 keepFinalTabstop：$0 原样保留、不记偏移', () => {
    const r = expandSnippetVars('awk \'{print $0}\'', { keepFinalTabstop: true })
    expect(r.text).toBe('awk \'{print $0}\'')
    expect(r.cursorOffset).toBeNull()
  })

  it('无 $0 时 cursorOffset 为 null', () => {
    expect(expandSnippetVars('plain').cursorOffset).toBeNull()
  })
})

describe('expandSnippetVars：宽容不炸（未识别原样保留）', () => {
  it('未识别变量 ${FOO} / $FOO 原样', () => {
    expect(expandSnippetVars('a ${FOO} b $BAR c').text).toBe('a ${FOO} b $BAR c')
  })

  it('VS Code 待补位 $1 / ${1:name} 不在子集内，原样保留', () => {
    expect(expandSnippetVars('f($1, ${2:x})').text).toBe('f($1, ${2:x})')
  })

  it('未闭合 ${DATE 原样；孤立 $ 与 shell 变量 $HOME 不受扰', () => {
    expect(expandSnippetVars('${DATE tail', { now: NOW }).text).toBe('${DATE tail')
    expect(expandSnippetVars('export $HOME/bin', { now: NOW }).text).toBe('export $HOME/bin')
  })

  it('与 utils/textTemplate 的 {参数} 语法互不干扰：先展开变量再填参不串扰', () => {
    const v = expandSnippetVars('scp {src} backup-${DATE}', { now: NOW })
    expect(v.text).toBe('scp {src} backup-2026-10-14')
  })

  it('空文本恒等', () => {
    expect(expandSnippetVars('')).toEqual({ text: '', cursorOffset: null, clipboardMissing: false })
  })
})
