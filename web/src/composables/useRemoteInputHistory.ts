import { terminalApi } from '../api/client'
import { useProjectStore } from '../stores/project'
import { feedRemoteInputChunk, newRemoteInputBuffer } from '../utils/remoteInputLines'

/**
 * 远程控制台输入域命令历史采集器（P-20261005-188）。
 *
 * 远程 shell（SSH PTY）无 shell integration，前端 terminalOscFrames 解析链对
 * 远程流天然无效——采集走输入侧务实退路：宿主 onData 收口（P-91 只读锁同款
 * 收口位置）在写入 WS 前截获按键流，行缓冲按回车分条提交，上报
 * source=input + host=主机键。语义诚实边界（utils/remoteInputLines 头注释）：
 * 条目是「提交的输入行」，无 exitCode/时长，消费面以来源徽标自明。
 *
 * 上报纪律与 OSC 133 D 链（useTerminalOscBridge.recordCommandHistory）一致：
 * fire-and-forget、失败仅 console.debug、不重试、不阻塞输入路径。落库侧
 * 敏感命令整条跳过（store sensitiveCmdRe）与总开关（服务端 settings）在
 * Append 端点统一生效，本层不做二次判定。
 *
 * 已知采集盲区（输入域固有）：inputGate 接管的 chunk（高危确认卡裁决后经
 * sendRawToSession 直发）不经 onData 收口，不记——高危命令本就该人工在场。
 */
export function createRemoteInputHistoryCollector(options: {
  /** 远程主机键（pane 生命周期内稳定） */
  hostId: () => string
  /** 远程会话 id：条目会话归属（terminalId，与本地条目同锚点语义） */
  sessionId: () => string
}) {
  const projectStore = useProjectStore()
  const buf = newRemoteInputBuffer()
  let disposed = false

  /** onData 收口注入点（observe-only，不返回、不拦截、不改写数据） */
  function tap(_sessionId: string, data: string): void {
    if (disposed) return
    // 远程命令与当前项目文档共存（提案口径：远程管理从项目页进入，存在当前
    // 项目）；无项目归属无处落盘，静默跳过（fire-and-forget 域不报错）
    const projectId = projectStore.currentProjectId
    if (!projectId) return
    for (const command of feedRemoteInputChunk(buf, data)) {
      // exitCode/durationMs 恒 0：输入域无此数据，消费面按 source=input 显示「—」
      terminalApi
        .recordHistory(projectId, {
          command,
          exitCode: 0,
          durationMs: 0,
          terminalId: options.sessionId(),
          source: 'input',
          host: options.hostId(),
        })
        .catch((err: unknown) => {
          console.debug('record remote input history failed', err)
        })
    }
  }

  /** 会话终态清理：未提交的半截行随会话丢弃（无回车不记） */
  function dispose(): void {
    disposed = true
    buf.line = ''
    buf.poisoned = false
  }

  return { tap, dispose }
}
