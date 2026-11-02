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
	spawned, err := restartService(currentBinary, port)
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
	ctx.saveResult("success", "")
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

func (c *updateContext) rollback(errMsg string) error {
	updateLogger.Printf("rollback: %s", errMsg)
	os.Remove(c.currentBinary)
	_ = os.Rename(c.backup, c.currentBinary)
	_, _ = restartService(c.currentBinary, c.port)
	c.saveResult("rolled_back", errMsg)
	return fmt.Errorf("%s", errMsg)
}

func (c *updateContext) killAndRollback(errMsg string) {
	updateLogger.Printf("kill and rollback: %s", errMsg)
	_ = killByPID(c.spawnedPID)
	os.Remove(c.currentBinary)
	_ = os.Rename(c.backup, c.currentBinary)
	spawned, err := restartService(c.currentBinary, c.port)
	if err == nil {
		c.spawnedPID = spawned
	}
	c.saveResult("rolled_back", errMsg)
}

func (c *updateContext) saveResult(status, errMsg string) {
	_ = SaveUpdateResult(c.dd, &UpdateResult{Status: status, Version: c.version, PreviousVersion: c.prevVersion, Error: errMsg})
}
