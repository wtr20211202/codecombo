import { describe, it, expect } from 'vitest'
import { sanitizeFontPayload, sectionItems } from '@/utils/settingsTransfer'

/**
 * 设置迁移 font 节消毒单测——只钉光标偏好（P-20261005-212）的值域消毒与投影：
 * 档位外样式/非布尔闪烁丢弃（缺省项不触碰本机值，与 store load 消毒同口径）；
 * 其余 font 字段的消毒与导入应用链由 e2e settings-transfer.spec.ts 端到端覆盖
 */
describe('sanitizeFontPayload 光标偏好消毒（P-20261005-212）', () => {
  it('合法三档样式与布尔闪烁入包；档位外样式与非布尔闪烁丢弃', () => {
    expect(sanitizeFontPayload({ cursorStyle: 'bar', cursorBlink: false })).toMatchObject({ cursorStyle: 'bar', cursorBlink: false })
    expect(sanitizeFontPayload({ cursorStyle: 'underline', cursorBlink: true }).cursorStyle).toBe('underline')
    expect(sanitizeFontPayload({ cursorStyle: 'dotted', cursorBlink: 'yes' })).toMatchObject({ sizes: {}, editor: {} })
    expect(sanitizeFontPayload({ cursorStyle: 42, cursorBlink: null }).cursorStyle).toBeUndefined()
  })

  it('cursorBlink=false 是合法值（不误当缺省剥除）；投影含两键供对称计数', () => {
    const items = sectionItems('font', { cursorStyle: 'bar', cursorBlink: false })
    expect(items.cursorStyle).toBe('bar')
    expect(items.cursorBlink).toBe(false)
    // 缺省项不入投影（计数不计）
    expect(sectionItems('font', { sizes: { base: 12 } }).cursorStyle).toBeUndefined()
    expect(sectionItems('font', { sizes: { base: 12 } }).cursorBlink).toBeUndefined()
  })
})
