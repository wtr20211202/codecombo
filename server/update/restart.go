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
		updateLogf("launchd-managed: no spawn, KeepAlive re-launches from the swapped binary")
		return 0, nil
	default:
		return restartBare(binary, port, dd)
	}
}

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

// RestartSelfExe 前台/裸进程形态的自重启：以**当前进程原参数**（os.Args 全量，
// 含 --host/--data-dir 等——restartService 只传 --port 会丢参数）spawn 自身后
// 返回，调用方先释放监听再调本函数（新进程可即时绑定）。systemd/Windows 服务/
// launchd 形态不走此链（各自监管者接管）
func RestartSelfExe() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	argv := append([]string{exe}, os.Args[1:]...)
	attr := &os.ProcAttr{
		Env:   os.Environ(),
		Files: []*os.File{os.Stdin, os.Stdout, os.Stderr},
	}
	proc, err := os.StartProcess(exe, argv, attr)
	if err != nil {
		return err
	}
	// 不等待退出：服务进程自负责生命周期，释放句柄避免僵尸
	return proc.Release()
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
//     一律视为「新进程未起」只继续轮询不判死——起点等待时旧进程已退出且其
//     PID 文件无退出清理（更新交接走 shutdownFn 钩子优雅退出，不删 PID 文件
//     〔app.go 仅监听失败/serve 收尾两路径删除〕），朴素活性循环会在 t≈0 读到
//     死旧 PID 而误回滚（beta.7→beta.8 事故形态）
//  2. /api/health 1s 轮询照旧，地址派生同前：读 PID 文件（新进程启动即重写）
//     第三行回环辅助端口 > 0（TLS 模式）则探测回环口，否则探测主端口明文
//     （历史缺陷见 git 历史：固定明文主端口在 TLS 默认开启后必挂）；PID 文件
//     不可读时回退主端口明文探测。进程稳定存活即持续等待，恢复再慢都等
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
				return nil
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
// readRunningPid 共用。顺序覆盖更新链全矩阵（P-20261025-1）：
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
// spawnedPID 恒 0，PID 文件是唯一来源）。无候选可读/解析失败返回 0
func readRunningPid(dd string) int {
	for _, path := range pidFileCandidates(dd) {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		line := strings.SplitN(strings.TrimSpace(string(data)), "\n", 2)[0]
		if pid, err := strconv.Atoi(strings.TrimSpace(line)); err == nil && pid > 0 {
			return pid
		}
	}
	return 0
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
