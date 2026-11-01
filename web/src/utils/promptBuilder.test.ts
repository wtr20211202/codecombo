import { describe, expect, it } from 'vitest'
import { assembleLaunchPrompt, type PromptSection } from './promptBuilder'
import { byteLength, fitByBytes } from './promptFit'

/**
 * 统一组装器段优先级矩阵（P-20261003-184）：三案前言（定位 P-102/接力
 * P-114/git 摘要 P-176）+ 主任务的装配语义回归——
 * - 顺序恒 = 声明顺序，主任务恒首行（promptSessionName 首行派生会话名）
 * - 优先级 = 主任务保底、前言按声明顺序弃（定位先于 git 弃 = git 预留配额）
 * - 主任务可截内容让位原子前言（P-176 budget 扣除同式）
 * - 接力摘要保尾装箱（P-114 fitByBytes 语义），配额尽弃段
 * 全程真实 fitByBytes 闭包装载（与消费方同款拼装器，非测试替身）。
 */

/** 主任务可截段（P-28 整文件询问同款：模板 + 可变内容保尾装箱） */
const taskFit = (content: string): PromptSection => ({
  id: 'task',
  kind: 'essential',
  text: '',
  fit: b => fitByBytes(p => `任务:${p}`, content, b),
})

/** 主任务定型措辞段（P-55 目录会话任务模板同款：固定文案不可截） */
const taskFixed = (text: string): PromptSection => ({ id: 'task', kind: 'essential', text })

const locate = (text: string): PromptSection => ({ id: 'locate', kind: 'atomic', text })
const git = (text: string): PromptSection => ({ id: 'git', kind: 'atomic', text })

/** 接力结论段（P-114 同款：模板 + 摘要保尾装箱，越近越相关） */
const relay = (content: string): PromptSection => ({
  id: 'relay',
  kind: 'tailKeep',
  text: '',
  fit: b => fitByBytes(p => `此前会话结论:${p}`, content, b),
})

describe('promptBuilder 段优先级矩阵（P-20261003-184）', () => {
  it('三段齐发·配额宽裕：全段在位，顺序 = 声明顺序（task → locate → git），dropped 空', () => {
    const r = assembleLaunchPrompt([taskFixed('T'.repeat(200)), locate('L'.repeat(100)), git('G'.repeat(60))])
    expect(r.text).toBe(`${'T'.repeat(200)}\n${'L'.repeat(100)}\n${'G'.repeat(60)}`)
    expect(r.dropped).toEqual([])
    expect(r.text.split('\n')[0]).toBe('T'.repeat(200)) // 首行恒主任务
  })

  it('三段齐发·配额紧张：定位前言先弃（声明序首位），task+git 保留且 git 完整在尾', () => {
    // 200 + 250 + 60 + 2 个换行 = 512 > 500 → 弃 locate → 261 ≤ 500
    const r = assembleLaunchPrompt([taskFixed('T'.repeat(200)), locate('L'.repeat(250)), git('G'.repeat(60))])
    expect(r.text).toBe(`${'T'.repeat(200)}\n${'G'.repeat(60)}`)
    expect(r.dropped).toEqual(['locate'])
  })

  it('三段齐发·更紧：前言按声明顺序连弃（locate → git），主任务保底', () => {
    // task+git+1 = 511 > 500 → git 也弃 → task 独存 ≤500
    const r = assembleLaunchPrompt([taskFixed('T'.repeat(480)), locate('L'.repeat(30)), git('G'.repeat(30))])
    expect(r.text).toBe('T'.repeat(480))
    expect(r.dropped).toEqual(['locate', 'git'])
  })

  it('两段·主任务可截 + git 摘要：摘要完整预留尾部，主任务内容按剩余份额收敛（P-176 budget 扣除同式）', () => {
    const summary = 'G'.repeat(100)
    const r = assembleLaunchPrompt([taskFit('x'.repeat(800)), git(summary)])
    // 主任务份额 = 500 - 100 - 1 = 399，内容必被裁（… 前缀标注）
    expect(r.text.startsWith('任务:…')).toBe(true)
    expect(r.text.endsWith(`\n${summary}`)).toBe(true) // 摘要零截断在尾部
    expect(r.dropped).toEqual([])
    expect(byteLength(r.text)).toBeLessThanOrEqual(500)
  })

  it('两段·主任务定型措辞 + git 摘要：超配额弃摘要保指令原文（NewSessionDialog 语义）', () => {
    const r = assembleLaunchPrompt([taskFixed('T'.repeat(480)), git('G'.repeat(60))])
    expect(r.text).toBe('T'.repeat(480))
    expect(r.dropped).toEqual(['git'])
  })

  it('单段·接力保尾装箱（P-114）：… 前缀标注省略、结论尾部保留、总额 ≤500', () => {
    const content = `head-${'x'.repeat(600)}-RELAY-TAIL`
    const r = assembleLaunchPrompt([relay(content)])
    expect(r.text.startsWith('此前会话结论:…')).toBe(true)
    expect(r.text.endsWith('RELAY-TAIL')).toBe(true) // 保尾：越近越相关
    expect(byteLength(r.text)).toBeLessThanOrEqual(500)
    expect(r.dropped).toEqual([])
  })

  it('单段·主任务可截：内容按全额收敛，总额 ≤500', () => {
    const r = assembleLaunchPrompt([taskFit('x'.repeat(800))])
    expect(r.text.startsWith('任务:…')).toBe(true)
    expect(byteLength(r.text)).toBeLessThanOrEqual(500)
  })

  it('单段·主任务定型措辞：配额内原样（零改动基线）', () => {
    const r = assembleLaunchPrompt([taskFixed('请先熟悉当前目录的代码结构，然后等待我的具体任务。')])
    expect(r.text).toBe('请先熟悉当前目录的代码结构，然后等待我的具体任务。')
    expect(r.dropped).toEqual([])
  })

  it('全超配额·主任务自身超限：前言全弃、主任务原样兜底（服务端 400 终检的理论边界）', () => {
    const big = 'T'.repeat(520)
    const r = assembleLaunchPrompt([taskFixed(big), locate('L'.repeat(30)), git('G'.repeat(30))])
    expect(r.text).toBe(big)
    expect(r.dropped).toEqual(['locate', 'git'])
    expect(byteLength(r.text)).toBeGreaterThan(500)
  })

  it('保尾前言无立锥之地：fit 极端超限时弃段重试（relay 让位主任务）', () => {
    // 主任务 490 → 接力只剩 9 字节，连「此前会话结论:…」都放不下 → 整段弃
    const r = assembleLaunchPrompt([taskFixed('T'.repeat(490)), relay(`${'x'.repeat(100)}-TAIL`)])
    expect(r.text).toBe('T'.repeat(490))
    expect(r.dropped).toEqual(['relay'])
  })

  it('空段过滤：text 空且无 fit = 无此段，不注空行/空换行（P-176 无摘要不追加同款）', () => {
    expect(assembleLaunchPrompt([taskFixed(''), git('G'.repeat(10))]).text).toBe('G'.repeat(10))
    const r = assembleLaunchPrompt([taskFit('short'), git('')])
    expect(r.text).toBe('任务:short')
    expect(r.text.endsWith('\n')).toBe(false)
    expect(assembleLaunchPrompt([]).text).toBe('')
  })

  it('maxBytes 参数：装配上限随调用方口径收紧', () => {
    const r = assembleLaunchPrompt([taskFixed('T'.repeat(80)), git('G'.repeat(30))], 100)
    expect(r.text).toBe('T'.repeat(80))
    expect(r.dropped).toEqual(['git'])
  })
})
