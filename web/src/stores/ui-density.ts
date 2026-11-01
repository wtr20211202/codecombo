import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { settingsApi } from '../api/client'

/**
 * 界面密度档（P-20261003-322）：compact（紧凑）/ comfortable（舒适，默认 =
 * 历史现状零变化）。落服务端 settings（uidensity 键，Go 白名单两档），agent 可
 * 经 settings API 惯例化调整，变更经 settings.changed 广播多端跟随。
 *
 * CSS 侧令牌约定（唯一注入点 = 本 store 的 apply，其余面只读变量）：
 * - `--row-h`   固定行高单行列表（文件树 / 变更树 .cp-node），虚拟列表 itemSize
 *               与之同源（useVirtualList 不支持响应式 itemHeight，函数形态 +
 *               watch 补触发，见 FileTreeView/CommitPanel）
 * - `--row-pad-y` 内容自适应行的纵向 padding 基准（会话列表 / 通知中心，
 *               后者 calc(+2px) 保持与历史 8px 对齐）
 * - `--fs-meta-min` 元信息可读性下限（P-20261019-3）：舒适档 11.5px（main.css
 *               :root 缺省，不注入）守可读下限，紧凑档注入 10.5px 保密度。
 *               使用点以 max(下限, em 期望值) 组合，随用户界面字号缩放。
 * 舒适档**不注入任何变量**——各使用点 fallback 即历史值，构造性零回归；
 * 紧凑档注入 22px / 3px。切回舒适档移除注入（而非写 26px），避免对自然行高
 * 面板（.tree-item 无显式行高）造成像素级漂移。
 */

export type UiDensity = 'comfortable' | 'compact'

/** 两档行高 token 值：虚拟列表 itemSize 与 CSS 注入同一事实源 */
export const UI_DENSITY_ROW_H: Record<UiDensity, number> = { comfortable: 26, compact: 22 }
/** 紧凑档自适应行的纵向 padding 基准（舒适档 6px/8px 为各面历史值，不注入） */
const COMPACT_ROW_PAD_Y = '3px'
/** 紧凑档元信息字号下限（舒适档 11.5px 为 main.css :root 缺省，不注入） */
const COMPACT_FS_META_MIN = '10.5px'

export const UI_DENSITY_DEFAULT: UiDensity = 'comfortable'

export const useUiDensityStore = defineStore('ui-density', () => {
  const density = ref<UiDensity>(UI_DENSITY_DEFAULT)

  // 虚拟列表 itemSize 消费的数值行高（computed 随档位联动）
  const rowHeightPx = computed(() => UI_DENSITY_ROW_H[density.value])

  function apply() {
    const root = document.documentElement.style
    if (density.value === UI_DENSITY_DEFAULT) {
      root.removeProperty('--row-h')
      root.removeProperty('--row-pad-y')
      root.removeProperty('--fs-meta-min')
    } else {
      root.setProperty('--row-h', `${rowHeightPx.value}px`)
      root.setProperty('--row-pad-y', COMPACT_ROW_PAD_Y)
      root.setProperty('--fs-meta-min', COMPACT_FS_META_MIN)
    }
  }

  // 从已 fetch 的 settings data 同步状态（避免调用方重复请求 /settings）
  function hydrate(data: { uidensity?: string }) {
    density.value = data.uidensity === 'compact' ? 'compact' : UI_DENSITY_DEFAULT
    apply()
  }

  async function load() {
    try {
      const res = (await settingsApi.get()) as unknown as { data?: { uidensity?: string } }
      hydrate(res.data ?? {})
    } catch {
      // silent: 保持默认档（= 现状），下次 settings.changed 广播重试
    }
  }

  // 乐观更新 + 失败回滚（terminal-theme store persistField 同款约定）
  async function setDensity(v: UiDensity): Promise<boolean> {
    const old = density.value
    density.value = v
    apply()
    try {
      await settingsApi.update({ uidensity: v })
      return true
    } catch (e) {
      console.error('[ui-density] persist failed, rollback', e)
      density.value = old
      apply()
      return false
    }
  }

  // store 首次激活即应用当前档位：默认舒适档零注入（= 现状，无首帧跳变）
  apply()

  return { density, rowHeightPx, load, hydrate, setDensity }
})
