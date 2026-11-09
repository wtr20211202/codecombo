import { computed } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from './useI18n'
import { useTerminalLiveShares } from './useTerminalLiveShares'
import { useShareDialog } from './useShareDialog'
import { useTermShareDialog } from './useTermShareDialog'
import { fetchWithEgressGate } from './useEgressGate'
import { useSensitiveMarkHint } from './useSensitiveMarkHint'
import { shareApi } from '../api/domains/share'
import { recordingApi } from '../api/domains/recording'
import { terminalApi } from '../api/domains/terminal'
import { exportFileName } from '../utils/exportFileName'

/**
 * 终端会话能力四件（直播分享 / 冻结分享 / 分享回放 / 导出输出）+ 直播徽标
 * 投影的单一实现（P-20261106-7 双入口纪律）。
 *
 * 动机：同一组会话级能力此前只活在底部终端 tab 右键菜单（TerminalView），
 * 终端会话管理页（AgentTerminalView 会话树）没有同款入口——agent/tmux 持久
 * 会话的宿主恰恰是管理页，四个能力在其主入口上缺席。抽成本组合式后两个入口
 * 共用同一份动作链与徽标数据面，防再分叉。
 *
 * 【横向纪律（P-20261106-7）】终端会话级能力新增必须双入口同步：底部终端
 * tab 右键 + 会话管理列表行右键。新增能力时改本组合式（或并列复用件），
 * 两入口的宿主只做接线——再出现「同一能力两个入口只活一个」即为回归。
 *
 * 导出取数语义（评审注意①）：走服务端会话层 CaptureScrollback 链
 * （`GET /api/terminals/:id/export`，tmux capture-pane / native 环形缓冲），
 * 不落前端视图缓冲——detached 会话无视图缓冲，两入口导出内容才一致。
 * 徽标数据面（评审注意②）：沿用 useTerminalLiveShares 单例（30s 惰性轮询 +
 * 变更点 bump），不逐行开订阅。
 * 能力锚定（评审注意③）：全部动作按 TerminalID（会话级）寻址，与 tab/行的
 * 实例形态（tmux 持久/native PTY、attached/detached）无关。
 */

/** 动作寻址目标：终端会话 id + 显示名（导出下载名/警示文案用） */
export interface TerminalShareTarget {
  id: string
  name: string
}

export function useTerminalShareActions() {
  const { t } = useI18n()
  const message = useMessage()
  // 直播/冻结/回放结果卡与文件/片段分享共用（useShareDialog 模块级单例，
  // 弹窗宿主挂 App 层 ShareDialogsHost——首页 overlay 管理页入口同样可达，
  // P-20261108-1）；敏感出域闸门的确认流在其内部收口
  const shareDialog = useShareDialog()
  // 直播/冻结创建链带选项弹层（遮蔽/水印，P-20261106-9）：两入口同走弹层，
  // 「遮蔽缺省开」的安全默认不因入口不同而旁路
  const termShare = useTermShareDialog()
  // 导出落地后的敏感内容自动检测建议（P-20261003-207）
  const { suggestSensitiveMarking } = useSensitiveMarkHint()
  // 直播锚点表（P-20261005-161）：30s 惰性轮询 + 创建/撤销点即时 bump；
  // start/stop 引用计数（见该模块），多宿主并存不互踢
  const live = useTerminalLiveShares()

  /**
   * 直播分享/结束直播（P-20261003-306 + P-20261005-161）：按直播态分流——
   * 无锚点先过选项弹层（遮蔽/水印，P-20261106-9 起）再创建；有锚点一键
   * DELETE 即时断流（撤销从分享管理器两跳变一跳）。不弹确认：同链幂等
   * （重建得回同一短链），误触代价对称可逆；失败 toast 归拦截器，成功失败
   * 都对账（失败时摘除陈旧锚点同理）
   */
  async function toggleLiveShare(target: TerminalShareTarget): Promise<void> {
    const liveRec = live.liveBySession.value[target.id]
    if (!liveRec) {
      termShare.createTerminalLive(target.id)
      return
    }
    try {
      await shareApi.remove(liveRec.token)
      message.success(t('terminal.endLiveShareDone'))
    } catch { /* 拦截器已 toast；下面对账会摘掉已失效的锚点 */ } finally {
      live.bump()
    }
  }

  /**
   * 冻结分享（P-20261005-205）：创建时刻的输出定格短链（净化在服务端快照
   * 链完成，快照即净本）——先过选项弹层（P-20261106-9），确认后创建；
   * 结果卡由 useShareDialog 单例弹出
   */
  function createFrozenShare(sessionId: string): void {
    termShare.createTerminalFrozen(sessionId)
  }

  /**
   * 分享回放（P-20261004-103）：取该会话最近一次过程录制生成只读回放短链
   * （异步 walkthrough，默认 1 小时）。录制由审批窗口自动开启（设置默认关），
   * 无录制时给出可行动提示而非静默失败
   */
  async function shareReplay(sessionId: string): Promise<void> {
    try {
      const res = (await recordingApi.list({ sessionId, limit: 1 })) as unknown as {
        data?: { id?: string }[]
      }
      const latest = res?.data?.[0]
      if (!latest?.id) {
        message.warning(t('terminal.replayShareNone'))
        return
      }
      await shareDialog.createRecordingShare(latest.id)
    } catch { /* 拦截器处理 */ }
  }

  /**
   * 导出输出（P-20261003-100）：服务端 scrollback 链剥 ANSI 直出 txt 留档
   * 附件。blob 下载名客户端合成（响应拦截器不透 Content-Disposition，claude
   * 导出同款）。出域闸（P-20261003-155 会话标记 + P-20261004-113 内容敏感）
   * 统一经 fetchWithEgressGate 弹一次确认，确认后同时带 override=1&confirm=1
   * 重取——JSON 永不落盘（半真文件比失败更糟）
   */
  async function exportOutput(target: TerminalShareTarget): Promise<void> {
    try {
      const blob = await fetchWithEgressGate(
        confirm => terminalApi.exportOutput(
          target.id,
          confirm ? { params: { override: '1', confirm: '1' } } : undefined,
        ) as unknown as Promise<Blob>,
        target.name,
      )
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = exportFileName(target.name, new Date(), 'txt', 'terminal')
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      message.success(t('terminal.exportOutputDone'))
      // 敏感内容自动检测建议（P-20261003-207）：下载已落地才扫描，void 不
      // await（尾窗抽样有界在 util 内收口）
      void suggestSensitiveMarking(target.id, target.name, () => blob.text())
    } catch { /* 拦截器处理 */ }
  }

  /**
   * 直播徽标投影（P-20261005-161 主播侧可见性）：sessionId → 徽标 title
   * （「直播中·剩 HH:MM·N 次观看」）。空记录的会话不进表 = 无徽标；观看数
   * 取分享记录 hits（累计打开，唯一前端可得口径——hub 实时订阅计数无 API
   * 出口）。到界（含轮询间隙内的过期）不产 title = 摘徽标；无 TTL 记录
   * （理论不出现）以 --:-- 兜底不误导。倒计时基准 = 锚点表模块的轮询同点
   * tick（30s 粒度，分钟级展示足够）
   */
  const liveTitles = computed<Record<string, string>>(() => {
    const src = live.liveBySession.value
    if (!Object.keys(src).length) return {}
    const now = live.now.value
    const out: Record<string, string> = {}
    for (const sessionId of Object.keys(src)) {
      const rec = src[sessionId]!
      const remainMs = rec.expiresAt
        ? new Date(rec.expiresAt).getTime() - now
        : NaN
      if (!Number.isNaN(remainMs) && remainMs <= 0) continue
      const totalMin = Number.isNaN(remainMs) ? 0 : Math.ceil(remainMs / 60_000)
      const time = `${String(Math.floor(totalMin / 60)).padStart(2, '0')}:${String(totalMin % 60).padStart(2, '0')}`
      out[sessionId] = t('terminal.liveBadgeTitle', {
        time: Number.isNaN(remainMs) ? '--:--' : time,
        n: rec.hits ?? 0,
      })
    }
    return out
  })

  return {
    toggleLiveShare,
    createFrozenShare,
    shareReplay,
    exportOutput,
    /** 直播锚点表（菜单「直播分享/结束直播」文案翻转、徽标在否的判定源） */
    liveBySession: live.liveBySession,
    /** 徽标 title 投影（行/tab 红点 title 与右键文案翻转共用） */
    liveTitles,
    /** 挂载 start / 卸载 stop（引用计数，多宿主并存） */
    start: live.start,
    stop: live.stop,
    /** 变更点即时对账（创建/撤销动作链内部已调；带外变更宿主可再调） */
    bump: live.bump,
  }
}
