#!/usr/bin/env node
/**
 * Codecombo npm wrapper —— 解析平台二进制包并接管执行。
 *
 * 免脚本安装（esbuild/biome 同款 optionalDependencies 机制）：npm 按
 * os/cpu 字段自动挑平台包，零 postinstall 下载，--ignore-scripts 环境
 * 照常工作。本 wrapper 只做一件事：找到对应平台包里的二进制，spawn 并
 * 透传参数/stdio/退出码——所有业务逻辑都在 Go 二进制里。
 */
'use strict'
const { spawn } = require('node:child_process')

const PLATFORM_PACKAGES = {
  'win32-x64': 'codecombo-win32-x64',
  'win32-arm64': 'codecombo-win32-arm64',
  'linux-x64': 'codecombo-linux-x64',
  'linux-arm64': 'codecombo-linux-arm64',
  'darwin-x64': 'codecombo-darwin-x64',
  'darwin-arm64': 'codecombo-darwin-arm64',
}

const pkg = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`]
if (!pkg) {
  console.error(`Codecombo has no prebuilt binary for ${process.platform}-${process.arch}.`)
  console.error('Build from source: https://github.com/wtr20211202/codecombo#quickstart')
  process.exit(1)
}

const binName = process.platform === 'win32' ? 'codecombo.exe' : 'codecombo'
let bin
try {
  bin = require.resolve(`${pkg}/bin/${binName}`)
} catch {
  console.error(`The platform package "${pkg}" is not installed — reinstall:`)
  console.error('  npm i -g codecombo')
  process.exit(1)
}

const child = spawn(bin, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: true,
  // 安装器标识：Go 侧 IsNpmManaged 据此拒绝自更新（node_modules 归 npm 管，
  // 原位替换会让 npm 版本记账漂移）。路径嗅探（node_modules 段）是 daemon
  // 重启 / env 丢失时的兜底判据
  env: { ...process.env, CODECOMBO_INSTALLER: 'npm' },
})
child.on('error', (err) => {
  console.error(`Failed to launch ${binName}: ${err.message}`)
  process.exit(1)
})
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)))
