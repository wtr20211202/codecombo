import { describe, expect, it } from 'vitest'
import { pathResidesIn } from './pathResidency'

/**
 * 项目驻留路径判定（P-20261006-36）表驱动：与服务端 residency_test.go 同源
 * 用例集（前端刻意不做大小写折叠——全平台纪律，见 pathResidency.ts 头注）。
 */
describe('pathResidesIn', () => {
  it('Windows 形态：正反斜杠混用、盘符根、UNC', () => {
    expect(pathResidesIn('D:\\work\\proj', 'D:\\work\\proj')).toBe(true) // 恰在项目根
    expect(pathResidesIn('D:\\work\\proj\\packages\\app', 'D:\\work\\proj')).toBe(true) // 子目录
    expect(pathResidesIn('D:/work/proj/src', 'D:\\work\\proj')).toBe(true) // 分隔符混用（OSC 7 折算形态）
    expect(pathResidesIn('D:\\work\\proj\\sub', 'D:\\work\\proj\\')).toBe(true) // 根带尾分隔符
    expect(pathResidesIn('D:\\anything\\here', 'D:\\')).toBe(true) // 根恰为盘符根
    expect(pathResidesIn('\\\\nas\\share\\proj\\sub', '\\\\nas\\share\\proj')).toBe(true) // UNC
    expect(pathResidesIn('D:\\work\\proj2\\x', 'D:\\work\\proj')).toBe(false) // 兄弟目录不得前缀误命中
    expect(pathResidesIn('C:\\work\\proj\\x', 'D:\\work\\proj')).toBe(false) // 不同盘符
  })

  it('POSIX 形态：子目录、根目录、大小写敏感', () => {
    expect(pathResidesIn('/home/u/proj', '/home/u/proj')).toBe(true)
    expect(pathResidesIn('/home/u/proj/packages/app', '/home/u/proj')).toBe(true)
    expect(pathResidesIn('/home/u/proj/sub', '/home/u/proj/')).toBe(true) // 根带尾分隔符
    expect(pathResidesIn('/srv/anywhere', '/')).toBe(true) // POSIX 根包含一切
    expect(pathResidesIn('/home/u/Proj/x', '/home/u/proj')).toBe(false) // 大小写敏感（刻意不折叠）
    expect(pathResidesIn('/home/u/proj2/x', '/home/u/proj')).toBe(false)
  })

  it('不可比形态从严不计', () => {
    expect(pathResidesIn('work/proj', 'D:\\work\\proj')).toBe(false) // 相对路径
    expect(pathResidesIn('D:\\work\\proj', 'work/proj')).toBe(false) // 根为相对路径
    expect(pathResidesIn('', 'D:\\work\\proj')).toBe(false)
    expect(pathResidesIn('D:\\work\\proj', '')).toBe(false)
    expect(pathResidesIn(undefined, '/home/u/proj')).toBe(false)
    expect(pathResidesIn('  /home/u/proj/sub  ', '/home/u/proj')).toBe(true) // 首尾空白容忍
    expect(pathResidesIn('/home/u/./proj/sub/../sub', '/home/u/proj')).toBe(true) // dot 段归一
  })
})
