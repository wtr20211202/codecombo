/**
 * 通知正文路径链接化（P-20261004-61，纯函数供单测）：任务失败/完成/哨兵类
 * 通知 body 携输出尾部与命令上下文，最常见信息形态是「文件路径:行号」（报错
 * 栈一行）——渲染前扫描 body，把路径形态片段切出供通知中心渲染为可点态，
 * 点击走 OPS_OPEN_FILE_AT 既有「打开文件+行定位」链（审批卡 target 可点态
 * P-20261003-47 同款事件桥）。
 *
 * 门禁分层（宁降级纯文本勿误渲染可点态，同 approvalTarget 守卫哲学）：
 * ① 必须携 `:LINE` 行号后缀——任务书命中的信息形态即「路径:行号」；无行号的
 *   多段 token（分支名 feature/x、纯目录 src/lib）在打开链上要么落空要么必然
 *   死链（目录不可按文件打开），从严判非；行号同时是「跳过去看什么」的承诺，
 *   与五步痛点收口的 Ctrl+G 语义对齐；
 * ② matchPathCandidates 形态扫描（utils/pathScan 共享匹配核，终端输出链接层
 *   同源——「输出尾部一行报错栈」两类场景文本形态一致，正则守卫只养一份）；
 * ③ isPathLikeTarget 复核（utils/approvalTarget 既有形态守卫，任务书点名的
 *   复用点）——绝对路径（POSIX 根/盘符，ops-notify open-file-at 发布口同样
 *   拒绝）与 URL 形态判非，保持纯文本；
 * ④ `..` 段剔除——打开链按项目根解析相对路径，`..` 段必越出项目根（服务端
 *   SafeJoinProject 403），链接注定落空不如不渲染（同「落空静默」但对用户
 *   少一次无效点击）。
 * 探测是纯形态启发式，不保证文件真实存在——与审批卡同哲学，落空由点击链
 * 静默兜底（不弹错）。多行 body 安全：匹配核字符类均不含换行，候选不跨行。
 */

import { isPathLikeTarget, normRelPath } from './approvalTarget'
import { matchPathCandidates } from './pathScan'

/** 通知正文分段：纯文本段原样渲染，path 段渲染为可点态 */
export interface NotifBodySegment {
  kind: 'text' | 'path'
  /** 原文片段（path 段含 :LINE[:COL] 后缀）——分段拼回恒等于原文，复制链
   *  （notifPlainText 走 notifBody 原文）与展示面文本零漂移 */
  text: string
  /** 归一化项目相对路径（正斜杠、去 ./ 前缀）——OPS_OPEN_FILE_AT detail.path；
   *  仅 path 段携带 */
  path?: string
  /** `:LINE` 行号后缀 */
  line?: number
  /** `:COL` 列号后缀 */
  col?: number
}

/** body 内 `..` 段判定：打开链按项目根解析，越根路径注定 403 落空 */
function hasParentSegment(p: string): boolean {
  return p.split('/').some(seg => seg === '..')
}

/** 把通知 body 切为渲染分段：无命中返回单段原文（调用方零分支渲染）；
 *  空 body 返回空数组。量级：body 是服务端钳制过的短摘要（尾部错误摘要
 *  ≤200 字符级），单次正则线性扫描 O(len)，列表 ≤200 条 × content-visibility
 *  跳过视口外渲染，无热路径顾虑 */
export function segmentNotifBody(body: string): NotifBodySegment[] {
  if (!body) return []
  const out: NotifBodySegment[] = []
  let cursor = 0
  for (const m of matchPathCandidates(body)) {
    // 门禁①③④：必须带行号 + 形态复核 + `..` 段剔除——不命中的候选留在纯
    // 文本流里
    if (m.line === undefined) continue
    if (!isPathLikeTarget(m.core) || hasParentSegment(normRelPath(m.core))) continue
    if (m.start > cursor) out.push({ kind: 'text', text: body.slice(cursor, m.start) })
    out.push({
      kind: 'path',
      text: m.text,
      path: normRelPath(m.core),
      line: m.line,
      col: m.col,
    })
    cursor = m.start + m.text.length
  }
  if (cursor < body.length) out.push({ kind: 'text', text: body.slice(cursor) })
  return out
}
