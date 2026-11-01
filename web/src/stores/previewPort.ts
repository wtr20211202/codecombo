import { defineStore } from 'pinia'
import router from '../router'
import { usePanelLayout } from '../composables/usePanelLayout'

/**
 * 预览端口直达（P-20261002-70）：agent 把 dev server 跑起来后经
 * /api/ops-notify 上报 preview.port，本 store 是三个消费方的共享状态源：
 * - 悬浮球/条快捷按钮（AgentTerminalMini）：读 port/label 渲染「预览 :N」
 * - 通知中心带动作条目：action='preview' 经 pendingAction 链回到 openInPanel
 * - 底部预览面板（PreviewPanel）：watch openPort 把端口填入 P-29 输入链路
 * 预览端口独立于任务生命周期（服务在任务结束后仍在跑），不挂 assistantTask
 * store；页面会话内内存态，刷新即清（端口可再上报，无持久化必要）。
 */

/** 面板输入与后端校验同口径：回环高位段（特权段 0~1023 不可绑定的下限） */
export const PREVIEW_PORT_MIN = 1024
export const PREVIEW_PORT_MAX = 65535

/** 端口合法性（store 写入口与事件消费口共用的单一判据） */
export function isValidPreviewPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= PREVIEW_PORT_MIN && v <= PREVIEW_PORT_MAX
}

export const usePreviewPortStore = defineStore('previewPort', {
  state: () => ({
    /** agent 最近上报的预览端口（null = 本会话尚无上报，快捷按钮不渲染）。
     * 携带 hostId 的远程上报时为「远端回环端口」（展示口径：用户认得的
     * dev server 端口），实际预览走 tunnel.localPort */
    port: null as number | null,
    /** 服务简称（agent 可选上报；悬浮球按钮 title 与通知正文展示） */
    label: '',
    /** 来源（P-20261002-83）：'detected' = 终端输出被动探测（悬浮球弱化展示
     * 「检测到 :N」）；'' = agent 主动上报（正式「预览 :N」样式） */
    source: '' as string,
    /** SSH 隧道映射（P-20261004-5）：port 为远端回环端口且隧道就绪时非空——
     * 面板打开 localPort 并展示「remote:N → local:M」徽标；null = 本机端口
     * 直达（或隧道尚未建好/开失败的降级形态，面板照常呈现不可达） */
    tunnel: null as { hostId: string; remotePort: number; localPort: number } | null,
    /** 待预览面板消费的打开请求（null = 无；消费后置回 null，重复点击可再触发） */
    openPort: null as number | null,
    /** 与 openPort 同批交付的隧道徽标载荷（consumeOpen 一并清位） */
    openTunnel: null as { remote: number; local: number } | null,
  }),
  actions: {
    /** 登记上报（去重已在 previewPortNotify 链完成，这里只存最新值） */
    report(port: number, label = '', source = '') {
      if (!isValidPreviewPort(port)) return
      this.port = port
      this.label = label.slice(0, 64)
      this.source = source === 'detected' ? 'detected' : ''
      // 隧道映射仅对同端口有效（上报换端口即失效；同端口升级重报保留）
      if (this.tunnel === null || this.tunnel.remotePort !== port) this.tunnel = null
    },
    /** 挂接隧道映射（P-20261004-5）：隧道异步建好后补挂——不覆写 port/label/
     * source（异步间隙可能有新上报顶掉本条，调用方自判端口归属） */
    attachTunnel(hostId: string, remotePort: number, localPort: number) {
      this.tunnel = { hostId, remotePort, localPort }
    },
    /** 直达：打开底部预览面板 + 交付端口。项目页就地开面板；首页/大屏先路由
     * 进项目页（与审批卡「查看发起会话」跳转同款 pendingBottomTab 语义——
     * 挂载期 ui-state 恢复晚于本赋值，打标防 tab 被上次保存值翻走）。
     * 端口命中隧道映射时交付 localPort（iframe 打隧道口）+ 徽标载荷 */
    openInPanel(port: number) {
      if (!isValidPreviewPort(port)) return
      const layout = usePanelLayout()
      // 「点啥显示啥」通用规则：目标视图被最大化面板覆盖时先还原
      layout.restoreFromMaximized()
      const tunnel = this.tunnel
      const mapped = tunnel !== null && tunnel.remotePort === port
      this.openPort = mapped ? tunnel.localPort : port
      this.openTunnel = mapped ? { remote: port, local: tunnel.localPort } : null
      layout.showBottomPanel.value = true
      layout.bottomTab.value = 'preview'
      if (router.currentRoute.value.name !== 'project') {
        layout.pendingBottomTab.value = 'preview'
        void router.push({ name: 'project' })
      }
    },
    /** 预览面板消费打开请求（清位：同端口的再次点击能重新触发 watch） */
    consumeOpen() {
      this.openPort = null
      this.openTunnel = null
    },
  },
})
