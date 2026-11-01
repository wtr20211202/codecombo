import { describe, expect, it } from 'vitest'
import type { ShareInfo } from '../api/domains/share'
import { reshareConfig, shareCanReshare } from './useShareReshare'

// 「重新分享」纯逻辑（P-20261020-10）：只对已过期/已消费且目标健康的 file
// 分享开放；重建沿用原 mode/水印/一次性，口令由用户重新输入。

const NOW = Date.parse('2026-10-10T00:00:00Z')
const IDS = new Set(['p1'])

function row(overrides: Partial<ShareInfo>): ShareInfo {
  return {
    token: 't1',
    kind: 'file',
    projectId: 'p1',
    projectName: 'demo',
    path: 'docs/a.md',
    name: 'a.md',
    isDir: false,
    size: 10,
    createdAt: '2026-10-01T00:00:00Z',
    ...overrides,
  }
}

describe('shareCanReshare', () => {
  it('仅过期/已消费且目标健康的 file 分享可重建', () => {
    expect(shareCanReshare(row({ expiresAt: '2026-10-09T00:00:00Z' }), NOW, IDS)).toBe(true)
    expect(shareCanReshare(row({ consumed: true }), NOW, IDS)).toBe(true)
    // 活跃行：重复 create 是幂等 no-op，没有重建语义
    expect(shareCanReshare(row({}), NOW, IDS)).toBe(false)
    // 异常行：目标不存在，重建只会失败
    expect(shareCanReshare(row({ expiresAt: '2026-10-09T00:00:00Z', health: 'target_missing' }), NOW, IDS)).toBe(false)
    // 非 file 形态没有可复用的项目文件配置
    expect(shareCanReshare(row({ kind: 'snippet', expiresAt: '2026-10-09T00:00:00Z' }), NOW, IDS)).toBe(false)
    expect(shareCanReshare(row({ kind: 'terminal', expiresAt: '2026-10-09T00:00:00Z' }), NOW, IDS)).toBe(false)
    // 归属项目已删除：冻结链可能仍健康，但没有可重拷的源目标
    expect(shareCanReshare(row({ expiresAt: '2026-10-09T00:00:00Z' }), NOW, new Set())).toBe(false)
  })
})

describe('reshareConfig', () => {
  it('沿用 frozen/live、水印与一次性设置；口令取本次输入', () => {
    expect(reshareConfig(row({ frozen: true, watermark: false }), 'pw')).toEqual({
      projectId: 'p1',
      path: 'docs/a.md',
      mode: 'frozen',
      passphrase: 'pw',
      watermark: false,
      viewOnce: false,
    })
  })

  it('watermark 缺省按开、viewOnce 缺省按关；live 口令可留空', () => {
    expect(reshareConfig(row({ viewOnce: true }))).toEqual({
      projectId: 'p1',
      path: 'docs/a.md',
      mode: 'live',
      passphrase: '',
      watermark: true,
      viewOnce: true,
    })
  })
})
