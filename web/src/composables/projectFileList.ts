// 项目文件清单数据面（P-20261003-107 从 useQuickNav.ts 提取共享）
//
// 消费方两处：Quick Open 面板（useQuickNav）与编辑器字符串内路径补全
// （views/editor/pathCompletion）。两处缓存节奏不同（面板打开时拉 / 补全触发
// 时拉），缓存状态各自持有；本模块只收敛「取数原语 + 上限 + 新鲜度 TTL」，
// 保证两个消费方读到的清单同源同口径（同上限、同能力探测分流、同 TTL 注入缝）。
import { projectApi } from '../api/client'
import { CAP_FLAT_FILE_LIST, useMetaStore } from '../stores/meta'

export interface PaletteFileItem { name: string; path: string }

/** Quick Open 文件索引上限（P-20261002-77）：与 ListFlatFiles 服务端上限对齐
 *  （server/api/gitops/tree.go 允许 max ≤ 20000）。超出部分不在面板检索范围内，
 *  达上限时列表尾部显示弱提示引导文件树/全局搜索 */
export const QUICK_OPEN_MAX_FILES = 20000

/** Quick Open 清单 SWR 新鲜度 TTL（P-20261003-299）：清单按项目缓存且事件失效
 *  （P-20261003-73）只覆盖有广播面的变更，WS 断线窗口/服务端 watcher 漏报时
 *  事件缺席——超过 TTL 的缓存视为陈旧，下次打开面板后台静默换新兜底。
 *  e2e 可经 addInitScript 设 window.__scQuickOpenSwrTtlMs 注入短值驱动过期路径 */
export const QUICK_OPEN_SWR_TTL_MS = 30_000

/** 读生效 TTL：未注入/非法值回退默认；每次面板打开读一次，非热路径 */
export function swrTtlMs(): number {
  const injected = (window as unknown as { __scQuickOpenSwrTtlMs?: number }).__scQuickOpenSwrTtlMs
  return typeof injected === 'number' && Number.isFinite(injected) && injected >= 0
    ? injected
    : QUICK_OPEN_SWR_TTL_MS
}

/** 拉取项目文件清单原始数据（上限 QUICK_OPEN_MAX_FILES，防巨型仓库
 *  失控），只取数不写缓存状态——全量加载与 SWR 后台重拉（P-20261003-299）
 *  共用，失败 reject 由调用方按各自语义兜底。优先走 /file-list 单请求端点
 *  （服务端一次遍历，不做 git 子进程调用）——是否可用经 /api/meta 能力探测
 *  （P-20261004-4）：对端声明 flat-file-list 才走快路径，旧对端不再白发注定
 *  404 的请求；file-list 失败（含 404 兜底）仍回退按目录逐层拉 file-tree 的
 *  BFS 慢路径。 */
export async function collectProjectFileList(projectId: string): Promise<{ files: PaletteFileItem[]; truncated: boolean }> {
  const collected: PaletteFileItem[] = []
  const MAX = QUICK_OPEN_MAX_FILES
  // 跳过这些目录：依赖产物/构建产物/版本控制目录，避免占用配额且让用户文件可被检索到
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', 'target', 'vendor', '.cache'])
  // 快路径：单请求扁平列表。能力探测分流（P-20261004-4）：先确保当前实例
  // 的 meta 在缓存，未声明 flat-file-list 直接落慢路径（旧对端不白发 404）
  const meta = useMetaStore()
  await meta.ensureCaps()
  if (meta.hasCap(CAP_FLAT_FILE_LIST)) {
    const flat = await projectApi.fileList(projectId, MAX)
      .catch(() => null) as { data?: Array<{ name: string; path: string }> } | null
    if (flat?.data) {
      // 服务端在 max 处停止遍历（len ≥ max 即视为截断——恰好等于上限时多提示一行可接受）
      return { files: (flat.data as PaletteFileItem[]).slice(0, MAX), truncated: flat.data.length >= MAX }
    }
  }
  // 慢路径（旧对端）：按目录逐层 BFS
  const queue: (string | undefined)[] = [undefined]
  while (queue.length > 0 && collected.length < MAX) {
    const dir = queue.shift()
    const res = await projectApi.fileTree(projectId, dir)
    const items = (res as { data?: Array<{ name: string; path: string; isDir: boolean }> }).data || []
    for (const it of items) {
      if (collected.length >= MAX) break
      if (it.isDir) {
        // 跳过依赖/构建产物目录
        if (SKIP_DIRS.has(it.name)) continue
        queue.push(it.path)
      } else {
        collected.push({ name: it.name, path: it.path })
      }
    }
  }
  return { files: collected, truncated: collected.length >= MAX }
}
