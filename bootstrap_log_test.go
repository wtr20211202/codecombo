package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// 启动早期致命退出落盘（P-20261122-9 必改3）：数据目录迁移拒绝/延后与
// 换包子进程末错发生在日志系统（app.Run dailyHandler）就绪之前，launchd/SCM
// 形态 stderr 是黑洞——bootstrapLog 是这条路径的唯一 durable 出口。

func todayLogName() string {
	return "codecombo-" + time.Now().Format("2006-01-02") + ".log"
}

// logs 目录在场 → 写当天日志（与 app.go dailyHandler 同命名，启动成功后无缝续上）
func TestBootstrapLogWritesDailyFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("CC_DATA_DIR", dir)
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0755); err != nil {
		t.Fatalf("mkdir logs: %v", err)
	}
	bootstrapLog("ERROR", "boom %d", 7)

	body, err := os.ReadFile(filepath.Join(dir, "logs", todayLogName()))
	if err != nil {
		t.Fatalf("read daily log: %v", err)
	}
	for _, want := range []string{"[ERROR]", "boom 7"} {
		if !strings.Contains(string(body), want) {
			t.Fatalf("daily log missing %q, got %q", want, string(body))
		}
	}
}

// 数据目录不存在（迁移拒绝态的常态）→ 回落固定名 bootstrap 日志，且**不得**
// 创建数据目录（拒绝态建出 <新目录>/logs 就是在造「空数据面」）
func TestBootstrapLogFallsBackWithoutCreatingDataDir(t *testing.T) {
	root := t.TempDir()
	dataDir := filepath.Join(root, "not-yet-migrated")
	t.Setenv("CC_DATA_DIR", dataDir)

	fallback := filepath.Join(t.TempDir(), "bootstrap.log")
	orig := bootstrapFallbackLogPath
	bootstrapFallbackLogPath = fallback
	t.Cleanup(func() { bootstrapFallbackLogPath = orig })

	bootstrapLog("ERROR", "migration refused")

	if _, err := os.Stat(dataDir); !os.IsNotExist(err) {
		t.Fatalf("bootstrapLog must not create the data dir, stat err = %v", err)
	}
	body, err := os.ReadFile(fallback)
	if err != nil {
		t.Fatalf("read fallback log: %v", err)
	}
	if !strings.Contains(string(body), "migration refused") {
		t.Fatalf("fallback log missing the line, got %q", string(body))
	}
}
