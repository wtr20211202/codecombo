/**
 * 终端写链路背压的风暴计数与落定自愈状态机（P-20261004-47）。
 *
 * 背景：写链路背压（enqueueWriteMessage）在挂起消息超上限时丢弃本帧输出——
 * 仅影响显示、不影响 PTY 状态，但被丢的帧可能携带光标定位/色彩/备屏切换等
 * 序列，风暴平息后 xterm 屏态与 PTY 真实屏永久偏离（「疑似花屏却无线索」，
 * 恢复全靠碰巧触发 resize/重绘）。本模块把「风暴 episode」的判定收口为可
 * 单测的状态机，宿主（useTerminalSession）只负责在三个时点喂事件：
 *   ① 帧被丢弃 → onFrameDropped()（episode 计数 +1，撤销已排程的落定自愈——
 *      丢弃仍在发生说明风暴未落定）；
 *   ② 写链任务完结 → onChainIdle(chainEmpty)（链排空且本 episode 有丢帧 →
 *      去抖 settleMs 后回调 onSettle 一次；去抖盖过「排空-再入风暴」的脉冲——
 *      期间任何新丢弃都会取消排程重新等落定）；
 *   ③ 会话 dispose → dispose()（停定时器防泄漏，复位计数）。
 *
 * 量级：全部为 O(1) 计数与单定时器，风暴稳态（每帧两处调用）零分配热路径。
 */

/** 写链路在途消息上限（超过即丢弃本帧）：与历史实现同值，本次只加计数不改闸门 */
export const TERMINAL_PENDING_WRITE_LIMIT = 256

/** 风暴落定去抖：写链排空后需静默此时长才认定风暴结束并触发一次自愈。
 *  取值盖过输出脉冲间隙（风暴常以「burst-排空-burst」形态出现），又远小于
 *  用户感知等待（亚秒级自愈用户无感） */
export const TERMINAL_STORM_SETTLE_MS = 800

export interface WriteStormTrackerOptions {
  /** 风暴落定回调：参数 = 本 episode 丢弃的帧数（一次性，回调后计数归零开新 episode） */
  onSettle: (droppedInEpisode: number) => void
  /** 落定去抖时长（单测注入短值；缺省 TERMINAL_STORM_SETTLE_MS） */
  settleMs?: number
}

export interface WriteStormTracker {
  /** 帧被背压丢弃：episode 计数 +1，并撤销已排程的落定自愈（风暴未落定） */
  onFrameDropped(): void
  /** 写链任务完结：chainEmpty=true（链排空）且本 episode 有丢帧时排程落定自愈 */
  onChainIdle(chainEmpty: boolean): void
  /** 会话 teardown：停定时器 + 复位计数（防 dispose 后定时器触达已卸载实例） */
  dispose(): void
  /** 本 episode（尚未落定自愈）已丢弃的帧数；0 = 无风暴在途 */
  readonly episodeDropped: number
}

export function createWriteStormTracker(options: WriteStormTrackerOptions): WriteStormTracker {
  const settleMs = options.settleMs ?? TERMINAL_STORM_SETTLE_MS
  let episodeDropped = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function cancelScheduledSettle(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    onFrameDropped() {
      episodeDropped++
      // 丢弃仍在发生 = 风暴未落定：撤销已排程的自愈，等新的静默窗
      cancelScheduledSettle()
    },
    onChainIdle(chainEmpty: boolean) {
      if (!chainEmpty || episodeDropped === 0 || timer !== null) return
      timer = setTimeout(() => {
        timer = null
        const dropped = episodeDropped
        episodeDropped = 0
        options.onSettle(dropped)
      }, settleMs)
    },
    dispose() {
      cancelScheduledSettle()
      episodeDropped = 0
    },
    get episodeDropped() {
      return episodeDropped
    },
  }
}
