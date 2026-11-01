/**
 * 会话 × 项目硬锁归属判定（P-20261004-143，终端域锁徽标的数据面）：
 * 判定「这个终端会话是否落在锁定项目内」——徽标是提示不是阻断（锁的 API 面
 * 已由服务端 ProjectHardLock 守卫承担；shell 直写不经 API，徽标只负责让存量
 * 终端「知道自己所在项目已锁」，消除「锁了就真动不了」的误信）。
 *
 * 归属判定两岔，与 CreateTerminal 守卫同取向（server/api/terminal/terminal.go
 * 的 lockedProjectForDir）：
 * - 会话带 projectId（shell 项目会话）：绑定即创建时登记的权威归属，按 id
 *   直查项目锁态；
 * - 无 projectId（agent 系统会话）：按会话工作目录对锁定项目路径做包含判定
 *   （sessionWorkingDir 收口：OSC 7 实时 cwd 优先、创建 dir 兜底），目录包含
 *   复用 isPathUnderPath（Windows 形态大小写不敏感，与服务端 lockedProjectForDir
 *   的大小写折叠同取向）。前端无 EvalSymlinks——软链目录降级为字面包含判定
 *   （宁缺勿滥，不误标）。
 * 归属不明（无 projectId 且无 dir）一律 false：不显示徽标，也不虚构归属。
 */
import { isPathUnderPath } from '../composables/useTerminalFileLinks'

/** 判定输入的项目最小面（Project 的结构化子集，宿主直接传 store.projects） */
export interface LockBadgeProject {
  id: string
  path: string
  locked?: boolean
}

/** 会话最小面：TerminalSessionInfo / AgentTermSession / TermTab 三种视图形状
 *  的公共子集（projectId 可选——agent 会话免项目绑定；dir 用可选双字段承接
 *  currentDir/path，由 sessionWorkingDir 同口径取值） */
export interface LockBadgeSession {
  projectId?: string
  currentDir?: string
  path?: string
}

/** 会话是否落在任一锁定项目内（锁定项目清单为空时零循环早退） */
export function isSessionInLockedProject(
  session: LockBadgeSession,
  projects: LockBadgeProject[],
): boolean {
  if (session.projectId) {
    return projects.some(p => p.id === session.projectId && p.locked === true)
  }
  const dir = session.currentDir || session.path || ''
  if (!dir) return false
  return projects.some(p => p.locked === true && !!p.path && isPathUnderPath(dir, p.path))
}
