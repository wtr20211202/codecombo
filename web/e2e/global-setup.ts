// e2e 目标实例版本对账（P-20261004-50）——「打错实例」整类假败的套件前 fail-fast。
//
// 动机：playwright.config 的 baseURL 静默缺省 :9999，worktree 执行器漏配
// PLAYWRIGHT_BASE_URL 时全部用例打在主实例旧代码上，曾致多轮用例假败浪费
// 整轮归因。此处在套件启动前 GET <baseURL>/api/meta（公开只读端点）取构建
// commit 与 git rev-parse HEAD 机器核对，不一致立即抛错终止套件（报错含两
// hash 与修复指引）。globalSetup 每套件仅跑一次，对账单请求毫秒级无感。
//
// 降级边界（宁漏判不误拦，三类只 console 注记继续）：
//   ① meta 不可达——dev-server 形态（vite dev 无后端）或实例未起，属预期；
//   ② 实例 commit 未注入——裸 go build 落 main.go 默认值 none/unknown/空；
//   ③ 当前目录非 git 仓库（读不到 HEAD）。
// 显式逃生口 SC_E2E_SKIP_VERSION_GUARD=1：确需对旧实例跑用例时自担风险跳过。
// 实例侧 commit 事实源由 scripts/e2e-restart.sh / wsl-e2e.sh 构建期 ldflags
// 注入（build.sh 主链路同法），否则本守卫会因「未注入」恒跳过成死代码。
import { execSync } from 'node:child_process'

// 未注入构建信息时实例会报的值（main.go: commit="none"、build.sh git 失败兜底 "unknown"、空串防御）
const UNINJECTED_COMMITS = new Set(['', 'none', 'unknown'])

// 对账请求超时：本机回环正常毫秒级；死端口 connection refused 即返，5s 封顶防挂死套件
const META_TIMEOUT_MS = 5000

// 默认解锁密码（与 tests/helpers.ts DEFAULT_PASSWORD 同值；global-setup 保持
// 零 src/助手层依赖，不 import——本文件职责是毫秒级对账，引助手层会拖入
// store 链与 expect 运行时）
const E2E_LOCK_PASSWORD = 'admin'

/**
 * userPrefs 漫游面套件级复位（P-20261007-1）：键位覆盖/通知三件/终端复制选中/
 * 终端主题跟随自本提案起是服务端全局态（settings 单键 userPrefs，各端启动首拉
 * 应用）——上个套件经 UI 写路径留下的偏差会泄入后续运行，打破既有 spec「偏好
 * 随浏览器上下文隔离」的假设。套件开始前 PUT null 恢复「服务端从未配置」形态
 *（null 而非 {}：null 让启动首拉走播种分支，本地种子用例不被空真值清掉；
 * 各 spec 的逐 context 复位见 tests/helpers.ts gotoAndUnlock）。已未配置时短路
 * （零写入）；失败只注记不拦截（同本模块降级哲学——复位失败时残留偏差属
 * 「定向 spec 首拉断言可能受扰」级风险，不升级为套件阻断）。
 */
async function resetUserPrefs(baseURL: string): Promise<void> {
  try {
    const unlock = await fetch(`${baseURL}/api/lock/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: E2E_LOCK_PASSWORD }),
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    })
    if (!unlock.ok) {
      console.log(`[e2e-meta] userPrefs 套件级复位跳过：解锁失败 HTTP ${unlock.status}`)
      return
    }
    const token = ((await unlock.json()) as { token?: string }).token || ''
    const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }
    const get = await fetch(`${baseURL}/api/settings`, { headers, signal: AbortSignal.timeout(META_TIMEOUT_MS) })
    const current = ((await get.json()) as { data?: { userPrefs?: unknown } }).data?.userPrefs ?? null
    if (current === null) return
    const res = await fetch(`${baseURL}/api/settings`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ userPrefs: null }),
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    })
    console.log(`[e2e-meta] userPrefs 套件级复位：${res.ok ? '残留偏差已清空回未配置' : `PUT 失败 HTTP ${res.status}（继续——残留偏差可能扰启动首拉）`}`)
  } catch (err) {
    console.log(`[e2e-meta] userPrefs 套件级复位跳过：${err instanceof Error ? err.message : String(err)}`)
  }
}

// baseURL 解析单点——playwright.config 的 use.baseURL 与本对账同源，
// 「|| :9999 静默缺省」只写这一处（尾部 / 归一，防拼出 //api/meta）
export function resolveBaseURL(): string {
  return (process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999').replace(/\/+$/, '')
}

// 当前仓库 HEAD；playwright 各入口（e2e-worktree/e2e-full/e2e-cross）均 cd web/
// 后运行，git 向上找仓库根天然兼容 worktree（即 worktree 分支头）
function gitHead(): string | null {
  try {
    const out = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
    return out.toString().trim() || null
  } catch {
    return null
  }
}

// 取目标实例构建 commit；不可达时返回 reason（HTTP 状态/网络错误文案），供跳过注记
async function fetchInstanceCommit(baseURL: string): Promise<{ commit: string; reason: string }> {
  try {
    const resp = await fetch(`${baseURL}/api/meta`, { signal: AbortSignal.timeout(META_TIMEOUT_MS) })
    if (!resp.ok) return { commit: '', reason: `HTTP ${resp.status}` }
    const body = (await resp.json()) as { version?: { commit?: unknown } }
    const commit = body?.version?.commit
    return { commit: typeof commit === 'string' ? commit.trim() : '', reason: '' }
  } catch (err) {
    return { commit: '', reason: err instanceof Error ? err.message : String(err) }
  }
}

export default async function globalSetup(): Promise<void> {
  const baseURL = resolveBaseURL()

  if (process.env.SC_E2E_SKIP_VERSION_GUARD === '1') {
    console.log('[e2e-meta] 版本对账已按 SC_E2E_SKIP_VERSION_GUARD=1 显式跳过（打错实例风险自担）')
    return
  }

  const head = gitHead()
  if (!head) {
    console.log('[e2e-meta] 版本对账跳过：当前目录不在 git 仓库内（读不到 HEAD）——不拦截继续')
    return
  }

  const { commit, reason } = await fetchInstanceCommit(baseURL)
  if (reason) {
    console.log(`[e2e-meta] 版本对账跳过：${baseURL}/api/meta 不可达（${reason}；dev-server 无后端属预期形态）——不拦截继续`)
    return
  }
  if (UNINJECTED_COMMITS.has(commit.toLowerCase())) {
    console.log('[e2e-meta] 版本对账跳过：目标实例未注入构建 commit（裸 go build 的 dev 形态）——不拦截继续')
    return
  }
  if (commit === head) {
    console.log(`[e2e-meta] 版本对账通过：${baseURL} @ ${commit.slice(0, 12)} == 当前 HEAD`)
    // 对账通过（确认打在右实例）才做漫游面复位——错配实例在下方直接终止，不触碰
    await resetUserPrefs(baseURL)
    return
  }

  // 注意：工作树提交发生建后会使守卫误拦「内容已含 WIP 的旧 hash 实例」——
  // 按仓库流程 e2e 先于提交跑，此形态应由 e2e-restart 重建消除；报错指引即修复路径
  throw new Error(
    [
      `[e2e-meta] 目标实例与当前仓库 HEAD 不一致——打错实例防护（P-20261004-50），套件终止：`,
      `  目标实例 ${baseURL} 运行 commit: ${commit}`,
      `  当前仓库 HEAD            : ${head}`,
      `  修复：① 设 PLAYWRIGHT_BASE_URL=<本 worktree 槽位实例>（scripts/e2e-worktree.sh 会自动设）；`,
      `        ② 或 bash scripts/e2e-restart.sh [web] <端口> <仓库目录> 重建实例后再跑。`,
      `  （确需对旧实例跑用例：SC_E2E_SKIP_VERSION_GUARD=1 显式跳过本守卫）`,
    ].join('\n'),
  )
}
