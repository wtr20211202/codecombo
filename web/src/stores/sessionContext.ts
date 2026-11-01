import { defineStore } from 'pinia'
import { ref } from 'vue'
import { settingsApi } from '../api/client'
import {
  parseSessionContext,
  type SessionContextOption,
} from '../utils/sessionContextSummary'

/**
 * 会话启动上下文（P-20261006-47）：settings 键 sessionContext（Go 白名单多选
 * git/notes/todos/env，none=全关，空串回落 git = P-176 既有默认零变化）的前端镜像。
 * env = 项目环境画像（P-20261007-14 注入源）。
 * 消费方 = ask 发起族（launchAskSession 经 useSessionContextSummary）与新建会话
 * 对话框的默认勾选——两处读同一设置，改一处两处跟随。
 *
 * 多端跟随沿 uidensity 既有机制：他端/agent 经 settings API 改值 → 服务端
 * settings.changed 广播 → OpsChannelBridge 调 load() 重读。本页改档走
 * GeneralSettings 的「保存」链（settingsApi.update），同广播回灌本 store。
 *
 * 惰性首载：store 激活不自动请求，消费方经 ensureLoaded() 兜一次（发会话是
 * 用户触发的非热路径，一次 GET 与 git 摘要的 log limit=1 现查同量级）；拉取
 * 失败保持默认档 ['git']（= 现状语义），下次广播/重启重试。
 */
export const useSessionContextStore = defineStore('session-context', () => {
  // 默认 ['git']：未加载/加载失败时的现状语义兜底
  const options = ref<SessionContextOption[]>(parseSessionContext(''))
  const loaded = ref(false)

  /** 从已 fetch 的 settings data 同步（调用方自持新鲜 settings 数据时复用，
   *  免重复请求——hydrate 即「手上有真值」，一并标记载入完成位） */
  function hydrate(data: { sessionContext?: string }) {
    options.value = parseSessionContext(data.sessionContext)
    loaded.value = true
  }

  async function load() {
    try {
      const res = (await settingsApi.get()) as unknown as { data?: { sessionContext?: string } }
      hydrate(res.data ?? {})
    } catch {
      // silent：保持默认档（= 现状），settings.changed 广播重试；放行下次
      // ensureLoaded 重试（首载失败不该永久卡死在默认档）
      loadInFlight = null
    }
  }

  // 首载去重：并发消费方共享同一次 GET（http 层 in-flight 去重之外的语义去重，
  // 免每次发会话都等一个新的 settings 往返）；已加载（load 或 hydrate）直接返回
  let loadInFlight: Promise<void> | null = null
  function ensureLoaded(): Promise<void> {
    if (loaded.value) return Promise.resolve()
    loadInFlight ??= load()
    return loadInFlight
  }

  return { options, loaded, hydrate, load, ensureLoaded }
})
