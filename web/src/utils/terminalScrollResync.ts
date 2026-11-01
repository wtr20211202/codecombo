// xterm v6 滚动区强制重同步——「滚轮上翻失效」类症状的根治手段。
//
// v6 视口改为 VS Code 式 SmoothScrollableElement，滚动尺寸
// （Viewport._sync → setScrollDimensions）只在三条路径重算：真实 resize
// （bufferService.onResize → queueSync）、buffer 激活、新输出（onScroll → _sync）。
// 面板隐藏期间写入/重放 scrollback 后，渲染尺寸与滚动区缓存可能停在陈旧值
// （隐藏时量测为 0），此时常规手段全部空转：
//   - FitAddon.fit()：proposeDimensions 遇 cell 尺寸 0 返回 undefined，或行列
//     无变化时直接 return；
//   - term.refresh()：只重绘行，不触发尺寸重算；
//   - term.scrollLines(0)：只是 setScrollPosition(+0)，与尺寸重算无关
//     （v6 Viewport.scrollLines 的实现即如此，此前「scrollLines(0) 走
//     setScrollDimensions 完整重算」的假设不成立）。
// 这正是「拖窗口/F12 能修、刷新按钮救不回」的差集：前者是尺寸真实变化的
// resize，走完整重算链路；后者都不是。
//
// 本函数以「行数抖动」resize（rows-1 → rows，终态尺寸不变）强制走一遍与
// 窗口 resize 完全相同的链路（charSize 重测 → 渲染尺寸重算 → queueSync →
// setScrollDimensions），是纯公开 API 下唯一可编程的等价自愈。抖动经
// term.onResize 以 silent resize 上报 PTY：resize 链路串行化 + 服务端相同
// 尺寸去重，终态与抖动前一致。
//
// 容器无布局盒（display:none 等，clientWidth/Height 为 0）时跳过——零尺寸
// 下重测只会把坏态写得更深，等可见后的 visibility 自愈点再治。
export function forceTerminalScrollResync(term: { element?: HTMLElement; cols: number; rows: number; resize(cols: number, rows: number): void }): void {
  try {
    const el = term.element
    if (!el || el.clientWidth === 0 || el.clientHeight === 0) return
    const rows = term.rows
    // 行数下限守卫：极小 pane 抖不动（rows-1 撞 MINIMUM_ROWS 时两次 resize
    // 同尺寸，CoreBrowserTerminal.resize 同尺寸早退，空转无害但也没意义）
    if (rows < 4) return
    term.resize(term.cols, rows - 1)
    term.resize(term.cols, rows)
  } catch {
    /* ignore */
  }
}
