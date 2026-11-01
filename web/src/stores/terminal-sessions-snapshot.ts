import type { TerminalSessionInfo } from './terminal-sessions-model'

/**
 * terminals.changed 快照对账的已知值合并（自 terminal-sessions store 拆出，
 * 纯搬运零逻辑改动）：全量替换会话列表时，快照缺失字段落回本地已知值。
 */
export function mergeSnapshotList(
  list: Partial<TerminalSessionInfo>[],
  prev: TerminalSessionInfo[],
): TerminalSessionInfo[] {
  // 已知值兜底：创建响应先行的 runtime/runtimeVersion 与 meta 反查快照之间
  // 有异步落库窗口（P-20261003-134），缺失时保留已知值防闪断；currentDir
  // 同口径——服务端快照（P-20261004-59，跨标签页/恢复场景的慢路对账）优先，
  // 旧服务端快照无该字段时保留本连接 OSC 7 实时值（快路径），都不在则缺省
  const knownRuntime = new Map(prev.map(s => [s.id, s.runtime]))
  const knownRuntimeVersion = new Map(prev.map(s => [s.id, s.runtimeVersion]))
  const knownCurrentDir = new Map(prev.map(s => [s.id, s.currentDir]))
  // 初始指令（P-20261003-146）同口径兜底：创建响应先行的值与异步 meta 落库
  // 之间存在竞态窗口；该字段创建后不变更，已知值兜底无过期风险
  const knownInitialPrompt = new Map(prev.map(s => [s.id, s.initialPrompt]))
  // 编队批元数据（P-20261005-145）同 initialPrompt 口径：创建后不变更，
  // 已知值兜底（旧服务端快照无该键时保留本地已知值，升级兼容不闪断）
  const knownFleetBatch = new Map(prev.map(s => [s.id, s.fleetBatch]))
  // 身份标记（P-20261023-3）同 initialPrompt 口径：创建后不变更，已知值兜底
  //（创建响应先行 vs meta 异步落库竞态窗口，防徽标闪断）
  const knownDerived = new Map(prev.map(s => [s.id, s.derived]))
  const knownResumed = new Map(prev.map(s => [s.id, s.resumed]))
  return list
    .filter(s => typeof s.id === 'string')
    .map(s => ({
      id: s.id as string,
      name: s.name || '',
      kind: s.kind || 'shell',
      projectId: s.projectId || '',
      path: s.path || '',
      createdAt: s.createdAt || '',
      runtime: s.runtime ?? knownRuntime.get(s.id as string),
      runtimeVersion: s.runtimeVersion ?? knownRuntimeVersion.get(s.id as string),
      currentDir: s.currentDir ?? knownCurrentDir.get(s.id as string),
      // 服务端活动时钟（P-20261003-192）：服务端权威真值直传（不本地兜底——
      // 活动时刻随时间前进，残留旧值会误导「最近活动」显示）；缺 key = 未知
      lastActivity: s.lastActivity,
      // 敏感标记（P-20261003-155）：服务端权威真值，不本地兜底——快照缺 key
      // 即未标记（服务端只置位携键），本地残留 true 会让闸门误报
      sensitive: s.sensitive === true,
      // 初始指令（P-20261003-146）：创建后不变更，已知值兜底（见上注）
      initialPrompt: s.initialPrompt ? String(s.initialPrompt) : knownInitialPrompt.get(s.id as string),
      // 编队批元数据（P-20261005-145）：服务端权威真值优先，已知值兜底
      fleetBatch: s.fleetBatch ?? knownFleetBatch.get(s.id as string),
      // 身份标记（P-20261023-3）：置位携键语义，创建后不变更已知值兜底
      derived: s.derived === true ? true : knownDerived.get(s.id as string),
      resumed: s.resumed === true ? true : knownResumed.get(s.id as string),
      origin: s.origin,
    }))
}
