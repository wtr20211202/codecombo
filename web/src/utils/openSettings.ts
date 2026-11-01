// 全局「打开设置弹窗并定位分区」通道：
// 深层组件（AI 结果面板的「去设置」等）无 props/emit 链可达设置弹窗宿主（Layout / HomeView），
// 沿用 sc-deploy-target 的 window CustomEvent 模式——宿主层监听后置 show，SettingsModal 自身监听切 tab
export const OPEN_SETTINGS_EVENT = 'sc-open-settings'

/**
 * 请求打开设置弹窗并定位到指定 tab（如 'ai' / 'security'）。
 * anchor（P-20261006-43）：可选区块锚点 = 分区 pane 内控件行 data-testid
 * （如 'settings-project-rules'），弹窗切分区后滚动定位 + 闪烁（SettingsModal
 * 侧经 useSettingsSearch.revealAnchor 消费）。detail 保持双形态——不带 anchor
 * 仍是裸 string（既有生产方含 NotificationCenter 直发 CustomEvent 零改动），
 * 带 anchor 升为 {tab, anchor} 对象，消费端双形态解析。
 */
export function openSettingsTab(tab: string, anchor?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, {
    detail: anchor ? { tab, anchor } : tab,
  }))
}
