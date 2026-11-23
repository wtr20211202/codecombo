package update

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// 自更新子进程的服务重启与健康检查（从 do_update.go 拆出）。
// binary 为服务端自身二进制的绝对路径（LaunchUpdateSubprocess 校验链传递），
// argv 列式传参不经 shell。

// systemdUnit 探测当前进程是否由 systemd 托管：Linux 上读 /proc/self/cgroup，
// 服务实例的 cgroup 路径末段形如 <name>.service。返回单元名（含 .service 后缀，
// 如 simple-coding.service）；裸进程 / Windows / 容器等非 systemd 环境返回空串
func systemdUnit() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	data, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(data), "\n") {
		// 形如 0::/system.slice/simple-coding.service
		idx := strings.LastIndex(line, "/")
		if idx < 0 {
			continue
		}
		unit := strings.TrimSpace(line[idx+1:])
		if strings.HasSuffix(unit, ".service") {
			return unit
		}
	}
	return ""
}

// systemdUnitOurs systemd 单元中「本产品部署器装的」那两类：codecombo.service
// 与旧名 simple-coding.service。canonicalizeBinaryName 只为这两类让位盘上改名
// ——unit ExecStart 钉着旧路径，换名会让 systemctl restart 落空；而泛化的
// .service 命中（宿主自身就是 systemd 服务的环境，如 GitHub Actions runner）
// 与本产品无关，不该拦改名（runner 上曾误判致单测挂，实锚）
//
// 经 systemdUnitOursFn 间接调用：测试注入可控值，摆脱对宿主 /proc/self/cgroup
// 实况的依赖（环境依赖探测的测试纪律——runner/容器/裸机各不相同）
func systemdUnitOurs() string {
	return systemdUnitOursFn()
}

var systemdUnitOursFn = func() string {
	unit := systemdUnit()
	if unit == "codecombo.service" || unit == "simple-coding.service" {
		return unit
	}
	return ""
}

// systemdUnitFn systemd 自查取值口（superviseFromEnv 的裁决依据）：环境依赖
// 探测的测试纪律——宿主 /proc/self/cgroup 实况各异，测试注入可控值
// （systemdUnitOursFn 同款间接调用）
var systemdUnitFn = systemdUnit

// superviseFromEnv 更新子进程的监管形态裁决（P-20261112-1-S1 契约语义）：
//  1. systemd 自查恒优先——env 提示只是 darwin/windows 服务形态的必要下发
//     源，与自查不一致时留痕；提示=bare（主进程对 systemd 形态的正常下发，
//     见 envUpdateSupervise）属中性值不算不一致，避免每次更新噪声日志
//  2. 其余按 env 提示裁决：windows-service|launchd 按提示；缺省（env 不存在
//     =旧主进程未下发）/未知值回落 bare——旧对端行为不劣化（跨版本矩阵
//     现状语义）
//
// S1 只裁决留痕不改路由（restartService 仍按自查 systemd 分叉）；S2 起
// restartService 按本函数结果路由各形态
func superviseFromEnv() superviseForm {
	if unit := systemdUnitFn(); unit != "" {
		if hint := os.Getenv(envUpdateSupervise); hint != "" && hint != string(superviseBare) {
			updateLogf("supervise env hint %q disagrees with self-check systemd unit %q — self-check wins", hint, unit)
		}
		return superviseSystemd
	}
	switch hint := os.Getenv(envUpdateSupervise); hint {
	case string(superviseWindowsService), string(superviseLaunchd):
		return superviseForm(hint)
	default:
		if hint != "" && hint != string(superviseBare) {
			updateLogf("unknown supervise env hint %q — falling back to bare", hint)
		}
		return superviseBare
	}
}

// 平台动作取值口（环境依赖探测的测试纪律——四形态路由矩阵单测注入可控值，
// 测试绝不真实 spawn 换包进程 / 碰真实 SCM 与 systemctl，launchUpdateSubprocessFn
// 注释同款护栏）：
//   - systemctlRestartFn systemd 分支的 restart 执行（默认 systemctl 命令）
//   - scStartServiceFn / stopWindowsServiceFn Windows 服务分支的 SCM 启停
//     （平台实现见 restart_windows.go / restart_other.go）
//   - spawnBareFn bare 分支的进程拉起（默认 os.StartProcess+Release）
var (
	systemctlRestartFn   = func(unit string) error { return exec.Command("systemctl", "restart", unit).Run() }
	scStartServiceFn     = scStartService
	stopWindowsServiceFn = stopWindowsService
	spawnBareFn          = func(binary string, argv []string, attr *os.ProcAttr) (int, error) {
		proc, err := os.StartProcess(binary, argv, attr)
		if err != nil {
			return 0, err
		}
		// 不等待退出：服务进程自负责生命周期，释放句柄避免僵尸
		if err := proc.Release(); err != nil {
			return proc.Pid, err
		}
		return proc.Pid, nil
	}
)

// maxUpdateArgvItems argv 列式契约计数的防御上界：主进程 os.Args 受 OS 限制
// 远小于此值，env 里的天文数字 N 视为契约损坏回落（防 make 按超大 cap 预分配）
const maxUpdateArgvItems = 512

// windowsServiceName SCM 服务名（平台无关定义：restartService 的失败留痕引用
// 它，非 Windows 分支只是不可达而非不可编译）。与 main 包 svc.Run("Codecombo")
// （windows_service.go）及 scripts/install.ps1 的 sc.exe create/config 同名
// ——改名必须三处同步
const windowsServiceName = "Codecombo"

// origArgsFromEnv 读主进程原参数 argv 列式契约（CODECOMBO_UPDATE_ARGV_N 计数 +
// CODECOMBO_UPDATE_ARGV_<i> 逐键承载主进程 os.Args[1:]，语义见 do_update.go
// 契约块）。契约缺省（旧主进程不下发，跨版本矩阵常态，无噪声不留痕）/ N 非法
// 或超上界 / 任一逐键缺失 → (nil, false)，调用方回落现状语义（--serve --port）。
// LookupEnv 区分「空串参数」与「缺键」——空串是合法参数值
func origArgsFromEnv() ([]string, bool) {
	raw := os.Getenv(envUpdateArgvN)
	if raw == "" {
		return nil, false
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 || n > maxUpdateArgvItems {
		updateLogf("argv contract %s=%q unusable (%v) — falling back to --serve --port", envUpdateArgvN, raw, err)
		return nil, false
	}
	args := make([]string, 0, n)
	for i := 0; i < n; i++ {
		v, ok := os.LookupEnv(envUpdateArgvPrefix + strconv.Itoa(i))
		if !ok {
			updateLogf("argv contract item %d missing — falling back to --serve --port", i)
			return nil, false
		}
		args = append(args, v)
	}
	return args, true
}

// restartService 以新二进制拉起服务进程，按监管形态路由（P-20261112-1-S2，
// 裁决语义见 superviseFromEnv），保持更新前的监管方式：
//   - systemd（自查优先）→ systemctl restart 交还 systemd（状态机、Restart=
//     策略、日志归属不变，不孵化孤儿进程）。换包完成后磁盘上已是新二进制，
//     restart 即以新版本拉起；返回 PID 无意义（由 systemd 接管），恒为 0
//   - windows-service → sc.exe start 交还 SCM（unit binPath 钉着同一路径，
//     换包后即新二进制）；失败走既有回滚链（回滚同走本函数形态路由，恢复
//     备份后再 sc start）。返回 PID 无意义（SCM 接管），恒为 0
//   - launchd → 不 spawn 直接成功返回，KeepAlive 拉起（换包窗口 KeepAlive
//     可能已先拉起，waitForHealthy 轮询容忍此竞态）
//   - bare/前台 → restartBare：原参数 spawn（argv 契约），返回新进程 PID
//
// --serve 子命令：main.go 按 os.Args[1] 分发，只有 --serve 进入服务装配
// （历史缺陷只传 --port，落 default 分支打印 unknown command 后立即退出）
func restartService(binary string, port int, dd string) (int, error) {
	switch superviseFromEnv() {
	case superviseSystemd:
		// unit 名自查取回（superviseFromEnv 内部已自查过一次，再取一次只为
		// 拿名字——/proc 读开销可忽略，不值得为此改 S1 裁决函数签名）
		unit := systemdUnitFn()
		if err := systemctlRestartFn(unit); err != nil {
			return 0, fmt.Errorf("systemctl restart %s: %w", unit, err)
		}
		return 0, nil
	case superviseWindowsService:
		if err := scStartServiceFn(); err != nil {
			return 0, fmt.Errorf("sc start %s: %w", windowsServiceName, err)
		}
		return 0, nil
	case superviseLaunchd:
		// 不 spawn：KeepAlive 是该形态唯一的拉起者（重复 spawn 会与重拉赛跑
		// 抢端口）。注意本函数对 launchd 恒为「交还监管者」，不负责终结换包
		// 窗口里 KeepAlive 已重拉起的旧实例——那属正向路径专属动作，见
		// terminateStaleLaunchdInstance 的落点纪律
		updateLogf("launchd-managed: no spawn, KeepAlive re-launches from the swapped binary")
		return 0, nil
	default:
		return restartBare(binary, port, dd)
	}
}

// terminateStaleLaunchdInstance 换包后终结 KeepAlive 重拉起的旧实例
// （P-20261122-6 正向路径专属）。
//
// 缺陷形态（代码实锚 + 用户实测时序）：launchd 正向更新的时序是「旧实例交接
// shutdownFn → srv.Shutdown → serve 收尾删 PID 文件 → 退出」→ KeepAlive=true
// 无条件同秒重拉**旧盘上二进制** → 旧实例重写 PID 文件并占住全部端口 → 子进程
// 才换包。restartService 的 launchd 分支不 spawn（KeepAlive 是唯一拉起者），
// 所以若不再终结这个运行中的旧实例：waitForHealthy 探到的 200 恒来自内存旧版，
// 轻则误判成功（盘上新版 + 内存旧版，直到手动重启才上线），重则探测失败走
// 回滚——两条都到不了新版。
//
// 落点纪律（评审裁定，负断言钉在测试里）：只由 DoUpdate 正向路径在
// restartService 成功后调用。restartService 被 rollback/killAndRollback 共用，
// 换包失败回滚时 KeepAlive 拉起的旧实例正是期望终态（旧版在跑=安全态），放进
// 该函数会无谓杀掉健康旧实例、重拉意外失败时终态反而恶化；killAndRollback 的
// launchd 分支保持原序不重构（先恢复旧包再杀，KeepAlive 重拉必捡旧包）。
//
// 步骤分两段：
//
//  1. 有界等待活实例（awaitLiveLaunchdPID）：换包窗口的常见序是「孩子返回、
//     旧实例后写盘」——旧实例写 PID 在 config/TLS/日志装配之后（app.go 常数
//     百 ms），且 os.WriteFile 是 O_TRUNC+单次 write 非原子，读到空/残缺文件
//     是常态而非异常。旧实现 readRunningPid=0 直接 return nil 把「还没写」
//     当「无需终结」（P-20261122-8 评审阻断级补充）；等待 ≤terminatePIDWait
//     仍无活实例 → 报错走回滚（失败反馈从 10 分钟 runaway 提前到 ~10s——
//     「无人可用」本身也无法证明新版上线，不能当成功）
//
//  2. 版本判据（classifyPIDVersion）——**版本 == 目标才跳过**：
//     - 已证实是换包后的新二进制（自更新链 got == target；中心链 got ≠
//     prevVersion）→ 跳过击杀（健康等待还会再确认一次）
//     - 其余一律终结：缺行（pre-version-line 实例，立即终结不等待）/ 版本 ≠
//     目标（KeepAlive 重拉的旧实例自己写的旧版本号——任何含 P-6 构建都会写
//     第五行，旧实现的「非空即跳过」从第二个更新起必跳过旧实例）/ 目标不
//     可知且无法比对。kill 是安全方向（KeepAlive 从盘上新版重拉，最多多一
//     次重启）；跳错是危险方向（旧实例常驻 → 健康门控读到旧版本号必不认
//     → 10 分钟 runaway → 必回滚，P-20261122-8 缺陷实锤）
//
// 终结动作：SIGTERM（走 app.go 信号处理同款优雅关停：5s 排空 + serve 收尾删
// PID 文件，给 waitForHealthy 干净起点）→ 等 ≤terminateGrace 退出 → 残活
// SIGKILL（复用 killByPID，与回滚链同一精确击杀原语）→ 再等 ≤terminateKillGrace
// → 仍活如实报错，由调用方回滚。不用 launchctl kickstart -k：Label 与 gui/uid
// 域推导成本高且存量 plist 可能仍是旧 Label，KeepAlive 已兜重拉。
func terminateStaleLaunchdInstance(dd, targetVersion, prevVersion string) error {
	pid, got, err := awaitLiveLaunchdPID(dd)
	if err != nil {
		return err
	}
	switch classifyPIDVersion(got, targetVersion, prevVersion) {
	case pidVersionNew:
		// 换包窗口内 KeepAlive 恰好拉起的是新二进制：健康等待自会带着版本证据
		// 确认，跳过击杀省一次重启
		if realVersion(targetVersion) {
			updateLogf("launchd terminate: pid=%d already runs the swapped binary (version %q == target) — nothing to terminate", pid, got)
		} else {
			updateLogf("launchd terminate: pid=%d runs version %q which differs from the pre-update version (target unknowable on this chain) — swapped binary, nothing to terminate", pid, got)
		}
		return nil
	case pidVersionAbsent:
		// 缺行 = 本版之前构建的实例（不写第五行）：不可能已在跑新二进制
		updateLogf("launchd terminate: pid=%d has no version line (pre-version-line instance) — stopping it", pid)
	case pidVersionPrev:
		if realVersion(targetVersion) {
			updateLogf("launchd terminate: pid=%d runs version %q != target %q (KeepAlive relaunched the pre-swap binary) — stopping it", pid, got, targetVersion)
		} else {
			updateLogf("launchd terminate: pid=%d still runs the pre-update version %q (target unknowable on this chain) — stopping it", pid, got)
		}
	default: // pidVersionLineOnly
		updateLogf("launchd terminate: pid=%d runs version %q unverifiable (target and pre-update version both unknowable) — stopping it", pid, got)
	}
	updateLogf("launchd terminate: stopping stale instance pid=%d (SIGTERM, grace %v)", pid, terminateGrace)
	if err := signalTermFn(pid); err != nil {
		// ESRCH（已退出）/权限问题都继续走下方活性等待：退出即可，残留则硬杀
		updateLogf("launchd terminate: SIGTERM pid=%d failed (%v) — checking liveness", pid, err)
	}
	if err := terminateWaitFn(pid, terminateGrace); err == nil {
		updateLogf("launchd terminate: pid=%d exited after SIGTERM", pid)
		return nil
	}
	updateLogf("launchd terminate: pid=%d still alive after %v — SIGKILL", pid, terminateGrace)
	if err := killByPIDFn(pid); err != nil {
		updateLogf("launchd terminate: SIGKILL pid=%d failed (%v)", pid, err)
	}
	if err := terminateWaitFn(pid, terminateKillGrace); err != nil {
		return fmt.Errorf("stale launchd instance pid %d still running after SIGTERM/%v and SIGKILL/%v", pid, terminateGrace, terminateKillGrace)
	}
	updateLogf("launchd terminate: pid=%d exited after SIGKILL", pid)
	return nil
}

// pidVersionClass PID 文件第五行版本相对本轮更新的身份（classifyPIDVersion 判据
// 两处决策共用：terminate 的跳过决策 / 健康门控的放行决策）。
// 「版本行在场」本身不是证据——任何含 P-20261122-6 修复的构建（beta.10 起）
// 启动时都写第五行，KeepAlive 重拉的旧实例照样写它自己的旧版本号
type pidVersionClass int

const (
	// pidVersionAbsent 缺行：pre-version-line 实例（beta.10 之前构建，不写此行）
	pidVersionAbsent pidVersionClass = iota
	// pidVersionPrev 已证实不是换包后的新二进制（自更新链 got≠target；中心链
	// got==prevVersion——prevVersion 否决）
	pidVersionPrev
	// pidVersionLineOnly 有版本行，但目标版本与换包前版本都不可知（dev 构建），
	// 无法比对：只能证明应答者带写行能力
	pidVersionLineOnly
	// pidVersionNew 已证实是换包后的新二进制
	pidVersionNew
)

// classifyPIDVersion 版本行身份判据（纯函数，两处决策共用同一口径）：
//   - 目标版本已知（自更新链 env 传 release 版本）：got 逐字等于目标才算新
//   - 目标版本不可知（中心链 env 传字面量 "center" / dev 构建）：换包前版本已知
//     时以它否决——got == prevVersion 说明应答者仍是旧版；got 是别的版本号
//     即已换装（新于目标也算，健康门控的 realVersion 口径同族）
//   - 两者都不可知（dev←dev）：只剩「有行」这一层证据（pidVersionLineOnly）
//
// 反例边界（如实记）：中心链重部署**同一构建**时，换装后的新进程与旧实例写的
// 版本行完全相同（都是 prevVersion）——版本行无法区分二者，按否决处理（诚实
// 回滚）。代价可接受：盘面与内存同为同一构建，没有版本劣化，只是报告「已回滚」
// 而非「成功」；方向与 terminate 的「跳错是危险方向」一致。
func classifyPIDVersion(got, targetVersion, prevVersion string) pidVersionClass {
	if got == "" {
		return pidVersionAbsent
	}
	if realVersion(targetVersion) {
		if got == targetVersion {
			return pidVersionNew
		}
		return pidVersionPrev
	}
	if realVersion(prevVersion) {
		if got == prevVersion {
			return pidVersionPrev
		}
		return pidVersionNew
	}
	return pidVersionLineOnly
}

// awaitLiveLaunchdPID 有界等待 PID 文件出现活实例，返回 (pid, 版本行)——两者
// 来自**同一次、同一文件**的读取（评审建议：分两次读取时「首个可解析 PID」与
// 「首个五行文件」可能命中不同候选，迁移窗把旧目录的 PID 与另一实例的版本行
// 拼在一起）。版本行随 PID 一起给出，缺行即该实例的真实形态，不跨文件续找。
// 超时报错由调用方回滚；单次读取语义见 readRunningPidVersion
func awaitLiveLaunchdPID(dd string) (int, string, error) {
	deadline := time.Now().Add(terminatePIDWait)
	waiting := false
	for {
		pid, got := readRunningPidVersionFn(dd)
		if pid > 0 && processAlive(pid) {
			if waiting {
				updateLogf("launchd terminate: live instance pid=%d appeared while waiting", pid)
			}
			return pid, got, nil
		}
		if !waiting {
			waiting = true
			updateLogf("launchd terminate: no live instance in pid file yet — waiting up to %v for the relaunch to land", terminatePIDWait)
		}
		if !time.Now().Add(terminatePIDStep).Before(deadline) {
			return 0, "", fmt.Errorf("no live instance appeared in the pid file within %v after the swap — cannot confirm the swapped binary or terminate a stale one", terminatePIDWait)
		}
		time.Sleep(terminatePIDStep)
	}
}

// terminateStaleLaunchdInstance 的动作取值口（环境依赖探测的测试纪律：单测
// 注入以断言信号目标来自 PID 文件、硬杀兜底与失败上抛，绝不真实向进程投信号
// ——本包测试无 t.Parallel，包级插桩安全，killByPIDFn/systemdUnitFn 同款）。
// readRunningPidVersionFn 是 (pid, 版本行) 同源读取的唯一入口：单测依序注入
// 「无活 PID → 活实例出现」序列以验证有界等待，不必真睡 10s 也不靠写盘竞态
var (
	signalTermFn            = signalTerm
	terminateWaitFn         = waitForProcess
	readRunningPidVersionFn = readRunningPidVersion
)

// 有界等待活实例的节奏（包级变量仅为测试压缩时长——生产恒默认值，与
// healthPollInterval 同款纪律：包测试无 t.Parallel，包级插桩安全）。
//   - terminatePIDStep 200ms：与 do_update_unix waitForProcess 的 500ms 轮询
//     同量级再细一档——旧实例写盘是数百 ms 级动作，粗了会白等一档
//   - terminatePIDWait 10s：旧实例的 config/TLS/日志装配 + PID 写盘在常数
//     百 ms 量级，10s 给足慢盘余量；到点仍无活实例=无法证明新版在跑，报错回滚
var (
	terminatePIDWait = 10 * time.Second
	terminatePIDStep = 200 * time.Millisecond
)

// 终结两步的等待上限（常量：测试经 terminateWaitFn 注入即瞬时返回，无需压缩）
const (
	// terminateGrace SIGTERM 后的优雅退出宽限：app.go 优雅关停最多 5s 排空，
	// 留一倍余量（慢盘会话多时 5s 可能刚好卡线）
	terminateGrace = 10 * time.Second
	// terminateKillGrace SIGKILL 后等内核回收进程的上限（SIGKILL 不可捕获，
	// 正常亚毫秒级退出，此值只兜不可杀态如 D 状态/挂起）
	terminateKillGrace = 5 * time.Second
)

// restartBare bare/前台形态的 spawn（P-20261112-1-S2）：循 RestartSelfExe 口径
// 以主进程原参数（argv 契约逐键还原，不经 shell）拉起新二进制——历史只传
// --serve --port 静默丢 --host/--data-dir 等旗标（host 无 env 回写面，全仓无
// 读取），用户点名「直接 start 的必须用老参数原样启动」。契约缺省（旧主进程）
// 回落现状语义（--serve --port）。进程属性走 daemonProcAttr（main 包
// setDaemonAttrs 同款：unix Setpgid / Windows CREATE_NO_WINDOW+新进程组），
// 脱离旧终端会话——前台形态关窗不再死；stdout/stderr 落数据目录日志
// （daemonStdout，前台形态脱离后终端不再接收输出，start 形态原为 /dev/null，
// 落文件是纯增益）
func restartBare(binary string, port int, dd string) (int, error) {
	argv := []string{binary}
	if args, ok := origArgsFromEnv(); ok {
		argv = append(argv, args...)
		updateLogf("bare restart: replaying %d original args from argv contract", len(args))
	} else {
		argv = append(argv, "--serve", "--port", strconv.Itoa(port))
		updateLogf("bare restart: argv contract absent (pre-S2 parent) — legacy --serve --port %d", port)
	}
	out := daemonStdout(dd)
	attr := &os.ProcAttr{
		Env:   os.Environ(),
		Files: []*os.File{os.Stdin, out, out},
		Sys:   daemonProcAttr(),
	}
	pid, err := spawnBareFn(binary, argv, attr)
	// 落盘句柄即关：StartProcess 已为子进程复制句柄（exec.Cmd 对自开 stdio
	// 同款处置），父侧留着只会锁住文件（Windows TempDir 清理实证）。回落
	// os.Stdout（打开失败）时不关——那是进程级句柄
	if out != os.Stdout {
		_ = out.Close()
	}
	return pid, err
}

// daemonStdout bare spawn 的 stdout/stderr 落盘文件（数据目录 logs/
// update-restart.log，O_APPEND 串接多轮更新；职责头注仅首次创建时写，
// openAppendLog——双文件防混淆面见 do_update.go 头注常量块）。打开失败回落
// 继承更新子进程自身 stdio（best-effort 不阻断 spawn——spawn 失败/不健康由
// 回滚链兜底）
func daemonStdout(dd string) *os.File {
	logDir := filepath.Join(dd, "logs")
	_ = os.MkdirAll(logDir, 0755)
	f, err := openAppendLog(filepath.Join(logDir, "update-restart.log"), restartLogHeader)
	if err != nil {
		updateLogf("open restart stdout log failed (%v) — inheriting update subprocess stdio", err)
		return os.Stdout
	}
	return f
}

// RestartViaSystemd systemd 托管实例的重启（P-20261106 页面重启链）：
// systemctl restart 停旧起新全托管（状态机、Restart= 策略、日志归属不变）。
// 返回 (false, nil)=非 systemd 环境由调用方走自 spawn 链；(true, err)=systemd
// 托管但 restart 失败（调用方留痕并保持存活——此时绝不能退出，退出即失联）
func RestartViaSystemd() (bool, error) {
	unit := systemdUnit()
	if unit == "" {
		return false, nil
	}
	if err := exec.Command("systemctl", "restart", unit).Run(); err != nil {
		return true, fmt.Errorf("systemctl restart %s: %w", unit, err)
	}
	return true, nil
}

// RestartSelfExe 前台/裸进程形态的自重启（页面重启链兜底，P-20261122-2 脱
// 会话升级）：以**当前进程原参数**（os.Args 全量，含 --host/--data-dir 等——
// restartService 只传 --port 会丢参数）spawn 自身后返回，调用方先释放监听再
// 调本函数（新进程可即时绑定）。systemd/Windows 服务/launchd/npm wrapper 前台
// 形态不走此链（各自监管者接管）。
//
// 进程属性走 daemonProcAttr + stdout/stderr 落数据目录日志（daemonStdout，与
// 更新链 restartBare 同款）——此前同会话 spawn 且 stdio 继承终端：前台/裸进程
// 与 npm 守护形态页面重启后，终端关闭（POSIX SIGHUP 组灭 / Windows 控制台
// CTRL_CLOSE_EVENT）即连带新进程死且再无监管者（npm 安装「重启后没启动起来」
// 主诉的兜底面根因）。升级后的语义注记：前台 `--serve` 页面重启转后台——终端
// 回提示符，后续输出看数据目录 logs/update-restart.log；npm 前台经 wrapper
// respawn（WrapperRestartRequested 握手）保持前台附着不变，不走本函数。
// dd 为数据目录（config.DataDir()，调用方传入——本包不反向依赖 config 装配）
func RestartSelfExe(dd string) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	argv := append([]string{exe}, os.Args[1:]...)
	out := daemonStdout(dd)
	attr := &os.ProcAttr{
		Env:   os.Environ(),
		Files: []*os.File{os.Stdin, out, out},
		Sys:   daemonProcAttr(),
	}
	// 不等待退出：服务进程自负责生命周期，spawnBareFn 内 Release 句柄避免僵尸
	_, err = spawnBareFn(exe, argv, attr)
	// 落盘句柄即关：StartProcess 已为子进程复制句柄（restartBare 同款处置），
	// 父侧留着只会锁住文件（Windows TempDir 清理实证）；回落 os.Stdout（打开
	// 失败）时不关——那是进程级句柄
	if out != os.Stdout {
		_ = out.Close()
	}
	return err
}

// killByPID 精确击杀（健康检查失败回滚路径）。按 PID 而非 pkill -f 名称匹配：
// 后者按完整命令行做正则匹配（`.` 通配任意字符），会误杀命令行里恰好包含
// 同名串的无关进程（如 tail -f simple-coding.log）
func killByPID(pid int) error {
	if pid <= 0 {
		return nil
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return proc.Kill()
}

// killByPIDFn 击杀取值口（killAndRollback 用）：单测注入以断言击杀目标来自
// PID 文件/本子进程 spawn（回滚链同构断言），不真实杀进程
var killByPIDFn = killByPID

// 健康等待的节奏与兜底（包级变量仅为测试压缩时长——生产恒默认值，包测试
// 无 t.Parallel 包级插桩安全，stallTimeout 同款纪律）
var (
	healthPollInterval = 1 * time.Second
	healthReportEvery  = 10 * time.Second
	healthRunawayGuard = 10 * time.Minute
	// crashLoopPidChanges 基线确立后 PID 文件值变化达到该次数即判 crash-loop。
	// 阈值 2：一次变化可能是服务形态正常单次重启（SCM failure-recovery 等），
	// 连续两次 = 新二进制起一次崩一次的循环，继续等只会循环下去
	crashLoopPidChanges = 2
)

// waitForHealthy 等待新版本进程健康（P-20261116-1-S1 活性驱动等待，替代
// 15s 硬编码死线）：恢复时间是用户环境的函数（会话数/机器性能/磁盘），不能
// 预设时间预算；误判代价极端不对称——多等无害、误回滚致命，故判据全部取
// 进程活性证据：
//  1. PID 基线播种：先确立「新 PID 基线」（PID 文件读到 ≠ 换包前旧 PID 且
//     存活的值）才启用 crash-loop 失败判据。基线未立前读到旧 PID/0/不可读
//     一律视为「新进程未起」只继续轮询不判死——起点等待窗口旧进程可能尚未
//     走完 serve 收尾（shutdownFn 钩子优雅退出后 Serve 返回、PID 文件按
//     PID==self 条件删除〔server/app removePIDFile〕都在 ms 级之后），朴素
//     活性循环会在 t≈0 读到死旧 PID 而误回滚（beta.7→beta.8 事故形态；
//     时序实况：更新链 waitForProcess 等旧进程全退才 spawn 新进程，旧删恒
//     先于新写——t≈0 读到旧 PID 是退出链尚未走完的窗口，非文件永留旧值）
//  2. /api/health 1s 轮询照旧，地址派生同前：读 PID 文件（新进程启动即重写）
//     第三行回环辅助端口 > 0（TLS 模式）则探测回环口，否则探测主端口明文
//     （历史缺陷见 git 历史：固定明文主端口在 TLS 默认开启后必挂）；PID 文件
//     不可读时回退主端口明文探测。进程稳定存活即持续等待，恢复再慢都等。
//     200 不再单独算成功——须再过版本证据门（pidVersionEvidence：PID 文件
//     第五行 version 与目标版本相符；旧实例不写行，launchd KeepAlive 重拉的
//     旧实例同样回 200 是误判成功实锚，P-20261122-6）
//  3. crash-loop 计数：基线确立后 PID 文件值变化 ≥ crashLoopPidChanges 次即
//     判 crash-loop 立即失败走回滚——unit Restart=on-failure 约 100ms 重拉使
//     「活性」永真（install.sh 的 unit 未设 StartLimit*，慢崩溃循环 systemd
//     拦不住），且把崩溃循环检测从 10 分钟兜底压回秒级。变化观察排除换包前
//     旧 PID（防陈旧文件在新进程首次改写前被计为一次重启）；不要求新值存活
//     （服务形态两次崩溃可短于轮询间隔，死后落盘的 PID 值同样是重启证据）
//  4. 失控兜底 healthRunawayGuard 仅作 runaway 防护，语义=超时兜底、原因未定
//     （慢恢复或死锁均可——23 会话慢盘恢复可合法超 10 分钟，触发不代表真
//     死锁），触发后恢复旧版本是正确动作
//  5. 诊断行证据化：每 healthReportEvery 落一行真实进展（基线存活态 + 已等
//     时长 + 数据目录日志字节增量，logsSize）；会话恢复计数在新进程内部，
//     更新子进程不可见，不以臆测值冒充该指标
func (c *updateContext) waitForHealthy(oldPID int) error {
	client := &http.Client{Timeout: 3 * time.Second}
	start := time.Now()
	var (
		baseline     int // 已确立的新 PID 基线；0=未播种（不启用失败判据）
		pidChanges   int
		lastReportAt time.Time
		lastLogSize  int64
		gateNote     string // 版本门控最近一次留痕的原因（同因只记一次）
	)
	for {
		if time.Since(start) >= healthRunawayGuard {
			return fmt.Errorf("health wait abandoned after runaway guard %v (cause undetermined: slow recovery or hang — progress log above tells which)", healthRunawayGuard)
		}

		url := fmt.Sprintf("http://localhost:%d/api/health", c.port)
		if loopback := readPIDLoopbackPort(c.dd); loopback > 0 {
			url = fmt.Sprintf("http://localhost:%d/api/health", loopback)
		}
		resp, err := client.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				// 200 只说明「本机有个实例在服务」——launchd 形态 KeepAlive 重拉
				// 起的旧实例同样回 200（P-20261122-6 误判成功实锚），故必须再要
				// 版本证据：PID 文件第五行 version == 目标版本（旧实例不写此行）
				if ok, reason := c.pidVersionEvidence(); ok {
					return nil
				} else if reason != gateNote {
					updateLogf("health wait: health 200 but responder not confirmed as the swapped-in version — continuing (%s)", reason)
					gateNote = reason
				}
			}
		}

		if pid := readRunningPid(c.dd); pid > 0 {
			switch {
			case baseline == 0:
				if pid != oldPID && processAlive(pid) {
					baseline = pid
					updateLogf("health wait: baseline seeded pid=%d after %s", pid, time.Since(start).Round(time.Second))
				}
			case pid != baseline && pid != oldPID:
				pidChanges++
				updateLogf("health wait: pid changed %d -> %d (change %d)", baseline, pid, pidChanges)
				if pidChanges >= crashLoopPidChanges {
					return fmt.Errorf("new process crash-loop: pid changed %d times during health wait (last %d -> %d)", pidChanges, baseline, pid)
				}
				baseline = pid
			}
		}

		now := time.Now()
		if lastReportAt.IsZero() {
			lastReportAt = start
			lastLogSize = logsSize(c.dd)
		} else if now.Sub(lastReportAt) >= healthReportEvery {
			size := logsSize(c.dd)
			progress := "no new pid yet (baseline unseeded)"
			if baseline > 0 {
				progress = fmt.Sprintf("pid %d alive=%v", baseline, processAlive(baseline))
			}
			if gateNote != "" {
				progress += "; version gate pending (" + gateNote + ")"
			}
			updateLogf("health wait: %s, waited %s, dd logs %+d bytes since last report", progress, now.Sub(start).Round(time.Second), size-lastLogSize)
			lastReportAt = now
			lastLogSize = size
		}

		time.Sleep(healthPollInterval)
	}
}

// logsSize 数据目录日志字节数合计（诊断行证据：增量 > 0 = 新进程在写日志 =
// 启动在推进）。排除本子进程自有 update.log——诊断行本身写它，不排除则增量
// 自证恒真。目录缺失/条目不可读按 0 计（best-effort 证据面，绝不影响判定）
func logsSize(dd string) int64 {
	entries, err := os.ReadDir(filepath.Join(dd, "logs"))
	if err != nil {
		return 0
	}
	var total int64
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".log") || e.Name() == "update.log" {
			continue
		}
		if info, err := e.Info(); err == nil {
			total += info.Size()
		}
	}
	return total
}

// pidFileCandidates 更新链 PID 文件候选（按序），readPIDLoopbackPort /
// readRunningPidVersion 共用。顺序覆盖更新链全矩阵（P-20261025-1）：
//  1. dd/codecombo.pid —— 本版正常形态
//  2. dd/simple-coding.pid —— 旧版写入的存量文件（更新子进程由旧代码下发
//     dd，而重启后的新版本进程已写新名——目录迁移会把旧名文件一并搬来）
//  3. config.DataDir()/codecombo.pid —— 数据目录迁移（旧默认目录整体改名）
//     发生在「旧二进制自更新换新」窗口内：env 下发的 dd 已随迁移消失，实际
//     pid 文件落在迁移后的新默认目录
func pidFileCandidates(dd string) []string {
	candidates := []string{
		filepath.Join(dd, "codecombo.pid"),
		filepath.Join(dd, "simple-coding.pid"),
	}
	if live := configDataDir(); live != dd {
		candidates = append(candidates, filepath.Join(live, "codecombo.pid"))
	}
	return candidates
}

// readRunningPid 读 PID 文件首行 = 当前监管者拉起进程的 PID（killAndRollback
// 的 windows-service/launchd 分支精确击杀/优雅停用——这两形态非本子进程 spawn，
// spawnedPID 恒 0，PID 文件是唯一来源）。无候选可读/解析失败返回 0。与
// readRunningPidVersion 同一实现——「谁的 PID」与「谁的版本行」永远同源
func readRunningPid(dd string) int {
	pid, _ := readRunningPidVersion(dd)
	return pid
}

// readRunningPidVersion 单次读取取 (pid, 第五行版本即写侧 app.writePIDFileScheme
// 的构建版本)——同一次、同一文件，绝不把 A 文件的 PID 与 B 文件的版本行拼装
// （迁移窗候选 1/3 可各有文件，分两次读会拼出不属于同一实例的对）。取首个
// 可解析 PID 的候选；该文件不足五行即版本行缺行（pre-version-line 实例的
// 真实形态），不续找候选（readPIDVersion 的续找语义是健康门控专用的
// 「有没有实例写了行」，与「这个 PID 的实例写了什么」是两回事）
func readRunningPidVersion(dd string) (int, string) {
	for _, path := range pidFileCandidates(dd) {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		content := strings.TrimSpace(string(data))
		idx := strings.IndexByte(content, '\n')
		if idx < 0 {
			// 首行无换行 = 空/残缺文件（os.WriteFile 是 O_TRUNC+单次 write，
			// 换包窗口读到空文件或被截断的首行是常态）。残缺首行（如 "12" 截自
			// "12345"）若可解析会指向无关进程，SIGTERM/SIGKILL 误杀面远大于多
			// 等一个轮询；合法写侧首行后必随端口行，故按「尚未写出」处理
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(content[:idx]))
		if err != nil || pid <= 0 {
			continue
		}
		lines := strings.Split(content, "\n")
		version := ""
		if len(lines) >= 5 {
			version = strings.TrimSpace(lines[4])
		}
		return pid, version
	}
	return 0, ""
}

// readPIDVersion 从数据目录读 PID 文件第五行的构建版本（P-20261122-6 写侧
// app.writePIDFileScheme）。行数不足按「缺行」返回空串（SplitN 截断容忍口径与
// app.go 写侧注释成对）。**缺行只说明该实例是 beta.10 之前构建的**——beta.10
// 起每个实例（含 KeepAlive 重拉的旧版）启动即写自己的版本号，「有行」不再是
// 「已换装」的证据，判据见 classifyPIDVersion。候选顺序见 pidFileCandidates；
// 命中候选但无第五行时继续找下一个候选（迁移窗口旧目录文件无行、新目录文件
// 有行的形态，与 readPIDLoopbackPort 同款续找语义）
func readPIDVersion(dd string) string {
	for _, path := range pidFileCandidates(dd) {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		if len(lines) < 5 {
			continue
		}
		return strings.TrimSpace(lines[4])
	}
	return ""
}

// pidVersionEvidence 健康 200 的应答者是否就是换包后的新二进制（P-20261122-6
// 证据性门控，补 terminateStaleLaunchdInstance 的第二道网）：PID 文件第五行
// 版本由带本修复的构建启动时写入。判据与 terminate 共用 classifyPIDVersion——
// **只有 beta.10 之前的实例不写行**，beta.10 起的旧实例（KeepAlive 重拉它）
// 会写自己的旧版本号，故「有行」本身不构成证据，须比对：
//   - 目标版本已知（自更新链 env 传 release 版本）：要求逐字相等
//   - 目标版本不可知（中心分发链 env 传字面量 "center"，或 dev 构建）：换包前
//     版本已知时以它否决（got == prevVersion = 应答者仍是旧版，P-20261122-8
//     回填；此前「有行即放行」在中心链对 P-6+ 旧实例恒真=静默假成功）；两者
//     都不可知时才退回「有行即是证据」（口径不变，dev 构建不误判回滚）
//
// 返回 (确认, 未确认原因)；原因供调用方留痕（同一原因只记一次，防 1s 轮询
// 刷屏 update.log）
func (c *updateContext) pidVersionEvidence() (bool, string) {
	got := readPIDVersion(c.dd)
	if got == "" {
		return false, "pid file has no version line (pre-upgrade instance, or the new process has not rewritten it yet)"
	}
	switch classifyPIDVersion(got, c.version, c.prevVersion) {
	case pidVersionNew:
		return true, ""
	case pidVersionPrev:
		if realVersion(c.version) {
			return false, fmt.Sprintf("pid file version %q != target %q", got, c.version)
		}
		return false, fmt.Sprintf("pid file version %q equals the pre-update version %q (responder is still the old build)", got, c.prevVersion)
	}
	// pidVersionLineOnly：目标与换包前版本均不可知（dev 构建），版本行在场即
	// 证明应答者带写行能力（beta.10 之前的实例不写行）
	return true, ""
}

// readPIDLoopbackPort 从数据目录读明文回环辅助端口（pid 文件第三行）。
// 文件缺失/格式不符返回 0（明文模式或尚未写出）。候选顺序见 pidFileCandidates
func readPIDLoopbackPort(dd string) int {
	for _, path := range pidFileCandidates(dd) {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		lines := strings.Split(strings.TrimSpace(string(data)), "\n")
		if len(lines) < 3 {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSpace(lines[2]))
		if err != nil {
			continue
		}
		return n
	}
	return 0
}
