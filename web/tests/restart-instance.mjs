// 独立进程重启 e2e 实例（P-20261003-326，deploy-restart-sweep.spec 专用）：
// Playwright worker 会在用例结束/崩溃时清杀自己进程树内的子进程——经 CLI
// start 拉起的守护进程是「孙进程」，实测刚就绪即随树清杀死亡（后续请求
// ECONNRESET）。本 helper 以 detached 进程运行：stop → start → 轮询就绪 →
// 写结果文件退出；守护进程在 helper 退出后成为孤儿进程存活，与 Playwright
// worker 的进程树彻底解耦。
// 用法：node restart-instance.mjs <binary> <dataDir> <port> <resultFile>
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const [binary, dataDir, port, resultFile] = process.argv.slice(2)

const result = { ok: false, error: '' }
try {
  // stop：实例未运行时 CLI 打印说明后退出 0，兜底 catch
  await execFileAsync(binary, ['stop', '-p', port, '-d', dataDir], { timeout: 30000 }).catch(() => {})
  // start：CLI 自带 30s 就绪探测后退出。探测期超时（新二进制杀软扫描实测可
  // 远超预期）时退出码非 0 但守护进程仍在启动——不在此处判失败，就绪轮询裁决
  await execFileAsync(binary, ['start', '-d', dataDir, '--no-tls', '-p', port], { timeout: 60000 }).catch(() => {})
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`)
      if (res.ok) { result.ok = true; break }
    } catch { /* 未就绪继续等 */ }
    await new Promise(r => setTimeout(r, 500))
  }
  if (!result.ok) result.error = `instance :${port} not ready 90s after restart`
} catch (e) {
  result.error = e?.message || String(e)
}
fs.mkdirSync(path.dirname(resultFile), { recursive: true })
fs.writeFileSync(resultFile, JSON.stringify(result))
