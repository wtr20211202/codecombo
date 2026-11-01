import { describe, expect, it } from 'vitest'
import { segmentNotifBody } from '../../utils/notifPathLinks'

// 通知正文路径链接化分段（P-20261004-61）：路径:行号形态片段切出为可点段，
// 其余（绝对路径/URL/../段/普通文本）保持纯文本。分段拼回恒等于原文的
// 不变量在多数用例中顺带断言（renderable = segments.map(s => s.text).join('')）。

function renderable(body: string): string {
  return segmentNotifBody(body).map(s => s.text).join('')
}

describe('segmentNotifBody', () => {
  it('空 body 返回空数组（调用方零分支）', () => {
    expect(segmentNotifBody('')).toEqual([])
  })

  it('无路径的普通 body：单段原文，既有呈现零变化', () => {
    const body = '任务完成（3.2s）\n退出码 1'
    expect(segmentNotifBody(body)).toEqual([{ kind: 'text', text: body }])
    expect(renderable(body)).toBe(body)
  })

  it('报错栈主形态：纯相对路径 + :LINE 切出可点段', () => {
    const body = '构建失败：src/api/user.go:18: undefined: Foo'
    const segs = segmentNotifBody(body)
    expect(segs).toHaveLength(3)
    expect(segs[0]).toEqual({ kind: 'text', text: '构建失败：' })
    expect(segs[1]).toMatchObject({ kind: 'path', text: 'src/api/user.go:18', path: 'src/api/user.go', line: 18 })
    expect(segs[2]).toEqual({ kind: 'text', text: ': undefined: Foo' })
    expect(renderable(body)).toBe(body)
  })

  it(':LINE:COL 双后缀解析', () => {
    const segs = segmentNotifBody('FAIL web/src/App.vue:12:5')
    expect(segs.find(s => s.kind === 'path')).toMatchObject({
      path: 'web/src/App.vue',
      line: 12,
      col: 5,
    })
  })

  it('Windows 反斜杠相对路径：切出并归一化为正斜杠（打开链契约）', () => {
    const segs = segmentNotifBody('error in server\\api\\file.go:18:5')
    expect(segs.find(s => s.kind === 'path')).toMatchObject({
      text: 'server\\api\\file.go:18:5',
      path: 'server/api/file.go',
      line: 18,
      col: 5,
    })
  })

  it('./ 前缀归一化去除', () => {
    const segs = segmentNotifBody('see ./src/a.ts:3 now')
    expect(segs.find(s => s.kind === 'path')).toMatchObject({ path: 'src/a.ts', line: 3 })
  })

  it('绝对路径保持纯文本（POSIX 根）', () => {
    const body = 'panic: /usr/local/go/src/app/main.go:12 +0x3a'
    expect(segmentNotifBody(body)).toEqual([{ kind: 'text', text: body }])
  })

  it('盘符绝对路径保持纯文本', () => {
    const body = 'at C:\\repo\\src\\main.go:42'
    expect(segmentNotifBody(body)).toEqual([{ kind: 'text', text: body }])
  })

  it('.. 段路径保持纯文本（打开链越项目根注定 403，不渲染死链接）', () => {
    const body = 'moved to ../lib/b.go:3 after refactor'
    expect(segmentNotifBody(body)).toEqual([{ kind: 'text', text: body }])
  })

  it('中段 .. 段同样剔除（形态守卫放行、越根门禁兜住）', () => {
    const body = 'renamed src/../lib/b.go:3 in passing'
    expect(segmentNotifBody(body)).toEqual([{ kind: 'text', text: body }])
  })

  it('http(s) URL 保持纯文本', () => {
    const body = 'see http://example.com/a/b here'
    expect(segmentNotifBody(body)).toEqual([{ kind: 'text', text: body }])
  })

  it('多行 body：候选不跨行，逐段切出', () => {
    const body = '第 1 步 ok\n第 2 步失败：web/src/App.vue:3: 错误\n重试中'
    const segs = segmentNotifBody(body)
    const pathSegs = segs.filter(s => s.kind === 'path')
    expect(pathSegs).toHaveLength(1)
    expect(pathSegs[0]).toMatchObject({ path: 'web/src/App.vue', line: 3 })
    expect(renderable(body)).toBe(body)
  })

  it('一行多路径各自成段（各携行号）', () => {
    const body = 'diff a/src/x.go:1:2 b/src/y.go:3'
    const segs = segmentNotifBody(body)
    expect(segs.filter(s => s.kind === 'path')).toHaveLength(2)
    expect(renderable(body)).toBe(body)
  })

  it('无行号后缀的路径保持纯文本（门禁①：分支名/纯目录在打开链必死链）', () => {
    const body = '分支 feature/x 已合并，见 src/x.go 说明'
    expect(segmentNotifBody(body)).toEqual([{ kind: 'text', text: body }])
  })
})
