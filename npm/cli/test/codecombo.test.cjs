'use strict'
/**
 * Codecombo npm wrapper 单测（P-20261122-2，node:test 零依赖——npm/cli 无
 * JS 测试设施，engines>=18 自带 node:test）。
 *
 * 两层覆盖：
 *   - 纯逻辑面：crash-loop 断路器（假时钟注入，免真等 60s 窗口；模块级滚动窗
 *     每用例前清零隔离）
 *   - 进程级面：临时目录组装「wrapper + 假平台包」布局（package.json files
 *     白名单只装 bin/，测试夹具不入发布包），以 node 可执行文件副本充当假
 *     平台二进制——wrapper spawn 它并透传参数，用 -e 脚本驱动子进程按剧本
 *     退出（75=重启请求 / 其他码透传 / 信号死亡），断言 wrapper 的路由行为：
 *     75 重 spawn（断路器放行期内）、他码透传、env 契约下发、argv 原样重放、
 *     信号透传（POSIX only——Windows 无跨进程信号投递通道）、断路器真熔断。
 *
 * 运行：node --test npm/cli/test/
 */
const { test, describe } = require('node:test')
const assert = require('node:assert')
const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const wrapperPath = path.join(__dirname, '..', 'bin', 'codecombo.js')
const wrapper = require(wrapperPath)

// ---------- 纯逻辑面：crash-loop 断路器 ----------

describe('restart breaker', () => {
  test('trips at 5 restarts within the window', () => {
    let now = 1000
    wrapper._resetRestarts()
    wrapper._setNowFn(() => now)
    const codes = []
    for (let i = 0; i < 5; i++) codes.push(wrapper.recordRestartAndCheckTrip())
    // 前 4 次放行，第 5 次熔断
    assert.deepStrictEqual(codes, [false, false, false, false, true])
  })

  test('restarts spaced beyond the window never accumulate', () => {
    let now = 1_000_000
    wrapper._resetRestarts()
    wrapper._setNowFn(() => now)
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(wrapper.recordRestartAndCheckTrip(), false, `restart #${i + 1} must not trip`)
      now += wrapper.RESTART_WINDOW_MS + 1 // 逐次跳出窗口，旧样本被裁剪
    }
  })

  test('window slides: sparse bursts do not trip', () => {
    let now = 2_000_000
    wrapper._resetRestarts()
    wrapper._setNowFn(() => now)
    // 4 次（未达阈值）后时间跳出窗口，计数清零再来 4 次仍不熔断
    for (let i = 0; i < 4; i++) wrapper.recordRestartAndCheckTrip()
    now += wrapper.RESTART_WINDOW_MS + 1
    for (let i = 0; i < 4; i++) {
      assert.strictEqual(wrapper.recordRestartAndCheckTrip(), false)
    }
  })
})

// ---------- 进程级面夹具 ----------

// 假平台包目录名 = wrapper 实际解析的包名（PLATFORM_PACKAGES 值，非裸
// platform-arch 串——真实发布树里平台包名带 windows/linux/darwin 全称）
const pkgName = wrapper.PLATFORM_PACKAGES[`${process.platform}-${process.arch}`]
const binName = process.platform === 'win32' ? 'codecombo.exe' : 'codecombo'

/**
 * 组装临时安装布局并返回 wrapper 入口路径：
 *   <tmp>/bin/codecombo.js（被测 wrapper 原样拷贝——测的是发布形态）
 *   <tmp>/node_modules/<平台包>/bin/<binName>（node 可执行文件副本充当假
 *   平台二进制：wrapper 直接 spawn 它，参数透传即 node 参数，用 -e 驱动剧本）
 */
function stageLayout(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codecombo-wrapper-test-'))
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }))
  fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true })
  fs.copyFileSync(wrapperPath, path.join(tmp, 'bin', 'codecombo.js'))
  const pkgBin = path.join(tmp, 'node_modules', pkgName, 'bin')
  fs.mkdirSync(pkgBin, { recursive: true })
  fs.writeFileSync(
    path.join(tmp, 'node_modules', pkgName, 'package.json'),
    JSON.stringify({ name: pkgName, version: '0.0.0-test', optional: true }),
  )
  fs.copyFileSync(process.execPath, path.join(pkgBin, binName))
  if (process.platform !== 'win32') fs.chmodSync(path.join(pkgBin, binName), 0o755)
  return path.join(tmp, 'bin', 'codecombo.js')
}

/**
 * 跑 wrapper 到退出（剧本参数经 argv 透传给假平台二进制执行）。隔离测试进程
 * 自身可能带出的握手 env——wrapper 必须每轮自建下发，不依赖继承值
 */
function runWrapper(entry, args, timeoutMs = 30000) {
  return spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, CODECOMBO_WRAPPER_PID: '', CODECOMBO_INSTALLER: '' },
  })
}

// ---------- 进程级面：退出码路由 / env 契约 / argv 重放 ----------

describe('wrapper process behavior', () => {
  test('exit code 75 → respawn loop trips the crash-loop breaker (exit 1)', (t) => {
    const entry = stageLayout(t)
    const r = runWrapper(entry, ['-e', 'process.exit(75)'], 60000)
    // 子进程连环 75 → wrapper 重 spawn 4 轮后断路退出非零
    assert.strictEqual(r.status, 1, `stderr: ${r.stderr}`)
    assert.match(r.stderr, /crash-loop breaker tripped/)
    assert.match(r.stderr, /respawning/)
  })

  test('other exit codes pass through unchanged', (t) => {
    const entry = stageLayout(t)
    for (const want of [0, 3, 42]) {
      const r = runWrapper(entry, ['-e', `process.exit(${want})`])
      assert.strictEqual(r.status, want, `exit code ${want} must pass through (got ${r.status}) stderr: ${r.stderr}`)
      assert.ok(!/respawn/.test(r.stderr), 'non-75 exit must not trigger respawn')
    }
  })

  test('env contract: installer flag + wrapper pid delivered fresh', (t) => {
    const entry = stageLayout(t)
    // 子进程直接回报自身 ppid 与 env 值：Go 侧双守卫的判据就是
    // ppid == CODECOMBO_WRAPPER_PID，假平台二进制的父进程正是 wrapper——
    // 这里断言的关系与生产判定同构，比只验「非空」强
    const script =
      'console.log(JSON.stringify({i: process.env.CODECOMBO_INSTALLER, p: process.env.CODECOMBO_WRAPPER_PID, ppid: process.ppid}))'
    const r = runWrapper(entry, ['-e', script])
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)
    const line = r.stdout.trim().split('\n').pop()
    const reported = JSON.parse(line)
    assert.strictEqual(reported.i, 'npm', 'CODECOMBO_INSTALLER=npm must be injected')
    // 外部预置的陈旧同名值（测试 env 钉空串）必须被 wrapper 重建的值覆盖——
    // Go 侧 ppid 双守卫的消费源是本 wrapper 的 PID
    assert.match(reported.p, /^\d+$/, 'CODECOMBO_WRAPPER_PID must be rebuilt as a numeric pid')
    assert.notStrictEqual(reported.p, '0', 'pid must be positive')
    assert.strictEqual(reported.ppid, Number(reported.p), 'child ppid must equal the wrapper pid handed via env (Go double-guard precondition)')
  })

  test('argv replay: wrapper args handed to the platform binary verbatim', (t) => {
    const entry = stageLayout(t)
    const script = 'console.log(JSON.stringify(process.argv.slice(1)))'
    const args = ['-e', script, 'extra-arg', '--flag=value']
    const r = runWrapper(entry, args)
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`)
    const line = r.stdout.trim().split('\n').pop()
    const replayed = JSON.parse(line)
    // 假平台二进制=node：自身消费 -e script 对（原样命中，script 得以执行），
    // 其余参数按原顺序落到子进程 argv——重放保真面 = 透传无损
    assert.deepStrictEqual(replayed, ['extra-arg', '--flag=value'])
  })

  test('signal death of the child surfaces as wrapper exit 1', (t) => {
    // 双平台同判：POSIX 子进程死于 SIGKILL（signal 死亡 → 原口径透传 1）；
    // Windows process.kill 落 TerminateProcess（code=1 → 透传 1）
    const entry = stageLayout(t)
    const r = runWrapper(entry, ['-e', 'process.kill(process.pid, "SIGKILL")'])
    assert.strictEqual(r.status, 1)
  })

  test('POSIX SIGTERM to the wrapper is forwarded to the child', { skip: process.platform === 'win32' ? 'Windows has no POSIX signals (child.kill is TerminateProcess)' : false }, async (t2) => {
    const entry = stageLayout(t2)
    // 子进程装 SIGTERM 处理器退出 42：wrapper 转发后经 exit 透传收口为 42
    const child = spawn(process.execPath, [entry, '-e', 'process.on("SIGTERM",()=>process.exit(42));setInterval(()=>{},1000)'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d
    })
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
    // 等 wrapper 完成 spawn 再投信号
    await new Promise((resolve) => setTimeout(resolve, 3000))
    process.kill(child.pid, 'SIGTERM')
    const code = await exited
    assert.strictEqual(code, 42, `wrapper must forward SIGTERM and mirror the child's exit code (stderr: ${stderr})`)
  })

  test('POSIX SIGINT is NOT forwarded (no double delivery to the child)', { skip: process.platform === 'win32' ? 'Windows cannot deliver SIGINT to a spawned child process' : false }, async (t2) => {
    const entry = stageLayout(t2)
    // 子进程无 SIGINT 处理器（默认=信号死亡）：3s 后自退 42。wrapper 若转发
    // SIGINT，子进程死于信号 → wrapper 收口为 1；正确行为=不转发，子进程按自身
    // 定时器退出 42——终端 Ctrl+C 的组投递由 OS 原生覆盖（转发会造成双投递，
    // 触发 Go 侧二次信号强制退出扳机）
    const child = spawn(process.execPath, [entry, '-e', 'setTimeout(()=>process.exit(42),3000);setInterval(()=>{},1000)'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr += d
    })
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
    await new Promise((resolve) => setTimeout(resolve, 1500))
    process.kill(child.pid, 'SIGINT')
    const code = await exited
    assert.strictEqual(code, 42, `wrapper must not forward SIGINT (child kept running to its own exit; stderr: ${stderr})`)
  })
})
