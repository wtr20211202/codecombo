import { describe, it, expect } from 'vitest'
import { isNewerVersion, isPrereleaseVersion } from './version'

describe('isNewerVersion', () => {
  it('相同版本返回 false', () => {
    expect(isNewerVersion('0.1.0-beta.1', '0.1.0-beta.1')).toBe(false)
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false)
  })

  it('补丁位更新', () => {
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(false)
  })

  it('主/次位更新', () => {
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true)
    expect(isNewerVersion('0.2.0', '0.1.9')).toBe(true)
    expect(isNewerVersion('0.1.0', '1.0.0')).toBe(false)
  })

  it('预发布版低于正式版（semver 语义）', () => {
    expect(isNewerVersion('1.0.0-beta.1', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0', '1.0.0-beta.1')).toBe(true)
  })

  it('预发布段之间比较', () => {
    expect(isNewerVersion('1.0.0-beta.2', '1.0.0-beta.1')).toBe(true)
    expect(isNewerVersion('1.0.0-beta.1', '1.0.0-beta.2')).toBe(false)
    expect(isNewerVersion('1.0.0-beta', '1.0.0-beta.1')).toBe(false)
    expect(isNewerVersion('1.0.0-alpha', '1.0.0-beta')).toBe(false)
  })

  it('v 前缀兼容', () => {
    expect(isNewerVersion('v1.2.3', '1.2.2')).toBe(true)
    expect(isNewerVersion('1.2.3', 'v1.2.4')).toBe(false)
  })

  it('无法解析的版本返回 false（宁可不提示不误报）', () => {
    expect(isNewerVersion('', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0.0', '')).toBe(false)
    expect(isNewerVersion('dev', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.0', 'not.a.version')).toBe(false)
  })

  it('位数不足自动补零', () => {
    expect(isNewerVersion('1.2', '1.1.9')).toBe(true)
    expect(isNewerVersion('2', '1.9.9')).toBe(true)
  })
})

describe('isPrereleaseVersion', () => {
  it('带预发布段为 true（npm 语义：-alpha/-beta/-rc 等）', () => {
    expect(isPrereleaseVersion('0.21-alpha.2')).toBe(true)
    expect(isPrereleaseVersion('1.0.0-beta.1')).toBe(true)
    expect(isPrereleaseVersion('1.0.0-rc.1')).toBe(true)
  })

  it('正式版为 false', () => {
    expect(isPrereleaseVersion('1.2.3')).toBe(false)
    expect(isPrereleaseVersion('v1.2.3')).toBe(false)
    expect(isPrereleaseVersion('1.2')).toBe(false)
  })

  it('解析失败按稳定版处理（宁多展示不误过滤）', () => {
    expect(isPrereleaseVersion('')).toBe(false)
    expect(isPrereleaseVersion('dev')).toBe(false)
  })
})
