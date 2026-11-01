// 能力探测缓存（P-20261004-4）：GET /api/meta 按实例维度缓存 + hasCap 同步探测。
//
// 多实例异版本是真实部署拓扑：前端经 /proxy 打到的是对端服务，旧对端无新端点
// 必 404。约定调用方在走「新版端点快路径」前先 `await ensureCaps()` 再
// `hasCap(name)` 分流——未声明/探测失败一律 false 走旧版兼容路径，既有 404
// 回退逻辑保留兜底（能力清单与路由漂移时不失能）。能力项名随服务端模块
// manifest 声明（kernel.Manifest.Capabilities），对账门禁在
// server/app/meta_conformance_test.go。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { getCurrentInstanceContext } from '@/api/client'
import { metaApi } from '@/api/domains/system'
import type { MetaVersion } from '@/api/domains/system'

/** 已投用的能力项名（hasCap 实参统一走这里，防手写字符串与服务端漂移） */
export const CAP_AHEAD_BEHIND_ALL = 'ahead-behind-all'
export const CAP_FLAT_FILE_LIST = 'flat-file-list'
export const CAP_WATCH_FALLBACK = 'watch-fallback'

/** 实例缓存键：本机（无实例上下文）归一为 'local' */
function instanceKey(): string {
  return getCurrentInstanceContext().instanceId || 'local'
}

export const useMetaStore = defineStore('meta', () => {
  /** 实例维度能力清单缓存：key → capabilities（空数组 = 探测过但无能力/失败） */
  const capsByInstance = ref<Record<string, string[]>>({})
  /** 实例维度版本缓存（诊断用；能力清单旁路信息） */
  const versionByInstance = ref<Record<string, MetaVersion | undefined>>({})
  // in-flight 去重：并发 ensureCaps 同一实例只发一次（非响应式即可）
  const inflight = new Map<string, Promise<void>>()

  /** 拉取并缓存当前实例上下文的 /api/meta（幂等，失败按无能力处理且本页
   *  周期内不重试——探测失败的代价只是走保守旧路径，无功能损伤） */
  async function ensureCaps(): Promise<void> {
    const key = instanceKey()
    if (capsByInstance.value[key] || inflight.has(key)) {
      await inflight.get(key)
      return
    }
    const p = (async () => {
      try {
        // /api/meta 公开只读，silent：探测失败不打扰用户（旧对端 404 属预期）
        const res = await metaApi.get({ silent: true })
        capsByInstance.value[key] = res?.capabilities || []
        versionByInstance.value[key] = res?.version
      } catch {
        capsByInstance.value[key] = []
      } finally {
        inflight.delete(key)
      }
    })()
    inflight.set(key, p)
    await p
  }

  /** 当前实例上下文是否声明了能力项。未拉取/未声明/探测失败一律 false
   *  （调用方先 await ensureCaps() 再读；false 走旧版兼容路径） */
  function hasCap(name: string): boolean {
    return (capsByInstance.value[instanceKey()] || []).includes(name)
  }

  return { capsByInstance, versionByInstance, ensureCaps, hasCap }
})
