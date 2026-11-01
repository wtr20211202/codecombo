/**
 * 会话 prompt 前言统一组装器（P-20261003-184）：定位前言（P-20261003-102）/
 * 接力结论（P-20261003-114）/git 状态摘要（P-20261003-176）三案此前各自往
 * launchArgs 拼接——拼接顺序/配额分配/截断优先级散在各调用点，族再扩容会
 * 漂移。本文件把它们收编为「段落数组 + 装配语义 + 优先级弃段」的单一事实源：
 * 改装配策略只改这里，新增前言段声明后进数组即可。
 *
 * 装配定案（沿用三案已合入的既有语义，逐条有出处）：
 * - 顺序 = 声明顺序，主任务恒首行：服务端 promptSessionName 按 launchArgs
 *   首行派生会话名，前言前置会毁掉会话列表辨识度（utils/gitStatusSummary
 *   头注的 P-176 定案，P-102 定位前言同款）
 * - 优先级 = 主任务保底不弃、前言按声明顺序弃：声明序靠前的前言先弃（定位
 *   前言先于 git 摘要——git 摘要预留配额的 P-176 既有装配同序）
 * - 主任务的「可截内容」（路径/选区代码）让位原子前言：git 摘要在场时主任务
 *   按剩余配额收敛（P-176 budget 扣除同式：500 - 摘要字节 - 换行），措辞段
 *   永不弃；主任务定型措辞段（无 fit）放不下份额时弃的是前言不是它
 * - 接力摘要类「保尾可截」前言在剩余配额内收敛（越近越相关，… 前缀标注，
 *   P-114 fitByBytes 语义），配额尽弃段
 */

import { byteLength, LAUNCH_ARGS_MAX_BYTES } from './promptFit'

/** 段落装配语义 */
export type PromptSectionKind =
  | 'essential' // 主任务保底段：整段不弃；有 fit 时内容按配额收敛（措辞保留）
  | 'atomic' // 前言定型整行（定位前言/git 摘要）：塞不下整段弃、不截断——半行定位/摘要比没有更误导
  | 'tailKeep' // 前言保尾可截段（接力摘要）：fit 在剩余配额内收敛，立锥之地都没有才弃段

export interface PromptSection {
  /** 段落标识（dropped 诊断与单测断言用：task/locate/relay/git 等） */
  id: string
  kind: PromptSectionKind
  /** 定型文本：atomic 段的注入内容、essential 固定措辞段的全文；fit 段留
   *  空串（自然形态由 fit 在配额内产出，免无预算下白拼一遍） */
  text: string
  /** 配额内收敛渲染（essential 可截内容 / tailKeep 保尾装箱），契约 = 返回值
   *  byteLength ≤ budget（fitByBytes 族契约；极端定型模板超限由装配层重分配
   *  与服务端 400 兜底）。须纯函数——装配器按弃段阶梯以不同配额反复调用 */
  fit?: (budget: number) => string
}

export interface AssembledPrompt {
  /** 装配结果：段间 \n 连接，总额 ≤ maxBytes（理论边界除外，见实现尾注） */
  text: string
  /** 被弃前言段 id（按声明顺序）；空 = 全段在位 */
  dropped: string[]
}

/**
 * 按声明顺序装配 launchArgs 段落：主任务保底、前言按声明顺序弃、配额分配与
 * 截断（maxBytes 缺省 = 服务端 launchArgs 硬上限）。装配纯函数、i18n 无关——
 * 段落以渲染好的文本/fit 闭包进数组，本文件不感知文案语言。
 *
 * 配额分配（谁让谁）：主任务措辞 > 原子前言（声明序靠后者先预留）> 主任务
 * 可截内容与保尾前言（fit 各自在份额内收敛）。实现按「弃段阶梯」试装：
 * 0 弃 → 弃首个前言 → 弃前两个 → …，首个能装下配额的阶梯即结果。前言至多
 * 三四段、阶梯轮数有穷，每轮 O(段数) 次字节度量，无常数级开销担忧。
 */
export function assembleLaunchPrompt(
  sections: PromptSection[],
  maxBytes: number = LAUNCH_ARGS_MAX_BYTES,
): AssembledPrompt {
  // 空段 = 无此段（text 空且无 fit；fit 段以 fit 判定在定性）
  const present = sections.filter(s => s.text !== '' || !!s.fit)
  const essential = present.find(s => s.kind === 'essential')
  // 前言 = 非 essential 段；声明顺序即展示顺序，弃段按此序从头部弃
  const preambles = present.filter(s => s.kind !== 'essential')

  for (let drop = 0; drop <= preambles.length; drop++) {
    const survivors = preambles.slice(drop)
    // 原子前言定型整行先预留（不可截，主任务份额给不出就弃更多前言重试）
    const atomicBytes = survivors.reduce((n, s) => (s.kind === 'atomic' ? n + byteLength(s.text) : n), 0)
    // 段间分隔符数 = 在场段数 - 1（主任务 + 幸存前言）
    const count = survivors.length + (essential ? 1 : 0)
    const seps = count > 0 ? count - 1 : 0
    // 主任务份额 = 总额 - 原子前言预留 - 分隔符：git 摘要在场时主任务按剩余
    // 配额收敛（与 P-176 手工装配同式：500 - 摘要字节 - 换行）
    const essentialShare = maxBytes - atomicBytes - seps
    const essentialText = !essential
      ? ''
      : essential.fit
        ? essential.fit(essentialShare)
        : essential.text
    if (byteLength(essentialText) > essentialShare) continue // 主任务定型措辞连份额都放不下：弃更多前言重试
    const tail = survivors.find(s => s.kind === 'tailKeep')
    // 保尾前言吃剩余配额（主任务收敛后）；立锥之地都没有 → 弃段重试
    const tailBudget = essentialShare - byteLength(essentialText)
    if (tail && tailBudget <= 0) continue
    const tailText = tail ? (tail.fit ? tail.fit(tailBudget) : tail.text) : ''
    const byId = new Map<string, string>()
    if (essential) byId.set(essential.id, essentialText)
    for (const s of survivors) byId.set(s.id, s === tail ? tailText : s.text)
    // join 前滤空串：契约外输入（fit 返回空/重复 tailKeep 段）不产空行伪影；
    // 契约内各段非空，此过滤恒无操作
    const text = present.filter(s => byId.has(s.id)).map(s => byId.get(s.id)!).filter(t => t !== '').join('\n')
    // fit 理论边界超限且还有弃段余地：继续收敛；末轮原样接受（服务端 400 兜底）
    if (byteLength(text) > maxBytes && drop < preambles.length) continue
    return { text, dropped: preambles.slice(0, drop).map(s => s.id) }
  }

  // 全弃仍超（理论边界：无 fit 的固定主任务措辞自身 > maxBytes）：主任务原样
  // 兜底交服务端 400 终检——与既有装配层「模板固定段超限原样返回」口径一致
  return {
    text: essential ? (essential.fit ? essential.fit(maxBytes) : essential.text) : '',
    dropped: preambles.map(s => s.id),
  }
}
