import { defineStore } from 'pinia'
import { ref } from 'vue'
import { safeStorage } from '../utils/storage'
import { notifyUserPrefsDirty } from './userPrefsLink'

// 桌面通知精简模式 store（P-20261003-90）：开启后桌面通知仅显「新通知」占位，
// 不携带 title/body 明细——共享工位/投屏等开放环境的内容泄露面收口（部署错误
// 摘要/文件路径旁人可见的问题）。通知隐私第三档：完整（默认）/精简/锁态抑制。
// 偏好持久化在 localStorage 而非服务端 NotificationPrefs——后端 PUT
// /notifications/prefs 是显式字段部分合并，未知字段落库即丢（同免打扰时段
// stores/dnd.ts 的既有结论）；精简又是设备本地语义（只影响本浏览器的桌面弹出，
// 站内通知中心与 webhook 外发均不受影响），与 sound 等 localStorage 偏好同款
export const NOTIFY_SIMPLE_STORAGE_KEY = 'notify-simple'

export const useNotifySimpleStore = defineStore('notifySimple', () => {
  // 默认关（提案口径）= 完整内容历史现状零变化；缺 key / 损坏值都按关——
  // 精简是隐私收窄的 opt-in，fail-open 方向与「默认完整」一致
  const enabled = ref(false)

  function load() {
    enabled.value = safeStorage.getItem(NOTIFY_SIMPLE_STORAGE_KEY) === '1'
  }

  function set(v: boolean) {
    enabled.value = v === true
    // 开 = 落 '1'；关 = 回归默认（清 key，未来若翻转默认值自动跟随，同 sound.ts 惯例）
    if (enabled.value) safeStorage.setItem(NOTIFY_SIMPLE_STORAGE_KEY, '1')
    else safeStorage.removeItem(NOTIFY_SIMPLE_STORAGE_KEY)
    // 服务端漫游双写（P-20261007-1）：精简模式属「跟人走」的用户偏好（桌面
    // 弹出的内容可见性是个人隐私习惯，随账号走；站点内通知中心不受影响）
    notifyUserPrefsDirty()
  }

  load()

  return { enabled, set, load }
})
