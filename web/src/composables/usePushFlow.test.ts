import { describe, expect, it } from 'vitest'
import { mapPushBehindChoice, pickPushFailReason } from './usePushFlow'

// 纯函数级测试（组合式本体依赖 useDialog/useI18n，jsdom 不可测——CLAUDE.md 测试节）：
// 预检三态决策映射与失败原因提取是连招/快捷推送共享的行为契约，locale 文案改动
// 不应破坏流向语义

describe('mapPushBehindChoice', () => {
  it('true → pull-first：预检主操作「先去拉取」，调用方接拉取流', () => {
    expect(mapPushBehindChoice(true)).toBe('pull-first')
  })

  it('null → dismissed：遮罩/Esc 关闭=不推不拉（不能当「仍要推送」）', () => {
    expect(mapPushBehindChoice(null)).toBe('dismissed')
  })

  it('false → continue：次操作「仍要推送」，继续直推交 git 兜底', () => {
    expect(mapPushBehindChoice(false)).toBe('continue')
  })
})

describe('pickPushFailReason', () => {
  it('AppError.userMessage 优先（KNOWN_ERROR_I18N 映射后的本地化文案）', () => {
    const err = { userMessage: '远程主机认证失败', rawMessage: 'authentication failed' }
    expect(pickPushFailReason(err, '兜底')).toBe('远程主机认证失败')
  })

  it('无 userMessage 时依次回退 rawMessage / message', () => {
    expect(pickPushFailReason({ rawMessage: 'rejected non-FF' }, '兜底')).toBe('rejected non-FF')
    expect(pickPushFailReason({ message: 'Network Error' }, '兜底')).toBe('Network Error')
  })

  it('全空 / 非对象 / null → 调用方兜底文案', () => {
    expect(pickPushFailReason({}, '兜底')).toBe('兜底')
    expect(pickPushFailReason({ userMessage: '', rawMessage: '' }, '兜底')).toBe('兜底')
    expect(pickPushFailReason(null, '兜底')).toBe('兜底')
    expect(pickPushFailReason('boom', '兜底')).toBe('兜底')
  })
})
