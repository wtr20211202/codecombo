import { describe, it, expect } from 'vitest'
import { hasUncommittedDiff, isDirectoryProbeError, isPathLikeTarget, middleEllipsis, normRelPath } from '@/utils/approvalTarget'

/** 审批卡 target 路径形态探测（P-20261003-47）：形态守卫决定 target 渲染为
 *  可点态还是纯文本；差异判定决定点击开文件还是直开差异视图；
 *  目录探测判定（P-20261003-201）决定点击开文件还是树定位；
 *  卡面展示中段省略（P-20261003-231）决定长路径展示形态（保首尾） */

describe('isPathLikeTarget', () => {
  it('含分隔符的项目相对路径判真（正斜杠/反斜杠）', () => {
    expect(isPathLikeTarget('src/main.go')).toBe(true)
    expect(isPathLikeTarget('web/src/composables/useOpenFiles.ts')).toBe(true)
    expect(isPathLikeTarget('src\\main.go')).toBe(true)
  })

  it('单段常见文件形态判真（含扩展名）', () => {
    expect(isPathLikeTarget('README.md')).toBe(true)
    expect(isPathLikeTarget('main.go')).toBe(true)
    expect(isPathLikeTarget('.gitignore')).toBe(true)
  })

  it('命令形 target 判假（形态守卫，保持纯文本）', () => {
    expect(isPathLikeTarget('git push origin main')).toBe(false)
    expect(isPathLikeTarget('reset --hard')).toBe(false)
    expect(isPathLikeTarget('push --force')).toBe(false)
  })

  it('绝对路径 / API 路径 / URL / 盘符路径判假', () => {
    expect(isPathLikeTarget('/api/projects/x/git/push')).toBe(false)
    expect(isPathLikeTarget('D:\\work\\proj\\a.go')).toBe(false)
    expect(isPathLikeTarget('https://example.com/a.go')).toBe(false)
  })

  it('空串 / 单段无扩展名（分支名等）判假', () => {
    expect(isPathLikeTarget('')).toBe(false)
    expect(isPathLikeTarget('   ')).toBe(false)
    expect(isPathLikeTarget('main')).toBe(false)
    expect(isPathLikeTarget('Makefile')).toBe(false)
  })
})

describe('hasUncommittedDiff', () => {
  const files = [
    { path: 'src/modified.ts', status: 'Modified' },
    { path: 'src/added.ts', status: 'Added' },
    { path: 'src/gone.ts', status: 'Deleted' },
    { path: 'src/new.ts', status: 'Untracked' },
  ]

  it('Modified/Added/Deleted 相对 HEAD 均有未提交差异', () => {
    expect(hasUncommittedDiff(files, 'src/modified.ts')).toBe(true)
    expect(hasUncommittedDiff(files, 'src/added.ts')).toBe(true)
    expect(hasUncommittedDiff(files, 'src/gone.ts')).toBe(true)
  })

  it('Untracked（将新建文件）与不在清单的干净文件判无差异', () => {
    expect(hasUncommittedDiff(files, 'src/new.ts')).toBe(false)
    expect(hasUncommittedDiff(files, 'docs/clean.md')).toBe(false)
  })

  it('匹配前归一化：反斜杠与 ./ 前缀不影响命中', () => {
    expect(hasUncommittedDiff(files, 'src\\modified.ts')).toBe(true)
    expect(hasUncommittedDiff([{ path: 'src/app.ts', status: 'Modified' }], './src/app.ts')).toBe(true)
  })
})

describe('normRelPath', () => {
  it('反斜杠统一正斜杠 + 去 ./ 前缀 + 去首尾空白', () => {
    expect(normRelPath(' src\\a\\b.ts ')).toBe('src/a/b.ts')
    expect(normRelPath('./src/a.ts')).toBe('src/a.ts')
    expect(normRelPath('src/a.ts')).toBe('src/a.ts')
  })
})

describe('isDirectoryProbeError（P-20261003-201 目录判定）', () => {
  // 结构与拦截器抛出的 AppError 对齐（status/rawMessage 字段）
  const probeErr = (status: number, rawMessage: string) => ({ status, rawMessage })

  it('filePolicy 对已存在目录的 400「path is a directory」判真', () => {
    expect(isDirectoryProbeError(probeErr(400, 'path is a directory'))).toBe(true)
    expect(isDirectoryProbeError(probeErr(400, 'Path is a Directory'))).toBe(true)
  })

  it('404 不存在 / 403 越根 / 目录外 400 原文判假（点击维持落空静默）', () => {
    expect(isDirectoryProbeError(probeErr(404, 'file not found'))).toBe(false)
    expect(isDirectoryProbeError(probeErr(403, 'path outside project root'))).toBe(false)
    expect(isDirectoryProbeError(probeErr(400, 'other bad request'))).toBe(false)
  })

  it('非对象错误（网络层字符串/undefined）判假', () => {
    expect(isDirectoryProbeError('network error')).toBe(false)
    expect(isDirectoryProbeError(undefined)).toBe(false)
    expect(isDirectoryProbeError(null)).toBe(false)
  })
})

describe('middleEllipsis（P-20261003-231 卡面中段省略）', () => {
  it('阈值内（≤45 码点）原样返回：短路径/空串不处理', () => {
    expect(middleEllipsis('')).toBe('')
    expect(middleEllipsis('docs/notes.md')).toBe('docs/notes.md')
    expect(middleEllipsis('a'.repeat(45))).toBe('a'.repeat(45))
  })

  it('超阈值长路径：前 20 + … + 后 24，目录形态与文件名两头保留', () => {
    const long = 'src/features/approval/components/approvalCards/sections/ApprovalCard.vue'
    const out = middleEllipsis(long)
    expect(out).toBe(long.slice(0, 20) + '…' + long.slice(-24))
    expect(out.startsWith(long.slice(0, 20))).toBe(true) // 头段目录前缀形态
    expect(out.endsWith('ApprovalCard.vue')).toBe(true) // 尾段文件名完整
    expect([...out].length).toBe(45) // 展示长度封顶 20+1+24
  })

  it('阈值边界：46 码点触发截断且截断后不长于原文', () => {
    const s46 = 'b'.repeat(46)
    expect(middleEllipsis(s46)).toBe('b'.repeat(20) + '…' + 'b'.repeat(24))
  })

  it('增补平面字符（emoji 文件名）按码点切不腰斩代理对', () => {
    // 19 ASCII + 1 emoji（2 码元 1 码点）+ 26 ASCII = 46 码点，切点恰落 emoji
    const s = 'a'.repeat(19) + '📦' + 'c'.repeat(26)
    expect(middleEllipsis(s)).toBe('a'.repeat(19) + '📦' + '…' + 'c'.repeat(24))
  })
})
