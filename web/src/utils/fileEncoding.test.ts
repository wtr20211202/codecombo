import { describe, expect, it } from 'vitest'
import { encodingLabel, encodingTestId, FILE_ENCODINGS } from './fileEncoding'

describe('FILE_ENCODINGS', () => {
  it('选项序：UTF-8（空标签）第一、GBK 第二（产品主场景中文 Windows）', () => {
    expect(FILE_ENCODINGS[0]).toEqual({ value: '', label: 'UTF-8' })
    expect(FILE_ENCODINGS[1]).toEqual({ value: 'gbk', label: 'GBK' })
    expect(FILE_ENCODINGS.map(o => o.value)).toEqual(['', 'gbk', 'big5', 'utf16le', 'utf16be'])
  })
})

describe('encodingLabel', () => {
  it('已知标签映射展示名（空值/undefined = UTF-8 缺省）', () => {
    expect(encodingLabel('')).toBe('UTF-8')
    expect(encodingLabel(undefined)).toBe('UTF-8')
    expect(encodingLabel('gbk')).toBe('GBK')
    expect(encodingLabel('big5')).toBe('Big5')
    expect(encodingLabel('utf16le')).toBe('UTF-16 LE')
    expect(encodingLabel('utf16be')).toBe('UTF-16 BE')
  })

  it('未知标签大写兜底（不吞未来新增编码）', () => {
    expect(encodingLabel('iso-8859-1')).toBe('ISO-8859-1')
  })
})

describe('encodingTestId', () => {
  it('空标签给语义化名字（testid 不允许空段）', () => {
    expect(encodingTestId('')).toBe('utf8')
    expect(encodingTestId('gbk')).toBe('gbk')
  })
})
