// 全局「打开帮助中心并锚定问答条目」通道：
// 深层组件（新建会话对话框的运行时安装指引等）无 props/emit 链可达帮助中心宿主
//（Layout / HomeView），沿用 openSettings 的 window CustomEvent 模式——宿主层
// 监听后置 show，HelpCenter 自身监听同一事件消化锚点（展开 + 滚动定位）
export const OPEN_HELP_EVENT = 'sc-open-help'

/** 请求打开帮助中心并定位到指定问答条目（entry id，见 server/api/help/help.go；
 *  缺省 = 仅打开不锚定） */
export function openHelpEntry(entryId?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_HELP_EVENT, { detail: entryId }))
}
