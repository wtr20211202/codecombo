/**
 * 通知中心未读分界线纯函数（P-20261003-259）：「上次查看后 N 条新增」——
 * 上次查看时点 = 面板关闭时刻（uiState notificationCenter.lastSeenAt），
 * 通知条目 time 晚于该时点即视为新增。
 *
 * 与过滤正交：计数与落点都由调用方传入「当前过滤视图」的条目/行序派生，
 * 切分类页签/项目/runtime/免打扰视图时界线随可见条目走——筛选后没有新
 * 条目不显示分界，全部为新时界线落在列表末尾（仍给出 N 条量化提示）。
 *
 * 通知列表按 time 倒序（最新在前）：新条目在上、旧条目在下，分界线插在
 * 最后一条「新」行之后。时间解析失败的脏条目按「旧」处理（不制造假新增）。
 */

/** ISO 时间 → 毫秒；非法/缺失时间回落 0（恒旧） */
export function notifTimeMs(time: string): number {
  const ts = new Date(time).getTime()
  return Number.isFinite(ts) ? ts : 0
}

/** 该条目是否晚于上次查看时点；lastSeenAt <= 0 = 尚无基线，一律非新增 */
export function isNewSince(time: string, lastSeenAt: number): boolean {
  if (!(lastSeenAt > 0)) return false
  return notifTimeMs(time) > lastSeenAt
}

/** 当前视图新增计数（按条目数，聚合组内的新成员同样计入） */
export function countNewSince(
  items: ReadonlyArray<{ time: string }>,
  lastSeenAt: number,
): number {
  if (!(lastSeenAt > 0)) return 0
  let n = 0
  for (const item of items) {
    if (isNewSince(item.time, lastSeenAt)) n++
  }
  return n
}

/** 分界落点：按列表顺序给出各行的代表时间（组行取组内最新成员），返回最后
 *  一条「新」行的下标（分界线插在其后）；无新增返回 -1（不渲染分界）。
 *  行序与通知列表同为时间倒序；容错非严格有序——从尾部回溯第一/最后一个
 *  新行仍取「最靠后」者，保证界线不会切在旧条目中间 */
export function lastNewRowIndex(rowTimes: readonly string[], lastSeenAt: number): number {
  if (!(lastSeenAt > 0)) return -1
  for (let i = rowTimes.length - 1; i >= 0; i--) {
    if (isNewSince(rowTimes[i]!, lastSeenAt)) return i
  }
  return -1
}
