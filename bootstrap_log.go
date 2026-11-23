package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"codecombo/server/config"
)

// 启动早期致命退出的落盘（P-20261122-9 必改3）：「服务起不来且全平台零日志」
// 的最后一块——数据目录迁移拒绝（--serve 直接 exit 1）、迁移延后/旧名回落告警、
// 换包子进程末错，这些落在日志系统（app.Run 内的 dailyHandler）就绪之前，
// 历史形态只有 stderr——而 launchd/SCM 形态 stderr 是黑洞（plist 无
// StandardErrorPath、SCM 不转存应用 stderr，全实测）。
//
// 纪律：**不创建数据目录**（刻意无 MkdirAll）。迁移拒绝态（旧实例存活等）若
// 在这里建出 <新目录>/logs，正是在造 main.go 注释警告的「空数据面」；logs 目录
// 不存在即走固定名回落日志，durable 面不缺席。
const bootstrapLogPrefix = "codecombo"

// bootstrapFallbackLogPath 回落日志路径（变量形态供单测重定向）：数据目录
// 不可写/不存在时的最后出口，写成功后把路径打到 stderr 供用户找到
var bootstrapFallbackLogPath = filepath.Join(os.TempDir(), "codecombo-bootstrap.log")

// bootstrapLog best-effort 追加一行启动日志：优先 DataDir/logs/codecombo-YYYY-MM-DD.log
// （与 app.go dailyHandler 同命名，启动成功后的当日日志无缝续上），失败回落
// 固定名 bootstrap 日志。任何失败静默（本就处于退出路径，不能二次制造错误）
func bootstrapLog(level, format string, args ...any) {
	line := fmt.Sprintf("%s [%s] %s\n",
		time.Now().Format("2006-01-02 15:04:05"), level, fmt.Sprintf(format, args...))
	logDir := filepath.Join(config.DataDir(), "logs")
	if info, err := os.Stat(logDir); err == nil && info.IsDir() {
		path := filepath.Join(logDir, bootstrapLogPrefix+"-"+time.Now().Format("2006-01-02")+".log")
		if appendBootstrapLine(path, line) == nil {
			return
		}
	}
	if appendBootstrapLine(bootstrapFallbackLogPath, line) == nil {
		// 让用户知道去哪看（stderr 之外通常无出口）
		fmt.Fprintf(os.Stderr, "bootstrap log: %s\n", bootstrapFallbackLogPath)
	}
}

// appendBootstrapLine O_APPEND 追加一行（不建父目录——见上方纪律）
func appendBootstrapLine(path, line string) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(line)
	return err
}
