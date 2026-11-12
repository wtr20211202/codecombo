package update

import (
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var updateLogger *log.Logger

// updateContext 更新子进程的上下文，避免函数间传递大量参数
type updateContext struct {
	currentBinary string
	backup        string
	port          int
	dd            string
	version       string
	prevVersion   string
	// spawnedPID 本轮 restartService 拉起的新版本进程 PID（精确回滚击杀用）
	spawnedPID int
}

func initLogger(dd string) {
	logDir := filepath.Join(dd, "logs")
	_ = os.MkdirAll(logDir, 0755)
	f, err := os.OpenFile(filepath.Join(logDir, "update.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		updateLogger = log.New(os.Stderr, "[update] ", log.LstdFlags)
		return
	}
	updateLogger = log.New(f, "", log.Ldate|log.Ltime)
}

// 更新子进程内部 env 契约（LaunchUpdateSubprocess 下发）。P-20261025-1 起正名
// CODECOMBO_UPDATE_*；SIMPLE_CODING_UPDATE_* 旧名回落双读一个版本期——跨版本
// 矩阵「旧中心二进制下载新二进制后以 _do_update 拉起它」时，env 由旧代码下发
// 旧名，新代码必须能读到（dd 缺失会退化为按本机默认目录健康检查，TLS 形态下
// 误回滚）
const (
	envUpdateDataDir    = "CODECOMBO_UPDATE_DATA_DIR"
	envUpdateVersion    = "CODECOMBO_UPDATE_VERSION"
	envUpdatePrevVer    = "CODECOMBO_UPDATE_PREV_VERSION"
	envUpdateDataDirOld = "SIMPLE_CODING_UPDATE_DATA_DIR"
	envUpdateVersionOld = "SIMPLE_CODING_UPDATE_VERSION"
	envUpdatePrevVerOld = "SIMPLE_CODING_UPDATE_PREV_VERSION"
	// envUpdateSupervise 主进程下发的监管形态提示（可选字段，P-20261112-1-S1）：
	// 值域见 superviseForm。此前自更新链的 restartService 只认 systemd 自查，
	// Windows 服务/launchd 形态换包后按裸进程 spawn——服务形态打成 SCM 记
	// STOPPED 的孤儿进程、launchd 与 KeepAlive 重拉赛跑抢端口。systemd 不在
	// 值域内：更新子进程经 /proc/self/cgroup 自查且自查优先（restart.go
	// superviseFromEnv），主进程对 systemd 形态下发 bare（中性值，自查覆盖，
	// 不算两源不一致）。无旧名双写：旧主进程在本字段诞生前不存在任何名字的
	// 下发——缺省（env 不存在）即「旧主进程+新 _do_update 二进制」矩阵，回落
	// bare=现状语义不劣化；反向矩阵「新主进程+旧 _do_update 二进制」旧代码
	// 忽略未知 env，亦无影响
	envUpdateSupervise = "CODECOMBO_UPDATE_SUPERVISE"
	// envUpdateArgvN / envUpdateArgvPrefix 主进程原参数 argv 列式契约（可选
	// 字段，P-20261112-1-S2）：N=计数，ARGV_<i> 逐键承载主进程 os.Args[1:]，
	// bare/前台形态 restartService 按原参数原样 spawn（含 --host/--data-dir/
	// --tls-* 等全部旗标——历史只传 --port 静默丢参，且 host 无 env 回写面）。
	// 逐键 env 防分隔符歧义（参数内空白/引号/= 原样承载，不经 shell）；读侧
	// LookupEnv 区分「空串参数」与「缺键」。缺省（旧主进程不下发）回落现状
	// 语义（--serve --port），旧 _do_update 忽略未知 env——跨版本双向矩阵
	// 安全，无旧名双写（同 envUpdateSupervise 缘由）
	envUpdateArgvN      = "CODECOMBO_UPDATE_ARGV_N"
	envUpdateArgvPrefix = "CODECOMBO_UPDATE_ARGV_"
)

// superviseForm 监管形态（env 契约值域 + 自查补充值）。systemd 仅由更新子
// 进程自查产出（restart.go systemdUnit），不是 env 契约值——主进程对 systemd
// 形态发 bare，由子进程自查覆盖
type superviseForm string

const (
	superviseWindowsService superviseForm = "windows-service"
	superviseLaunchd        superviseForm = "launchd"
	superviseBare           superviseForm = "bare"
	superviseSystemd        superviseForm = "systemd"
)

func getenvOr(canonical, legacy string) string {
	if v := os.Getenv(canonical); v != "" {
		return v
	}
	return os.Getenv(legacy)
}

func DoUpdate(currentBinary, newBinary string, port int, pid int) error {
	dd := getenvOr(envUpdateDataDir, envUpdateDataDirOld)
	version := getenvOr(envUpdateVersion, envUpdateVersionOld)
	prevVersion := getenvOr(envUpdatePrevVer, envUpdatePrevVerOld)
	if dd == "" {
		dd = configDataDir()
	}

	initLogger(dd)
	updateLogger.Printf("update started: %s -> %s (pid=%d, port=%d)", prevVersion, version, pid, port)
	// 监管形态裁决留痕（自查优先、缺省回落 bare，语义见 superviseFromEnv）；
	// S2 起 restartService 按此路由（restartService 内部自裁决，此处留痕与
	// 成功结果注记复用同一裁决值）
	form := superviseFromEnv()
	updateLogger.Printf("supervise form: %s", form)

	ctx := &updateContext{
		currentBinary: currentBinary,
		backup:        currentBinary + ".bak",
		port:          port,
		dd:            dd,
		version:       version,
		prevVersion:   prevVersion,
	}

	updateLogger.Printf("waiting for old process %d to exit...", pid)
	if err := waitForProcess(pid, 30*time.Second); err != nil {
		updateLogger.Printf("wait failed: %v", err)
		ctx.saveResult("failed", err.Error())
		return err
	}
	updateLogger.Printf("old process exited")

	updateLogger.Printf("backing up %s -> %s", currentBinary, ctx.backup)
	if err := os.Rename(currentBinary, ctx.backup); err != nil {
		updateLogger.Printf("backup failed: %v", err)
		ctx.saveResult("failed", "backup failed: "+err.Error())
		return err
	}

	updateLogger.Printf("copying new binary %s -> %s", newBinary, currentBinary)
	if err := CopyFile(newBinary, currentBinary); err != nil {
		_ = ctx.rollback("replace failed: " + err.Error())
		return fmt.Errorf("replace failed: %s", err)
	}
	_ = os.Chmod(currentBinary, 0755)

	updateLogger.Printf("starting new version on port %d", port)
	spawned, err := restartService(currentBinary, port, dd)
	ctx.spawnedPID = spawned
	if err != nil {
		_ = ctx.rollback("start new version failed: " + err.Error())
		return fmt.Errorf("start new version failed: %s", err)
	}

	// 健康检查走 PID 文件派生的明文地址：TLS 默认开启后主端口是 https（自签），
	// 明文 GET 必失败导致更新误回滚；新进程启动后会重写 PID 文件，
	// 第三行的明文回环辅助端口（仅 TLS 模式存在）即为本机可靠的明文入口
	updateLogger.Printf("health check (timeout 15s)")
	if err := ctx.waitForHealthy(15 * time.Second); err != nil {
		ctx.killAndRollback("health check failed: " + err.Error())
		return err
	}

	updateLogger.Printf("update successful, cleaning up")
	os.Remove(ctx.backup)
	os.RemoveAll(filepath.Dir(newBinary))
	// 盘上二进制名归一（P-20261025-1）：旧名二进制（simple-coding[.exe] 或
	// simple-coding-<os>-<arch>）原位替换成功 + 健康检查通过后，原子换名至
	// codecombo 同名形态。约束三条：
	//   - systemd 托管不换（unit ExecStart 钉着旧路径，换名会让下一次
	//     systemctl restart 落空——那些实例由部署器装新 unit 收口）
	//   - Windows 上新进程正从该文件运行时 rename 会失败（映像句柄锁定），
	//     失败仅记日志保持旧名（原位替换语义不劣化）
	//   - 只认本产品旧名前缀（e2e 的 polish-e2e-9999.exe 等 harness 名不动）
	canonicalizeBinaryName(ctx.currentBinary)
	// bare/前台形态的成功结果注记（P-20261112-1-S2）：spawn 已脱离终端会话，
	// 前台形态 stdout 不再入终端、start 形态原为 /dev/null——stdout/stderr
	// 统一落数据目录日志（restartBare daemonStdout），如实告知去哪看。
	// 仅 bare 形态注记：windows-service/launchd/systemd 由各自监管者接管，
	// stdio 归属未变。走 UpdateResult.Error 通道（成功通知渲染忽略该字段，
	// 版本面板结局块在原因行透出——唯一自由文本通道）
	resultNote := ""
	if form == superviseBare {
		resultNote = "restarted as detached background daemon; stdout/stderr captured to logs/update-restart.log under the data dir"
	}
	ctx.saveResult("success", resultNote)
	return nil
}

// updateLogf 更新链日志（updateLogger 仅在 DoUpdate 的 initLogger 之后非 nil——
// 独立调用方如 canonicalizeBinaryName 单测路径 nil 安全回退 stderr）
func updateLogf(format string, args ...any) {
	if updateLogger != nil {
		updateLogger.Printf(format, args...)
		return
	}
	log.New(os.Stderr, "[update] ", log.LstdFlags).Printf(format, args...)
}

// canonicalizeBinaryName 更新成功后的盘上名归一（best-effort，任何失败静默留旧名）
func canonicalizeBinaryName(currentBinary string) {
	if systemdUnitOurs() != "" {
		updateLogf("systemd-managed: keep on-disk binary name (unit ExecStart pins the path)")
		return
	}
	base := filepath.Base(currentBinary)
	if !strings.HasPrefix(base, "simple-coding") {
		return
	}
	newBase := "codecombo" + strings.TrimPrefix(base, "simple-coding")
	newPath := filepath.Join(filepath.Dir(currentBinary), newBase)
	if err := os.Rename(currentBinary, newPath); err != nil {
		updateLogf("canonical rename %s -> %s failed (kept legacy name): %v", base, newBase, err)
		return
	}
	updateLogf("canonical rename done: %s -> %s", base, newBase)
}

// restoreBackup 回滚的盘面恢复段（旧二进制归位），rollback/killAndRollback
// 共用——回滚 restartService 一律走形态路由（与正向启动同构），本函数只管盘面
func (c *updateContext) restoreBackup() {
	os.Remove(c.currentBinary)
	_ = os.Rename(c.backup, c.currentBinary)
}

func (c *updateContext) rollback(errMsg string) error {
	updateLogger.Printf("rollback: %s", errMsg)
	c.restoreBackup()
	// 形态路由重启（P-20261112-1-S2）：windows-service 恢复备份后再 sc start、
	// launchd 交 KeepAlive、bare 原参数 spawn——与正向启动同一 restartService
	_, _ = restartService(c.currentBinary, c.port, c.dd)
	c.saveResult("rolled_back", errMsg)
	return fmt.Errorf("%s", errMsg)
}

// killAndRollback 健康检查失败回滚：先终止运行中的坏新进程再恢复盘面重拉。
// 运行中进程的 PID 来源按形态分叉——bare 是本子进程 spawn 的 spawnedPID；
// windows-service/launchd 非本子进程拉起（SCM sc start / KeepAlive 重拉），
// spawnedPID 恒 0，唯一 PID 来源是数据目录 PID 文件（新进程启动即重写）
func (c *updateContext) killAndRollback(errMsg string) {
	updateLogger.Printf("kill and rollback: %s", errMsg)
	switch superviseFromEnv() {
	case superviseWindowsService:
		// SCM 优雅停（sc stop）而非硬杀：服务进程退出码非零会触发 SCM
		// failure-recovery（install.ps1 actions=restart/5000）与回滚 sc start
		// 赛跑。停毕（waitForProcess）才能换回旧二进制——Windows 映像句柄锁定
		// 运行中 exe；等不到（服务挂死）也继续，后续失败由结果文件如实记录
		if pid := readRunningPid(c.dd); pid > 0 {
			_ = stopWindowsServiceFn()
			_ = waitForProcess(pid, 12*time.Second)
		}
	case superviseLaunchd:
		// 顺序关键：先恢复旧二进制再杀——launchd 检测到退出即刻重拉，杀完
		// 再恢复会让重拉捡到坏新包；恢复后杀则重拉必捡旧包。杀完不再
		// restartService（KeepAlive 是该形态唯一拉起者，重复 spawn 会赛跑抢端口）
		c.restoreBackup()
		if pid := readRunningPid(c.dd); pid > 0 {
			_ = killByPIDFn(pid)
		}
		c.saveResult("rolled_back", errMsg)
		return
	default:
		// bare/systemd：bare 击杀本子进程 spawn 的坏新进程（systemd 时恒 0
		// no-op），交由下方 restoreBackup + 形态路由收尾
		_ = killByPIDFn(c.spawnedPID)
	}
	c.restoreBackup()
	spawned, err := restartService(c.currentBinary, c.port, c.dd)
	if err == nil {
		c.spawnedPID = spawned
	}
	c.saveResult("rolled_back", errMsg)
}

func (c *updateContext) saveResult(status, errMsg string) {
	_ = SaveUpdateResult(c.dd, &UpdateResult{Status: status, Version: c.version, PreviousVersion: c.prevVersion, Error: errMsg})
}
