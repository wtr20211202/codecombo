import { afterEach, describe, expect, it } from 'vitest'
import { hasBlockingOverlay } from './overlayGuard'

describe('hasBlockingOverlay', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('无遮蔽弹层时 false（自定义弹层可自行消费 Esc）', () => {
    expect(hasBlockingOverlay()).toBe(false)
  })

  it.each(['.n-modal', '.n-dialog', '.n-drawer', '.n-dropdown-menu'])(
    '%s 在场时 true（Esc 让位 Naive 自带关闭层）',
    (cls) => {
      const el = document.createElement('div')
      el.className = cls.slice(1)
      document.body.appendChild(el)
      expect(hasBlockingOverlay()).toBe(true)
    },
  )
})
