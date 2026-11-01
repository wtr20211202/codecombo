/**
 * 会话 shell 集成检测判据（P-20261004-90）：命令历史/空闲提示/退出码装饰/git
 * 面板自刷新整族功能依赖 OSC 133 shell 集成，但用户无从知道某会话有没有集成
 * ——功能静默缺失时只能困惑「为什么这个会话没有历史/空闲徽标」。本模块只做
 * 纯判定，文案与展示在各宿主（侧栏会话行 tooltip 一行 + 未检测弱灰图标）。
 *
 * 数据源 = terminal-sessions store 的 runningMap + activityMap（OSC 133 C/D/E
 * 事件驱动、浏览器内存态）：任一 map 含该会话的键 = 本浏览器收到过至少一枚
 * shell 侧 OSC 133 帧（shellint 会话首个 prompt 渲染即发 D——oscstate 同款
 * 时序，附着重放的历史帧同样记账）→ 已检测到集成；两 map 都缺键 = 未检测到。
 *
 * 诚实滞后语义（宁漏报不误报，lastCmdMap 同款浏览器内存态边界）：新创建尚未
 * 渲染提示符 / 本浏览器从未附着 / 刷新后的窗口期同判「未检测」——附着后首个
 * D 帧即转「已连接」。判定即数据：任何形态的 shellint 补全（如平台覆盖面扩展
 * 提案）落地后指示自动转已连接，前端零额外改动。
 *
 * 为什么不用 sessionsWithOutput（useTerminalSession 的「收过任意服务端字节」
 * 集合）：任意输出 ≠ shell 集成——tmux 重绘/端点探测等自发字节都会点亮它；
 * OSC 133 帧只能来自 shellint 钩子（或重放缓冲里的历史帧），才是集成的直接
 * 证据。
 */

/**
 * 该会话是否检测到 shell 集成（本浏览器视角）：runningMap / activityMap 任一
 * 含键即真。两 map 由宿主以 props 下发（与运行点/最近活动同链路），缺省
 * （宿主未接数据面）按未检测处理——与静默标「无记录不判」同口径。
 */
export function sessionShellIntDetected(
  runningMap: Record<string, boolean> | undefined,
  activityMap: Record<string, number> | undefined,
  id: string,
): boolean {
  return runningMap?.[id] !== undefined || activityMap?.[id] !== undefined
}
