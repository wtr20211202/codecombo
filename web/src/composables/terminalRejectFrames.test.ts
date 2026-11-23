import { describe, expect, it } from 'vitest'
import {
  TERMINAL_WS_REJECT_INPUT_HELD_BY_SHARE,
  TERMINAL_WS_REJECT_READONLY_EXTERNAL,
  terminalRejectToastKey,
} from './terminalRejectFrames'

// 终端 WS input_rejected 帧码 → 文案键（P-20261122-17）：两码分义是稳定
// 契约（服务端 ws_attach 同名常量），文案键必须落在既有 terminal.inputLock
// 词典块（check:i18n 成对校验）
describe('terminalRejectToastKey', () => {
  it('maps readonly_external to the unlock-path toast', () => {
    expect(TERMINAL_WS_REJECT_READONLY_EXTERNAL).toBe('readonly_external')
    expect(terminalRejectToastKey(TERMINAL_WS_REJECT_READONLY_EXTERNAL))
      .toBe('terminal.inputLock.rejectedServer')
  })

  it('maps input_held_by_share to the share-center recovery toast', () => {
    expect(TERMINAL_WS_REJECT_INPUT_HELD_BY_SHARE).toBe('input_held_by_share')
    expect(terminalRejectToastKey(TERMINAL_WS_REJECT_INPUT_HELD_BY_SHARE))
      .toBe('terminal.inputLock.rejectedShare')
  })

  it('ignores unknown codes (forward compatible, no noise toast)', () => {
    expect(terminalRejectToastKey('some_future_code')).toBeNull()
    expect(terminalRejectToastKey(undefined)).toBeNull()
    expect(terminalRejectToastKey('')).toBeNull()
  })
})
