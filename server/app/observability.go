package app

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
)

// 可观测性装配（P-20261122-9 必改B/必改C）：两件"失败必有痕"的底座能力，
// 集中在此保持 app.go（组合根）体量与职责可控。

// envLogLevel 运行期日志级别环境变量（必改C，env-only：评审拒绝设置页开关——
// config.ServerConfig 是受守护 payload 契约需重写快照，TS 镜像落 system.ts
// 冻结行数；诊断场景有 env 足够）。updateSubprocessEnv 走 append(os.Environ())，
// 换包子进程自然继承同一级别
const envLogLevel = "CC_LOG_LEVEL"

// resolveLogLevel 解析 CC_LOG_LEVEL（debug|info|warn|error，大小写不敏感、
// 容忍首尾空白）。返回的 LevelVar 供 dailyHandler.Enabled 动态读取：非法值
// 回落 Info 并返回错误（调用方在日志系统就绪后把原始值写启动告警——静默回落
// 会让「我明明设了 debug 却没有 debug 日志」变成新的无痕疑案）
func resolveLogLevel(raw string) (*slog.LevelVar, error) {
	lv := new(slog.LevelVar)
	lv.Set(slog.LevelInfo)
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return lv, nil
	}
	switch strings.ToLower(trimmed) {
	case "debug":
		lv.Set(slog.LevelDebug)
	case "info":
		lv.Set(slog.LevelInfo)
	case "warn", "warning":
		lv.Set(slog.LevelWarn)
	case "error":
		lv.Set(slog.LevelError)
	default:
		return lv, fmt.Errorf("unknown log level %q (want debug|info|warn|error)", raw)
	}
	return lv, nil
}

// crashLogMaxBytes crash.log 启动期轮转入阈值：崩溃转储可能很大（goroutine
// dump 可达 MB 级），只保本次启动的一份 + 上一次的 .1，防无界增长
const crashLogMaxBytes = 1 << 20

// crashLogPath 崩溃转储路径（与当天日志同目录，便于「一次翻目录」排障）
func crashLogPath(dataDir string) string {
	return filepath.Join(dataDir, "logs", "crash.log")
}

// installCrashOutput 安装进程级崩溃转储（必改B）：DataDir/logs/crash.log。
//
// 为什么是 debug.SetCrashOutput 而不是只加 recover：它是**唯一**能覆盖
//   - 非主 goroutine panic（顶层 defer recover 只能护主 goroutine），
//   - fatal runtime error（concurrent map write / OOM 类，recover 无效）
//
// 的手段；且绕开 launchd/SCM 的 stderr 黑洞（plist 无 StandardErrorPath、
// SCM 不转存应用 stderr——全实测；systemd 才落 journal）。
//
// 安装在 app.Run 第一条语句（早于 config.Load）：pre-logger 崩溃同样有痕。
// 启动时 >1MiB 轮转 .1。诚实的边界：SIGKILL/launchd 组杀/无 recover 的 C 层
// 崩溃不可捕获（写入 runbook §11）。失败不阻断服务（返回路径+错误由调用方告警）
func installCrashOutput(dataDir string) (string, error) {
	path := crashLogPath(dataDir)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return path, err
	}
	fresh := false
	if info, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			fresh = true
		}
	} else if info.Size() > crashLogMaxBytes {
		_ = os.Remove(path + ".1")
		_ = os.Rename(path, path+".1")
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return path, err
	}
	defer f.Close() // SetCrashOutput 复制句柄，调用后即可关闭
	if fresh {
		_, _ = f.WriteString("# crash.log — fatal panic/runtime crash dumps (includes non-main goroutines and fatal runtime errors). See logs/codecombo-YYYY-MM-DD.log for the structured timeline; swap-subprocess output lives in update-subprocess.log\n")
	}
	if err := debug.SetCrashOutput(f, debug.CrashOptions{}); err != nil {
		return path, err
	}
	return path, nil
}
