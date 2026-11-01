// 桌面通知 composable：浏览器原生 Notification API 封装
// 仅在 document.hidden（页面不可见）时触发，避免与 UI 内通知重复打扰
// 权限被拒绝时静默降级，不抛错
// 免打扰时段（P-20261002-40）：时段内整体静默，通知中心入账不受影响
// 免打扰例外类别（P-20261003-115）：通知携带 category 时先查例外表，命中穿透
// error 级穿透（P-20261004-117）：通知携带 type 时 error 级豁免勿扰仍提醒
//（开关 exceptError 默认开，可关为绝对静默）——勿扰滤的是噪声不是警报
// 应用锁定静默（P-20261003-5）：锁定态抑制桌面弹出，通知中心入账不受影响
// 精简模式（P-20261003-90）：开放环境内容泛化，通知中心入账不受影响
// 点击会话直达（P-20261004-121）：通知携带 terminalId 时 onclick 在聚焦窗口后
// 派发 OPS_ACTIVATE_TERMINAL 既有激活广播——回拉信号最后一米，点通知直接落到
// 完成任务的会话
import i18n from '../i18n'
import { OPS_ACTIVATE_TERMINAL } from '../utils/opsEvents'
import type { NotificationItem } from '../api/client'
import { useDndStore } from '../stores/dnd'
import { useLockStore } from '../stores/lock'
import { useNotifySimpleStore } from '../stores/notifySimple'

export function useDesktopNotify() {
  // 请求权限（首次触发时调）
  async function requestPermission(): Promise<boolean> {
    if (!('Notification' in window)) return false
    if (Notification.permission === 'granted') return true
    if (Notification.permission === 'denied') return false
    try {
      const result = await Notification.requestPermission()
      return result === 'granted'
    } catch {
      return false
    }
  }

  // 触发桌面通知：仅当页面 hidden 时弹；category 可选（通知归属类别，
  // P-20261003-115 免打扰例外穿透依据，无归属不参与例外）；type 可选（通知
  // 分级，P-20261004-117 error 级穿透依据，与 category 同款「携带着参与豁免」）；
  // terminalId 可选（P-20261004-121 会话直达落点，data 落档 + onclick 派发
  // 激活广播，无归属不传——点击仅聚焦窗口维持现状语义）
  function notify(title: string, body?: string, category?: string, type?: NotificationItem['type'], terminalId?: string) {
    if (!('Notification' in window)) return
    if (Notification.permission !== 'granted') return
    // 精简模式（P-20261003-90）：共享工位/投屏等开放环境的内容泄露面收口——
    // 桌面通知仅显「新通知」占位，不携带 title/body 明细（部署错误摘要/文件
    // 路径旁人可见）。站内中心入账链不经过本函数不受影响；webhook 外发是服务
    // 端独立通道同样不受影响（设置页有注记）。守卫链顺序与门控家族一致：
    // 例外→精简→免打扰→锁态——例外只在免打扰门内放行（内容隐私与注意力
    // 优先级正交，穿透不免除泛化）；精简在前只改内容不吞通知，后续门控照常
    // 可整体抑制
    if (useNotifySimpleStore().enabled) {
      title = i18n.global.t('notify.simple.title')
      body = undefined
    }
    // 免打扰时段静默（P-20261002-40）：入账链在调用方（store.add），不经过
    // 本函数，时段只吞打扰不吞账目。审批确认卡不走桌面通知（常驻卡片堆），
    // 天然不受影响；例外类别（P-20261003-115）与 error 级穿透（P-20261004-117）
    // 在 isSilenced 内先查后判——两者都只放行免打扰门，锁定门照常压制
    if (useDndStore().isSilenced(category, type)) return
    // 锁定态静默（P-20261003-5）：桌面通知携带通知正文，锁屏（共享环境）上
    // 弹出即内容泄露面，锁定期间整体抑制。与免打扰同款「只吞打扰不吞账目」
    // 语义：入账链（store.add / addLocal → NotificationCenter watch）不经过
    // 本函数，解锁后通知中心照常可见
    if (useLockStore().isLocked) return
    if (!document.hidden) return
    try {
      const n = new Notification(title, {
        body,
        // silent: false,  // 使用系统默认提示音
        // tag 复用同一通知槽，避免长任务堆积
        tag: 'codecombo',
        // data 携带 terminalId（P-20261004-121）：Notification 标准数据载体，
        // onclick 会话直达的落点依据（无归属不带 data 字段）
        ...(terminalId ? { data: { terminalId } } : {}),
      })
      // 点击桌面通知聚焦窗口；携带 terminalId 时同时派发与在册卡「查看会话」
      // 同款 OPS_ACTIVATE_TERMINAL 激活广播（useAgentTerminal / TerminalView
      // 既有消费端接管落点）。remote: 命名空间 id 本地无对应会话，消费端按
      // 会话表对账对未知 id 幂等早退——等同现状仅聚焦，跳实例链不在此展开
      n.onclick = () => {
        window.focus()
        n.close()
        if (terminalId) {
          window.dispatchEvent(new CustomEvent(OPS_ACTIVATE_TERMINAL, { detail: { id: terminalId } }))
        }
      }
      // 5 秒后自动关闭（部分浏览器需要）
      setTimeout(() => { try { n.close() } catch { /* 已被用户手动关闭 */ } }, 5000)
    } catch {
      // 静默：部分浏览器在 SW 上下文外可能报错
    }
  }

  return { notify, requestPermission }
}
