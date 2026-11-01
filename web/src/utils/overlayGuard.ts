// 自定义弹层（大纲/任务运行器/全工程搜索/通知中心/智能体 docked 页）Esc 关闭
// 的让位守卫：Naive 的模态与抽屉自带 Esc 关闭，自定义弹层检测到它们在场上时
// 应跳过自己的 Esc 处理，保证 Esc 一次只关最上层。
// .n-drawer 必须在列——帮助中心等抽屉压在弹层上层时，Esc 不能把底层一起关掉。
// .n-dropdown-menu 同理：项目筛选等下拉压在宿主列表上层时，方向键/Enter/Esc
// 都归下拉所有（会话选择器键盘导航依赖此让位）。
export function hasBlockingOverlay(): boolean {
  return !!document.querySelector('.n-modal, .n-dialog, .n-drawer, .n-dropdown-menu')
}
