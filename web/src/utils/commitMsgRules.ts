/**
 * 提交信息规范校验（P-20261003-273）：scripts/check-commit-msg.cjs（commit-msg
 * 门禁，P-20261002-92）规则的前端移植——同一套 <type>(<scope>)?: <标题> 规则在
 * 提交流程的客户端预检（纯前端，服务端 git commit 不感知）。规则语义与脚本逐
 * 条对齐（类型白名单 / scope 可选但非空 / 标题非空 / 标题长度上限 / Merge、
 * Revert 自动信息跳过）；违规返回结构化条目（rule + 参数），文案由 UI 层经
 * i18n 渲染——纯函数不持翻译，双语同源。
 *
 * 与脚本的刻意差异：脚本 detail 是面向终端报告的中文字符串，这里改为携带参数
 * 的结构体（错误结构化，提案「失败原因透传」面）——交给智能体修与弹层清单两
 * 个消费方各自组装文案，避免把展示文案混进数据面。
 */

/** 类型白名单：与 scripts/check-commit-msg.cjs TYPES 同源（常规 conventional
 *  类型 + 本仓沉淀的 polish/merge/security/diag/review/i18n），增删须两处同步 */
export const COMMIT_MSG_TYPES = [
  'feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci',
  'chore', 'revert', 'polish', 'merge', 'security', 'diag', 'review', 'i18n',
] as const

/** 标题长度上限（脚本 DEFAULT_MAX_LEN 同值） */
export const COMMIT_MSG_MAX_LEN = 100

/** git 自动生成的提交信息不属规范约束对象（脚本 SKIP_PREFIXES 同源） */
const SKIP_PREFIXES: RegExp[] = [/^Merge /, /^Revert "/]

/** <type>(<scope>)?: <标题>（脚本 SUBJECT_RE 同源） */
const SUBJECT_RE = /^([a-zA-Z][a-zA-Z0-9-]*)(\(([^()]*)\))?: (.*)$/

export type CommitMsgRule = 'format' | 'type' | 'scope' | 'subject' | 'length'

/** 结构化违规条目：rule 定位文案键，type/len/max 为对应插值参数 */
export interface CommitMsgViolation {
  rule: CommitMsgRule
  /** rule=type：越界类型名 */
  type?: string
  /** rule=length：实际长度与上限 */
  len?: number
  max?: number
}

/** 从完整提交信息取标题行：跳过注释行（# 帮助块）与空行（脚本 subjectOfMessage
 *  同语义——模板预填/历史回填的消息可能带注释段） */
export function subjectLineOf(message: string): string {
  for (const line of (message || '').split(/\r?\n/)) {
    const t = line.trim()
    if (t !== '' && !t.startsWith('#')) return t
  }
  return ''
}

/** 校验单条标题（脚本 validateSubject 同语义），返回违规列表（空 = 合规） */
export function validateCommitSubject(subject: string, maxLen: number = COMMIT_MSG_MAX_LEN): CommitMsgViolation[] {
  if (SKIP_PREFIXES.some((re) => re.test(subject))) return []
  if (subject.trim() === '') return [{ rule: 'subject' }]
  const errs: CommitMsgViolation[] = []
  const m = SUBJECT_RE.exec(subject)
  if (!m) return [{ rule: 'format' }]
  const [, type, scopeGroup, scope, title] = m
  if (!(COMMIT_MSG_TYPES as readonly string[]).includes(type!)) errs.push({ rule: 'type', type })
  if (scopeGroup !== undefined && scope!.trim() === '') errs.push({ rule: 'scope' })
  if (title!.trim() === '') errs.push({ rule: 'subject' })
  else if (subject.length > maxLen) errs.push({ rule: 'length', len: subject.length, max: maxLen })
  return errs
}

/** 校验完整提交信息（取标题行后核验）：提交预检与「交给智能体修」共用入口 */
export function validateCommitMsg(message: string, maxLen: number = COMMIT_MSG_MAX_LEN): CommitMsgViolation[] {
  return validateCommitSubject(subjectLineOf(message), maxLen)
}
