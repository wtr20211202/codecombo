/**
 * 重连补拉集中注册表（P-20261003-236）：WS 通道断线重连成功后「补拉各域状态」
 * 的 domain → refetch 函数注册表。
 *
 * 动机：补拉实现此前分散三处各自为政（useWebSocket 项目域 refetchAfterReconnect /
 * OpsChannelBridge watch opsConnected 手写 seedPending 清单 / notification store
 * onOpen 单行补拉），grep 难寻、新增域易漏。集中后：
 * - 新增域的断线补拉 = 域主模块装配期 `registerReconnectRefetch(domain, fn)` 一行
 *   （grep 本符号即全量清单，单点化）；
 * - 重连触发点一律调 `runReconnectRefetches()` 统一遍历执行，不再各自维护补拉清单。
 *
 * 内建六域（注册位随域主，装配期自动生效）：
 *   project      → composables/useWebSocket.ts（changes/branch/log/projects 四 store）
 *   approvals    → stores/approvals.ts（seedPending）
 *   asks         → stores/asks.ts（seedPending）
 *   notification → stores/notification.ts（loadHistory）
 *   terminals    → stores/terminal-sessions.ts（refresh，会话列表对账；
 *                  tab/pane 的 socket 重连仍归 TerminalPane/useTerminalReconnect UI 链）
 *   assistantTask → stores/assistantTask.ts（seedActive，task.progress 最近
 *                  上报快照对账——断线窗口期进度广播不可回放，P-20261004-120）
 *
 * 语义约定：
 * - 「重连」= 任一常驻通道恢复（项目 WS onOpen / ops 通道 connected false→true /
 *   通知 WS onOpen）。通道同生共死（同一次断网/休眠/后端重启），任一恢复即全表
 *   补拉一遍——各域 fn 必须幂等（内建域均为 id 幂等 upsert 或带 loading 态的
 *   幂等 GET），重复执行无害。
 * - 量级注记：全表 ≈ 8 个幂等 GET，重连风暴下随每次重连触发；重连本身有 3s/5s
 *   起步指数退避兜底（useWebSocketBase / useOpsChannel），沿用 useWebSocket
 *   P-20261001-19「不再加节流」的既有裁决。
 * - allSettled 语义收口为逐域 catch：单域失败不拖累其余域、不产生未处理
 *   rejection——下一轮断线重连会再补。
 * - 派发时序：fn 在触发点同步起跑（保持原 refetchAfterReconnect 语义——
 *   onOpen 返回前请求已发出），失败收口异步。
 * - 同域重复注册 = 覆盖（Map 语义），装配幂等。
 *
 * P-20261003-235 已在本注册表领取覆盖面锁定：哨兵单测
 * reconnectRefetch.coverage.test.ts 把注册表键数/键集与本文档清单锁成同一份
 * 事实（域增删必红，更新义务三处同步——本头注清单、哨兵 DOCUMENTED_DOMAINS、
 * e2e 恢复用例 ws-reconnect-refetch / ops-reconnect-refetch /
 * reconnect-refetch-coverage）；后续若落地锁定/解锁恢复链，同样以
 * runReconnectRefetches 为入口，新增域登记即自动入哨兵覆盖面。
 */

/** 单域补拉函数：同步或异步均可，返回值忽略，抛错/拒绝由遍历器逐域收口 */
export type ReconnectRefetchFn = () => unknown

const registry = new Map<string, ReconnectRefetchFn>()

/** 登记/覆盖一个域的重连补拉函数（域主模块装配期调用；同域重复注册覆盖） */
export function registerReconnectRefetch(domain: string, refetch: ReconnectRefetchFn): void {
  registry.set(domain, refetch)
}

/** 重连成功后统一遍历执行全部已注册域的补拉（重连触发点唯一入口） */
export function runReconnectRefetches(): void {
  for (const [domain, refetch] of registry) {
    try {
      // 同步起跑（fn 内部自管的 promise 照常自行落定）：保持原 refetchAfterReconnect
      // 的派发时序——onOpen 返回前 fetch 请求已发出。fn 的同步抛错与返回值
      // （含 promise 拒绝）统一走逐域 catch 收口
      void Promise.resolve(refetch()).catch((err) => {
        console.warn(`[reconnect-refetch] ${domain} 补拉失败:`, err)
      })
    } catch (err) {
      console.warn(`[reconnect-refetch] ${domain} 补拉失败:`, err)
    }
  }
}

/** 仅供测试：清空注册表（用例隔离；生产代码不得调用） */
export function resetReconnectRefetchRegistryForTest(): void {
  registry.clear()
}

/** 仅供测试/哨兵对账：当前已注册域清单（注册序） */
export function registeredReconnectDomains(): string[] {
  return [...registry.keys()]
}
