import { defineStore } from 'pinia'
import router from '../router'
import { usePanelLayout } from '../composables/usePanelLayout'
import type { RunbookOnFailure, RunbookStep } from '../api/client'

/**
 * 运行书草稿直达（P-20261005-3 会话录制一键转运行书）：录制回放器按 OSC133
 * 命令索引生成草稿后经本 store 交付 RunbookPanel 新建表单——生成物是草稿非
 * 直入库（防误自动化），人工过目确认走面板既有 saveBook 链。
 * 结构仿 previewPort store（暂存载荷 + 直达开面板 + 消费清位）：录制浏览器
 * 是跨路由弹层（值班大屏 /monitor 与审批卡两宿主），与运行书面板（项目页
 * 底部终端区）之间无 props/emit 链可达，store 暂存即解耦面。
 */

/** 待预填的运行书草稿（fromRecording = 来源是会话录制，表单呈现入库前检查警示条） */
export interface RunbookDraft {
  title: string
  description?: string
  onFailure: RunbookOnFailure
  steps: RunbookStep[]
  fromRecording?: boolean
}

export const useRunbookDraftStore = defineStore('runbookDraft', {
  state: () => ({
    /** 待 RunbookPanel 消费的草稿（null = 无；消费后置回 null，再次点击可重新触发） */
    pending: null as RunbookDraft | null,
  }),
  actions: {
    /** 直达：打开底部终端分区 + 运行书面板并交付草稿（previewPort.openInPanel
     * 同款路由语义：项目页就地开面板；首页/大屏先路由进项目页 + pendingBottomTab
     * 打标——挂载期 ui-state 恢复晚于本赋值，打标防 tab 被上次保存值翻走） */
    openInPanel(draft: RunbookDraft) {
      const layout = usePanelLayout()
      // 「点啥显示啥」通用规则：目标视图被最大化面板覆盖时先还原
      layout.restoreFromMaximized()
      this.pending = draft
      layout.showBottomPanel.value = true
      layout.bottomTab.value = 'terminal'
      if (router.currentRoute.value.name !== 'project') {
        layout.pendingBottomTab.value = 'terminal'
        void router.push({ name: 'project' })
      }
    },
    /** RunbookPanel 消费草稿（清位：消费即预填新建表单，取消不回档——重新生成
     * 走回放器再点一次，草稿不值留防旧内容突袭下次新建） */
    consume(): RunbookDraft | null {
      const d = this.pending
      this.pending = null
      return d
    },
  },
})
