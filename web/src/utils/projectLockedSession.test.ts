import { describe, expect, it } from 'vitest'
import { isSessionInLockedProject } from './projectLockedSession'

// P-20261004-143 终端域锁徽标的归属判定：projectId 直查 / agent 会话 dir 包含
const projects = [
  { id: 'p1', path: 'D:/work/alpha', locked: true },
  { id: 'p2', path: '/home/u/beta', locked: false },
  { id: 'p3', path: 'E:\\Archive\\Gamma', locked: true },
]

describe('isSessionInLockedProject', () => {
  it('带 projectId 的会话按 id 直查锁态', () => {
    expect(isSessionInLockedProject({ projectId: 'p1' }, projects)).toBe(true)
    expect(isSessionInLockedProject({ projectId: 'p2' }, projects)).toBe(false)
    expect(isSessionInLockedProject({ projectId: 'ghost' }, projects)).toBe(false)
  })

  it('无 projectId 按 dir 包含判定（正斜杠/反斜杠/盘符大小写折叠）', () => {
    expect(isSessionInLockedProject({ path: 'D:/work/alpha/sub/pkg' }, projects)).toBe(true)
    expect(isSessionInLockedProject({ path: 'd:\\work\\alpha' }, projects)).toBe(true)
    expect(isSessionInLockedProject({ currentDir: 'e:/archive/gamma/x' }, projects)).toBe(true)
  })

  it('目录边界：同前缀兄弟目录不误标', () => {
    expect(isSessionInLockedProject({ path: 'D:/work/alphabet' }, projects)).toBe(false)
    expect(isSessionInLockedProject({ path: 'D:/work' }, projects)).toBe(false)
  })

  it('未锁项目内的 dir 不标', () => {
    expect(isSessionInLockedProject({ path: '/home/u/beta/src' }, projects)).toBe(false)
  })

  it('归属不明（无 projectId 且无 dir / 空清单）一律 false 不误标', () => {
    expect(isSessionInLockedProject({}, projects)).toBe(false)
    expect(isSessionInLockedProject({ path: '' }, projects)).toBe(false)
    expect(isSessionInLockedProject({ path: 'D:/work/alpha' }, [])).toBe(false)
  })
})
