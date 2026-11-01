import { defineStore } from 'pinia'
import { ref } from 'vue'
import { safeStorage } from '../utils/storage'
import { notifyUserPrefsDirty } from './userPrefsLink'

// 审批/提问等待音效开关 store（P-20261003-33）：偏好持久化在 localStorage 而非
// 服务端 NotificationPrefs——后端 PUT /notifications/prefs 是显式字段部分合并，
// 未知字段落库即丢（同免打扰时段 stores/dnd.ts 的既有结论）；音效又是设备本地
// 语义（浏览器音频能力/系统音量都跟着浏览器走），与 font/keymap 等 localStorage
// 偏好同款持久化方式
export const SOUND_STORAGE_KEY = 'notify-sound'

export const useSoundStore = defineStore('notifySound', () => {
  // 默认开（提案口径）：缺 key / 损坏值都按开——音效是旁路注意通道，fail-open
  // 与免打扰时段判定的 fail-open（判不出就不静默）同向：宁可打扰不可漏报
  const enabled = ref(true)

  function load() {
    enabled.value = safeStorage.getItem(SOUND_STORAGE_KEY) !== '0'
  }

  function set(v: boolean) {
    enabled.value = v === true
    // 开 = 回归默认（清 key，未来若翻转默认值自动跟随）；关 = 落 '0'
    if (enabled.value) safeStorage.removeItem(SOUND_STORAGE_KEY)
    else safeStorage.setItem(SOUND_STORAGE_KEY, '0')
    // 服务端漫游双写（P-20261007-1）：等待音效属「跟人走」的用户偏好
    notifyUserPrefsDirty()
  }

  load()

  return { enabled, set, load }
})
