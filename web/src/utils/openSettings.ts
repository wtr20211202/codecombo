import { nextTick } from 'vue'

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

/** 路由面最小契约（openVersionPanel 只需读当前路由名 + 跳首页） */
export interface RouterLike {
  currentRoute: { value: { name?: unknown } }
  push: (to: { name: string }) => Promise<unknown>
}

/**
 * 打开版本面板（P-20261109-10 更新进度回跳：全局徽标 / 更新通知行内动作）：
 * 设置弹窗「关于」分区即 VersionPanel 宿主——首页/项目页的设置弹窗宿主都监听
 * OPEN_SETTINGS_EVENT，经同一通道直达。大屏路由（/monitor）无设置弹窗宿主：先回
 * 首页、nextTick 待宿主监听挂载后再发定位事件（ApprovalModeBadge.openRecovery
 * 同款前置）。router 惰性取（notification store handleClick 同款：模块级 import
 * 主 router 会把 routes→views 整图拖进 e2e 装载器）；loadRouter 可注入供单测
 */
export async function openVersionPanel(
  loadRouter: () => Promise<RouterLike> = async () => (await import('../router')).default,
): Promise<void> {
  const router = await loadRouter()
  if (router.currentRoute.value.name === 'monitor') {
    await router.push({ name: 'home' })
    await nextTick()
  }
  openSettingsTab('about')
}
