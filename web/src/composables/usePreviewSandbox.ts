import { ref } from 'vue'
import { settingsApi } from '../api/domains/system'

/**
 * 预览沙箱姿态镜像（P-20261019-1）：服务端 settings 键 previewCompatMode 的
 * 前端单例镜像——false（缺省，含旧服务端缺键）= 预览 iframe 挂 sandbox 最小
 * 授权（不含 allow-same-origin，被预览页跑在不透明源，读不到主应用
 * localStorage/锁 cookie、无法同源携带凭据调 /api/*）；true = 兼容模式回落
 * 同源直挂（个别 dev app 依赖同源存储/Service Worker 时的显式选择，设置页
 * 红色警示确认后落盘）。
 *
 * 拉取时机 = 预览面板挂载（低频动作，一次 GET 与面板打开链其余取数同量级，
 * 不进热路径）；他端/agent 经 settings API 改档 → 服务端 settings.changed
 * 广播 → OpsChannelBridge 调 invalidatePreviewCompat() 重拉（invalidatePaste-
 * PrecheckCache 同款缓存失效惯例），PreviewPanel watch 姿态翻转即重载 iframe
 * ——开着的预览无须重开面板即按新姿态重建。拉取失败保持默认沙箱（安全优先），
 * 下次广播/重进面板重试。
 */

/** 当前兼容模式档位（true = 同源直挂，false = 沙箱隔离） */
export const previewCompatMode = ref(false)

let loaded = false
let fetchInFlight: Promise<void> | null = null

function fetchOnce(): Promise<void> {
  fetchInFlight ??= (settingsApi.get() as Promise<{ data?: { previewCompatMode?: boolean } }>)
    .then(res => {
      previewCompatMode.value = res?.data?.previewCompatMode === true
      loaded = true
    })
    .catch(() => {
      // 拉取失败保持默认沙箱（安全优先），置空在途标记让下次调用可重试
    })
    .finally(() => {
      fetchInFlight = null
    })
  return fetchInFlight
}

/** 面板挂载时兜一次首载（已加载直接返回，不重复请求） */
export function ensurePreviewCompatLoaded(): Promise<void> {
  if (loaded) return Promise.resolve()
  return fetchOnce()
}

/** settings.changed 广播后的缓存失效：重拉档位（多端/agent 改档即时跟随） */
export function invalidatePreviewCompat(): void {
  loaded = false
  void fetchOnce()
}
