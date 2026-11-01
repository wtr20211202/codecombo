import { defineStore } from 'pinia'

/**
 * 停滞分诊卡的打开状态（P-20261004-37，纯前端会话内 UI 态）：
 * 停滞强标的三个宿主（管理页侧栏会话行 / 悬浮列表行 / 值班大屏会话卡）分布
 * 在不同组件树，分诊卡本体挂 App 层单一实例（DiagnoseDialog 等全局弹窗同款
 * 惯例）——宿主只写这里的目标会话 id，卡片组件自读各数据 store 装配现场。
 * 只存 id 不存快照：分诊要的是「打开那一刻的最新现场」，读态收口在组件。
 */
export const useStallTriageStore = defineStore('stallTriage', {
  state: () => ({
    /** 分诊中的会话 id；空串 = 卡片关闭 */
    sessionId: '',
  }),
  getters: {
    /** 卡片是否打开（宿主无感，卡片组件自消费） */
    open: (state) => state.sessionId !== '',
  },
  actions: {
    /** 打开某会话的分诊卡（幂等：重复打开同会话无变化） */
    openSession(sessionId: string) {
      if (sessionId) this.sessionId = sessionId
    },
    close() {
      this.sessionId = ''
    },
  },
})
