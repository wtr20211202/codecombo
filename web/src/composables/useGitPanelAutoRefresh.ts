import { onBeforeUnmount } from 'vue'

/**
 * git 面板自动刷新（P-20261003-74 + P-20261004-81 + P-20261005-7）：
 * agent/人在终端跑 git 写类命令后，分支面板/变更面板不自知——用户切回来看的是旧数据
 * （fsnotify 跳过 .git，索引/引用类操作不产生 file.changed；branch.changed 等服务端
 * 广播只有 gitops API 链路语义，终端命令不经过 execGit）。感知链三路并轨本窗口事件：
 * 1. 前端终端 OSC 133 D 事件：useTerminalSession 对写类命中命令派发（shell 集成会话，
 *    人在终端敲命令的形态；useWebSocket.test.ts 有同链断言）；
 * 2. 服务端 git.activity 定向广播（P-20261004-81）：readLoop 输出嗅探命中经 busbridge
 *    落项目 WS，useWebSocket 转发本事件——TUI 运行时（claude/codex）内部子进程调 git
 *    不发 OSC 133，此路是面板秒级感知的唯一链（不依赖终端 pane 挂载）；
 * 3. WS 重连补拉同谓词顺带派发（P-20261005-7）：useWebSocket onOpen 在补拉触发点
 *    （真重连 / 离线进入后的首开）随补拉一并派发——面板是独立 fetch 链不读
 *    branch/changes store，store 补拉惠及不到它，断线窗口期外部（远端/他设备）
 *    的 git 改动只有面板自己拉才可见；项目切换不派发（切换链自会拉取），在线
 *    首开的冗余派发由面板侧去抖合并（幂等 GET），同 P-19 对四 store 的既有裁决。
 * 各面板经 useGitPanelAutoRefresh 挂监听，去抖后复用各自既有 fetch。
 */

/** 面板自动刷新窗口事件名（模块级单例，无 payload——面板只管刷自己的数据） */
export const GIT_PANEL_AUTO_REFRESH = 'sc:git-panel-autorefresh'

/** 去抖窗口：连续命令（git add -A && git commit 等高频连发）合并为单次拉取 */
export const GIT_PANEL_REFRESH_DEBOUNCE_MS = 1000

/**
 * git 写类命令白名单：命中才触发刷新——读类命令（status/log/diff/grep…）高频
 * 且不改变面板数据。在提案原表（branch/checkout/commit/tag/push/pull/merge/rebase/
 * stash）上补三类同族命令：switch（checkout 的现代形态）、add/reset（搬移索引/HEAD，
 * 只动 .git 不产生 file.changed，是变更面板 stale 的主源）。后续同类命令在此追加即可
 */
const GIT_WRITE_COMMANDS: ReadonlySet<string> = new Set([
  'add', 'branch', 'checkout', 'commit', 'merge', 'pull', 'push', 'rebase', 'reset', 'stash', 'switch', 'tag',
])

/** 带独立值的全局 git 选项：识别子命令时须连同值一起跳过（git -c k=v commit） */
const GIT_GLOBAL_OPTS_WITH_VALUE: ReadonlySet<string> = new Set([
  '-c', '-C', '--exec-path', '--git-dir', '--work-tree', '--namespace', '--super-prefix',
])

/**
 * 判断一条终端命令行是否为 git 写类命令：按 shell 复合分隔符切段后逐段识别
 * `git [全局选项] <写类子命令>`，容忍 VAR=value 环境变量前缀。识别从宽——
 * 复合命令（git add -A && git commit）切段的每一段独立判定；误识别（如
 * `git -C add …` 把路径当子命令）的代价只是一次幂等刷新，漏识别则面板保持旧数据
 */
export function isGitWriteCommand(commandLine: string): boolean {
  for (const seg of commandLine.split(/&&|\|\||;|\|/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean)
    let i = 0
    // 剥离 VAR=value 环境变量前缀（GIT_AUTHOR_NAME=x git commit）
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++
    if (tokens[i] !== 'git') continue
    i++
    // 跳过全局选项：自含式（--git-dir=x / --no-pager）只消费自身；带独立值的
    // （-c k=v / -C path）连同值 token 一起消费。带值选项的值若恰为写类词会被
    // 误命中，接受（见上「识别从宽」）
    while (i < tokens.length && tokens[i]!.startsWith('-')) {
      const opt = tokens[i]!
      i++
      if (GIT_GLOBAL_OPTS_WITH_VALUE.has(opt) && i < tokens.length) i++
    }
    const sub = tokens[i]
    if (sub && GIT_WRITE_COMMANDS.has(sub)) return true
  }
  return false
}

/**
 * 服务端 git 状态缓存 TTL（对齐 server/api/gitops/status_cache.go gitStatusCacheTTL）：
 * /status 等 gitops 读端点按仓库缓存 3s，且只在删项目时失效——终端里的 git 写命令
 * 不经 execGit，无法触发服务端失效钩子，因此紧邻上一轮拉取（<3s）的自动刷新会命中
 * 旧缓存。首拉仍用 1s 去抖（多数场景距上次采集已超 TTL，即时正确）；每轮拉取后再
 * 排一次 TTL 窗口外的兜底拉取，保证最迟 ~4.3s 收敛到真值
 */
export const GIT_STATUS_CACHE_TTL_MS = 3000
export const CATCHUP_DELAY_MS = GIT_STATUS_CACHE_TTL_MS + 300

/**
 * 面板侧自动刷新监听（须在组件 setup 内调用，卸载时随作用域移除）：
 * 命中事件 → 尾沿去抖（防刷新风暴）→ 复用面板既有 fetch（refresh 参数）。
 * - in-flight 期间再命中不丢事件：记 pending，本轮完成后补一轮——命令完成晚于
 *   上轮 fetch 启动时，其效果仍需一次拉取才能上屏
 * - 每轮拉取（兜底轮除外）后追加一次 TTL 窗口外的兜底拉取，治「连续命令后第二
 *   轮拉取命中服务端 3s 状态缓存旧值」；兜底轮不再续排，收敛即止不轮询
 * - 与面板自操作后的手动刷新正交：手动链零改动，自动拉取自身带 in-flight 去重，
 *   同 tick 手动+自动重叠时最多多一次幂等 GET
 */
export function useGitPanelAutoRefresh(refresh: () => unknown | Promise<unknown>): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let catchupTimer: ReturnType<typeof setTimeout> | null = null
  let inFlight = false
  let pendingAfterFlight = false

  function schedule(): void {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void run()
    }, GIT_PANEL_REFRESH_DEBOUNCE_MS)
  }

  function armCatchup(): void {
    if (catchupTimer !== null) clearTimeout(catchupTimer)
    catchupTimer = setTimeout(() => {
      catchupTimer = null
      void run(true)
    }, CATCHUP_DELAY_MS)
  }

  async function run(isCatchup = false): Promise<void> {
    if (inFlight) {
      pendingAfterFlight = true
      return
    }
    inFlight = true
    try {
      await refresh()
    } catch {
      /* 拉取失败静默：面板既有错误链路（axios 拦截器）已统一处理 */
    } finally {
      inFlight = false
      if (pendingAfterFlight) {
        pendingAfterFlight = false
        schedule()
      } else if (!isCatchup) {
        armCatchup()
      }
    }
  }

  window.addEventListener(GIT_PANEL_AUTO_REFRESH, schedule)
  onBeforeUnmount(() => {
    window.removeEventListener(GIT_PANEL_AUTO_REFRESH, schedule)
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (catchupTimer !== null) {
      clearTimeout(catchupTimer)
      catchupTimer = null
    }
  })
}
