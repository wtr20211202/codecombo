import i18n from '../i18n'
import { useNotificationStore } from '../stores/notification'
import { usePreviewPortStore, isValidPreviewPort } from '../stores/previewPort'
import { tunnelApi } from '../api/domains/remote'
import type { PreviewPortDetail } from './opsEvents'

/**
 * 预览端口直达通知链（P-20261002-70）：preview.port 事件 → 去重 →
 * 悬浮球快捷按钮登记 + 通知中心入账（带 action='preview' 动作，点击经
 * pendingAction 链直达底部预览面板）。
 * P-20261002-83 扩展：source='detected'（终端输出被动探测命中）走弱化文案
 *（标题「检测到本地服务 :N」），与 agent 主动上报区分；探测先到、agent 实报
 * 后到的同端口升级为正式样式（不重复入账通知）。
 * P-20261004-5 扩展：载荷带 hostId（服务跑在远程主机终端）→ 登记后异步开
 * SSH 隧道补挂映射，面板打开走本机映射口并展示「remote:N → local:M」徽标。
 * 逻辑独立成纯函数模块：不持有视图状态，OpsChannelBridge 仅委托一行——
 * 与 agentTaskNotify（P-20261002-15）同构，组件拆分（P-27）时随事件桥整体迁移。
 */

// —— 会话内去重：同 port+label+hostId 只入账一次（agent 重试/WS 重连可能
// 重复送达；服务重启换端口或 label 变更视为新上报）。全页面会话生效，无时间窗
// ——端口级事实不随时间翻新。指纹表模块级（多标签页各自一份）；上限防长会话
// 无界增长（同 endFingerprints 惯例）
const reportedFingerprints = new Set<string>()
const FP_MAX = 200

function markReported(key: string): void {
  reportedFingerprints.add(key)
  if (reportedFingerprints.size > FP_MAX) {
    const first = reportedFingerprints.values().next()
    if (!first.done) reportedFingerprints.delete(first.value)
  }
}

// 测试钩子：清空模块级状态（用例间隔离）
export function resetPreviewPortNotifyStateForTest(): void {
  reportedFingerprints.clear()
}

/**
 * 通知链入口（OpsChannelBridge 对每个 preview.port 事件调用一次）：
 * 非法端口静默忽略（服务端已校验，此处防其它来源）；重复上报整链跳过。
 * 返回 true = 本次已处理（登记 + 入账），false = 忽略或去重命中
 */
export function handlePreviewPortNotify(p: PreviewPortDetail): boolean {
  if (!isValidPreviewPort(p.port)) return false
  const label = (p.label || '').slice(0, 64)
  // 来源：仅认服务端标注的 detected（其余值一律按 agent 主动上报处理）
  const detected = p.source === 'detected'
  // hostId（P-20261004-5）：服务在远程主机终端里，port 是远端回环端口——
  // 指纹含 hostId，本机端口与远端同号端口互不误伤
  const hostId = (p.hostId || '').trim()
  const key = `${p.port}|${label}|${hostId}`
  const previewPort = usePreviewPortStore()
  if (reportedFingerprints.has(key)) {
    // 去重命中不重复入账；唯一例外：探测（弱化）先到、agent 实报后到 →
    // 悬浮球样式升级为正式上报，通知不再发一条（同端口事实不翻新）
    if (!detected && previewPort.source === 'detected') {
      previewPort.report(p.port, label)
    }
    return false
  }
  markReported(key)

  previewPort.report(p.port, label, detected ? 'detected' : '')
  // 远程端口：登记后异步开隧道补挂映射（不阻塞通知链；开失败静默降级为
  // 直开远端端口——面板照常呈现不可达，上报本身不被吞）
  if (hostId) void bridgeTunnelPreview(p.port, hostId)

  // 通知中心入账：后端失败 store.add 自动降级本地插入。归类 task（agent 上报链
  // 与任务终态通知同门类，「任务」子开关一并管辖）；动作 preview → 面板直达。
  // 探测命中文案走「检测到」弱化变体（来源归属如实：不是 agent 说的）
  const t = (k: string, params?: Record<string, unknown>) => i18n.global.t(k, params as never)
  void useNotificationStore().add({
    type: 'info',
    category: 'task',
    title: label
      ? t(detected ? 'notify.preview.detectedTitleLabeled' : 'notify.preview.titleLabeled', { port: p.port, label })
      : t(detected ? 'notify.preview.detectedTitle' : 'notify.preview.title', { port: p.port }),
    body: t(detected ? 'notify.preview.detectedBody' : 'notify.preview.body'),
    action: 'preview',
    actionPayload: String(p.port),
  })
  return true
}

/**
 * 远程端口隧道桥（P-20261004-5）：POST tunnels 拿本机映射口补挂 store。
 * 异步间隙新上报可能已顶掉本条（store 单槽位）——仅当仍为本端口时挂载。
 * 失败静默（面板直开远端端口呈不可达，用户重报即重试）
 */
async function bridgeTunnelPreview(remotePort: number, hostId: string): Promise<void> {
  try {
    // 响应拦截器已解包：res 即 { data: TunnelInfo }（同 useRemoteConsoleTabs 断言惯例）
    const res = await tunnelApi.open(hostId, remotePort) as unknown as { data?: { localPort?: number } }
    const previewPort = usePreviewPortStore()
    if (previewPort.port === remotePort && res.data?.localPort) {
      previewPort.attachTunnel(hostId, remotePort, res.data.localPort)
    }
  } catch (err) {
    console.warn('[previewPort] tunnel open failed, degrade to direct port', err)
  }
}
