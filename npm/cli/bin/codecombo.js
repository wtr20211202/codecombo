#!/usr/bin/env node
/**
 * Codecombo npm wrapper —— 解析平台二进制包并接管执行。
 *
 * 免脚本安装（esbuild/biome 同款 optionalDependencies 机制）：npm 按
 * os/cpu 字段自动挑平台包，零 postinstall 下载，--ignore-scripts 环境
 * 照常工作。本 wrapper 做两件事：找到对应平台包里的二进制，spawn 并
 * 透传参数/stdio/退出码；以及充当**循环监管者**（P-20261122-2）——页面
 * 重启在 npm 前台形态下不自 spawn，Go 二进制优雅停机后以退出码 75 交还
 * 重启所有权（server/update/npm_restart.go 双守卫握手），本脚本收到 75
 * 重 resolve 平台二进制并同参数重 spawn。其余退出码照旧透传。75 连环
 * （窗口内超阈值）判 crash-loop 断路退出非零，绝不无限重 spawn。
 *
 * 所有业务逻辑都在 Go 二进制里。
 */
'use strict'
const { spawn } = require('node:child_process')

const PLATFORM_PACKAGES = {
  'win32-x64': 'codecombo-windows-x64',
  'win32-arm64': 'codecombo-windows-arm64',
  'linux-x64': 'codecombo-linux-x64',
  'linux-arm64': 'codecombo-linux-arm64',
  'darwin-x64': 'codecombo-darwin-x64',
  'darwin-arm64': 'codecombo-darwin-arm64',
}

const binName = process.platform === 'win32' ? 'codecombo.exe' : 'codecombo'

// 页面重启握手退出码（与 server/update/npm_restart.go RestartExitCode 同值，
// 改名必须两处同步）
const RESTART_EXIT_CODE = 75

// crash-loop 断路器（Go 侧 waitForHealthy crashLoopPidChanges 同型防线）：
// 窗口内 75 退出达到阈值即断路退出非零。真实页面重启必隔一次完整启动（服务
// 就绪 + 用户动作，秒级），窗口内连环 75 只能是「起来就退」的循环——继续重
// spawn 只会空转烧 CPU，断路把故障显性化（stderr 留痕 + 非零退出）
const RESTART_WINDOW_MS = 60000
const RESTART_MAX_IN_WINDOW = 5

// 断路器时间源（node:test 注入假时钟，免真等窗口）
let nowFn = Date.now

// 75 退出时间戳滚动窗（只增不减地记录，按窗口裁剪旧样本）
const restartTimestamps = []

/**
 * 记一次 75 退出并裁决是否断路：60s 滚动窗内达到 RESTART_MAX_IN_WINDOW 次
 * 返回 true。窗口滑动 = 裁掉窗外旧样本后按剩余计数判断，偶发重启（间隔超过
 * 窗口）永不累计到阈值。
 */
function recordRestartAndCheckTrip() {
  const now = nowFn()
  restartTimestamps.push(now)
  while (restartTimestamps.length > 0 && now - restartTimestamps[0] > RESTART_WINDOW_MS) {
    restartTimestamps.shift()
  }
  return restartTimestamps.length >= RESTART_MAX_IN_WINDOW
}

/**
 * 解析平台二进制绝对路径。每轮重 resolve（不缓存上一轮结果）：npm 安装/卸载
 * 等中途操作后按盘上实况重找，缓存的旧路径可能已被 npm 换掉。解析失败返回
 * null（调用方负责报错退出）。
 */
function resolveBin() {
  const pkg = PLATFORM_PACKAGES[`${process.platform}-${process.arch}`]
  if (!pkg) {
    console.error(`Codecombo has no prebuilt binary for ${process.platform}-${process.arch}.`)
    console.error('Build from source: https://github.com/wtr20211202/codecombo#quickstart')
    return null
  }
  try {
    return require.resolve(`${pkg}/bin/${binName}`)
  } catch {
    console.error(`The platform package "${pkg}" is not installed — reinstall:`)
    console.error('  npm i -g codecombo')
    return null
  }
}

/**
 * 子进程环境：安装器标识（Go 侧 IsNpmManaged 据此拒绝自更新，路径嗅探是
 * 兜底判据）+ wrapper PID（页面重启握手，server/update/npm_restart.go
 * EnvWrapperPid——Go 侧 ppid==该值双守卫通过才交还重启所有权；守护形态
 * `codecombo start` 经 cmdStart 绕过 wrapper 自 spawn，env 被继承但 ppid
 * 已非本 wrapper，Go 侧判否落脱会话自 spawn 兜底，绝不误发 75 让守护进程
 * 无人接手）。每轮重建 env（不沿用旧 child 对象），值恒指本 wrapper。
 */
function childEnv() {
  return {
    ...process.env,
    CODECOMBO_INSTALLER: 'npm',
    CODECOMBO_WRAPPER_PID: String(process.pid),
  }
}

let child = null

/**
 * spawn 平台二进制并挂透传面。退出码路由：75（且非信号死亡）=页面重启请求
 * ——断路器放行则重 resolve 重 spawn；其余码/信号死亡照旧透传退出。stdio
 * inherit + windowsHide 保持原口径（前台附着不变）。
 */
function launch(bin) {
  child = spawn(bin, process.argv.slice(2), {
    stdio: 'inherit',
    windowsHide: true,
    env: childEnv(),
  })
  child.on('error', (err) => {
    console.error(`Failed to launch ${binName}: ${err.message}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (!signal && code === RESTART_EXIT_CODE) {
      if (recordRestartAndCheckTrip()) {
        console.error(
          `codecombo requested a restart ${RESTART_MAX_IN_WINDOW} times within ` +
            `${RESTART_WINDOW_MS / 1000}s — crash-loop breaker tripped, giving up. ` +
            'Check the app log (~/.codecombo/logs/) and start it manually.',
        )
        process.exit(1)
      }
      console.error('codecombo exited for a page restart — respawning')
      const next = resolveBin()
      if (!next) process.exit(1)
      launch(next)
      return
    }
    process.exit(signal ? 1 : (code ?? 0))
  })
}

// 信号处理：注册监听即接管默认终止——wrapper 留守到子进程退出，由 exit 事件
// 统一收口（透传子进程的退出码/信号语义），不再默认抢跑（默认 disposition 先
// 杀 wrapper 会失去 75 重 spawn 监管）。转发面按平台信号语义收敛，绝不让转发
// 变成对孩子进程的二次投递/硬杀：
//   - POSIX SIGINT：**不转发**——终端 Ctrl+C 按前台进程组原生投递（child 与
//     wrapper 同组，直接收到；连按第二次的「强制退出」逃生门也走同一原生通道，
//     Go 侧二次信号语义完好）。再转发=双投递：Go 把第二个 SIGINT 当强制退出
//     扳机（app.go 二次信号 os.Exit），优雅停机被截断（Node 实测组投递+显式
//     转发=子进程收到两次）
//   - POSIX SIGTERM：转发——定向 kill（supervisor/运维按 PID 投递）不经进程组
//     语义，不转发子进程会失去监管孤儿化
//   - Windows：**不转发**——无 POSIX 信号，child.kill 落 TerminateProcess 无条件
//     硬杀（Node 实测信号名只是报告值，子进程 handler 不执行），而控制台 Ctrl+C
//     已原生投递到同控制台的子进程；转发只会截断优雅停机
// POSIX 下子进程信号死亡透传为退出码 1（原口径保留）
process.on('SIGINT', () => {})
if (process.platform !== 'win32') {
  process.on('SIGTERM', () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
    }
  })
}

function main() {
  const bin = resolveBin()
  if (!bin) process.exit(1)
  launch(bin)
}

// 直接执行（npm bin shim）跑 main；被 node:test require 时只暴露测试面，
// 无副作用
if (require.main === module) {
  main()
}

module.exports = {
  PLATFORM_PACKAGES,
  RESTART_EXIT_CODE,
  RESTART_WINDOW_MS,
  RESTART_MAX_IN_WINDOW,
  recordRestartAndCheckTrip,
  resolveBin,
  // 测试注入面（生产不可达——导出面仅供 node:test）：假时钟 + 滚动窗清零
  //（模块级状态跨用例隔离）
  _setNowFn: (fn) => {
    nowFn = fn
  },
  _resetRestarts: () => {
    restartTimestamps.length = 0
  },
}
