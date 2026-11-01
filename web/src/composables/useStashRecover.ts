import { computed } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useChangesStore } from '../stores/changes'
import { useI18n } from './useI18n'
import { stashApi } from '../api/domains/git'
import { OPS_FILES_EXTERNAL_CHANGE } from '../utils/opsEvents'

/**
 * autoStash 一键恢复（P-20261006-48，通知动作族）：切回原分支的 checkout 成功
 * 响应携带 recoverableStash（服务端按 On <branch>: + auto: checkout to 双注记
 * 匹配），useBranchCheckout 据此落通知中心条目（action='stash-recover'，行内
 * 「恢复」按钮经 NotificationRow（通知中心行组件，P-20261007-23 分域拆解落点）actionInlineLabel 注册表渲染，P-140 落地基）；
 * 点击经 pendingAction 分发回本组合式，调既有 stash pop 链把变更放回工作区。
 * pop 冲突走 stashKept 同款 warning 语义（git pop 冲突不 drop，条目保留变更未丢，
 * P-20261003-203 哲学），处置出口在 stash 面板。
 */

/** stash-recover 通知 payload（useBranchCheckout 落档形态） */
export interface StashRecoverPayload {
  /** 项目 id（stash 面寻址锚） */
  projectId: string
  /** 条目归属分支（= 检出目标分支，重定位匹配键之一） */
  branch: string
  /** 条目消息（写入端确定性产物，重定位匹配键之二——前端不重复养消息前缀常量） */
  message: string
}

/** 解析 stash-recover payload（纯函数，单测锚点）：非法 JSON / 缺任一键返回
 *  null——损坏通知不可恢复，调用方就地提示（不发无效请求） */
export function parseStashRecoverPayload(raw: string): StashRecoverPayload | null {
  try {
    const v = JSON.parse(raw) as Partial<StashRecoverPayload>
    if (!v || typeof v.projectId !== 'string' || !v.projectId) return null
    if (typeof v.branch !== 'string' || !v.branch) return null
    if (typeof v.message !== 'string' || !v.message) return null
    return { projectId: v.projectId, branch: v.branch, message: v.message }
  } catch {
    return null
  }
}

export function useStashRecover() {
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useCronRetry/useAgentFix 同范式）：本组合式在 setup 期调用
  // 一次，事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  /** 通知 stash-recover 动作入口：按 branch+message 重定位条目后走既有 pop 链。
   *  通知落档时刻的 index 不直接消费——期间 pop/drop 会使栈位前移，按旧 index
   *  pop 会误吃他人条目（P-203 宁多勿丢哲学）；消息是写入端确定性产物，重拉
   *  列表按双键重定位，命中的首条即当时服务端点名的最新条目。P-20261003-264：
   *  重定位后把列表下发的 hash 一并交给 pop（稳定寻址），旧服务端无 hash 时
   *  pop 层回退 index */
  async function recoverFromNotification(payload: string): Promise<void> {
    const parsed = parseStashRecoverPayload(payload)
    if (!parsed) {
      message.error(t('git.autoStashRecoverFailed'))
      return
    }
    let hit: { index: number; hash?: string } | undefined
    try {
      const res: unknown = await stashApi.list(parsed.projectId, { silent: true })
      const list = (res as { data?: Array<{ index: number; message?: string; branch?: string; hash?: string }> })?.data || []
      const found = list.find(s => s.branch === parsed.branch && s.message === parsed.message)
      if (found) hit = { index: found.index, hash: found.hash }
    } catch { /* 列表失败按条目缺失降级，下方就地提示 */ }
    if (!hit) {
      // 条目已不在（已被恢复/手管处置/旧服务端无 branch 字段）：如实提示，不动栈
      message.info(t('git.autoStashRecoverMissing'))
      return
    }
    try {
      // silent：pop 冲突不是错误——git pop 冲突不 drop，条目保留变更未丢，
      // 走 stashKept 同款 warning 语义而非拦截器全局错误 toast
      await stashApi.pop(parsed.projectId, hit, { silent: true })
      message.success(t('git.autoStashRecoverDone', { branch: parsed.branch }))
      // 文件树/打开中的编辑器随恢复重读（useBranchCheckout 同款广播）；变更面板
      // 计数沿状态栏 focus 重拉 / 面板刷新按钮既有节奏补看
      window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE))
    } catch {
      message.warning(t('git.autoStashRecoverConflict'))
    }
    // 当前项目刚被恢复：变更树/状态栏计数就地拉齐（服务端 pop 已失效 status
    // 缓存，此处重拉即新状态；非当前项目不拉，切回时自然重读）
    const projectStore = useProjectStore()
    if (projectStore.currentProjectId === parsed.projectId) {
      void useChangesStore().fetchStatus(parsed.projectId)
    }
  }

  return { recoverFromNotification }
}
