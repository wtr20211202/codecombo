import { ref } from 'vue'
import { useAgentTerminal } from './useAgentTerminal'

/**
 * 联邦会话派发入口桥（P-20261004-101）：入口动作与 NewSessionDialog 之间的
 * 模块级单例信号（useAgentChain.openChainContinue 同范式）。
 *
 * 入口两路：
 *   - NewSessionDialog「目标实例」下拉（本机缺省 / 各注册实例，可用态徽标）
 *   - fleet 总览行动作「在此实例新建会话」——对话框宿主 AgentTerminalView 是
 *     惰性挂载（宿主 v-if），fleet 弹层持有时它可能不存在，两级信号送达：
 *     `requestDispatchDialog` 置 pendingTarget + 递增 openRequest + open('docked')
 *     拉起管理页；View 挂载/存续期间 watch openRequest 打开对话框，
 *     对话框消费 pendingTarget 预选目标实例
 */

/** 待预选的目标实例 id（空串 = 无预选；消费即清，防残留意图污染后续打开） */
const pendingTarget = ref('')
/** 对话框打开请求代数：先于 View 挂载到达的请求经 immediate watch 补消费
 *  （导出为 watch 源；消费进度经 consumeDispatchRequest 模块级推进） */
const openRequest = ref(0)
/** 已消费代数（模块级）：View 是惰性挂载可随实例切换 remount，消费进度
 *  必须跨 remount 存活——否则旧请求在新挂载树上被二次消费、对话框幽灵自开 */
let consumedRequest = 0

/** fleet 总览行动作入口：拉起智能体管理页并打开对话框、预选目标实例 */
export function requestDispatchDialog(instanceId: string): void {
  pendingTarget.value = instanceId
  openRequest.value++
  // docked 形态拉起管理页（项目上下文内嵌主区 / home 全屏 overlay）——
  // 挂载后 openRequest 立即被消费，无感衔接
  void useAgentTerminal().open('docked')
}

/** 消费一次打开请求：有未消费请求返回目标实例 id（空串 = 无预选本机），
 *  无则返回 null（调用方不开对话框）。消费即推进模块级进度并清预选 */
export function consumeDispatchRequest(): string | null {
  if (openRequest.value <= consumedRequest) return null
  consumedRequest = openRequest.value
  const target = pendingTarget.value
  pendingTarget.value = ''
  return target
}

/** 打开请求代数（对话框宿主 View 的 watch 源） */
export const dispatchOpenRequest = openRequest
