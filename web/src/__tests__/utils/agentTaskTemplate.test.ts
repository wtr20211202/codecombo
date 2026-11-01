import { describe, expect, it } from 'vitest'
import {
  AGENT_TASK_NAME_MAX,
  AGENT_TASK_PROMPT_MAX_BYTES,
  AGENT_TASK_SELECTION_MAX_RUNES,
  resolveAgentTaskTemplate,
  templatePromptKeywords,
  truncateSelectionForTemplate,
  validateAgentTaskTemplate,
} from '../../utils/agentTaskTemplate'

/**
 * 任务模板域纯函数（P-20261002-16）：占位符替换复用 utils/textTemplate
 * （解析语义不在此重复测试，textTemplate.test.ts 已覆盖），这里测任务
 * 模板域的语义包装——上下文缺失保留并提示 / 未知占位符不告警 / 校验码。
 */

describe('resolveAgentTaskTemplate', () => {
  it('三个上下文占位符全部替换', () => {
    const r = resolveAgentTaskTemplate('审查 {file}（分支 {branch}，目录 {dir}）', {
      file: 'src/app.ts',
      branch: 'feat/x',
      dir: '/repo',
    })
    expect(r.text).toBe('审查 src/app.ts（分支 feat/x，目录 /repo）')
    expect(r.unresolved).toEqual([])
  })

  it('上下文缺失的已知占位符原样保留并进 unresolved（不静默清空）', () => {
    const r = resolveAgentTaskTemplate('审查 {file}，分支 {branch}', { branch: 'main' })
    expect(r.text).toBe('审查 {file}，分支 main')
    expect(r.unresolved).toEqual(['file'])
  })

  it('未知占位符名原样保留但不告警（非任务模板契约）', () => {
    const r = resolveAgentTaskTemplate('scp {src} {dir}', { dir: '/repo' })
    expect(r.text).toBe('scp {src} /repo')
    expect(r.unresolved).toEqual([])
  })

  it('同一占位符多次出现只报一次 unresolved', () => {
    const r = resolveAgentTaskTemplate('{file} 与 {file}', {})
    expect(r.text).toBe('{file} 与 {file}')
    expect(r.unresolved).toEqual(['file'])
  })

  it('${VAR} shell 语法与 {{ 转义不被吞（textTemplate 语义穿透）', () => {
    const r = resolveAgentTaskTemplate("export PATH=${PATH} && awk '{{print $1}}' {file}", { file: 'a.txt' })
    expect(r.text).toBe("export PATH=${PATH} && awk '{print $1}' a.txt")
    expect(r.unresolved).toEqual([])
  })

  it('{selection} 有选区替换为选区文本，无选区（空串）原样保留并进 unresolved（P-20261005-149）', () => {
    const withSel = resolveAgentTaskTemplate('解释这段代码：{selection}', { selection: 'const a = 1' })
    expect(withSel.text).toBe('解释这段代码：const a = 1')
    expect(withSel.unresolved).toEqual([])
    const noSel = resolveAgentTaskTemplate('解释这段代码：{selection}', {})
    expect(noSel.text).toBe('解释这段代码：{selection}')
    expect(noSel.unresolved).toEqual(['selection'])
  })
})

describe('truncateSelectionForTemplate（P-20261005-149 {selection} 截断）', () => {
  const NOTE = '…（选区已截断）'

  it('未超限原样返回，不加注记；恰 200 rune 也不加（无信息损失）', () => {
    expect(truncateSelectionForTemplate('abc', NOTE)).toBe('abc')
    expect(truncateSelectionForTemplate('', NOTE)).toBe('')
    expect(truncateSelectionForTemplate('a'.repeat(AGENT_TASK_SELECTION_MAX_RUNES), NOTE)).toBe('a'.repeat(AGENT_TASK_SELECTION_MAX_RUNES))
  })

  it('超限保头 200 rune + 注记尾缀', () => {
    const long = 'x'.repeat(300)
    const r = truncateSelectionForTemplate(long, NOTE)
    expect(r).toBe('x'.repeat(AGENT_TASK_SELECTION_MAX_RUNES) + NOTE)
  })

  it('按码点计数：增补平面字符（emoji）不劈半', () => {
    // 199 个 ASCII + 1 个增补平面字符（2 code unit）= 200 rune；再补内容必截，
    // 截断点落在 emoji 之后（头 200 rune 完整含 emoji，不出现半个代理对）
    const head = 'a'.repeat(199) + '😀'
    const r = truncateSelectionForTemplate(head + 'tail', NOTE)
    expect(r.startsWith(head)).toBe(true)
    expect(r.endsWith(NOTE)).toBe(true)
    expect(Array.from(r.slice(0, head.length))).toHaveLength(AGENT_TASK_SELECTION_MAX_RUNES)
  })

  it('CJK 按字符计数（rune 非字节），200 汉字不加注记、201 截', () => {
    expect(truncateSelectionForTemplate('审'.repeat(200), NOTE)).toBe('审'.repeat(200))
    expect(truncateSelectionForTemplate('审'.repeat(201), NOTE)).toBe('审'.repeat(200) + NOTE)
  })
})

describe('templatePromptKeywords', () => {
  it('英文按空白分词取前 N 词', () => {
    expect(templatePromptKeywords('review the current file changes now', 4)).toBe('review the current file')
  })

  it('中文长段无词界：整段一词按字符窗口截取', () => {
    const r = templatePromptKeywords('审查当前文件的改动并给出意见')
    expect(r.length).toBeLessThanOrEqual(48)
    expect(r.startsWith('审查当前文件')).toBe(true)
  })

  it('词数与累计字符双上限任一先到即截（keywords 进面板模糊打分不可无界）', () => {
    const long = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ')
    // 字符窗口先到：w0..w2 累计 6 字符，w3 被挡
    expect(templatePromptKeywords(long, 8, 6)).toBe('w0 w1 w2')
    // 词数上限先到
    expect(templatePromptKeywords(long, 2, 100)).toBe('w0 w1')
  })

  it('空白正文返回空串（模板校验层另有 promptRequired 把关）', () => {
    expect(templatePromptKeywords('   ')).toBe('')
  })
})

describe('validateAgentTaskTemplate', () => {
  it('空白名/空白 prompt 给出对应校验码', () => {
    expect(validateAgentTaskTemplate('', 'x')).toBe('nameRequired')
    expect(validateAgentTaskTemplate('  ', 'x')).toBe('nameRequired')
    expect(validateAgentTaskTemplate('n', ' ')).toBe('promptRequired')
  })

  it('超长名/超限 prompt 给出对应校验码', () => {
    expect(validateAgentTaskTemplate('a'.repeat(AGENT_TASK_NAME_MAX + 1), 'x')).toBe('nameTooLong')
    // CJK 3 字节/字符：170 字 ≈ 510 字节，超 500 上限
    expect(validateAgentTaskTemplate('n', '审'.repeat(170))).toBe('promptTooLong')
  })

  it('合法输入通过（返回空串）；prompt 按字节度量非字符数', () => {
    expect(validateAgentTaskTemplate('审查', '审查 {file}')).toBe('')
    expect(validateAgentTaskTemplate('n', 'a'.repeat(AGENT_TASK_PROMPT_MAX_BYTES))).toBe('')
    expect(validateAgentTaskTemplate('n', 'a'.repeat(AGENT_TASK_PROMPT_MAX_BYTES + 1))).toBe('promptTooLong')
  })
})
