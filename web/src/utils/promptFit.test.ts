import { describe, it, expect } from 'vitest'
import {
  byteLength,
  buildTaskFileDoc,
  fitByBytes,
  fitListByBudget,
  LAUNCH_ARGS_MAX_BYTES,
  TASK_FILE_LAUNCH_ARGS,
  TASK_FILE_NAME,
  withTaskFileFallback,
} from './promptFit'

// agent 发起族 launchArgs 字节装箱（P-20261004-6）纯函数：fitByBytes 尾部优先
// 两段式估裁（原 useAgentFix.fitLaunchPrompt / useEditorAskAgent.fitPrompt 逐
// 字节同款实现归一）+ 边界（多字节截断点/空模板/恰好上限）；
// fitListByBudget 清单型装箱（P-20261006-41：逐条贪心 + 注记计入预算回吐腾位，
// todo/diff 留言/P-138 族三处本地实现归一）+ 边界（贪心断点/空清单/域降级）；
// 任务文件降级（P-20261006-44）：500 字节墙的文件面绕行判定原语。

describe('fitByBytes 尾部优先字节装箱', () => {
  it('总长不超上限时原样返回（不挂 …）', () => {
    expect(fitByBytes((c) => `head ${c}`, 'body')).toBe('head body')
  })

  it('恰好上限（500 字节整）：原样返回、零裁剪', () => {
    const content = 'x'.repeat(LAUNCH_ARGS_MAX_BYTES - 1)
    const out = fitByBytes((c) => `h${c}`, content)
    expect(byteLength(out)).toBe(LAUNCH_ARGS_MAX_BYTES)
    expect(out).toBe(`h${content}`)
    expect(out).not.toContain('…')
  })

  it('超限时裁变量内容头部、保尾部并 … 标注，总长收进 500 字节', () => {
    // 500 个 ASCII 字符的内容 + 固定段必然超限
    const content = 'x'.repeat(500) + 'TAIL-END'
    const out = fitByBytes((c) => `固定头部：${c}`, content)
    expect(byteLength(out)).toBeLessThanOrEqual(LAUNCH_ARGS_MAX_BYTES)
    expect(out.endsWith('TAIL-END')).toBe(true)
    expect(out).toContain('…')
    expect(out.startsWith('固定头部：')).toBe(true)
  })

  it('max 参数化：自定义上限同样收口（空固定段模板）', () => {
    const out = fitByBytes((c) => c, 'a'.repeat(200), 100)
    // 保尾：保留 97 个 a + … 前缀，恰好 100 字节
    expect(out).toBe('…' + 'a'.repeat(97))
    expect(byteLength(out)).toBe(100)
  })

  it('多字节截断点：CJK 逐字符微调落在码点边界，无半字符伪影', () => {
    // CJK 每字符 3 字节：批量裁剪 floor(over/4) 后仍超限，逐字符兜底生效。
    // 定量：full=6+400×3=1206，over=706，批量裁 floor(706/4)=176 字符；逐字符
    // 收口到 6+3+3k≤500 → k=163（总 498 字节）——截断点恰在字符边界
    const out = fitByBytes((c) => `前缀${c}`, '错'.repeat(400))
    expect(out).toBe('前缀…' + '错'.repeat(163))
    expect(byteLength(out)).toBe(498)
    expect(out).not.toContain('\uFFFD')
  })

  it('4 字节字符（代理对）同样收进上限（不变量）', () => {
    const out = fitByBytes((c) => `前缀${c}`, '😀'.repeat(300))
    expect(byteLength(out)).toBeLessThanOrEqual(LAUNCH_ARGS_MAX_BYTES)
    expect(out.startsWith('前缀…')).toBe(true)
  })
})

describe('fitByBytes 空模板边界', () => {
  it('空内容且固定段放得下：原样返回，不挂 …', () => {
    expect(fitByBytes((c) => `head:${c}`, '')).toBe('head:')
  })

  it('固定段本身超上限：内容裁空后原样返回（服务端 400 兜底，仅理论边界）', () => {
    const out = fitByBytes((c) => '固'.repeat(300) + c, '')
    expect(out).toBe('固'.repeat(300) + '…')
    expect(byteLength(out)).toBeGreaterThan(LAUNCH_ARGS_MAX_BYTES)
  })
})

describe('byteLength UTF-8 字节度量', () => {
  it('ASCII 单字节 / CJK 三字节 / emoji 四字节', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('错错')).toBe(6)
    expect(byteLength('😀')).toBe(4)
  })
})

// 清单型装配样例（useTodoAgentFix 同形：计数头 + 逐条行 + 注记），手算字节即得
const countAssemble = (lines: string[], omitted: number): string => {
  const parts = [`n=${lines.length}`, ...lines]
  if (omitted > 0) parts.push(`~${omitted}~`)
  return parts.join('\n')
}

describe('fitListByBudget 清单型装箱（P-20261006-41）', () => {
  it('空清单：included=0/omittedCount=0，不附注记', () => {
    const r = fitListByBudget([], 100, { assemble: countAssemble })
    expect(r).toEqual({ included: 0, omittedCount: 0, text: 'n=0' })
  })

  it('全部装得下：保序整装，omittedCount=0 无注记', () => {
    const r = fitListByBudget(['aaaa', 'bbbb'], 100, { assemble: countAssemble })
    expect(r).toEqual({ included: 2, omittedCount: 0, text: 'n=2\naaaa\nbbbb' })
  })

  it('贪心边界：恰好 budget 收下，超 1 字节即断', () => {
    const join = (lines: string[]): string => lines.join('\n')
    expect(fitListByBudget(['aaaaaa', 'bbbb'], 11, { assemble: join }).included).toBe(2) // 6+1+4=11 恰好
    expect(fitListByBudget(['aaaaaaa', 'bbbb'], 11, { assemble: join }).included).toBe(1) // 12 > 11
  })

  it('溢出即止：中间超大条目截断后，后续更小条目不回补（保序保头语义）', () => {
    const r = fitListByBudget(['aaaa', 'x'.repeat(20), 'bb'], 10, { assemble: (lines) => lines.join('\n') })
    expect(r.included).toBe(1)
    expect(r.omittedCount).toBe(2)
    expect(r.text).toBe('aaaa')
  })

  it('注记计入预算：贪心装得下的条目因放不下注记从尾部回吐腾位', () => {
    // 无注记装配可收 2 条（'n=2\naaaa\nbbbb'=13 ≤ 14）；注记 '~1~'（3 字节）挤爆
    // 预算（17 > 14）→ 回吐 b 后 'n=1\naaaa\n~2~'=12 收口
    const bare = fitListByBudget(['aaaa', 'bbbb', 'cc'], 14, {
      assemble: (lines) => `n=${lines.length}\n${lines.join('\n')}`,
    })
    expect(bare.included).toBe(2)
    const r = fitListByBudget(['aaaa', 'bbbb', 'cc'], 14, { assemble: countAssemble })
    expect(r.included).toBe(1)
    expect(r.omittedCount).toBe(2)
    expect(r.text).toBe('n=1\naaaa\n~2~')
    expect(byteLength(r.text)).toBeLessThanOrEqual(14)
  })

  it('首条都装不下：fallback 域整形收首条，included=1/omittedCount=n-1', () => {
    const r = fitListByBudget(['x'.repeat(30), 'b'], 10, {
      assemble: countAssemble,
      fallback: (first) => `${first.slice(0, 8)}…`,
    })
    expect(r).toEqual({ included: 1, omittedCount: 1, text: 'xxxxxxxx…' })
    // 单条超限同款：首条经整形计入，omittedCount=0
    const single = fitListByBudget(['x'.repeat(30)], 10, {
      assemble: countAssemble,
      fallback: (first) => first.slice(0, 5),
    })
    expect(single).toEqual({ included: 1, omittedCount: 0, text: 'xxxxx' })
  })

  it('注记回吐至空仍放不下（仅理论边界）：同样走 fallback 域降级', () => {
    // 头（20 字节）+ 注记（9 字节）定型段挤压：首条恰可入（26 ≤ 27），注记一发
    // 即爆（36 > 27），回吐至空 → 域降级收首条
    const r = fitListByBudget(['aaaaa', 'bb'], 27, {
      assemble: (lines, omitted) =>
        ['H'.repeat(20), ...lines, ...(omitted > 0 ? ['~'.repeat(9)] : [])].join('\n'),
      fallback: (first) => `first:${first}`,
    })
    expect(r).toEqual({ included: 1, omittedCount: 1, text: 'first:aaaaa' })
  })

  it('无 fallback 且首条装不下：装 0 条，omittedCount 如实记账（调用方自读）', () => {
    const r = fitListByBudget(['x'.repeat(30)], 10, { assemble: (lines) => lines.join('\n') })
    expect(r).toEqual({ included: 0, omittedCount: 1, text: '' })
  })

  it('budget 参数化：非 500 上限同款收敛（P-138 族 essential 份额入口）', () => {
    // 服务端上限恒 500，预算再分配入口传份额进来——原语对任意 budget 同语义
    const r = fitListByBudget(['x'.repeat(90), 'x'.repeat(20)], 100, { assemble: (lines) => lines.join('\n') })
    expect(r.included).toBe(1)
    expect(r.omittedCount).toBe(1)
    expect(byteLength(r.text)).toBeLessThanOrEqual(100)
    expect(LAUNCH_ARGS_MAX_BYTES).toBe(500) // 服务端契约锚定（terminal.go len>500 拒绝）
  })
})

describe('withTaskFileFallback 超限降级判定（P-20261006-44）', () => {
  it('≤500 字节：原样直发，无任务文件（零行为变化）', () => {
    const text = '请修复以下 2 处技术债标记：\na.ts:1 // TODO: a'
    const plan = withTaskFileFallback(text)
    expect(plan).toEqual({ launchArgs: text })
    expect(plan.taskFile).toBeUndefined()
  })

  it('恰好 500 字节整：仍走原文直发分支', () => {
    const text = 'x'.repeat(LAUNCH_ARGS_MAX_BYTES)
    expect(withTaskFileFallback(text)).toEqual({ launchArgs: text })
  })

  it('超 500 字节：launchArgs 换短引用指令，全文交 taskFile 待落盘', () => {
    const text = `请修复以下 30 处技术债标记：\n${'x'.repeat(600)}`
    const plan = withTaskFileFallback(text)
    expect(plan.launchArgs).toBe(TASK_FILE_LAUNCH_ARGS)
    expect(plan.taskFile).toBe(text)
  })

  it('短引用指令自身远在 500 字节内（不构成二次超限面）', () => {
    expect(byteLength(TASK_FILE_LAUNCH_ARGS)).toBeLessThanOrEqual(LAUNCH_ARGS_MAX_BYTES / 2)
    expect(TASK_FILE_LAUNCH_ARGS).toContain(TASK_FILE_NAME)
  })
})

describe('buildTaskFileDoc 任务文件正文', () => {
  it('自述头（一次性载体/可删/覆盖式）+ 任务全文 + 尾随换行', () => {
    const doc = buildTaskFileDoc('请修复以下任务：\na.ts:1 // TODO: a')
    expect(doc).toContain(TASK_FILE_NAME)
    expect(doc).toContain('一次性任务载体')
    expect(doc).toContain('任务完成即可删除')
    expect(doc).toContain('整体覆盖')
    expect(doc).toContain('请修复以下任务：\na.ts:1 // TODO: a')
    expect(doc.endsWith('\n')).toBe(true)
  })

  it('尾随空白归一：任务尾部多余换行不重复入文', () => {
    const doc = buildTaskFileDoc('task body\n\n\n')
    expect(doc.endsWith('task body\n')).toBe(true)
  })
})
