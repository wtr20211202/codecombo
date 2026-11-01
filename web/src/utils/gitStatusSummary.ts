/**
 * agent 发起族 git 状态摘要（P-20261003-176）：会话创建时把「当前分支 / N 处
 * 未提交变更 / 最近提交主题」拼成一行上下文注入 launchArgs——agent 接手第一轮
 * 几乎总要跑 git status/branch 摸底，摘要省一轮探底。数据面全部现成缓存
 * （projectStore.currentProject.currentBranch / changesStore.files /
 * logApi.getLog limit=1，useCommitActions amend 回填同款先例），本文件只做
 * 纯拼装与字节护栏，取数在 composables/useGitStatusSummary。
 *
 * 拼接顺序约定（提案注记留白，此处定案）：摘要放**定位前言之后**（prompt 尾部
 * 追加），不放最前——服务端 promptSessionName（terminal.go）以 launchArgs 首行
 * 派生会话名，摘要前置会让所有 ask 会话都以「git 状态：…」命名，列表辨识度
 * 全毁；后置则首行仍是真实任务，命名语义不变。
 */

import { byteLength } from './promptFit'

/** 摘要自身字节上限：模板 + 超长提交主题截到这么多，为任务正文保底留出
 *  ≥280 字节（LAUNCH_ARGS_MAX_BYTES 500 - 本上限 - 换行 1） */
export const GIT_SUMMARY_MAX_BYTES = 200

/** 摘要组装所需事实（取数面见 composables/useGitStatusSummary） */
export interface GitStatusFacts {
  /** 项目名（摘要自带归属，非项目 cwd 会话/对话框主目录会话也可读） */
  projectName: string
  /** 当前分支；空 = 非 git 工作区/未知 → 不产出摘要 */
  branch: string
  /** 未提交变更数（含 staged/unstaged/untracked，changes store 口径） */
  changedCount: number
  /** 最近提交主题（首行）；空 = 空仓库/取数失败 → 省略该段 */
  lastCommitSubject: string
}

/** 极小翻译面（纯函数可测；组合式传 useI18n 的 t，useTodoAgentFix 同款先例） */
export type GitSummaryTranslator = (key: string, params?: Record<string, unknown>) => string

/** 拼一行摘要：分支缺失返回空串（上游按「无摘要」处理不注入）；
 *  提交主题超长从尾部截（保头——主题信息密度在开头），… 尾缀标注；主题完全
 *  塞不下时降级为无提交段（不输出「最近提交：…」悬空标签） */
export function buildGitStatusSummary(facts: GitStatusFacts, t: GitSummaryTranslator): string {
  const branch = facts.branch.trim()
  if (!branch) return ''
  const project = facts.projectName.trim()
  const subject = facts.lastCommitSubject.trim()
  const baseKey = `agentTerminal.gitSummary.${facts.changedCount > 0 ? 'dirty' : 'clean'}`
  const key = subject ? `${baseKey}Commit` : baseKey
  const params = { project, branch, count: facts.changedCount, subject }
  const line = t(key, params)
  if (byteLength(line) <= GIT_SUMMARY_MAX_BYTES) return line
  if (!subject) return line // 无主题段可裁：模板固定段超限属理论边界，原样交装配层兜底
  let subj = subject
  // 批量估裁：UTF-8 每字符 ≤3 字节（BMP 内 CJK），先按超额估裁再逐字符微调
  subj = subj.slice(0, Math.max(0, subj.length - Math.ceil((byteLength(line) - GIT_SUMMARY_MAX_BYTES) / 3)))
  while (subj.length > 0 && byteLength(t(key, { ...params, subject: `${subj}…` })) > GIT_SUMMARY_MAX_BYTES) {
    subj = subj.slice(0, -1)
  }
  if (!subj) return t(baseKey, params)
  return t(key, { ...params, subject: `${subj}…` })
}
