#!/usr/bin/env node
/**
 * manifest-hash.mjs —— 目录树 sha256 清单生成器（release-scan.sh 与
 * release-publish.sh 共用）。哈希行格式与 GNU sha256sum 兼容
 * （<hash>  <path>，两空格），Linux 侧 `sha256sum -c` 可直接互验。
 *
 * 用 node crypto 单进程而非 find|xargs sha256sum：后者每文件一进程，
 * Windows 上 3261 文件进程风暴 20 分钟+ 不出活（2026-11-02 实锚）。
 *
 * 用法：node scripts/manifest-hash.mjs <dir> <out>
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const [dir, out] = process.argv.slice(2)
if (!dir || !out) {
  console.error('用法：node scripts/manifest-hash.mjs <dir> <out>')
  process.exit(1)
}
if (!fs.existsSync(dir)) {
  console.error(`FATAL: 目录不存在：${dir}`)
  process.exit(1)
}

const lines = []
;(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.isFile()) {
      const rel = path.relative(dir, p).split(path.sep).join('/')
      const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
      lines.push(`${h}  ${rel}`)
    }
  }
})(dir)
lines.sort((a, b) => a.slice(65).localeCompare(b.slice(65)))
fs.writeFileSync(out, lines.join('\n') + '\n')
