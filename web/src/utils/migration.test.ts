import { describe, expect, it } from 'vitest'
import {
  MIGRATION_BLOCK_KEYS,
  migrationBlockLabelKey,
  migrationDownloadName,
  migrationFormatBytes,
  passphraseStrength,
  passphraseStrengthKey,
  projectOversize,
} from './migration'

// 换机迁移纯前端助手（P-20261003-147）：口令强度分档 / 块元数据 / 字节人性化 /
// 超阈值判定 / 下载名合成。服务端是校验权威，这里钉的是输入前反馈的分档边界。

describe('passphraseStrength', () => {
  it('长度不足 8 一律 0（不可提交）', () => {
    expect(passphraseStrength('').score).toBe(0)
    expect(passphraseStrength('Ab1!').score).toBe(0)
    expect(passphraseStrength('Ab1!Ab1').score).toBe(0)
    expect(passphraseStrength('Ab1!Ab1!').ok).toBe(true) // 恰 8 位
  })

  it('恰 8 位单一字符类 = 弱（1 档）', () => {
    expect(passphraseStrength('aaaaaaaa')).toEqual({ score: 1, ok: true })
  })

  it('≥12 位两类字符 = 中（2 档）', () => {
    expect(passphraseStrength('abcdefgh1234').score).toBe(2)
  })

  it('≥16 位三类以上字符 = 强（3 档）', () => {
    expect(passphraseStrength('Abcdefghij123456!').score).toBe(3)
  })

  it('16 位但仅一类字符仍是弱（多样性不足不给高档）', () => {
    expect(passphraseStrength('abcdefghijklmnop').score).toBe(1)
  })
})

describe('passphraseStrengthKey', () => {
  it('档位映射 settings.migration.strength.<n>', () => {
    expect(passphraseStrengthKey(0)).toBe('settings.migration.strength.0')
    expect(passphraseStrengthKey(3)).toBe('settings.migration.strength.3')
  })
})

describe('migrationFormatBytes', () => {
  it('字节/KB/MB/GB 分段', () => {
    expect(migrationFormatBytes(512)).toBe('512 B')
    expect(migrationFormatBytes(2048)).toBe('2.0 KB')
    expect(migrationFormatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(migrationFormatBytes(3.5 * 1024 * 1024 * 1024)).toBe('3.5 GB')
  })

  it('非法输入回退占位（NaN/负数不渲染假数）', () => {
    expect(migrationFormatBytes(-1)).toBe('—')
    expect(migrationFormatBytes(NaN)).toBe('—')
  })
})

describe('projectOversize', () => {
  it('2GB 阈值边界（≥ 阈值告警）', () => {
    expect(projectOversize(2 * 1024 * 1024 * 1024)).toBe(true)
    expect(projectOversize(2 * 1024 * 1024 * 1024 - 1)).toBe(false)
  })
})

describe('migrationBlockLabelKey', () => {
  it('四块词汇稳定序 + i18n 键拼写', () => {
    expect([...MIGRATION_BLOCK_KEYS]).toEqual(['credentials', 'tokens', 'settings', 'instances'])
    expect(migrationBlockLabelKey('credentials')).toBe('settings.migration.blocks.credentials')
  })
})

describe('migrationDownloadName', () => {
  it('sc-migration-<yyyymmdd-hhmmss>.scpkg（双位补零）', () => {
    const name = migrationDownloadName(new Date(2026, 0, 5, 7, 8, 9))
    expect(name).toBe('sc-migration-20260105-070809.scpkg')
  })
})
