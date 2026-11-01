import { safeStorage } from './storage'

// 项目终端「记住每个项目的激活 tab」：localStorage 持久化（单键 JSON 映射）。
// 刷新重连 / 实例切换 / 解锁 / 项目切换时恢复用户离开时所在的 tab，
// 而不是永远落到项目的最后一个。
// tab id 即服务端会话 id（tmux/PTY 持久），跨刷新稳定可引用；已被关闭的
// 会话 id 残留无害——恢复方校验 tab 存在后才使用，否则回退最后一个。
const KEY = 'sc.term.activeTabMap'

type ActiveTabMap = Record<string, string>

function readMap(): ActiveTabMap {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as ActiveTabMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 激活 tab 变化时记录（projectId → tabId） */
export function rememberActiveTab(projectId: string, tabId: string): void {
  if (!projectId || !tabId) return
  const m = readMap()
  if (m[projectId] === tabId) return
  m[projectId] = tabId
  safeStorage.setItem(KEY, JSON.stringify(m))
}

/** 取项目记忆的激活 tab id（无记忆返回 ''，调用方须校验 tab 仍存在） */
export function recallActiveTab(projectId: string): string {
  if (!projectId) return ''
  return readMap()[projectId] ?? ''
}
