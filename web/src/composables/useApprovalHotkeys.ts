import { onBeforeUnmount, onMounted } from 'vue'
import { useApprovalsStore } from '../stores/approvals'
import { hasBlockingOverlay } from '../utils/overlayGuard'

/**
 * 审批卡键盘裁决（P-20261003-1）：待裁决卡在屏时全局 1/2/3 三选直达
 * （1=允许一次 / 2=完全允许 / 3=拒绝），高危裁决键盘化，agent 工作流全程
 * 手不离键盘。bubble 相位监听即可——裸数字与全部既有全局键位无冲突（布局
 * 数字直达 Ctrl/Cmd+1..9 是 capture 相位且带修饰键，useLayoutKeyboard）。
 *
 * - 守卫（零误触面）：焦点在可编辑面（INPUT/TEXTAREA——含 Monaco inputarea
 *   与 xterm 的 textarea，裸数字是正文键入）/ contentEditable / 组合键修饰 /
 *   IME 合成中 / 已被前置链消费（defaultPrevented）/ 模态弹层在场（裁决卡被
 *   压在下面，按键不隔空生效——hasBlockingOverlay 让位，同 useLayoutKeyboard
 *   isDialogOpen 语义）时一律放行不接管
 * - 目标卡：pendingList 首张（卡片堆 v-for 同源渲染，屏上首卡即裁决对象；
 *   审批 id 为非数字字符串，插入序即展示序，多卡先清首张再逐张）
 * - 键 2（完全允许）不直接落账：走宿主注入的 requestAllowAlways 打开该卡
 *   Popconfirm 二次确认（P-20261002-126 全局语义防护原样保留，误触不静默
 *   放开安全面）
 * - 裁决动作由宿主注入（而非此处调 useApprovalActions）：本组合式只做键位
 *   判定与监听管理，toast/路由等注入依赖留在宿主（deps 注入同 useLayoutKeyboard，
 *   单测免 naive-ui provider）
 */

/** 键位 → 裁决动作（宿主注入；requestAllowAlways 为二次确认入口非直接落账） */
export interface ApprovalHotkeyActions {
  allowOnce: (id: string) => void
  requestAllowAlways: (id: string) => void
  deny: (id: string) => void
}

/** 焦点在可编辑面（输入框/文本域/contentEditable）→ 裸数字是正文键入，
 *  不接管。导出纯函数供单测 */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
}

/** 1/2/3 → 裁决动作解析（纯函数供单测）：命中返回对应动作，任一守卫不满足
 *  返回 null 放行（不消费按键） */
export function approvalHotkeyDecision(
  e: KeyboardEvent,
  actions: ApprovalHotkeyActions,
): ((id: string) => void) | null {
  // 组合键各有归宿（布局数字直达/浏览器标签页切换/输入法），热键只认裸键
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null
  // IME 合成中的数字是候选输入；前置链已消费（preventDefault）不重复接管
  if (e.isComposing || e.defaultPrevented) return null
  if (isEditableTarget(e.target)) return null
  // 模态/抽屉/下拉在场：裁决卡被压在弹层下，键盘不该隔空改后台状态
  if (hasBlockingOverlay()) return null
  switch (e.key) {
    case '1': return actions.allowOnce
    case '2': return actions.requestAllowAlways
    case '3': return actions.deny
    default: return null
  }
}

/** 审批热键全局监听（宿主 ApprovalCards，App 根常驻挂载即全局生效） */
export function useApprovalHotkeys(actions: ApprovalHotkeyActions): void {
  const approvals = useApprovalsStore()

  function onKeyDown(e: KeyboardEvent): void {
    if (approvals.pendingCount === 0) return
    const decide = approvalHotkeyDecision(e, actions)
    const first = approvals.pendingList[0]
    if (!decide || !first) return
    e.preventDefault()
    decide(first.id)
  }

  onMounted(() => document.addEventListener('keydown', onKeyDown))
  onBeforeUnmount(() => document.removeEventListener('keydown', onKeyDown))
}
