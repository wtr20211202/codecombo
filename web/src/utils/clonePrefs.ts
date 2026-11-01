import { safeStorage } from './storage'

// 克隆对话框上次选择记忆（P-20261003-241）：多仓连续克隆（同密钥/同深度）每次
// 都要重选——SSH 密钥下拉与深度在对话框每次打开时清零。这里把两个选择持久化
// localStorage（safeStorage 通道——裸 localStorage 在屏蔽 Cookie/隐私模式下抛
// SecurityError 是既有红线），对话框打开时恢复。
// 读侧逐字段校验（loadClonePrefs）：密钥被删后的陈旧选择由调用方对账当前密钥
// 清单回落默认链，不在下拉里复活失效 id。

const STORAGE_KEY = 'clone-prefs'

/** depth 理智上限：git --depth 本身接受大值，封顶只为挡手改/脏数据撑爆输入框 */
const MAX_DEPTH = 100000

/** 持久化载荷：sshKeyId=上次选定的密钥 id（''=无记忆），depth=上次填写的深度（0=完整克隆） */
export interface ClonePrefs {
  sshKeyId: string
  depth: number
}

export function fallbackClonePrefs(): ClonePrefs {
  return { sshKeyId: '', depth: 0 }
}

function validDepth(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_DEPTH ? v : 0
}

/**
 * 读取上次选择。逐字段校验：sshKeyId 非空串保留（其存在性由调用方对账当前
 * 密钥清单——密钥删除/清单异步加载都发生在读取之后），depth 合法整数保留；
 * 任何字段不合法只回落该字段，不整档作废（useNotifyFilterPrefs 同构）
 */
export function loadClonePrefs(): ClonePrefs {
  try {
    const raw = safeStorage.getItem(STORAGE_KEY)
    if (!raw) return fallbackClonePrefs()
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return fallbackClonePrefs()
    const { sshKeyId, depth } = parsed as Record<string, unknown>
    return {
      sshKeyId: typeof sshKeyId === 'string' ? sshKeyId : '',
      depth: validDepth(depth),
    }
  } catch {
    return fallbackClonePrefs() // 非 JSON 脏数据：默认档起步，不阻断对话框
  }
}

/** 选择变更即写持久层（调用方以 watch 挂在对话框状态上） */
export function saveClonePrefs(p: ClonePrefs): void {
  safeStorage.setItem(STORAGE_KEY, JSON.stringify({ sshKeyId: p.sshKeyId, depth: validDepth(p.depth) }))
}
