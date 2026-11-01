import { describe, expect, it } from 'vitest'
import {
  buildInlineEditInstruction,
  foldInlineText,
  QUEUE_ITEM_MAX_RUNES,
} from './inlineEditPrompt'

/** rune 计数（与服务端 utf8.RuneCountInString 同轴断言） */
const runes = (s: string) => Array.from(s).length

const PARTS = {
  instruction: '给这段代码加上空值保护',
  location: 'src/a.ts 第 1-2 行',
  codePrefix: '原代码：',
}

describe('foldInlineText', () => {
  it('折叠换行/制表/连续空白为单空格并去首尾（单行语义，服务端同款）', () => {
    expect(foldInlineText('  const a\n\t= 1;\n  ')).toBe('const a = 1;')
    expect(foldInlineText('a\r\nb')).toBe('a b')
    expect(foldInlineText('')).toBe('')
  })
})

describe('buildInlineEditInstruction', () => {
  it('组装单行结构化指令：指令在前、定位次之、选区殿后', () => {
    const out = buildInlineEditInstruction(PARTS, 'let x = y.z\nreturn x')
    expect(out).toBe('给这段代码加上空值保护（src/a.ts 第 1-2 行；原代码：let x = y.z return x）')
    expect(out).not.toContain('\n')
  })

  it('总长不超服务端 rune 上限', () => {
    const out = buildInlineEditInstruction(PARTS, 'x'.repeat(5000))
    expect(runes(out)).toBeLessThanOrEqual(QUEUE_ITEM_MAX_RUNES)
  })

  it('超限时从选区尾部裁剪（保头）并 … 标注，指令与定位不丢', () => {
    const out = buildInlineEditInstruction(PARTS, 'x'.repeat(5000))
    expect(out.startsWith('给这段代码加上空值保护（src/a.ts 第 1-2 行；原代码：')).toBe(true)
    expect(out.endsWith('…）')).toBe(true)
    expect(out).toContain('xxxx')
  })

  it('多字节内容按 rune 裁剪不腰斩（CJK 3 字节但上限轴是 rune）', () => {
    const out = buildInlineEditInstruction(PARTS, '汉'.repeat(3000))
    expect(runes(out)).toBeLessThanOrEqual(QUEUE_ITEM_MAX_RUNES)
    expect(out.endsWith('…）')).toBe(true)
    // 汉字整字保留：无半个码点伪影（最后字符必为 ）或完整汉字）
    expect(out.at(-2)).toMatch(/[汉…]/)
  })

  it('极端长的指令+定位挤爆配额：保头裁剪，定位不丢', () => {
    const out = buildInlineEditInstruction(
      { ...PARTS, instruction: '意'.repeat(1500), location: `p/${'长'.repeat(600)}` },
      'code',
    )
    expect(runes(out)).toBeLessThanOrEqual(QUEUE_ITEM_MAX_RUNES)
    expect(out.startsWith('意')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })

  it('敏感值出域前遮蔽（maskSensitive 兜底，指令与选区同盖）', () => {
    const out = buildInlineEditInstruction(
      { ...PARTS, instruction: '把 password=abc123 这段改成读环境变量' },
      'const t = "sca_abcdef123456"',
    )
    expect(out).not.toContain('abc123')
    expect(out).not.toContain('sca_abcdef123456')
    expect(out).toContain('password=')
  })

  it('空选区（折叠后空串）允许：纯指令+定位成立', () => {
    const out = buildInlineEditInstruction(PARTS, '')
    expect(out).toBe('给这段代码加上空值保护（src/a.ts 第 1-2 行；原代码：）')
  })
})
