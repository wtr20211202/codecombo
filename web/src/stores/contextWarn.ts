import { defineStore } from 'pinia'
import { ref } from 'vue'
import { safeStorage } from '../utils/storage'
import { LOW_REMAINING_PCT } from '../utils/sessionRelay'

// 上下文警示阈值 store（P-20261006-33）：「上下文将满」警示与活跃行接力放开
// 的低余量判定线（utils/sessionRelay.isLowRemaining 第二参注入）。接力换代的
// 最佳时机因任务类型而异——长写作/重构会话调高阈值（如 20%）给尾部结论生成
// 留余量，长编译会话维持出厂 10% 即可；属个人工作习惯而非项目语义，落
// localStorage 设备本地（uiFont/notify-simple 等 P-69 同口径），不入服务端
// settings、不进「保存」链（滑条直写即时生效，见 GeneralSettings 直写行惯例）。
// STORAGE_KEY 导出（同 dnd.ts NOTIFY_* 惯例）：e2e 播种设备本地偏好用
export const CONTEXT_WARN_STORAGE_KEY = 'ctx-warn-pct'

/** 档位边界（提案口径 5-30%）：上限保守——阈值过高（30%）警示频繁造成疲劳 */
export const CONTEXT_WARN_MIN = 5
export const CONTEXT_WARN_MAX = 30

export const useContextWarnStore = defineStore('contextWarn', () => {
  const pct = ref(LOW_REMAINING_PCT)

  function load() {
    const raw = Number(safeStorage.getItem(CONTEXT_WARN_STORAGE_KEY))
    // 缺 key / 非数 / 越界一律回落出厂档：手改 localStorage 与旧版本残留值
    // 都不会把警示打歪（fail-closed 到与 P-141 现行为一致）
    pct.value = Number.isFinite(raw) && raw >= CONTEXT_WARN_MIN && raw <= CONTEXT_WARN_MAX
      ? raw
      : LOW_REMAINING_PCT
  }

  function set(v: number) {
    const n = Math.round(Number(v))
    // 越界钳制在档位内；回到出厂档清 key（未来翻转缺省值自动跟随，同 sound.ts 惯例）
    pct.value = Math.min(CONTEXT_WARN_MAX, Math.max(CONTEXT_WARN_MIN, Number.isFinite(n) ? n : LOW_REMAINING_PCT))
    if (pct.value === LOW_REMAINING_PCT) safeStorage.removeItem(CONTEXT_WARN_STORAGE_KEY)
    else safeStorage.setItem(CONTEXT_WARN_STORAGE_KEY, String(pct.value))
  }

  load()

  return { pct, set, load }
})
