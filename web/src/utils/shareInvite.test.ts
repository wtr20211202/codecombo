import { describe, it, expect } from 'vitest'
import { buildShareInviteText, type ShareInviteLabels } from './shareInvite'

const labels: ShareInviteLabels = {
  link: 'LINK: ',
  passphrase: 'PASS: ',
  expires: 'EXPIRES: ',
  permanent: 'PERMANENT',
  viewOnce: 'ONCE',
}

describe('buildShareInviteText', () => {
  it('链接 + 口令 + 有效期 + 一次性说明一次成型', () => {
    const text = buildShareInviteText({
      url: 'http://192.168.1.50:18080/s/tok',
      passphrase: 's3cret',
      expiresText: '2026-10-21 10:00',
      viewOnce: true,
    }, labels)
    expect(text).toBe([
      'LINK: http://192.168.1.50:18080/s/tok',
      'PASS: s3cret',
      'EXPIRES: 2026-10-21 10:00',
      'ONCE',
    ].join('\n'))
  })

  it('无口令不输出口令行；无有效期走永久文案', () => {
    const text = buildShareInviteText({ url: 'https://x/s/t' }, labels)
    expect(text).toBe('LINK: https://x/s/t\nPERMANENT')
    expect(text).not.toContain('PASS:')
  })

  it('口令只出现在独立行，链接行不含口令（二维码/剪贴板同源约束）', () => {
    const url = 'https://x/s/t?not-a-secret'
    const text = buildShareInviteText({ url, passphrase: 'do-not-leak' }, labels)
    expect(text.split('\n')[0]).toBe(`LINK: ${url}`)
    expect(text.split('\n')[1]).toBe('PASS: do-not-leak')
    expect(text.split('\n')[0]).not.toContain('do-not-leak')
  })

  it('空口令字符串视为未设门', () => {
    expect(buildShareInviteText({ url: 'u', passphrase: '' }, labels)).toBe('LINK: u\nPERMANENT')
  })
})
