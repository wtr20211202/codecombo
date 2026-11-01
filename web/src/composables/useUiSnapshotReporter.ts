import { getCurrentScope, onScopeDispose, watch } from 'vue'
import { useDebounceFn } from '@vueuse/core'
import { useProjectStore } from '../stores/project'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { usePanelLayout } from './usePanelLayout'
import { useEditorNavHistory } from './useEditorNavHistory'
import { settingsApi, uiSnapshotApi } from '../api/domains/system'
import { OPS_SETTINGS_CHANGED } from '../utils/opsEvents'
import { buildUiSnapshot, uiSnapshotEquals } from '../utils/uiSnapshot'
import type { UiSnapshotPayload, UiSnapshotSource } from '../api/domains/system'

/**
 * 用户 UI 现场上报器（P-20261004-52）：把各 store 的「用户此刻在看什么」低频
 * POST 到 /api/ui/snapshot，agent 读取实现「看着问」。调度语义：
 *
 * - 显著变化去抖 2s（尾沿）：活跃文件/行、面板开合、活跃终端会话、激活项目
 *   任一变化即重排 2s 尾沿计时器——连续光标移动只在停下来 2s 后落一次盘；
 * - 60s 心跳：与变化无关强制上报一拍，刷新服务端 TTL（10 分钟无心跳即查无，
 *   浏览器关闭/休眠断拍自然过期，陈旧现场宁缺勿错）；
 * - 相等短路：去抖到期后与上次已上报载荷深比较，相同则不 POST（稳态零请求，
 *   心跳是唯一的稳态流量）；
 * - 隐藏页不上报：多标签页竞争 MVP 最后写入优先，但后台标签页的 setInterval
 *   会被浏览器节流到分钟级且携带本页陈旧视图，仍会与可见页交替覆写——
 *   document.hidden 直接跳过 = 可见页胜（「现场」语义下唯一合理裁决）；
 * - 开关门控：settings.uiSnapshotEnabled（默认开）挂载时读一次，
 *   settings.changed 广播重读（设置页翻转即时停/复上报，无需重进项目页）；
 * - 全程静默：现场是尽力而为的旁路面，失败保旧等下一拍，不走全局错误 toast。
 *
 * 宿主：useLayoutShell（项目页 Layout）——现场数据源都在 shell 作用域内存里；
 * Layout 卸载（实例切换）即停表停听，重挂重新开始。本 composable 非 store：
 * 每次调用独立实例，但 Layout 同一时刻至多一个（同 useChangeStream 论证）。
 */

/** 显著变化去抖窗口（ms）：显著 = 文件/行/面板/会话/项目任一维度变化 */
export const UI_SNAPSHOT_DEBOUNCE_MS = 2000
/** 心跳周期（ms）：远小于服务端 TTL（10 分钟），容忍丢拍 */
export const UI_SNAPSHOT_HEARTBEAT_MS = 60_000

/** 现场签名（去抖触发的比较键）：显式拼接而非 JSON——光标移动级热路径上
 *  避免每次分配序列化中间结构，一次模板串拼接足够 */
function sourceSignature(s: UiSnapshotSource): string {
  return [
    s.activeProjectId, s.activeFilePath, s.activeFileLine, s.activeFileColumn ?? 0,
    s.side, s.sideOpen ? 1 : 0, s.bottom, s.bottomOpen ? 1 : 0, s.activeTerminalSessionId,
  ].join('|')
}

export interface UiSnapshotReporter {
  /** 停表停听（onScopeDispose 兜底；测试/手动停止用） */
  stop: () => void
  /** 最近一次成功上报的载荷（测试观察位；尚未上报为 null） */
  getLastSent: () => UiSnapshotPayload | null
}

export function startUiSnapshotReporter(): UiSnapshotReporter {
  const projectStore = useProjectStore()
  const layout = usePanelLayout()
  const navHistory = useEditorNavHistory()
  const sessionsStore = useTerminalSessionsStore()

  // 开关门控：默认开（与服务端缺省一致），settings 读取失败也按开处理——
  // 读取失败是瞬时网络问题，不该连带停掉整个上报面
  let enabled = true
  async function refreshEnabled(): Promise<void> {
    try {
      const res = (await settingsApi.get()) as unknown as { data?: { uiSnapshotEnabled?: boolean } }
      enabled = res.data?.uiSnapshotEnabled !== false
    } catch {
      enabled = true
    }
  }
  void refreshEnabled()

  function currentSource(): UiSnapshotSource {
    const loc = navHistory.activeLocation.value
    return {
      activeProjectId: projectStore.currentProjectId || '',
      activeFilePath: loc?.path || '',
      activeFileLine: loc?.line || 0,
      activeFileColumn: loc?.column,
      side: layout.sideView.value,
      sideOpen: layout.showSidePanel.value,
      bottom: layout.bottomTab.value,
      bottomOpen: layout.showBottomPanel.value,
      activeTerminalSessionId: sessionsStore.activeId,
    }
  }

  let lastSent: UiSnapshotPayload | null = null
  let inFlight = false
  async function flush(force: boolean): Promise<void> {
    if (!enabled || inFlight) return
    if (typeof document !== 'undefined' && document.hidden) return
    const payload = buildUiSnapshot(currentSource())
    // 心跳（force=true）跳过相等短路：与变化无关地刷新服务端 TTL
    if (!force && uiSnapshotEquals(payload, lastSent)) return
    inFlight = true
    try {
      await uiSnapshotApi.put(payload)
      lastSent = payload
    } catch {
      /* 静默保旧：下一拍/下一次变化再试 */
    } finally {
      inFlight = false
    }
  }

  const debouncedFlush = useDebounceFn(() => { void flush(false) }, UI_SNAPSHOT_DEBOUNCE_MS)

  // 变化驱动：任一维度变化 → 重排 2s 尾沿。immediate 覆盖挂载首报
  //（boot 恢复布局落定后的初始现场 2s 内落盘）
  const stopWatch = watch(
    () => sourceSignature(currentSource()),
    () => debouncedFlush(),
    { immediate: true },
  )

  // 心跳驱动：强制上报刷新 TTL
  const timer = setInterval(() => { void flush(true) }, UI_SNAPSHOT_HEARTBEAT_MS)

  // 设置开关即时生效：设置页翻转 → settings.changed 广播 → 重读
  const onSettingsChanged = () => { void refreshEnabled() }
  window.addEventListener(OPS_SETTINGS_CHANGED, onSettingsChanged)

  function stop(): void {
    stopWatch()
    clearInterval(timer)
    window.removeEventListener(OPS_SETTINGS_CHANGED, onSettingsChanged)
  }
  if (getCurrentScope()) onScopeDispose(stop, true)

  return {
    stop,
    getLastSent: () => lastSent,
  }
}
