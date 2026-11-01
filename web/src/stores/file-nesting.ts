import { defineStore } from 'pinia'
import { ref } from 'vue'
import { safeStorage } from '../utils/storage'

/**
 * 文件树同名族嵌套显示开关（P-20261006-21）：对标 VS Code explorer.fileNesting.enabled，
 * 默认关——树形态变化影响既有习惯，设置·外观自开。归组只是渲染组织层
 * （utils/fileNesting 纯函数），文件清单 API 与目录结构面不受影响。
 *
 * 每设备视觉偏好，graph-lanes 同哲学：safeStorage 自有键、不入设置迁移包
 * （utils/settingsTransfer per-device 差异不入包口径）、跨标签分发经
 * utils/settingsSync 按键寻址。
 */

/** 自有 localStorage 键：graph-lane-settings 同款隔离惯例——设置域各自独立演进 */
export const FILE_NESTING_STORAGE_KEY = 'file-nesting-settings'

export const useFileNestingStore = defineStore('file-nesting', () => {
  const enabled = ref(false)

  /** 从 safeStorage 静默重读（启动恢复 / settingsSync 跨标签回读共用，缺省回落默认关） */
  function load() {
    try {
      const saved = safeStorage.getItem(FILE_NESTING_STORAGE_KEY)
      if (saved) enabled.value = JSON.parse(saved)?.enabled === true
    } catch { /* ignore：脏值回落默认关 */ }
  }

  function setEnabled(v: boolean) {
    enabled.value = v
    try {
      safeStorage.setItem(FILE_NESTING_STORAGE_KEY, JSON.stringify({ enabled: v }))
    } catch { /* 持久化失败不阻断会话内生效（safeStorage 已兜底内存） */ }
  }

  // store 首次激活即恢复：树首帧渲染前读到已存开关（无形态跳变）
  load()

  return { enabled, setEnabled, load }
})
