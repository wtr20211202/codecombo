import { defineStore } from 'pinia'
import { ref } from 'vue'
import i18n from '../i18n'
import type { NotificationItem } from '../api/client'
import { safeStorage } from '../utils/storage'
import {
  isWithinDnd,
  isExcepted,
  isManualDndActive,
  DND_EXCEPTION_DEFAULTS,
  DND_EXCEPTION_CATEGORIES,
  type DndWindow,
  type ManualDndUntil,
} from '../utils/dndSchedule'
import { useNotificationStore } from './notification'
import { notifyUserPrefsDirty } from './userPrefsLink'

// 全局 t 函数（store 在 setup 外，无法用 useI18n composable；同 notification.ts 惯例）
const t = (key: string, params?: Record<string, unknown>) => i18n.global.t(key, params as never)

// 通知免打扰时段 store（P-20261002-40）：偏好持久化在 localStorage 而非服务端
// NotificationPrefs——后端 PUT /notifications/prefs 是显式字段部分合并，未知字段
// 落库即丢，免打扰又是设备本地语义（桌面通知/本地时区都跟着浏览器走），与
// font/keymap 等 localStorage 偏好同款持久化方式
const STORAGE_KEY = 'notify-dnd'
// localStorage key 导出（同 lock.ts UNLOCK_TOKEN_KEY 惯例）：e2e 播种设备本地
// 偏好时 import 常量，避免字面量散落导致漂移
export const DND_STORAGE_KEY = STORAGE_KEY

// 手动临时免打扰（P-20261003-227）独立落盘键：与时段偏好分键而非并入 notify-dnd
// ——设置弹窗的 localDnd 编辑副本/isDirty 深比较只覆盖时段字段，手动档是即时
// 生效面（不随「保存」落地），分键让两条写路径互不可见，避免设置保存误清手动档
const MANUAL_STORAGE_KEY = 'notify-dnd-manual'
export const DND_MANUAL_STORAGE_KEY = MANUAL_STORAGE_KEY

export const DND_DEFAULTS: DndWindow = { enabled: false, start: '22:00', end: '08:00', exceptError: true }

// 例外类别归一化（P-20261003-115）：非数组（含旧落盘数据无该字段）补默认值
//（审批等待默认穿透——升级既有配置即获得新能力，无需清数据）；只保留全集内的
// 值，损坏/外来值不进偏好（与 UI 多选选项集一致，防 n-select 渲染出裸值标签）
function normalizeExcept(v: unknown): string[] {
  if (!Array.isArray(v)) return [...DND_EXCEPTION_DEFAULTS]
  const known = DND_EXCEPTION_CATEGORIES as readonly string[]
  return v.filter((x): x is string => typeof x === 'string' && known.includes(x))
}

// error 级穿透开关归一化（P-20261004-117）：仅显式 false 视为关——旧落盘数据
// 无该字段（undefined）按默认开处理（升级既有配置即获得警报可达性，无需清数据；
// 与 normalizeExcept 同款向后兼容读取），损坏值（字符串/数字）同归一为开
function normalizeExceptError(v: unknown): boolean {
  return v !== false
}

export const useDndStore = defineStore('notifyDnd', () => {
  const prefs = ref<DndWindow>({ ...DND_DEFAULTS, except: [...DND_EXCEPTION_DEFAULTS], exceptError: true })
  // 手动临时档状态（P-20261003-227）：null 关 / 0 直到手动关 / >0 到期时刻 ms
  const manualUntil = ref<ManualDndUntil>(null)
  // 到期自动恢复定时器（会话内句柄，非响应式）：enableManual 重排前先清旧，
  // 防旧回调清掉新开启的档。后台标签页定时器会被浏览器节流（最深约 1 分钟档），
  // 只延迟「恢复通知」的入账时刻——静默判定本身是 isSilenced 按挂钟实时对账
  //（manualUntil > now），到期后新通知不会被误吞
  let expiryTimer: ReturnType<typeof setTimeout> | null = null

  function load() {
    try {
      const raw = safeStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<DndWindow>
        prefs.value = {
          enabled: parsed.enabled === true,
          start: typeof parsed.start === 'string' && parsed.start ? parsed.start : DND_DEFAULTS.start,
          end: typeof parsed.end === 'string' && parsed.end ? parsed.end : DND_DEFAULTS.end,
          except: normalizeExcept(parsed.except),
          exceptError: normalizeExceptError(parsed.exceptError),
        }
      }
    } catch { /* 损坏数据回退默认 */ }
    // 手动档独立键随 load 一并恢复（P-20261003-227）——注意不可放在 prefs 的
    // `if (!raw) return` 之后（无时段偏好的全新环境也要恢复手动档）
    loadManual()
  }

  function set(w: DndWindow) {
    prefs.value = {
      enabled: w.enabled === true,
      start: typeof w.start === 'string' && w.start ? w.start : DND_DEFAULTS.start,
      end: typeof w.end === 'string' && w.end ? w.end : DND_DEFAULTS.end,
      except: normalizeExcept(w.except),
      exceptError: normalizeExceptError(w.exceptError),
    }
    safeStorage.setItem(STORAGE_KEY, JSON.stringify(prefs.value))
    // 服务端漫游双写（P-20261007-1）：时段偏好属「跟人走」的用户偏好，镜像
    // 照旧落 localStorage，上云经 userPrefsLink 交给 userPrefs store 编排
    notifyUserPrefsDirty()
  }

  // ---- 手动临时档（P-20261003-227） ----

  function persistManual(): void {
    if (manualUntil.value === null) safeStorage.removeItem(MANUAL_STORAGE_KEY)
    else safeStorage.setItem(MANUAL_STORAGE_KEY, JSON.stringify({ until: manualUntil.value }))
  }

  function clearExpiryTimer(): void {
    if (expiryTimer !== null) {
      clearTimeout(expiryTimer)
      expiryTimer = null
    }
  }

  /** 到期自动恢复：清状态 + 落盘 + 通知中心入账本地告知（addLocal 纯前端条目，
   * 与「后端已重连」同通道——手动档是设备本地语义，不过服务端）。期间状态被
   * 改写（重开/手动关）则本次回调失效（按值比对，句柄唯一不会串档） */
  function scheduleExpiry(until: ManualDndUntil): void {
    clearExpiryTimer()
    if (until === null || until <= 0) return
    expiryTimer = setTimeout(() => {
      expiryTimer = null
      if (manualUntil.value !== until) return
      manualUntil.value = null
      persistManual()
      useNotificationStore().addLocal({
        type: 'info',
        category: 'system',
        title: t('notify.dndManual.expiredTitle'),
        body: t('notify.dndManual.expiredBody'),
      })
    }, Math.max(0, until - Date.now()))
  }

  function loadManual(): void {
    try {
      const raw = safeStorage.getItem(MANUAL_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as { until?: unknown }
      if (typeof parsed.until !== 'number' || !Number.isFinite(parsed.until) || parsed.until < 0) return
      const until = parsed.until as ManualDndUntil
      // 离线/关页期间已到期的档：静默清账不补发通知（挂钟已过到期点，isSilenced
      // 本就不会静默，这里只做持久层卫生；补发「已结束」属启动期噪声）
      if (until !== null && until > 0 && until <= Date.now()) {
        safeStorage.removeItem(MANUAL_STORAGE_KEY)
        return
      }
      manualUntil.value = until
      scheduleExpiry(until)
    } catch { /* 损坏数据按关处理 */ }
  }

  /** 开启手动临时免打扰：durationMs > 0 → 到期自动恢复（快速档 1 小时）；
   * 缺省/0 → 直到手动关（无到期哨兵 0，JSON 安全）。即时生效（不入设置弹窗
   * 的暂存面——分钟窗规则走「保存」，临时档是即时需求走即改即生效） */
  function enableManual(durationMs = 0): void {
    manualUntil.value = durationMs > 0 ? Date.now() + durationMs : 0
    persistManual()
    scheduleExpiry(manualUntil.value)
  }

  /** 手动关闭临时档（含到期前的主动解除） */
  function disableManual(): void {
    if (manualUntil.value === null) return
    manualUntil.value = null
    persistManual()
    clearExpiryTimer()
  }

  /** 当前是否处于免打扰（生效点统一入口；now 可注入供测试）。时段规则与手动
   * 临时档 OR 组合（P-20261003-227：任一生效即静默）。category 可选
   * （P-20261003-115）：调用方携带通知类别时先查例外表，命中穿透（返回不静默
   * ——例外表在两源之上统一判定，审批等待对手动档同样穿透）；无类别的调用点
   * （ops-notify toast 等无归属消息）不参与例外，维持整体静默。type 可选
   * （P-20261004-117）：error 级穿透勿扰仍提醒（夜间值守的警报可达性——勿扰
   * 滤的是噪声不是警报），与类别例外同为两源之上的统一豁免；开关可关
   *（exceptError=false，绝对静默是合法偏好）。不携带 type 的调用点不参与
   * 豁免（维持整体静默），调用方语义：「我确知这条的通知分级」 */
  function isSilenced(category?: string, type?: NotificationItem['type'], now = new Date()): boolean {
    if (category !== undefined && isExcepted(prefs.value, category)) return false
    if (type === 'error' && prefs.value.exceptError) return false
    if (isManualDndActive(manualUntil.value, now.getTime())) return true
    return isWithinDnd(prefs.value, now)
  }

  load()

  return {
    prefs, set, load,
    manualUntil, enableManual, disableManual,
    isSilenced,
  }
})
