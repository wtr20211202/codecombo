import { defineStore } from 'pinia'
import { ref } from 'vue'
import { safeStorage } from '../utils/storage'

/**
 * 低特效档（P-20261125-2 S2）：远控/串流（UU、向日葵、TeamViewer、屏幕共享）与
 * 低配机上「弹层持续闪烁」的用户侧开关。开启后经根属性 `html[data-low-fx="1"]`
 * 由 styles/low-fx.css 收口：
 *   - 剩余 5 处 backdrop-filter（锁屏/命令面板/项目搜索/异常信号条 + .glass-panel
 *     兜底）去模糊，透明遮罩补实底（锁屏 alpha=1.0，防窥不降级）；
 *   - 装饰性动画逐条关闭（AppLogo 轨道/脉冲、skeleton shimmer、scanline、running
 *     状态脉冲、更新进度流动条），功能性 spinner 保留（加载反馈不能冻）；
 *   - scroll-behavior 恢复 auto（只覆盖 main.css 两处 CSS；显式 behavior:'smooth'
 *     的 6 处调用接受残余）。
 *
 * 默认关、设备本地偏好：远控是「这台机器的使用形态」，不该随账号漫游把减弱档带到
 * 真机（与 ui-zoom / graph-lanes / file-nesting 同哲学，localStorage 轨、不入设置
 * 迁移包、不进 settings API/多实例同步）。选轨登记见
 * web/src/persistence/uiStateLanes.json（ls.appearance.lowFx 行）。
 *
 * 为什么不做自动探测：宿主浏览器对 UU/串流无任何信号（UU 非 RDP，不暴露会话标记），
 * 进程探测既不可靠也越权——显式开关 + 设置页文案 + `?__lowfx=1` 零点击入口是诚实面。
 */

/** 设备本地键（localStorage 轨，`sc.<域>.<含义>` 约定） */
export const LOW_FX_STORAGE_KEY = 'sc.appearance.lowFx'

/** 根属性名（CSS 收口入口，styles/low-fx.css 全部规则以此为前缀） */
export const LOW_FX_ROOT_ATTR = 'data-low-fx'

/** 零点击入口 query 键（与现场排障同一参数：?__lowfx=1 开 / ?__lowfx=0 关） */
export const LOW_FX_QUERY_KEY = '__lowfx'

/** 出厂档：标准（低特效关）——设置行「已修改」标记的对比基准 */
export const LOW_FX_DEFAULT = false

/** 存储载荷解析：单键 JSON `{ enabled: boolean }`（file-nesting/graph-lanes 同形），脏值回落 null */
function parseStored(raw: string | null): boolean | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { enabled?: unknown }
    return typeof parsed.enabled === 'boolean' ? parsed.enabled : null
  } catch {
    // silent-by-design: 脏偏好（手改/旧格式）回退默认档，等同于未设置
    return null
  }
}

/** URL 参数解析：'1' 开 / '0' 关 / 其它（含缺省）未指定 */
export function parseLowFxQuery(value: string | null | undefined): boolean | null {
  if (value === '1') return true
  if (value === '0') return false
  return null
}

/** 仅读存储（不含 query）：apply()/store.load 的幂等来源——query 只在冷启动消费一次 */
export function readStoredLowFx(): boolean {
  return parseStored(safeStorage.getItem(LOW_FX_STORAGE_KEY)) ?? LOW_FX_DEFAULT
}

function writeLowFx(enabled: boolean): void {
  try {
    safeStorage.setItem(LOW_FX_STORAGE_KEY, JSON.stringify({ enabled }))
  } catch {
    // silent-by-design: safeStorage 自身已 try/catch + 内存兜底，本 catch 只防御
    // 序列化层意外；档位已即时生效，最坏情况是刷新后回落标准档
  }
}

/**
 * 首帧判定（themes/early-init.ts 在 Vue mount 前调用）：显式 query 优先并落盘——
 * 远控现场 `?__lowfx=1` 一键生效后，后续导航/刷新仍保持（否则一次跳转就丢档，
 * 「零点击」不成立）；用户在设置里改回标准即覆盖。无 query 回落存储。
 */
export function readLowFxEarly(search: string = typeof window !== 'undefined' ? window.location.search : ''): boolean {
  const fromQuery = parseLowFxQuery(new URLSearchParams(search).get(LOW_FX_QUERY_KEY))
  if (fromQuery !== null) {
    writeLowFx(fromQuery)
    return fromQuery
  }
  return readStoredLowFx()
}

/** 根属性落位（幂等：同值重写无副作用；无 document 环境静默跳过） */
export function applyLowFxRootAttribute(enabled: boolean): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (enabled) {
    if (root.getAttribute(LOW_FX_ROOT_ATTR) !== '1') root.setAttribute(LOW_FX_ROOT_ATTR, '1')
  } else if (root.hasAttribute(LOW_FX_ROOT_ATTR)) {
    root.removeAttribute(LOW_FX_ROOT_ATTR)
  }
}

export const useLowFxStore = defineStore('low-fx', () => {
  const enabled = ref(LOW_FX_DEFAULT)

  /** 从 safeStorage 静默重读（启动恢复 / settingsSync 跨标签回读共用，缺省回落标准档） */
  function load() {
    enabled.value = readStoredLowFx()
    applyLowFxRootAttribute(enabled.value)
  }

  /** 直存直生效（设置行即时落位；不参与脏护栏——设备本地视觉偏好，同 diffPalette 形态） */
  function setEnabled(v: boolean) {
    enabled.value = v
    writeLowFx(v)
    applyLowFxRootAttribute(v)
  }

  // store 首次激活即恢复：首屏渲染前属性与存储一致（无档位跳变）
  load()

  return { enabled, setEnabled, load }
})
