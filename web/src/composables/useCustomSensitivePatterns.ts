import { settingsApi } from '../api/domains/system'
import { setCustomSensitivePatterns } from '../utils/sensitiveMask'

/**
 * 自定义敏感模式的前端同步（P-20261006-11）：从 GET /settings 拉取
 * customSensitivePatterns 注入 utils/sensitiveMask 的模块级编译态——注入后
 * 遮蔽链（回放兜底/审批卡面/接力摘要/录制渲染）与会话出域检测全部消费点
 * 自动生效，无需各自感知。
 *
 * 刷新时机由宿主编排（useTerminalDangerGate 的设置开关缓存同款惯例）：
 * OpsChannelBridge 挂载首拉 + settings.changed 广播跟随（他端/agent 改设置
 * 亦到达），设置页保存成功后就地刷新（不依赖广播往返）。拉取失败静默保旧
 * ——遮蔽是安全兜底面，旧列表总好过空列表（模式是追加防护非撤销语义）。
 * 旧服务端无该字段回落空数组 = 纯通用表现状。
 */
export async function refreshCustomSensitivePatterns(): Promise<void> {
  try {
    const res: any = await settingsApi.get()
    const list: string[] = Array.isArray(res?.data?.customSensitivePatterns)
      ? res.data.customSensitivePatterns
      : []
    setCustomSensitivePatterns(list)
  } catch { /* 拉取失败保旧列表（或初始空），静默 */ }
}
