import { ref } from 'vue'
import { safeStorage } from '../utils/storage'

/**
 * 审批卡首触说明（P-20261003-311）：审批流是本产品核心交互，新用户的第一张
 * 审批卡是懵的——agent 为什么突然停了？「允许/拒绝」各意味什么？手册面向
 * agent 不面向用户。首次出现审批卡（localStorage 一次性标记，键
 * APPROVAL_GUIDE_DISMISS_KEY）时在卡顶展示三行说明条；「不再显示」落标记后
 * 永不重现。多设备各自首次是本地标记语义的自然结果（可接受，提案已注明）。
 *
 * 状态为模块级单例（useLocaleSuggest / useHttpWarning 同款）：dismiss 写
 * safeStorage（屏蔽 Cookie / 隐私模式自动落内存兜底，会话内生效），刷新/
 * 重开不再出现；说明条本体与展开/收起交互在 ApprovalGuideBar（全局卡堆与
 * 值班大屏两处宿主共用，同标记键）。
 */

/** 一次性标记键（「不再显示」；进 safeStorage 体系，禁裸 localStorage） */
export const APPROVAL_GUIDE_DISMISS_KEY = 'sc.approvalGuideDismissed'

// 模块级共享「已不再显示」记忆：存储读取非响应式，启动时读一次入 ref——
// dismiss 即时翻转为真（同帧消失，不等存储回读），跨宿主（全局卡堆/大屏）
// 同源一致
const dismissed = ref(safeStorage.getItem(APPROVAL_GUIDE_DISMISS_KEY) === '1')

export function useApprovalGuide() {
  /** 「不再显示」：写一次性记忆，此后说明条不再出现（两宿主同标记键） */
  function dismiss(): void {
    dismissed.value = true
    safeStorage.setItem(APPROVAL_GUIDE_DISMISS_KEY, '1')
  }

  return { dismissed, dismiss }
}
