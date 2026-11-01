import { defineStore } from 'pinia'

/**
 * 日报历史面板的可见性与下钻聚焦（P-20261004-96，纯前端会话内 UI 态，不落盘）：
 * 面板本体挂通知中心组件根（App 层单例，独立 fixed 遮罩），入口两路分布在不同
 * 组件树——通知中心头部日历钮（普通打开，默认看最新日）与值班大屏活动热力图
 * 格子点击（下钻，看指定日）——两树经这里共达（postmortem store 同款惯例：
 * 宿主只写诉求，读态收口在面板组件）。
 *
 * focusDate 空串 = 无下钻诉求的普通打开；openAt 写聚焦 + focusSeq 递增——
 * seq 而非日期作变化信号：同一日期重复点击（面板已开重选、关后再钻同日）也
 * 必须重发，日期比较会把它误判为「没变」。
 */
export const useReportArchiveStore = defineStore('reportArchive', {
  state: () => ({
    /** 日报历史面板可见性（两路入口共写） */
    open: false,
    /** 下钻聚焦日期 YYYY-MM-DD；空串 = 普通打开（面板默认选最新日） */
    focusDate: '',
    /** 聚焦递增代：面板 watch 它消费下钻诉求（同日重发也生效） */
    focusSeq: 0,
  }),
  actions: {
    /** 普通打开（通知中心头部入口）：清残留聚焦，面板选最新日 */
    openLatest() {
      this.focusDate = ''
      this.open = true
    },
    /** 下钻某日（热力图格子点击）：面板已开也重发（seq 递增驱动重选该日） */
    openAt(date: string) {
      if (!date) return
      this.focusDate = date
      this.focusSeq++
      this.open = true
    },
  },
})
