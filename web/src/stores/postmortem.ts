import { defineStore } from 'pinia'

/**
 * 复盘报告弹层的打开状态（P-20261004-60，纯前端会话内 UI 态）：
 * 入口两路分布在不同组件树——退出通知卡的 postmortem 动作（经 notification
 * store pendingAction → useLayoutShell 分发）与会话行右键「复盘报告」
 * （AgentSidebarSessionTree → AgentTerminalView）——弹层本体挂 App 层单一
 * 实例（stallTriage / DiagnoseDialog 全局弹窗同款惯例），宿主只写这里的目标
 * 会话 id。只存 id 不存快照：复盘要的是「打开那一刻的最新聚合」（服务端
 * 现取 meta+history+尾部），读态收口在弹层组件。
 */
export const usePostmortemStore = defineStore('postmortem', {
  state: () => ({
    /** 复盘中的会话 id；空串 = 弹层关闭 */
    sessionId: '',
  }),
  getters: {
    /** 弹层是否打开（宿主无感，弹层组件自消费） */
    open: (state) => state.sessionId !== '',
  },
  actions: {
    /** 打开某会话的复盘弹层（幂等：重复打开同会话无变化，换 id 即换报告） */
    openSession(sessionId: string) {
      if (sessionId) this.sessionId = sessionId
    },
    close() {
      this.sessionId = ''
    },
  },
})
