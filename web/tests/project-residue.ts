import fs from 'node:fs'
import path from 'node:path'
import { API_BASE } from './api-base'
import { DEFAULT_PASSWORD } from './helpers'

/**
 * e2e 项目残留清理 + 测试项目注册的公共实现（clone 域自愈式清理）。
 *
 * 背景：clone-flow / push-dialog 注册的 e2e 项目散落在共享父目录（D:/workspace/
 * go/coding）下，运行中断（崩溃/Ctrl-C/重试）会让 afterAll 清理不执行——残留
 * 项目卡在首页累积（40 项目 × git 子进程风暴拖慢首页），rmSync 失败的目录更是
 * 注册删掉后沦为无人认领的孤儿，目录层只增不减。
 *
 * 双端调用约定：beforeAll 清历史残留（上次中断留给本次的尾巴 + 孤儿目录），
 * afterAll 清本次尾巴——spec 中断也不留残留给下次。与 P-48 播种互补：播种管
 * 实例启动态的金态重建，本 helper 管运行中中断的残留。
 *
 * 不可抗跳过（锁定态无法解锁等）不阻塞用例判定：console.warn 记录原因与残留
 * 路径（Playwright 报告 stdout 可见），绝不盲试密码——解锁失败会写审计，连续
 * 3 次失败还触发 IP 限流 + 通知中心告警，污染共享实例的可观测面。
 */

export interface ResidueCleanupResult {
  /** 已删除的注册项目数 */
  removedProjects: number
  /** rmSync 失败的磁盘目录清单（被占用等），已 console.warn 逐条列出 */
  failedDirs: string[]
  /** 无法清理的原因（锁定态不可解锁/实例不可达），此时注册与磁盘均未触碰 */
  blockReason?: string
}

interface LockStateView {
  enabled?: boolean
  needsSetup?: boolean
  isDefaultPassword?: boolean
}

/**
 * 按锁定状态解析可写项目 API 的请求头（锁定开启时含解锁 token）。
 * 先查 /api/lock/state 判默认密码再决定是否解锁；返回 blockReason 表示当前
 * 锁定态下项目 API 不可写，调用方应跳过清理/注册并记录原因。
 */
async function resolveLockHeaders(): Promise<{ headers: Record<string, string>; blockReason?: string }> {
  let state: LockStateView
  try {
    const res = await fetch(`${API_BASE}/api/lock/state`)
    state = (await res.json()) as LockStateView
  } catch (err) {
    return { headers: {}, blockReason: `GET /api/lock/state 失败（实例不可达？）：${String(err)}` }
  }
  // needsSetup：后端从未初始化锁定配置——项目 API 全量 423（仅 state/unlock/setup
  // 可达），而 setup 会把锁定 Enabled=true 写进共享实例，清理不能借道 setup
  if (state.needsSetup) {
    return { headers: {}, blockReason: '锁定未初始化（needsSetup）：项目 API 全量 423，无法清理/注册' }
  }
  if (!state.enabled) {
    // 已配置但关闭：LockMiddleware 直接放行，无需 token
    return { headers: { 'Content-Type': 'application/json' } }
  }
  if (!state.isDefaultPassword) {
    return {
      headers: {},
      blockReason: '锁定开启且密码非默认：不盲试密码（防限流/审计/通知污染），跳过清理/注册',
    }
  }
  try {
    const res = await fetch(`${API_BASE}/api/lock/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: DEFAULT_PASSWORD }),
    })
    if (!res.ok) {
      return { headers: {}, blockReason: `解锁失败 HTTP ${res.status}（isDefaultPassword=true 预期可解锁）` }
    }
    const token = ((await res.json()) as { token?: string }).token || ''
    return { headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token } }
  } catch (err) {
    return { headers: {}, blockReason: `解锁请求异常：${String(err)}` }
  }
}

/**
 * 清理磁盘路径含 marker 的全部注册项目 + localParentDir 下 marker 前缀的磁盘
 * 目录（含注册已删但目录遗留的孤儿——「只增不减」的主因）。
 *
 * 磁盘目录按 localParentDir 本地条目清单清扫而非逐个 rmSync 注册路径：跨拓扑
 * （E2E_SERVER_OS=linux）下服务端形态路径对本地 fs 不可用，目录条目名（marker
 * 前缀）才是拓扑无关的清理键。
 */
export async function cleanupProjectsByPathMarker(opts: {
  marker: string
  localParentDir: string
}): Promise<ResidueCleanupResult> {
  const { marker, localParentDir } = opts
  const result: ResidueCleanupResult = { removedProjects: 0, failedDirs: [] }

  const { headers, blockReason } = await resolveLockHeaders()
  if (blockReason) {
    console.warn(`[e2e-residue-cleanup] 跳过清理（marker=${marker}）：${blockReason}——残留将保留到下次`)
    return { ...result, blockReason }
  }

  // 1) 注册项目：路径含 marker 即删（与 add-project-enter 的名前缀清理同口径）
  try {
    const listRes = await fetch(`${API_BASE}/api/projects`, { headers })
    const listJson = (await listRes.json().catch(() => null)) as { data?: { id: string; path: string }[] } | null
    for (const p of listJson?.data || []) {
      if (!p.path.includes(marker)) continue
      const delRes = await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
      if (delRes.ok) {
        result.removedProjects += 1
      } else {
        console.warn(`[e2e-residue-cleanup] DELETE /api/projects/${p.id} 失败 HTTP ${delRes.status}（path=${p.path}）`)
      }
    }
  } catch (err) {
    console.warn(`[e2e-residue-cleanup] 项目列表/删除请求失败：${String(err)}`)
  }

  // 2) 磁盘目录：marker 前缀条目全清，失败逐条记录路径清单（不静默）。
  // 服务端删除注册后的 watch 摘除是异步的——afterAll 瞬间刚克隆的目录常被
  // 句柄短暂占用（历史实现静默忽略正是「目录层只增不减」的主因），对失败
  // 条目做有界重试（500ms×2）再放弃
  try {
    const pending: string[] = []
    for (const entry of fs.readdirSync(localParentDir)) {
      if (!entry.startsWith(marker)) continue
      const full = path.join(localParentDir, entry)
      try {
        fs.rmSync(full, { recursive: true, force: true })
      } catch {
        pending.push(full)
      }
    }
    for (let attempt = 0; attempt < 2 && pending.length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      for (let i = pending.length - 1; i >= 0; i -= 1) {
        try {
          fs.rmSync(pending[i], { recursive: true, force: true }) // force：已被并轮清掉不报错
          pending.splice(i, 1)
        } catch { /* 仍占用：进入下一轮或落入最终清单 */ }
      }
    }
    result.failedDirs.push(...pending)
  } catch (err) {
    console.warn(`[e2e-residue-cleanup] 扫描 ${localParentDir} 失败：${String(err)}`)
  }
  if (result.failedDirs.length > 0) {
    console.warn(
      `[e2e-residue-cleanup] ${result.failedDirs.length} 个磁盘目录删除失败（被占用？）：\n  ` +
        result.failedDirs.join('\n  '),
    )
  }
  return result
}

/**
 * 把现有目录注册为项目（push-dialog 自建前置用）。锁定开启时按 state 自动
 * 解锁取 token；前置失败抛错让 beforeAll 显式失败，而非静默跑空用例。
 */
export async function registerProjectByPath(name: string, serverFormPath: string): Promise<void> {
  const { headers, blockReason } = await resolveLockHeaders()
  if (blockReason) throw new Error(`注册项目前置失败：${blockReason}`)
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, path: serverFormPath }),
  })
  if (!res.ok) throw new Error(`POST /api/projects 失败 HTTP ${res.status}（name=${name} path=${serverFormPath}）`)
}
