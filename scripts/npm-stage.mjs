#!/usr/bin/env node
/**
 * npm-stage.mjs —— 从 dist/ 二进制组装 npm 发布包（P-20261102-2）。
 *
 * 形态 = esbuild/biome 同款免脚本分发：主包 codecombo（JS wrapper）+ 六平台包
 * codecombo-{windows,linux,darwin}-{x64,arm64}（裸二进制 + os/cpu 字段），npm 安装
 * 时按平台自动择一，零 postinstall。输出 npm/dist/<pkg>/ 树（.gitignore 忽略）；
 * 发布命令打印不代跑——npm publish 由 CI（release.yml，需 NPM_TOKEN）或人工执行。
 *
 * 用法：node scripts/npm-stage.mjs --version 0.1.0 [--dist dist] [--out npm/dist]
 *   --version 缺省取最近 v* tag（去 v 前缀）；六平台二进制缺一即 FATAL 列缺。
 */
import fs, { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

// ---------- 参数 ----------
const args = process.argv.slice(2)
const argOf = (flag) => {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : undefined
}
let version = argOf('--version')
const distDir = path.resolve(REPO, argOf('--dist') ?? 'dist')
const outDir = path.resolve(REPO, argOf('--out') ?? 'npm/dist')

if (!version) {
  try {
    version = execSync('git describe --tags --abbrev=0', { cwd: REPO, encoding: 'utf8' }).trim().replace(/^v/, '')
  } catch {
    console.error('FATAL: 无 --version 且仓库无 v* tag 可推断——显式传 --version')
    process.exit(1)
  }
}
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`FATAL: 版本号 "${version}" 不是合法 SemVer`)
  process.exit(1)
}

// ---------- 平台映射：npm 包名 / os+cpu / 产物二进制 ----------
const HOMEPAGE = 'https://wtr20211202.github.io/codecombo/'
const REPO_URL = 'https://github.com/wtr20211202/codecombo'
const PLATFORMS = [
  { pkg: 'codecombo-windows-x64', os: 'win32', cpu: 'x64', bin: 'codecombo-windows-amd64.exe', as: 'codecombo.exe' },
  { pkg: 'codecombo-windows-arm64', os: 'win32', cpu: 'arm64', bin: 'codecombo-windows-arm64.exe', as: 'codecombo.exe' },
  { pkg: 'codecombo-linux-x64', os: 'linux', cpu: 'x64', bin: 'codecombo-linux-amd64', as: 'codecombo' },
  { pkg: 'codecombo-linux-arm64', os: 'linux', cpu: 'arm64', bin: 'codecombo-linux-arm64', as: 'codecombo' },
  { pkg: 'codecombo-darwin-x64', os: 'darwin', cpu: 'x64', bin: 'codecombo-darwin-amd64', as: 'codecombo' },
  { pkg: 'codecombo-darwin-arm64', os: 'darwin', cpu: 'arm64', bin: 'codecombo-darwin-arm64', as: 'codecombo' },
]

// ---------- 前置校验：六平台二进制缺一即停 ----------
const missing = PLATFORMS.filter((p) => !existsSync(path.join(distDir, p.bin))).map((p) => p.bin)
if (missing.length) {
  console.error('FATAL: dist/ 缺平台二进制（先跑 build.sh all）：\n  ' + missing.join('\n  '))
  process.exit(1)
}
const LICENSE = path.join(REPO, 'LICENSE')
if (!existsSync(LICENSE)) {
  console.error('FATAL: 仓库根缺 LICENSE')
  process.exit(1)
}
const wrapper = path.join(REPO, 'npm', 'cli', 'bin', 'codecombo.js')
if (!existsSync(wrapper)) {
  console.error('FATAL: 缺 npm/cli/bin/codecombo.js（wrapper 源文件）')
  process.exit(1)
}

// ---------- 组包 ----------
rmSync(outDir, { recursive: true, force: true })

const cliPkg = {
  name: 'codecombo',
  version,
  description: 'Self-hosted single-binary workbench: Git workbench, real terminals, AI coding agents and remote machines in one browser tab.',
  license: 'Apache-2.0',
  bin: { codecombo: 'bin/codecombo.js' },
  engines: { node: '>=18' },
  keywords: ['workbench', 'terminal', 'git', 'ai', 'agents', 'self-hosted', 'claude', 'code'],
  homepage: HOMEPAGE,
  repository: { type: 'git', url: `git+${REPO_URL}.git` },
  bugs: { url: `${REPO_URL}/issues` },
  optionalDependencies: Object.fromEntries(PLATFORMS.map((p) => [p.pkg, version])),
  files: ['bin'],
}

mkdirSync(path.join(outDir, 'codecombo', 'bin'), { recursive: true })
writeFileSync(path.join(outDir, 'codecombo', 'package.json'), JSON.stringify(cliPkg, null, 2) + '\n')
copyFileSync(wrapper, path.join(outDir, 'codecombo', 'bin', 'codecombo.js'))
copyFileSync(path.join(REPO, 'npm', 'cli', 'README.md'), path.join(outDir, 'codecombo', 'README.md'))
copyFileSync(LICENSE, path.join(outDir, 'codecombo', 'LICENSE'))

for (const p of PLATFORMS) {
  const dir = path.join(outDir, p.pkg)
  mkdirSync(path.join(dir, 'bin'), { recursive: true })
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: p.pkg,
    version,
    description: `Codecombo native binary for ${p.os}-${p.cpu}`,
    license: 'Apache-2.0',
    os: [p.os],
    cpu: [p.cpu],
    repository: { type: 'git', url: `git+${REPO_URL}.git` },
    files: ['bin'],
  }, null, 2) + '\n')
  const target = path.join(dir, 'bin', p.as)
  copyFileSync(path.join(distDir, p.bin), target)
  chmodSync(target, 0o755)
  copyFileSync(LICENSE, path.join(dir, 'LICENSE'))
}

// ---------- 组包内容自证（固化防错）：npm 包只允许 wrapper+二进制+元数据，
// 白名单外任何条目（尤其 .go/.ts/.vue 源码）= 响亮失败——「不发源码」不是
// 纪律是断言，CI 里的 publish 只消费这里产出的树 ----------
const ALLOWED_TOP = new Set(['package.json', 'LICENSE', 'README.md', 'bin'])
const bad = []
for (const p of [path.join(outDir, 'codecombo'), ...PLATFORMS.map((x) => path.join(outDir, x.pkg))]) {
  const pkgName = path.basename(p)
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    if (!ALLOWED_TOP.has(e.name)) {
      bad.push(`${pkgName}/${e.name}（意外顶层条目）`)
      continue
    }
    if (e.name !== 'bin') continue
    for (const b of fs.readdirSync(path.join(p, 'bin'))) {
      const ext = path.extname(b)
      if (ext !== '.js' && ext !== '.exe' && ext !== '') {
        bad.push(`${pkgName}/bin/${b}（意外文件类型）`)
      }
    }
  }
}
if (bad.length) {
  console.error('FATAL: 组包内容含白名单外文件（npm 包不得混入源码）：\n  ' + bad.join('\n  '))
  process.exit(1)
}

// ---------- 摘要 ----------
const mb = (f) => (statSync(f).size / 1048576).toFixed(1) + 'MB'
console.log(`==> Staged ${PLATFORMS.length + 1} npm packages (v${version}) -> ${outDir}`)
console.log(`    codecombo              wrapper`)
for (const p of PLATFORMS) {
  console.log(`    ${p.pkg.padEnd(24)} ${mb(path.join(outDir, p.pkg, 'bin', p.as))}`)
}
console.log('==> 发布顺序（平台包先行，主包 optionalDependencies 引用其版本）：')
console.log('    for d in npm/dist/codecombo-*/; do npm publish "$d"; done && npm publish npm/dist/codecombo/')
console.log('    （预发布版本加 --tag next，防 rc/beta 抢占 latest 通道）')
