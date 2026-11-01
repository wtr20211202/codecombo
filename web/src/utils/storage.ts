// 安全存储包装：localStorage/sessionStorage 在"屏蔽所有 Cookie"/部分隐私
// 模式下属性访问即抛 SecurityError，启动链路（主题/i18n/锁存取）裸访问会
// 直接白屏。这里统一 try/catch + 内存 Map 兜底——存取失败时功能降级为
// 会话内生效，绝不阻断应用启动或请求链路。

const memory = new Map<string, string>()
const sessionMemory = new Map<string, string>()

function safeLocal(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function safeSession(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export const safeStorage = {
  /** 读 localStorage；不可用/未设置返回 null */
  getItem(key: string): string | null {
    const s = safeLocal()
    if (s) {
      try {
        return s.getItem(key)
      } catch {
        /* 落内存兜底 */
      }
    }
    return memory.has(key) ? (memory.get(key) as string) : null
  },

  /** 写 localStorage；不可用/超额时内存兜底（会话内生效） */
  setItem(key: string, value: string): void {
    const s = safeLocal()
    if (s) {
      try {
        s.setItem(key, value)
        return
      } catch {
        /* QuotaExceeded / 隐私模式：落内存 */
      }
    }
    memory.set(key, value)
  },

  /** 删除 localStorage 键；不可用时同时清内存兜底 */
  removeItem(key: string): void {
    const s = safeLocal()
    if (s) {
      try {
        s.removeItem(key)
      } catch {
        /* 忽略 */
      }
    }
    memory.delete(key)
  },

  /** 读 sessionStorage；不可用/未设置返回 null */
  sessionGet(key: string): string | null {
    const s = safeSession()
    if (s) {
      try {
        return s.getItem(key)
      } catch {
        return null
      }
    }
    return sessionMemory.has(key) ? (sessionMemory.get(key) as string) : null
  },

  /** 写 sessionStorage；不可用时静默丢弃（会话数据丢失可接受） */
  sessionSet(key: string, value: string): void {
    const s = safeSession()
    if (s) {
      try {
        s.setItem(key, value)
      } catch {
        /* 忽略 */
      }
    } else {
      sessionMemory.set(key, value)
    }
  },

  /** 删除 sessionStorage 键 */
  sessionRemove(key: string): void {
    const s = safeSession()
    if (s) {
      try {
        s.removeItem(key)
      } catch {
        /* 忽略 */
      }
    }
    sessionMemory.delete(key)
  },
}
