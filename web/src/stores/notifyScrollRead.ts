import { defineStore } from 'pinia'
import { ref } from 'vue'
import { safeStorage } from '../utils/storage'

// 通知滚动自动已读 store（P-20261003-260）：开启后通知中心列表滚入视口的
// 未读条目自动标已读（Slack「滚过即读」惯例），滚到底即全部已读。默认关——
// 滚过可能只是粗略扫过，保守起见不替用户清未读（opt-in 档）。
// 偏好持久化在 localStorage 而非服务端 NotificationPrefs——后端 PUT
// /notifications/prefs 是显式字段部分合并，未知字段落库即丢（同精简模式
// stores/notifySimple.ts 的既有结论）；且这是设备本地的浏览行为档位
// （条目已读态本身仍逐条经既有 readOne 同步服务端，跨端账目不受影响）
export const NOTIFY_SCROLL_READ_STORAGE_KEY = 'notify-scroll-read'

export const useNotifyScrollReadStore = defineStore('notifyScrollRead', () => {
  // 默认关（提案口径）= 不滚动的历史行为零变化；缺 key / 损坏值都按关——
  // 自动清未读是行为变更的 opt-in，fail-open 方向与「默认手动」一致
  const enabled = ref(false)

  function load() {
    enabled.value = safeStorage.getItem(NOTIFY_SCROLL_READ_STORAGE_KEY) === '1'
  }

  function set(v: boolean) {
    enabled.value = v === true
    // 开 = 落 '1'；关 = 回归默认（清 key，未来若翻转默认值自动跟随，同 notifySimple 惯例）
    if (enabled.value) safeStorage.setItem(NOTIFY_SCROLL_READ_STORAGE_KEY, '1')
    else safeStorage.removeItem(NOTIFY_SCROLL_READ_STORAGE_KEY)
  }

  load()

  return { enabled, set, load }
})
