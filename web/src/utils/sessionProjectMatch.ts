/**
 * 会话 ↔ 项目归属判定（P-20261005-224 项目仪表盘「会话态」卡数据面）：
 *
 * - kind='shell' 会话带 projectId 绑定（服务端创建链写入），直接按 id 判定；
 * - kind='agent' 系统会话免项目绑定（projectId=''），唯一可用线索是工作目录
 *   （创建 dir / OSC 7 追踪的 currentDir 经 sessionWorkingDir 回落）——「在项目
 *   根或其子目录里跑的 agent 会话」计为该项目会话，与「交给智能体修复/任务
 *   模板」等从项目发起的链（dir=项目根）天然对上。
 *
 * 路径比较只归一分隔符方向（两侧字符串都来自同一服务端：project.path 注册值
 * 与会话创建 dir 原样传递），**不做大小写折叠**——那是 Windows 专属假设（前端
 * 全平台纪律禁用）；大小写不一致的极端输入宁漏不计（「宁缺毋谎」口径，与
 * numstat 未覆盖文件不出行数同哲学）。
 */
import { sessionWorkingDir } from '../stores/terminal-sessions'

/** 归一路径：反斜杠统一为正斜杠 + 去尾部斜杠（win/posix 两侧都成立） */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

export interface SessionLike {
  id: string
  kind: string
  projectId: string
  currentDir?: string
  path?: string
}

/**
 * 会话是否属于项目：
 * @param projectId 项目的注册 id（kind='shell' 判定依据）
 * @param projectPath 项目根绝对路径（kind='agent' 目录判定依据；空串跳过目录判定）
 */
export function sessionBelongsToProject(s: SessionLike, projectId: string, projectPath: string): boolean {
  if (!s) return false
  if (s.kind === 'shell') return !!s.projectId && s.projectId === projectId
  if (s.kind !== 'agent') return false
  const root = normalizePath(projectPath || '')
  const dir = normalizePath(sessionWorkingDir(s))
  if (!root || !dir) return false
  return dir === root || dir.startsWith(root + '/')
}
