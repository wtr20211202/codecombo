package update

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// 换包子进程诊断面（P-20261122-9 必改A）：DataDir/logs/update-subprocess.log。
// 职责两段——
//   - 换包子进程的 stdout/stderr（Start 成功之后、initLogger 落 update.log 之前
//     的 runtime 诊断/数据目录迁移/panic trace——此前 cmd.Stdout/Stderr 全 nil，
//     这些字节被操作系统直接丢弃）；
//   - 父进程活性裁决行（握手失败时由 recordSubprocessFailure 追加一行，含 PID/
//     outcome/原因——P-5 判死只能说「10s 没动静」，说不出「怎么死的」，且判死后
//     主日志之外零落盘，用户体感「压根没有日志」的最后一环）。
//
// 刻意不并入 update.log：runbook #26/#27 的判别式「主日志无 start update
// process failed + update.log 不存在 + tmp/update-* 有完整产物 ⇒ launchd 组杀/
// 未进 DoUpdate」依赖 update.log 只是更新决策时间线；子进程的 runtime 噪声混
// 进去会同时破坏「不存在」与「内容」两种判读。也不并入 update-restart.log：
// 那是重启进程（换包成功后的新服务进程）的 stdio，本质不同（P-20261116-1-S3
// 三文件职责头注见 do_update.go）。
//
// 有界性：按次轮转（spawn 前非空即改名 .1，只留上一次），上限 2 文件；不接
// CleanOldLogs（它只解析 `<prefix>-YYYY-MM-DD.log` 日期段，扩第三前缀要同步
// servicelogs.go 双处字面量，收益不抵漂移面）。

// updateSubprocessLogPath 换包子进程诊断日志路径
func updateSubprocessLogPath(dataDir string) string {
	return filepath.Join(dataDir, "logs", "update-subprocess.log")
}

// openSubprocessLog 按次轮转并打开诊断日志（O_APPEND；首次创建写职责头注）。
// 轮转失败不阻断：上一轮子进程仍可能持有该文件（Windows 句柄锁/超时放弃后
// 仍存活的子进程），退化为继续追加——诊断字节不丢，只是跨轮混排。
func openSubprocessLog(dataDir string) (*os.File, error) {
	if err := os.MkdirAll(filepath.Join(dataDir, "logs"), 0755); err != nil {
		return nil, err
	}
	path := updateSubprocessLogPath(dataDir)
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		_ = os.Remove(path + ".1")
		_ = os.Rename(path, path+".1")
	}
	return openAppendLog(path, updateSubprocessLogHeader)
}

// writeSubprocessVerdict 父进程活性裁决落盘（单行、可 grep）：err 原文压成
// 单行（含换行的 darwin 自救指引不影响「一行一条裁决」的判读）
func writeSubprocessVerdict(f *os.File, pid int, outcome string, err error) {
	if f == nil {
		return
	}
	detail := ""
	if err != nil {
		detail = " err=" + strings.Join(strings.Fields(err.Error()), " ")
	}
	_, _ = fmt.Fprintf(f, "%s [parent] handshake failed pid=%d outcome=%s%s\n",
		time.Now().Format("2006-01-02 15:04:05"), pid, outcome, detail)
}

// recordSubprocessFailure 活性握手失败的父进程侧双落点（P-20261122-9 必改1）：
// 主日志（slog.Error，进当天 codecombo-YYYY-MM-DD.log）给「结论 + 去哪看」，
// update-subprocess.log 追加裁决行给「子进程自己的最后字节」一个同文件锚点。
// 两条调用链（自更新 Manager.ApplyUpdate / 中心链 ApplyUpdateFromCenter）都经
// LaunchUpdateSubprocess，故留痕收口在此单一裁决点（避免两处复制漂移）
func recordSubprocessFailure(dataDir string, f *os.File, pid int, outcome string, err error) {
	slog.Error("update: subprocess handshake failed",
		"pid", pid,
		"outcome", outcome,
		"log", updateSubprocessLogPath(dataDir),
		"err", err,
	)
	writeSubprocessVerdict(f, pid, outcome, err)
}
