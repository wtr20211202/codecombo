import { describe, expect, it } from 'vitest'
import { applyContentChanges, isSpliceUnsafeEvent } from './modelContentSplice'

/**
 * 增量拼接纯函数单测（P-20261004-140）：EOL 原语变更事件的拼接安全性——
 * model.setEOL/pushEOL 触发的 onDidChangeModelContent 不保证携带可拼接的
 * changes（0.55.1 实测为单段合成 change、空数组是其他版本形态），拼接链必须
 * 先过 isSpliceUnsafeEvent 守卫改走模型权威值，否则差位复制静默损坏全文。
 */

describe('isSpliceUnsafeEvent', () => {
  it('常规文本编辑事件（带 rangeOffset/text）可拼接', () => {
    expect(isSpliceUnsafeEvent({
      changes: [{ rangeOffset: 3, rangeLength: 0, text: 'x' }],
    })).toBe(false)
  })

  it('EOL 原语变更（isEolChange）不可拼接——模型权威值接管', () => {
    // 0.55.1 的 setEOL 事件：isEolChange=true + 覆盖全文的单段合成 change，
    // 拼接基线与其 rangeLength 不保证等长（混合行尾文件打开即被规范化）
    expect(isSpliceUnsafeEvent({
      isEolChange: true,
      changes: [{ rangeOffset: 0, rangeLength: 100, text: 'new full value' }],
    })).toBe(true)
  })

  it('changes 为空数组不可拼接（任务书点名的防御形态）', () => {
    expect(isSpliceUnsafeEvent({ changes: [] })).toBe(true)
  })

  it('changes 缺 rangeOffset/text（ModelRawEOLChanged 裸形态）不可拼接', () => {
    expect(isSpliceUnsafeEvent({ changes: [{ changeType: 5 } as never] })).toBe(true)
    expect(isSpliceUnsafeEvent({ changes: [{ rangeOffset: 0, rangeLength: 1 }] })).toBe(true)
  })
})

describe('applyContentChanges', () => {
  it('单段插入', () => {
    expect(applyContentChanges('hello world', [
      { rangeOffset: 5, rangeLength: 0, text: ',' },
    ])).toBe('hello, world')
  })

  it('单段替换', () => {
    expect(applyContentChanges('hello world', [
      { rangeOffset: 6, rangeLength: 5, text: 'monaco' },
    ])).toBe('hello monaco')
  })

  it('多段变更乱序输入按 offset 从后向前拼接（多光标形态）', () => {
    expect(applyContentChanges('aaa\nbbb\nccc', [
      { rangeOffset: 8, rangeLength: 3, text: 'C' },
      { rangeOffset: 0, rangeLength: 3, text: 'A' },
      { rangeOffset: 4, rangeLength: 3, text: 'B' },
    ])).toBe('A\nB\nC')
  })

  it('全文覆盖段（offset 0 / rangeLength=全文长）拼接结果即 text', () => {
    expect(applyContentChanges('old content', [
      { rangeOffset: 0, rangeLength: 11, text: 'new\r\ncontent' },
    ])).toBe('new\r\ncontent')
  })
})
