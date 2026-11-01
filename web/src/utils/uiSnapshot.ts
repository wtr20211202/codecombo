/**
 * 用户 UI 现场聚合（P-20261004-52）：把分散在各 store/composable 的「用户此刻
 * 在看什么」折叠为一个上报载荷。纯函数无副作用——聚合正确性与相等判定在
 * uiSnapshot.test.ts 单测；去抖/心跳的调度在 useUiSnapshotReporter（组合式，
 * 本文件不依赖 Vue）。
 *
 * 隐私边界（与手册「用户现场」节同文）：仅位置不内容——只含项目/文件路径+
 * 行号/面板开合/活跃终端会话 id，绝不含文件内容、终端输出；agent 不得据此
 * 推断用户行为。
 */
import type { UiSnapshotPayload, UiSnapshotSource } from '../api/domains/system'

/** 从现场数据源构建上报载荷（服务端 POST /api/ui/snapshot 契约）：
 * - 无激活文件（首页/欢迎页/diff 伪键/未命名草稿）或无行级定位（行号 <1）
 *   → activeFile 省略不传——「没有位置」与「位置是 null/0 行」是两回事，
 *   省略即诚实降级，也免 agent 读到 0 行误当第一行；
 * - 空 id 字段统一归一省略（载荷最小化，也免服务端存空白串） */
export function buildUiSnapshot(src: UiSnapshotSource): UiSnapshotPayload {
  const payload: UiSnapshotPayload = {
    visiblePanels: {
      side: src.side,
      sideOpen: src.sideOpen,
      bottom: src.bottom,
      bottomOpen: src.bottomOpen,
    },
  }
  if (src.activeProjectId) payload.activeProjectId = src.activeProjectId
  if (src.activeFilePath && src.activeFileLine >= 1) {
    const file: { path: string; line: number; column?: number } = {
      path: src.activeFilePath,
      line: src.activeFileLine,
    }
    if (src.activeFileColumn && src.activeFileColumn > 0) file.column = src.activeFileColumn
    payload.activeFile = file
  }
  if (src.activeTerminalSessionId) payload.activeTerminalSessionId = src.activeTerminalSessionId
  return payload
}

/** 深相等判定（逐字段显式比较，非 JSON 串行化——键序无关且避免每次比较分配）：
 *  去抖窗口到期后只有「与上次已上报不同」才真正 POST，稳态零请求 */
export function uiSnapshotEquals(a: UiSnapshotPayload | null, b: UiSnapshotPayload | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.activeProjectId !== b.activeProjectId) return false
  if (a.activeTerminalSessionId !== b.activeTerminalSessionId) return false
  if (!!a.activeFile !== !!b.activeFile) return false
  if (a.activeFile) {
    if (a.activeFile.path !== b.activeFile?.path) return false
    if (a.activeFile.line !== b.activeFile.line) return false
    if (a.activeFile.column !== b.activeFile.column) return false
  }
  const pa = a.visiblePanels
  const pb = b.visiblePanels
  return pa.side === pb.side && pa.sideOpen === pb.sideOpen
    && pa.bottom === pb.bottom && pa.bottomOpen === pb.bottomOpen
}
