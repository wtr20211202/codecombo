/**
 * git 面板挂载期外部变更感知——focus/编辑器视图切回静默重取（P-20261004-39）：
 * GitPanel 挂载持续期间仓库可被产品 API 之外的手段修改（agent 会话在另一视图跑
 * git、外部 IDE 双开、终端 CLI），面板零感知——branch.changed/file.changed 只覆盖
 * 经产品 API 的操作，sc:git-panel-autorefresh 三感知链（P-20261003-74/81/7）只覆盖
 * 本产品终端会话；bottomTab 切走再切回由 BottomPanel 的 v-if 重挂载天然重取，盲区
 * 恰在挂载持续期间。本件只管「>10s 节流」这一件事：触发源（window focus /
 * visibilitychange(visible) / 主区编辑器视图切回 / 底部面板 v-show 重开）由宿主
 * GitPanel 接线，命中即 maybeRefresh()——距上次拉取不足间隔则跳过，防连续触发
 * 密集重取；宿主其他链路（手动刷新按钮/挂载首拉）完成同等拉取后 markRefreshed()
 * 对齐窗口。拉取本体复用宿主既有 refreshingRefs 互斥与子面板 refresh 链（静默、
 * 无 toast、列表原地替换不扰滚动/展开态），与本件正交。
 */

/** 节流间隔：与「切走再切回才重取」的既有节奏对齐——外部变更多为 agent 作业
 *  收尾形态，10s 足以挡掉连续 focus/视图往返的冗余拉取，又不至于滞旧可感 */
export const GIT_PANEL_FOCUS_REFRESH_MIN_INTERVAL_MS = 10_000

export function useGitPanelFocusRefresh(
  refresh: () => unknown,
  minIntervalMs: number = GIT_PANEL_FOCUS_REFRESH_MIN_INTERVAL_MS,
) {
  let lastRefreshAt = 0

  /** 宿主完成同等数据拉取后调用：把节流窗口起点对齐到该时刻 */
  function markRefreshed(): void {
    lastRefreshAt = Date.now()
  }

  /** 触发源命中入口：过节流则拉取。触发即记账（而非完成后）——拉取全链静默幂等
   *  （子面板各自 catch），在途/失败都不密集重试，下一窗口自然自愈 */
  function maybeRefresh(): void {
    if (Date.now() - lastRefreshAt < minIntervalMs) return
    markRefreshed()
    // then 链承接同步/异步两种 refresh 形态的异常，不让静默链外溢 unhandled rejection
    void Promise.resolve().then(refresh).catch(() => { /* 静默：宿主子面板既有错误链路已统一处理 */ })
  }

  return { maybeRefresh, markRefreshed }
}
