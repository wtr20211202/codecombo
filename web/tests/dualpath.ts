import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

/**
 * 跨拓扑双路径：同一份测试夹具，Windows 测试侧用 win 形态读写，
 * 服务端（按 E2E_SERVER_OS 决定）拿它认识的形态。
 *
 * - E2E_SERVER_OS=linux（e2e-cross.sh 设置；服务实例跑在本机 WSL）：
 *   C:\Users\u\AppData\Local\Temp\x → /mnt/c/Users/u/AppData/Local/Temp/x
 *   （%TEMP% 在 WSL 侧经 /mnt/c 可见可写，两侧操作同一份文件）
 * - 未设置或缺省（服务实例与测试同在 Windows，e2e-worktree.sh 等不设）：
 *   server 形态 = win 形态原样。
 *
 * spec 迁移口径：凡把本地路径交给服务端 API 的地方（注册项目/克隆/
 * file:// 源仓库等）一律传 serverPath(...)；测试侧自身的 fs 断言继续用
 * 原路径。已迁移的 spec 在两种拓扑下都可跑（Windows 全量 + 跨拓扑）。
 */

/** 服务端是否为 Linux：显式信号（E2E_SERVER_OS=linux，e2e-cross.sh 设置——
 * Windows Playwright 打 Linux 服务实例）或 spec 进程自身跑在 Linux（WSL 门禁
 * e2e-worktree.sh / wsl-e2e.sh——Playwright 与服务实例同在 Linux，服务端必为
 * Linux）。个别用例的夹具搭建/断言需按服务端 shell 语义分支（如 worktree 建、
 * bash vs PowerShell 提示符），以这个常量守卫，Windows 侧行为不变 */
export const serverIsLinux = process.platform === 'linux' || process.env.E2E_SERVER_OS === 'linux'

/** 跨拓扑形态：测试侧（浏览器宿主）与服务端异机异 os——测试侧本地 fs
 * （os.homedir()/os.tmpdir()）建的夹具服务端结构性不可见。路径类夹具可经
 * serverPath() 翻译交服务端（/mnt/c 同见）；但 homedir 域夹具（~/.claude
 * transcripts 等无服务端写入 API 的位置）无法翻译——依赖它们的用例以此守卫
 * test.skip，同机拓扑（Windows 实例 / WSL 内门禁）行为不变 */
export const serverIsRemote = process.env.E2E_SERVER_OS === 'linux' && process.platform !== 'linux'

/** Windows 路径 → 本机 WSL 服务端路径；非 linux 服务端模式原样返回 */
export function serverPath(winPath: string): string {
  if (process.env.E2E_SERVER_OS !== 'linux') return winPath
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath)
  if (!m) return winPath
  const [, drive, rest] = m
  return `/mnt/${drive.toLowerCase()}/${rest.replace(/\\/g, '/')}`
}

/** 建一个两侧都可见的临时目录（夹具根），返回 { win, server } 双形态 */
export function dualTmpDir(prefix: string): { win: string; server: string } {
  const win = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  return { win, server: serverPath(win) }
}

/** 清理夹具目录（两侧同一份文件，win 形态删一次即可） */
export function dualTmpClean(win: string): void {
  try { fs.rmSync(win, { recursive: true, force: true }) } catch { /* Windows 句柄延迟占用忽略 */ }
}
