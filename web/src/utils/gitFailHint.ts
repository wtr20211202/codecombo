/**
 * git 失败恢复 hint → 行动化提示映射（P-20261005-194，纯函数无 i18n 实例）。
 *
 * 服务端分类器（server/git/failhint.go ClassifyFailHint）随 gitops 错误响应
 * 返回结构化 hint {kind, detail?}（与错误码正交：码管注册文案分支，kind 管
 * 恢复语义）。本模块把 kind 映射为「原因一句话 + 可选直达按钮」，axios 拦截器
 * 据此把裸 toast 升级为行动化提示；映射不到动作的 kind（hook-rejected /
 * network / dubious-ownership 等）返回 null = 保持裸 toast 零降级——按钮宁缺
 * 勿滥：给一个点了必再失败的按钮（如 diverged 直接再拉）比不给更糟。
 */

/** 服务端 hint 载荷镜像（server/git/failhint.go FailHint） */
export interface GitFailHintPayload {
  kind?: string
  detail?: string
}

export interface GitHintButton {
  /** 按钮文案 i18n 键 */
  labelKey: string
  /** 动作指令：由拦截器派发（pull/conflict 走 gitFailHint store，credentials 走设置直达） */
  run: 'pull' | 'conflict' | 'credentials'
}

export interface GitHintAction {
  /** 原因一句话 i18n 键（替代裸 toast 的原文/通用文案；原文仍留 Console 与错误中心） */
  reasonKey: string
  reasonParams?: Record<string, unknown>
  button?: GitHintButton
}

export function gitHintToastAction(hint: GitFailHintPayload | undefined | null, projectId: string | undefined): GitHintAction | null {
  if (!hint?.kind) return null
  switch (hint.kind) {
    case 'non-fast-forward':
      // push 拒（fetch first / behind）：标准修法=先拉取再推。需 projectId 才能定位拉取流
      if (!projectId) return null
      return { reasonKey: 'git.hint.nonFastForward', button: { labelKey: 'git.hint.actionPull', run: 'pull' } }
    case 'conflict':
      // 冲突态：直达冲突视图（P-44 直达先例，按钮文案复用既有 git.conflictOpen）
      if (!projectId) return null
      return { reasonKey: 'git.hint.conflict', button: { labelKey: 'git.conflictOpen', run: 'conflict' } }
    case 'authentication':
      // 认证失败：git 凭据管理在 设置→安全（CredentialList）
      return { reasonKey: 'git.hint.authentication', button: { labelKey: 'git.hint.actionCredentials', run: 'credentials' } }
    case 'diverged':
      // 分叉：合并/变基二选由仓库 pull 策略与用户意图决定，不替用户点——给指引不给按钮
      return { reasonKey: 'git.hint.diverged' }
    case 'lock':
      // 锁残留：指引文案携锁路径（服务端 detail 提取失败时回退相对名）
      return { reasonKey: 'git.hint.lock', reasonParams: { path: hint.detail || '.git/index.lock' } }
    default:
      // hook-rejected / network / dubious-ownership：无既定 UI 直达，裸 toast 不动
      return null
  }
}
