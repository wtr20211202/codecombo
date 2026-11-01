import { describe, expect, it } from 'vitest'
import { buildGitTabStatusMap, validateBranchName } from './git'

// validateBranchName（P-20261003-221 分支重命名弹窗）：与服务端
// gitops.validateRefName 同规则镜像，键位文案由 setup 的 i18n 直译兜底
describe('validateBranchName', () => {
  it('合法名（字母数字与 _ - . / 组合、含层级）返回 null', () => {
    expect(validateBranchName('main')).toBeNull()
    expect(validateBranchName('feature/xxx')).toBeNull()
    expect(validateBranchName('feat_1.0-beta')).toBeNull()
    expect(validateBranchName('  release/1.0  ')).toBeNull() // 容忍首尾空白（提交前 trim）
  })

  it('空名 / 全空白返回错误文案', () => {
    expect(validateBranchName('')).not.toBeNull()
    expect(validateBranchName('   ')).not.toBeNull()
  })

  it('超长（>200）返回错误文案', () => {
    expect(validateBranchName('a'.repeat(201))).not.toBeNull()
    expect(validateBranchName('a'.repeat(200))).toBeNull()
  })

  it('非法字符 / 打头符号返回错误文案', () => {
    expect(validateBranchName('-feature')).not.toBeNull() // 打头 "-"（git 选项注入形态）
    expect(validateBranchName('.feature')).not.toBeNull()
    expect(validateBranchName('feat ure')).not.toBeNull() // 空格
    expect(validateBranchName('feat~1')).not.toBeNull()
    expect(validateBranchName('feat^1')).not.toBeNull()
    expect(validateBranchName('a:b')).not.toBeNull()
    expect(validateBranchName('a\\b')).not.toBeNull()
    expect(validateBranchName('中文名')).not.toBeNull()
  })
})

// buildGitTabStatusMap（P-20261003-242 编辑器 tab git 状态着色）：路径→档位
// 查找表纯函数，消费方 EditorGroupPane（组件内只做开关/伪路径守卫+查表）
describe('buildGitTabStatusMap', () => {
  it('Untracked → untracked，其余在册状态（staged 与否）→ modified', () => {
    const map = buildGitTabStatusMap([
      { path: 'a.ts', status: 'Modified' },
      { path: 'b.ts', status: 'Untracked' },
      { path: 'c.ts', status: 'Added', },
      { path: 'd.ts', status: 'Deleted' },
      { path: 'e.ts', status: 'Renamed' },
      { path: 'f.ts', status: 'Unmerged' },
    ])
    expect(map.get('a.ts')).toBe('modified')
    expect(map.get('b.ts')).toBe('untracked')
    expect(map.get('c.ts')).toBe('modified')
    expect(map.get('d.ts')).toBe('modified')
    expect(map.get('e.ts')).toBe('modified')
    expect(map.get('f.ts')).toBe('modified')
  })

  it('不在变更集内的路径无键（查表 undefined → 组件不着色）', () => {
    const map = buildGitTabStatusMap([{ path: 'a.ts', status: 'Modified' }])
    expect(map.has('clean.ts')).toBe(false)
    expect(map.get('clean.ts')).toBeUndefined()
  })

  it('同路径多条目后写胜出（staged+unstaged 并存同落蓝色档，结果稳定）', () => {
    const map = buildGitTabStatusMap([
      { path: 'a.ts', status: 'Modified' },
      { path: 'a.ts', status: 'Modified' },
    ])
    expect(map.get('a.ts')).toBe('modified')
    expect(map.size).toBe(1)
  })

  it('空变更集返回空表；空路径条目跳过', () => {
    expect(buildGitTabStatusMap([]).size).toBe(0)
    const map = buildGitTabStatusMap([{ path: '', status: 'Modified' }])
    expect(map.size).toBe(0)
  })
})
